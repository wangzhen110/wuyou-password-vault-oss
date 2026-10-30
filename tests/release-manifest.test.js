const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'scripts', 'release-manifest.json'),
  'utf8',
));
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const projectConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const REQUIRED_EXISTING_FUNCTION_ACTIONS = {
  ensureCollections: 'exclude',
  globalStats: 'retain-unmodified',
  initDB: 'retain-unmodified',
  leaderboard: 'retain-unmodified',
};

test('release manifest matches the local release configuration', () => {
  // 不再硬编码版本号：manifest 与根 package 必须一致即可，避免每次升版都要改两处
  assert.equal(manifest.version, rootPackage.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version 必须为 semver');
  assert.equal(projectConfig.appid, manifest.appid);
  assert.equal(projectConfig.miniprogramRoot, `${manifest.miniprogramRoot}/`);
  assert.equal(projectConfig.cloudfunctionRoot, `${manifest.cloudfunctionRoot}/`);
  assert.equal(projectConfig.projectname, '云端密码储存管家');
});

test('release manifest deployment metadata has stable types', () => {
  assert.equal(typeof manifest.envId, 'string');
  assert.ok(manifest.envId.trim().length > 0);
  assert.ok(Array.isArray(manifest.cloudFunctions));
  assert.ok(manifest.cloudFunctions.length > 0);
  assert.ok(
    manifest.cloudFunctions.every(
      functionName => typeof functionName === 'string' && functionName.trim().length > 0,
    ),
  );
  assert.equal(
    new Set(manifest.cloudFunctions).size,
    manifest.cloudFunctions.length,
  );
});

test('release cloud functions exist and use the pinned server SDK', () => {
  for (const functionName of [
    ...manifest.cloudFunctions,
    ...manifest.maintenanceOnlyFunctions,
  ]) {
    const functionRoot = path.join(ROOT, manifest.cloudfunctionRoot, functionName);
    const packagePath = path.join(functionRoot, 'package.json');
    assert.ok(fs.existsSync(path.join(functionRoot, 'index.js')), `${functionName}/index.js`);
    assert.ok(fs.existsSync(packagePath), `${functionName}/package.json`);

    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.equal(packageJson.version, manifest.version, `${functionName} version`);
    assert.equal(packageJson.dependencies['wx-server-sdk'], '4.0.2', `${functionName} SDK`);
  }
});

test('release manifest excludes local-only artifacts', () => {
  const requiredExclusions = [
    'devtools-probe*.js',
    'preview*.png',
    'shots/',
    'project.private.config.json',
    'node_modules/',
    'scripts/*query.json',
    'scripts/*update.json',
    'scripts/production-user-*.json',
    'scripts/id-projection.json',
    'scripts/empty-query.json',
    '.env*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'AI_SYNC/',
    'AI协作模块/',
    'logs/',
    '.workbuddy/',
  ];

  for (const excluded of manifest.excludedFromRelease) {
    const normalized = excluded.replaceAll('\\', '/');
    assert.ok(
      !path.posix.isAbsolute(normalized) &&
        !normalized.includes('..') &&
        normalized.length > 0,
      `expected an explicit local-only exclusion: ${excluded}`,
    );
  }

  for (const required of requiredExclusions) {
    assert.ok(
      manifest.excludedFromRelease.includes(required),
      `missing required release exclusion: ${required}`,
    );
  }

  assert.equal(manifest.cloudFunctions.includes('ensureCollections'), false);
  assert.equal(manifest.cloudFunctions.includes('login'), true);
  assert.equal(manifest.cloudFunctions.includes('sync'), true);
});

test('release manifest does not package production inspection parameters', () => {
  assert.ok(
    manifest.excludedFromRelease.includes('scripts/production-user-*.json'),
    'production user query/update parameter files must stay local-only',
  );
});

test('release manifest records disposition for every known production-only function', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.existingProductionFunctions)
        .map(([name, entry]) => [name, entry.action]),
    ),
    REQUIRED_EXISTING_FUNCTION_ACTIONS,
  );

  for (const [name, entry] of Object.entries(manifest.existingProductionFunctions)) {
    assert.equal(typeof entry.reason, 'string', `${name} disposition reason`);
    assert.ok(entry.reason.trim().length > 0, `${name} disposition reason is non-empty`);
  }
});
