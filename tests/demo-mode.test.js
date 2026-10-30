// 演示模式测试：只读示例数据、禁止写入、退出后恢复锁屏状态
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function withApp(globalData, fn) {
  const original = global.getApp;
  global.getApp = () => ({ globalData });
  try { return fn(); } finally { global.getApp = original; }
}

test('demo mode returns sample entries and never touches real storage', () => {
  const demo = require(path.join(ROOT, 'miniprogram/utils/demo-mode.js'));
  withApp({ demoMode: false, isLocked: true }, () => {
    assert.equal(demo.isActive(), false);
    demo.enter();
    assert.equal(demo.isActive(), true);
    const entries = demo.getEntries();
    assert.equal(entries.length, 5);
    assert.ok(entries.every(e => typeof e.platform === 'string' && e.id.startsWith('demo-')));
    // 返回副本：外部修改不影响内置数据
    entries[0].platform = 'hacked';
    assert.notEqual(demo.getEntries()[0].platform, 'hacked');
  });
});

test('demo mode blocks every write path and disables sync', () => {
  const demo = require(path.join(ROOT, 'miniprogram/utils/demo-mode.js'));
  const blocked = demo.blocked();
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /演示模式/);

  const storage = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/storage.js'), 'utf8');
  // 读路径：演示模式直接返回示例，不读密文
  assert.match(storage, /if \(demoMode\.isActive\(\)\) return demoMode\.getEntries\(\);/);
  // 四条写路径 + canSync 都必须被挡
  for (const fn of ['importPasswords', 'addPassword', 'updatePassword', 'deletePassword']) {
    const idx = storage.indexOf('async function ' + fn);
    assert.ok(idx > 0, fn + ' 应存在');
    const body = storage.slice(idx, idx + 200);
    assert.match(body, /demoMode\.isActive\(\)/, fn + ' 应有演示模式拦截');
  }
  assert.match(storage, /function canSync\(\) \{\s*\n\s*if \(demoMode\.isActive\(\)\) return false;/);
});

test('exiting demo mode clears master key and relocks the app', () => {
  const demo = require(path.join(ROOT, 'miniprogram/utils/demo-mode.js'));
  withApp({ demoMode: true, isLocked: false, masterKey: { encryptionKey: 1 } }, () => {
    demo.exit();
    const app = global.getApp();
    assert.equal(app.globalData.demoMode, false);
    assert.equal(app.globalData.isLocked, true);
    assert.equal(app.globalData.masterKey, null);
  });
});

test('lock screen exposes a demo entry that does not require the master password', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.js'), 'utf8');
  assert.match(wxml, /bindtap="onEnterDemo"/);
  assert.match(wxml, /演示模式/);
  assert.match(js, /onEnterDemo\(\)/);
  assert.match(js, /demoMode\.enter\(\)/);
});

test('home page shows demo banner and can exit back to lock', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  assert.match(wxml, /demo-banner/);
  assert.match(wxml, /演示模式/);
  assert.match(js, /onExitDemo\(\)/);
  assert.match(js, /demoMode\.exit\(\)/);
});

test('home header profile area taps to account page like settings, blocked in demo mode', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.js'), 'utf8');
  // 与设置页资料卡相同的跳转目标
  const accountUrl = settingsJs.match(/onGoAccount\(\)\s*\{[\s\S]*?url:\s*'([^']+)'/);
  assert.ok(accountUrl, 'settings onGoAccount should navigate to account page');
  // 首页信息栏左侧整块可点（4.3.11 起品牌头改为 infobar/ib-left），跳同一目标
  assert.match(wxml, /class="ib-left tappable" bindtap="onGoAccount"/);
  assert.match(js, /onGoAccount\(\)/);
  assert.ok(js.includes(`url: '${accountUrl[1]}'`), `index onGoAccount should navigate to ${accountUrl[1]}`);
  // 演示模式下不进入账户页（写路径隔离）
  assert.match(js, /onGoAccount\(\)\s*\{[\s\S]*?demoMode[\s\S]*?return/);
});
