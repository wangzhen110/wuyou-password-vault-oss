const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/backup-release.ps1');
const WINDOWS_ONLY = process.platform === 'win32';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-backup-test-'));
  const projectRoot = path.join(root, 'project');
  const backupRoot = path.join(root, 'release-backups');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'fixture'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    version: '2.3.4',
  }));
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'committed source\n');
  fs.writeFileSync(path.join(projectRoot, 'node_modules', 'fixture', 'cache.js'), 'exclude\n');
  fs.writeFileSync(path.join(projectRoot, 'project.private.config.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(projectRoot, 'debug.log'), 'exclude\n');

  runGit(projectRoot, ['init', '--quiet']);
  runGit(projectRoot, ['config', 'user.email', 'backup-test@example.invalid']);
  runGit(projectRoot, ['config', 'user.name', 'Backup Test']);
  runGit(projectRoot, ['add', '.']);
  runGit(projectRoot, ['commit', '--quiet', '-m', 'fixture baseline']);

  return { root, projectRoot, backupRoot };
}

function runGit(projectRoot, args) {
  const result = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function runBackup(fixture, args = []) {
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT_PATH,
    '-ProjectRoot',
    fixture.projectRoot,
    '-BackupRoot',
    fixture.backupRoot,
    ...args,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
}

function listArchives(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot)
    .filter(name => name.endsWith('.zip'))
    .sort()
    .map(name => path.join(backupRoot, name));
}

function readMetadata(archivePath) {
  return JSON.parse(fs.readFileSync(`${archivePath}.manifest.json`, 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function extractArchive(archivePath, destination) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:ZIP_PATH, $env:EXTRACT_PATH)',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZIP_PATH: archivePath,
      EXTRACT_PATH: destination,
    },
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || 'archive extraction failed');
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('creates a verified working-tree snapshot and excludes private or volatile files', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.projectRoot, 'src', 'app.js'), 'uncommitted source\n');
    const result = runBackup(fixture, ['-Label', 'working-tree']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const resultPayload = JSON.parse(result.stdout.trim());

    const archives = listArchives(fixture.backupRoot);
    assert.equal(archives.length, 1);
    const metadata = readMetadata(archives[0]);
    assert.equal(metadata.schema, 'codex-project-release-backup/v1');
    assert.equal(metadata.source_kind, 'WorkingTree');
    assert.equal(metadata.package_version, '2.3.4');
    assert.match(metadata.archive_sha256, /^[a-f0-9]{64}$/i);
    assert.equal(metadata.archive_sha256, sha256(archives[0]));
    assert.equal(resultPayload.archive_sha256, metadata.archive_sha256);
    assert.equal(path.resolve(resultPayload.archive), path.resolve(archives[0]));

    const extracted = path.join(fixture.root, 'extracted');
    extractArchive(archives[0], extracted);
    assert.equal(fs.readFileSync(path.join(extracted, 'src', 'app.js'), 'utf8'), 'uncommitted source\n');
    assert.ok(fs.existsSync(path.join(extracted, '.gitignore')));
    assert.ok(!fs.existsSync(path.join(extracted, 'node_modules')));
    assert.ok(!fs.existsSync(path.join(extracted, '.git')));
    assert.ok(!fs.existsSync(path.join(extracted, 'project.private.config.json')));
    assert.ok(!fs.existsSync(path.join(extracted, 'debug.log')));
    assert.ok(fs.existsSync(path.join(extracted, 'release-manifest.json')));
    assert.equal(
      metadata.manifest_sha256,
      sha256(path.join(extracted, 'release-manifest.json')),
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('applies the project release manifest exclusions to working-tree snapshots', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(path.join(fixture.projectRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, 'scripts', 'release-manifest.json'), JSON.stringify({
      excludedFromRelease: [
        'devtools-probe*.js',
        'preview*.png',
        'shots/',
        'scripts/*query.json',
        'AI_SYNC/',
        'AI协作模块/',
        'scripts/id-projection.json',
        'scripts/empty-query.json',
        'logs/',
        '.workbuddy/',
      ],
    }));
    fs.writeFileSync(path.join(fixture.projectRoot, 'devtools-probe.js'), 'probe\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'devtools-probe2.js'), 'probe\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'preview.png'), 'preview\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'preview-release.png'), 'preview\n');
    fs.mkdirSync(path.join(fixture.projectRoot, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, 'shots', 'screen.png'), 'screen\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'scripts', 'users-query.json'), '{}\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'scripts', 'id-projection.json'), '{}\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'scripts', 'empty-query.json'), '{}\n');
    fs.mkdirSync(path.join(fixture.projectRoot, 'AI_SYNC'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, 'AI_SYNC', 'notes.md'), 'local\n');
    fs.mkdirSync(path.join(fixture.projectRoot, 'AI协作模块'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, 'AI协作模块', 'notes.md'), 'local\n');
    fs.mkdirSync(path.join(fixture.projectRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, 'logs', 'run.log'), 'local\n');
    fs.mkdirSync(path.join(fixture.projectRoot, '.workbuddy'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, '.workbuddy', 'memory.md'), 'local\n');
    fs.writeFileSync(path.join(fixture.projectRoot, 'keep.txt'), 'keep\n');

    const result = runBackup(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const extracted = path.join(fixture.root, 'extracted');
    extractArchive(listArchives(fixture.backupRoot)[0], extracted);
    const snapshotManifest = JSON.parse(
      fs.readFileSync(path.join(extracted, 'release-manifest.json'), 'utf8'),
    );
    for (const exclusion of [
      'devtools-probe*.js',
      'preview*.png',
      'shots/',
      'scripts/*query.json',
      'AI_SYNC/',
      'AI协作模块/',
      'scripts/id-projection.json',
      'scripts/empty-query.json',
      'logs/',
      '.workbuddy/',
    ]) {
      assert.ok(snapshotManifest.exclusions.includes(exclusion), `missing metadata exclusion: ${exclusion}`);
    }

    assert.ok(!fs.existsSync(path.join(extracted, 'devtools-probe.js')));
    assert.ok(!fs.existsSync(path.join(extracted, 'devtools-probe2.js')));
    assert.ok(!fs.existsSync(path.join(extracted, 'preview.png')));
    assert.ok(!fs.existsSync(path.join(extracted, 'preview-release.png')));
    assert.ok(!fs.existsSync(path.join(extracted, 'shots', 'screen.png')));
    assert.ok(!fs.existsSync(path.join(extracted, 'scripts', 'users-query.json')));
    assert.ok(!fs.existsSync(path.join(extracted, 'scripts', 'id-projection.json')));
    assert.ok(!fs.existsSync(path.join(extracted, 'scripts', 'empty-query.json')));
    assert.ok(!fs.existsSync(path.join(extracted, 'AI_SYNC')));
    assert.ok(!fs.existsSync(path.join(extracted, 'AI协作模块')));
    assert.ok(!fs.existsSync(path.join(extracted, 'logs')));
    assert.ok(!fs.existsSync(path.join(extracted, '.workbuddy')));
    assert.ok(fs.existsSync(path.join(extracted, 'keep.txt')));
  } finally {
    cleanup(fixture.root);
  }
});

test('defaults project root to the parent of the script directory', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    const scriptDirectory = path.join(fixture.projectRoot, 'scripts');
    fs.mkdirSync(scriptDirectory, { recursive: true });
    const scriptPath = path.join(scriptDirectory, 'backup-release.ps1');
    fs.copyFileSync(SCRIPT_PATH, scriptPath);

    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-BackupRoot',
      fixture.backupRoot,
      '-Label',
      'default-root',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const archives = listArchives(fixture.backupRoot);
    assert.equal(archives.length, 1);
    const extracted = path.join(fixture.root, 'extracted');
    extractArchive(archives[0], extracted);
    assert.equal(
      fs.readFileSync(path.join(extracted, 'src', 'app.js'), 'utf8'),
      'committed source\n',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('retains the two newest valid project snapshots and leaves unrelated archives alone', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(fixture.backupRoot, { recursive: true });
    const unrelatedArchive = path.join(fixture.backupRoot, 'manual-backup.zip');
    fs.writeFileSync(unrelatedArchive, 'do not manage');
    fs.writeFileSync(`${unrelatedArchive}.manifest.json`, JSON.stringify({
      schema: 'user-owned-backup',
    }));

    for (const version of ['v1', 'v2', 'v3']) {
      fs.writeFileSync(
        path.join(fixture.projectRoot, 'src', 'app.js'),
        `${version}\n`,
      );
      const result = runBackup(fixture, ['-Label', version]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const archives = listArchives(fixture.backupRoot);
    assert.equal(archives.length, 3);
    assert.ok(fs.existsSync(unrelatedArchive));
    assert.equal(fs.readFileSync(unrelatedArchive, 'utf8'), 'do not manage');

    const managed = archives.filter(archive => archive !== unrelatedArchive);
    assert.equal(managed.length, 2);
    const versions = managed
      .map(readMetadata)
      .map(metadata => metadata.label)
      .sort();
    assert.deepEqual(versions, ['v2', 'v3']);
  } finally {
    cleanup(fixture.root);
  }
});

test('does not prune existing snapshots when a new Git snapshot fails', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    for (const label of ['keep-a', 'keep-b']) {
      const result = runBackup(fixture, ['-Label', label]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const before = listArchives(fixture.backupRoot).map(archive => ({
      name: path.basename(archive),
      hash: readMetadata(archive).archive_sha256,
    }));
    const failed = runBackup(fixture, [
      '-SourceKind',
      'GitCommit',
      '-Commitish',
      'missing-ref-for-test',
    ]);
    assert.notEqual(failed.status, 0);

    const after = listArchives(fixture.backupRoot).map(archive => ({
      name: path.basename(archive),
      hash: readMetadata(archive).archive_sha256,
    }));
    assert.deepEqual(after, before);
  } finally {
    cleanup(fixture.root);
  }
});

test('creates a Git baseline snapshot without including uncommitted changes', {
  skip: !WINDOWS_ONLY,
}, () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.projectRoot, 'src', 'app.js'), 'uncommitted source\n');
    const commit = runGit(fixture.projectRoot, ['rev-parse', 'HEAD']);
    const result = runBackup(fixture, [
      '-SourceKind',
      'GitCommit',
      '-Commitish',
      'HEAD',
      '-Label',
      'git-head',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const archive = listArchives(fixture.backupRoot)[0];
    const metadata = readMetadata(archive);
    assert.equal(metadata.source_kind, 'GitCommit');
    assert.equal(metadata.git_commit, commit);
    const extracted = path.join(fixture.root, 'extracted');
    extractArchive(archive, extracted);
    assert.equal(
      fs.readFileSync(path.join(extracted, 'src', 'app.js'), 'utf8').replace(/\r\n/g, '\n'),
      'committed source\n',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('rejects retention settings below two', { skip: !WINDOWS_ONLY }, () => {
  const fixture = makeFixture();
  try {
    const result = runBackup(fixture, ['-Keep', '1']);
    assert.notEqual(result.status, 0);
    assert.deepEqual(listArchives(fixture.backupRoot), []);
  } finally {
    cleanup(fixture.root);
  }
});

test('rejects backup directories that overlap the source project', { skip: !WINDOWS_ONLY }, () => {
  const fixture = makeFixture();
  try {
    for (const backupRoot of [
      path.join(fixture.projectRoot, 'nested-backups'),
      fixture.root,
    ]) {
      const result = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT_PATH,
        '-ProjectRoot',
        fixture.projectRoot,
        '-BackupRoot',
        backupRoot,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(!fs.existsSync(path.join(backupRoot, 'fixture-project-2.3.4-worktree-working-tree.zip')));
    }
  } finally {
    cleanup(fixture.root);
  }
});
