/**
 * 页面主题初始化的唯一实现（2026-10-23 收敛自 11 个页面的重复代码）。
 * 用法：
 *   const pageTheme = require('../../utils/page-theme');
 *   // data 里：...pageTheme.themeData()
 *   // onLoad/onShow 里：pageTheme.apply(this)
 */
const theme = require('./theme');

/** 页面 data 的主题初始值：模块加载时即求值，首帧渲染前生效（避免主题闪烁） */
function themeData() {
  return { themeClass: theme.getThemeClass() };
}

/** 把当前主题应用到页面实例；extra 可附带页面自己的字段（如 themeLabel） */
function apply(pageInstance, extra) {
  pageInstance.setData({
    themeClass: theme.getThemeClass(),
    ...(extra || {}),
  });
}

module.exports = { themeData, apply };
