/**
 * 主题系统 V3.0
 * 
 * 通过 page 元素的 class 控制主题，配合 theme.wxss 的 CSS 变量实现
 * - auto: 删除手动 class，依赖 @media (prefers-color-scheme)
 * - dark:  添加 .theme-dark class
 * - light: 添加 .theme-light class（覆盖系统深色）
 * 
 * 新增字号系统：
 * - normal: 标准字号（已适老化放大）
 * - large:  更大字号（老年友好模式）
 */
const storage = require('../utils/storage');

/**
 * 获取字号对应的 CSS class
 * 字号调整功能已下线（2026-10-20）：全量固定标准字号。
 * 保留函数与导出，各页面调用点无需改动；存量 'font-large' 设置自动失效。
 * @returns {string} ''
 */
function getFontSizeClass() {
  return '';
}

/**
 * 获取主题对应的 CSS class（包含字号）
 * @param {string} [effectiveTheme] - 可选，外部已知的生效主题（如 onThemeChange 回调携带的
 *   系统主题），避免回调时机下 getSystemInfoSync 尚未同步；缺省自动判定
 * @returns {string}
 */
/**
 * 同步状态栏前景色（时间/信号/电量）。
 * setNavigationBarColor 是「页面级」设置，切页后会回落到 app.json 的 navigationBarTextStyle，
 * 所以必须在每个页面 show 时重新设置——这里挂在 getThemeClass 上，所有页面取主题类时自动生效。
 */
function syncStatusBar(effectiveTheme) {
  const t = effectiveTheme || getEffectiveTheme();
  const front = t === 'light' ? '#000000' : '#ffffff';
  try {
    wx.setNavigationBarColor({
      frontColor: front,
      backgroundColor: t === 'light' ? '#F7F8FA' : '#121212',
      fail: () => { /* 自定义导航下部分端不支持，静默 */ },
    });
  } catch (e) { /* 静默 */ }
}

function getThemeClass(effectiveTheme) {
  // 每次页面 show 取主题类时，顺带同步状态栏前景色（否则切页后白字/黑字会不一致）
  syncStatusBar(effectiveTheme);
  const fs = getFontSizeClass();
  const themePart = 'theme-' + (effectiveTheme || getEffectiveTheme());
  // 合并主题和字号 class
  return (themePart + ' ' + fs).trim();
}

/**
 * 应用主题到当前页面
 * @param {string} themeName - 'dark' | 'light' | 'auto'
 */
function apply(themeName) {
  const actualTheme = themeName || getTheme();
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  
  if (!page) return;

  if (actualTheme === 'dark') {
    page.setData({ _themeClass: 'theme-dark' });
  } else if (actualTheme === 'light') {
    page.setData({ _themeClass: 'theme-light' });
  } else {
    page.setData({ _themeClass: '' });
  }

  // 状态栏前景色随主题：浅色模式黑字（浅绿渐变上），深色模式白字（深绿渐变上）
  try {
    const effective = actualTheme === 'light' || actualTheme === 'dark'
      ? actualTheme
      : getEffectiveTheme();
    wx.setNavigationBarColor({
      frontColor: effective === 'light' ? '#000000' : '#ffffff',
      backgroundColor: effective === 'light' ? '#F7F8FA' : '#121212',
      fail: () => { /* 自定义导航下部分端不支持，静默 */ },
    });
  } catch (e) { /* 静默 */ }
}

function getEffectiveTheme() {
  const themeName = getTheme();
  if (themeName === 'auto') {
    try {
      const sysInfo = wx.getSystemInfoSync();
      return sysInfo.theme === 'light' ? 'light' : 'dark';
    } catch (error) {
      return 'dark';
    }
  }
  return themeName;
}

function getThemeList() {
  return [
    { key: 'auto', label: '跟随系统' },
    { key: 'light', label: '浅色' },
    { key: 'dark', label: '深色' },
  ];
}

function getTheme() {
  // 未设置过主题时默认跟随系统（2026-10-23 产品调整）
  return storage.get('theme') || 'auto';
}

function setTheme(themeName) {
  storage.set('theme', themeName);
  apply(themeName);
  
  const app = getApp();
  if (app) {
    app.globalData.theme = themeName;
  }
}

module.exports = { apply, getEffectiveTheme, getThemeList, getTheme, setTheme, getThemeClass, getFontSizeClass, syncStatusBar };
