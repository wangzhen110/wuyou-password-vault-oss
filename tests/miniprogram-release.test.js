const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/build-miniprogram-release.ps1');
const WINDOWS_ONLY = process.platform === 'win32';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('builds a clean mini-program release archive from the manifest', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'scripts/release-manifest.json'), {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login', 'sync'],
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(path.join(project, 'miniprogram/app.js'), 'App({});\n');
    for (const name of ['login', 'sync']) {
      fs.mkdirSync(path.join(project, 'cloudfunctions', name, 'node_modules', 'fake'), { recursive: true });
      fs.writeFileSync(path.join(project, 'cloudfunctions', name, 'index.js'), `exports.main = () => '${name}';\n`);
      writeJson(path.join(project, 'cloudfunctions', name, 'package.json'), { name, version: '4.0.1' });
      if (name === 'sync') {
        writeJson(path.join(project, 'cloudfunctions', name, 'config.json'), { name, version: '4.0.1' });
      }
      fs.writeFileSync(path.join(project, 'cloudfunctions', name, 'node_modules', 'fake/index.js'), 'local\n');
    }
    fs.mkdirSync(path.join(project, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'logs/run.log'), 'local\n');

    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-ProjectRoot', project,
      '-OutputRoot', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.version, '4.0.1');
    assert.equal(payload.appid, 'fixture-appid');
    assert.equal(payload.env_id, 'fixture-env');
    assert.match(payload.sha256, /^[a-f0-9]{64}$/);
    assert.equal(payload.sha256, sha256(payload.archive));
    assert.equal(typeof payload.entry_count, 'number');
    assert.equal(Number.isInteger(payload.entry_count), true);
    assert.ok(payload.entry_count > 0);
    assert.deepEqual(payload.cloud_functions, ['login', 'sync']);
    assert.ok(fs.existsSync(payload.archive));
    assert.equal(payload.manifest, `${payload.archive}.manifest.json`);
    assert.ok(fs.existsSync(payload.manifest));

    const archiveManifest = JSON.parse(fs.readFileSync(payload.manifest, 'utf8'));
    assert.deepEqual(archiveManifest, {
      version: '4.0.1',
      appid: 'fixture-appid',
      env_id: 'fixture-env',
      archive_name: path.basename(payload.archive),
      sha256: payload.sha256,
      entry_count: payload.entry_count,
      cloud_functions: ['login', 'sync'],
    });
    const archiveHashBeforeRetry = sha256(payload.archive);
    const manifestBeforeRetry = fs.readFileSync(payload.manifest, 'utf8');

    const duplicateBuild = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-ProjectRoot', project,
      '-OutputRoot', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.notEqual(duplicateBuild.status, 0);
    assert.match(
      `${duplicateBuild.stdout}\n${duplicateBuild.stderr}`,
      /Refusing to overwrite existing release archive/,
    );
    assert.equal(sha256(payload.archive), archiveHashBeforeRetry);
    assert.equal(fs.readFileSync(payload.manifest, 'utf8'), manifestBeforeRetry);

    const listing = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:ZIP); try { $z.Entries | % FullName } finally { $z.Dispose() }',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, ZIP: payload.archive },
    });
    assert.equal(listing.status, 0, listing.stderr);
    const names = listing.stdout.trim().split(/\r?\n/).filter(Boolean).map(name => name.replaceAll('\\', '/'));
    const normalizedNames = names.map(name => name.replace(/^\/+/, ''));
    assert.equal(payload.entry_count, normalizedNames.length);
    assert.equal(archiveManifest.entry_count, normalizedNames.length);
    const hasEntry = relativePath => normalizedNames.some(name =>
      name === relativePath || name.endsWith(`/${relativePath}`)
    );
    assert.ok(hasEntry('project.config.json'));
    assert.ok(hasEntry('miniprogram/app.json'));
    assert.ok(hasEntry('cloudfunctions/login/index.js'));
    assert.ok(hasEntry('cloudfunctions/sync/index.js'));
    assert.ok(hasEntry('cloudfunctions/sync/config.json'));
    assert.ok(normalizedNames.every(name => !/(^|\/)(node_modules|logs)(\/|$)/.test(name)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects AppID and cloud function version drift before packaging', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-metadata-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    fs.mkdirSync(path.join(project, 'cloudfunctions', 'login'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'wrong-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'scripts/release-manifest.json'), {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login'],
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(path.join(project, 'cloudfunctions', 'login', 'index.js'), 'exports.main = () => "login";\n');
    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.0',
    });
    writeJson(path.join(project, 'cloudfunctions', 'login', 'config.json'), {
      name: 'login',
      version: '4.0.1',
    });

    const runBuild = () => spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-ProjectRoot', project,
      '-OutputRoot', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

    const appidMismatch = runBuild();
    assert.notEqual(appidMismatch.status, 0);
    assert.match(`${appidMismatch.stdout}\n${appidMismatch.stderr}`, /AppID mismatch/);

    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    const functionVersionMismatch = runBuild();
    assert.notEqual(functionVersionMismatch.status, 0);
    assert.match(`${functionVersionMismatch.stdout}\n${functionVersionMismatch.stderr}`, /cloudfunctions[\\/]login[\\/]package\.json/);

    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.1',
    });
    writeJson(path.join(project, 'cloudfunctions', 'login', 'config.json'), {
      name: 'login',
      version: '4.0.0',
    });
    const configVersionMismatch = runBuild();
    assert.notEqual(configVersionMismatch.status, 0);
    assert.match(`${configVersionMismatch.stdout}\n${configVersionMismatch.stderr}`, /cloudfunctions[\\/]login[\\/]config\.json/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('honors manifest exclusions for directories, wildcards, and exact files', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-exclusions-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'scripts/release-manifest.json'), {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login'],
      excludedFromRelease: [
        'miniprogram/local-only/',
        'miniprogram/*.tmp',
        'miniprogram/exact-local.txt',
        '.env*',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
      ],
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(path.join(project, 'miniprogram/app.js'), 'App({});\n');
    fs.mkdirSync(path.join(project, 'cloudfunctions', 'login'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'cloudfunctions', 'login', 'index.js'),
      'exports.main = () => "login";\n',
    );
    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.1',
    });
    fs.mkdirSync(path.join(project, 'miniprogram/local-only/nested'), { recursive: true });
    fs.writeFileSync(path.join(project, 'miniprogram/local-only/nested/secret.txt'), 'local\n');
    fs.writeFileSync(path.join(project, 'miniprogram/temporary.tmp'), 'local\n');
    fs.writeFileSync(path.join(project, 'miniprogram/exact-local.txt'), 'local\n');
    fs.writeFileSync(path.join(project, 'miniprogram/.env.production'), 'local secret\n');
    fs.mkdirSync(path.join(project, 'miniprogram/private'), { recursive: true });
    for (const fileName of ['certificate.pem', 'private.key', 'client.p12', 'client.pfx']) {
      fs.writeFileSync(path.join(project, 'miniprogram/private', fileName), 'local secret\n');
    }

    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-ProjectRoot', project,
      '-OutputRoot', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim());

    const listing = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:ZIP); try { $z.Entries | % FullName } finally { $z.Dispose() }',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, ZIP: payload.archive },
    });
    assert.equal(listing.status, 0, listing.stderr);
    const names = listing.stdout.trim().split(/\r?\n/).filter(Boolean).map(name => name.replaceAll('\\', '/'));
    const normalizedNames = names.map(name => name.replace(/^\/+/, ''));
    const hasEntry = relativePath => normalizedNames.some(name =>
      name === relativePath || name.endsWith(`/${relativePath}`)
    );

    assert.ok(hasEntry('miniprogram/app.js'));
    assert.equal(hasEntry('miniprogram/local-only/nested/secret.txt'), false);
    assert.equal(hasEntry('miniprogram/temporary.tmp'), false);
    assert.equal(hasEntry('miniprogram/exact-local.txt'), false);
    assert.equal(hasEntry('miniprogram/.env.production'), false);
    for (const fileName of ['certificate.pem', 'private.key', 'client.p12', 'client.pfx']) {
      assert.equal(hasEntry(`miniprogram/private/${fileName}`), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid cloud function manifest metadata', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-manifest-validation-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    fs.mkdirSync(path.join(project, 'cloudfunctions', 'login'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(path.join(project, 'cloudfunctions', 'login', 'index.js'), 'exports.main = () => "login";\n');
    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.1',
    });

    const baseManifest = {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login'],
    };
    const runBuild = manifestValue => {
      writeJson(path.join(project, 'scripts/release-manifest.json'), manifestValue);
      return spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-ProjectRoot', project,
        '-OutputRoot', output,
      ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    };

    const emptyFunctions = runBuild({ ...baseManifest, cloudFunctions: [] });
    assert.notEqual(emptyFunctions.status, 0);
    assert.match(
      `${emptyFunctions.stdout}\n${emptyFunctions.stderr}`,
      /cloudFunctions must contain at least one function/,
    );

    const nonStringFunction = runBuild({ ...baseManifest, cloudFunctions: ['login', 7] });
    assert.notEqual(nonStringFunction.status, 0);
    assert.match(
      `${nonStringFunction.stdout}\n${nonStringFunction.stderr}`,
      /cloudFunctions must contain only non-empty strings/,
    );

    const duplicateFunction = runBuild({ ...baseManifest, cloudFunctions: ['login', 'login'] });
    assert.notEqual(duplicateFunction.status, 0);
    assert.match(
      `${duplicateFunction.stdout}\n${duplicateFunction.stderr}`,
      /cloudFunctions must contain unique function names/,
    );

    const nonArrayFunctions = runBuild({ ...baseManifest, cloudFunctions: 'login' });
    assert.notEqual(nonArrayFunctions.status, 0);
    assert.match(
      `${nonArrayFunctions.stdout}\n${nonArrayFunctions.stderr}`,
      /cloudFunctions must be an array/,
    );

    const nonStringEnv = runBuild({ ...baseManifest, envId: 123 });
    assert.notEqual(nonStringEnv.status, 0);
    assert.match(
      `${nonStringEnv.stdout}\n${nonStringEnv.stderr}`,
      /field must be a non-empty string: envId/,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects manifest paths that escape the project before packaging', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-path-boundary-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    fs.mkdirSync(path.join(project, 'cloudfunctions', 'login'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(
      path.join(project, 'cloudfunctions', 'login', 'index.js'),
      'exports.main = () => "login";\n',
    );
    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.1',
    });
    fs.writeFileSync(path.join(root, 'outside-marker.txt'), 'must-not-be-read\n');

    const baseManifest = {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login'],
    };
    const cases = [
      {
        field: 'miniprogramRoot',
        value: '../outside',
        label: 'miniprogramRoot',
      },
      {
        field: 'cloudfunctionRoot',
        value: '../outside-functions',
        label: 'cloudfunctionRoot',
      },
      {
        field: 'cloudFunctions',
        value: ['../outside-function'],
        label: 'cloudFunctions',
      },
    ];

    for (const { field, value, label } of cases) {
      writeJson(path.join(project, 'scripts/release-manifest.json'), {
        ...baseManifest,
        [field]: value,
      });
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-ProjectRoot', project,
        '-OutputRoot', output,
      ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

      assert.notEqual(result.status, 0, label);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /Release manifest path must be relative and stay inside its parent directory/,
        label,
      );
      assert.equal(fs.existsSync(output), false, label);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an existing orphan sidecar path before publishing', {
  skip: !WINDOWS_ONLY,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-release-cleanup-test-'));
  const project = path.join(root, 'project');
  const output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(project, 'miniprogram'), { recursive: true });
    fs.mkdirSync(path.join(project, 'cloudfunctions', 'login'), { recursive: true });
    writeJson(path.join(project, 'package.json'), { version: '4.0.1' });
    writeJson(path.join(project, 'project.config.json'), {
      appid: 'fixture-appid',
      miniprogramRoot: 'miniprogram/',
      cloudfunctionRoot: 'cloudfunctions/',
    });
    writeJson(path.join(project, 'scripts/release-manifest.json'), {
      version: '4.0.1',
      appid: 'fixture-appid',
      envId: 'fixture-env',
      miniprogramRoot: 'miniprogram',
      cloudfunctionRoot: 'cloudfunctions',
      cloudFunctions: ['login'],
    });
    writeJson(path.join(project, 'miniprogram/app.json'), { pages: [] });
    fs.writeFileSync(path.join(project, 'cloudfunctions', 'login', 'index.js'), 'exports.main = () => "login";\n');
    writeJson(path.join(project, 'cloudfunctions', 'login', 'package.json'), {
      name: 'login',
      version: '4.0.1',
    });

    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.join(output, 'miniprogram-4.0.1.zip.manifest.json'));
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-ProjectRoot', project,
      '-OutputRoot', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Refusing to overwrite existing release manifest/,
    );
    assert.equal(fs.existsSync(path.join(output, 'miniprogram-4.0.1.zip')), false);
    assert.deepEqual(
      fs.readdirSync(output).filter(name => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
