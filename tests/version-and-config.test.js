const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const VERSION = '4.3.15';
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'release-manifest.json'), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const projectConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const syncConfig = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'sync', 'config.json'),
  'utf8',
));

test('root release metadata is consistent', () => {
  assert.equal(rootPackage.version, VERSION);
  assert.equal(manifest.version, VERSION);
  assert.equal(projectConfig.appid, manifest.appid);
  assert.equal(projectConfig.miniprogramRoot, `${manifest.miniprogramRoot}/`);
  assert.equal(projectConfig.cloudfunctionRoot, `${manifest.cloudfunctionRoot}/`);
  assert.equal(projectConfig.projectname, '云端密码储存管家');
  assert.equal(manifest.appid, 'wx0000000000000000');
  assert.equal(manifest.envId, 'your-cloud-env-id');
});

test('all release cloud functions use the pinned version and SDK', () => {
  for (const functionName of [
    ...manifest.cloudFunctions,
    ...manifest.maintenanceOnlyFunctions,
  ]) {
    const functionRoot = path.join(ROOT, manifest.cloudfunctionRoot, functionName);
    const packageJson = JSON.parse(fs.readFileSync(path.join(functionRoot, 'package.json'), 'utf8'));
    const lockJson = JSON.parse(fs.readFileSync(path.join(functionRoot, 'package-lock.json'), 'utf8'));
    assert.equal(packageJson.version, VERSION, `${functionName} package version`);
    assert.equal(lockJson.version, VERSION, `${functionName} lock version`);
    assert.equal(packageJson.dependencies['wx-server-sdk'], '4.0.2', `${functionName} SDK`);
    assert.equal(lockJson.packages['node_modules/wx-server-sdk'].version, '4.0.2', `${functionName} locked SDK`);
  }
});

test('sync cloud function metadata matches the implemented collection contract', () => {
  assert.equal(syncConfig.version, VERSION);
  assert.match(syncConfig.description, /passwords/);
  assert.match(syncConfig.description, /vault_meta/);
  assert.doesNotMatch(syncConfig.description, /categories|settings/);
});

test('current project entry points exist and point to the authoritative status guide', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /docs\/项目状态与路线图\.md/);
  assert.match(readme, /DEPLOY_GUIDE\.md/);
  // 版本号跟随文件顶部 VERSION 常量，升版本只改一处
  const versionRe = new RegExp(VERSION.replace(/\./g, '\\.'));
  assert.match(readme, versionRe);
});
