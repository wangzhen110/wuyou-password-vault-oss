/**
 * utils/feedback.js - 统一交互反馈（P3 交互统一，2026-10-24）
 *
 * 背景：全站 toast 时长/图标不一致（有的 1.5s、有的 3s；成功有时用 success 图标、有时用 none），
 * 失败提示文案长短不一。这里统一收口，新代码直接用；老代码按页面逐步迁移，不做一次性批量替换。
 *
 * 用法：
 *   const fb = require('../../utils/feedback');
 *   fb.success('已保存');            // 成功：✓ 图标，1.8s
 *   fb.fail('保存失败，请重试');      // 失败：✕ 图标（用 error），2.2s
 *   fb.toast('已复制');              // 中性：无图标，1.8s
 *   fb.loading('正在同步…');          // 显示 loading，需手动 hideLoading
 *   fb.hideLoading();
 *   fb.confirm({ title, content })   // 需要用户确认时用（Promise<boolean>）
 */

const TOAST_MS = 1800;
const FAIL_MS = 2200;

/** 中性提示：无图标，适合「已复制」「已刷新」这类轻提示 */
function toast(title, duration) {
  wx.showToast({ title: String(title || ''), icon: 'none', duration: duration || TOAST_MS });
}

/** 成功提示：对勾图标 */
function success(title, duration) {
  wx.showToast({ title: String(title || '操作成功'), icon: 'success', duration: duration || TOAST_MS });
}

/**
 * 失败提示：用 none 图标 + 错误文案。
 * 不用 icon:'error'——部分机型 error 图标文案会截断，纯文字更可控。
 */
function fail(title, duration) {
  wx.showToast({ title: String(title || '操作失败，请重试'), icon: 'none', duration: duration || FAIL_MS });
}

/** 加载中（成对使用 hideLoading） */
function loading(title) {
  wx.showLoading({ title: String(title || '处理中…'), mask: true });
}

function hideLoading() {
  try { wx.hideLoading(); } catch (e) { /* 未显示时忽略 */ }
}

/**
 * 确认弹窗（Promise 化，避免回调嵌套）
 * @returns {Promise<boolean>} 用户点确定 → true
 */
function confirm(options) {
  const opts = options || {};
  return new Promise(resolve => {
    wx.showModal({
      title: opts.title || '提示',
      content: opts.content || '',
      confirmText: opts.confirmText || '确定',
      cancelText: opts.cancelText || '取消',
      showCancel: opts.showCancel !== false,
      confirmColor: opts.confirmColor || '#0e8a4f',
      success: res => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 仅提示（无取消按钮），用于展示不可逆操作结果 */
function alert(content, title) {
  return new Promise(resolve => {
    wx.showModal({
      title: title || '提示',
      content: String(content || ''),
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#0e8a4f',
      complete: () => resolve(true),
    });
  });
}

module.exports = { toast, success, fail, loading, hideLoading, confirm, alert, TOAST_MS, FAIL_MS };
