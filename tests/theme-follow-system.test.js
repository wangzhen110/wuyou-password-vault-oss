// 主题跟随系统：darkmode 声明 + onThemeChange 实时刷新链路
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

test('app.json declares darkmode with theme.json for system theme', () => {
  const appJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8')
  );
  // darkmode:true 是 wx.getSystemInfoSync().theme 与 wx.onThemeChange 生效的前提
  assert.equal(appJson.darkmode, true);
  assert.equal(appJson.themeLocation, 'theme.json');
  // 原生窗口颜色走 @ 变量，跟随系统深浅切换
  assert.match(appJson.window.backgroundColor, /^@/);
  assert.match(appJson.window.backgroundTextStyle, /^@/);

  const themeJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'miniprogram/theme.json'), 'utf8')
  );
  for (const mode of ['light', 'dark']) {
    assert.ok(themeJson[mode] && themeJson[mode].bgColor, `theme.json ${mode}.bgColor`);
    assert.ok(themeJson[mode] && themeJson[mode].bgTxtStyle, `theme.json ${mode}.bgTxtStyle`);
  }
});

test('app.js registers onThemeChange refresh guarded by auto mode', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8');
  assert.match(appJs, /wx\.onThemeChange/);
  // 仅跟随系统模式刷新 + 用回调携带的主题重算 class + 同步 tabBar
  assert.match(appJs, /getTheme\(\)\s*!==\s*'auto'/);
  assert.match(appJs, /getThemeClass\(res\.theme\)/);
  assert.match(appJs, /refreshTheme/);
});

test('getThemeClass accepts explicit effective theme overriding system probe', () => {
  const themePath = path.join(ROOT, 'miniprogram/styles/theme.js');
  const originalLoad = Module._load;
  Module._load = function load(request) {
    if (request === '../utils/storage') return { get: key => (key === 'theme' ? 'auto' : 'normal') };
    return originalLoad.apply(this, arguments);
  };
  const originalWx = global.wx;
  try {
    delete require.cache[themePath];
    const themeModule = require(themePath);
    // 系统探针为 light，但回调传入 dark 时应优先显式参数
    global.wx = { getSystemInfoSync: () => ({ theme: 'light' }) };
    assert.equal(themeModule.getThemeClass(), 'theme-light');
    assert.equal(themeModule.getThemeClass('dark'), 'theme-dark');
    assert.equal(themeModule.getThemeClass('light'), 'theme-light');
    // 缺省仍走系统探针
    assert.equal(themeModule.getThemeClass(), 'theme-light');
  } finally {
    Module._load = originalLoad;
    global.wx = originalWx;
    delete require.cache[themePath];
  }
});
