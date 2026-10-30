/**
 * 云同步模块 V3.1
 * 支持登录后自动同步 + 手动触发同步
 * 安全处理：getApp() 可能尚未就绪
 */

const storage = require('./storage');

let _syncing = false;

function _getApp() {
  try {
    return getApp();
  } catch (e) {
    return null;
  }
}

/**
 * 自动同步（app.js onShow 调用）
 */
/** 自动同步最小间隔：1 小时（2026-10-24 用户要求：登录强制一次，其后每小时一次） */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
let _lastAutoSyncAt = 0;

/**
 * 定时间隔同步：距上次自动同步不足 1 小时直接跳过。
 * 用于 app.onShow 与前台每小时定时器（小程序在后台时定时器会被挂起，故两处共用同一判定）。
 */
function intervalSync() {
  if (_syncing) return Promise.resolve({ skipped: true });
  const now = Date.now();
  if (_lastAutoSyncAt && now - _lastAutoSyncAt < SYNC_INTERVAL_MS) {
    return Promise.resolve({ skipped: true });
  }
  _lastAutoSyncAt = now;
  return autoSync();
}

/** 强制同步：登录成功后调用，忽略 1 小时间隔限制 */
function forceSync() {
  _lastAutoSyncAt = Date.now();
  return autoSync();
}

function autoSync() {
  if (!storage.canSync()) {
    return Promise.resolve({ success: false, error: '身份未验证或密码库同步已隔离' });
  }
  
  if (_syncing) {
    return Promise.resolve();
  }
  
  return new Promise((resolve) => {
    _syncing = true;
    
    storage.syncFromCloud((result) => {
      _syncing = false;
      if (result && result.success) {
        console.log('[sync] 自动同步完成, 数量:', result.count);
      }
      resolve(result);
    });
  });
}

/**
 * 手动触发同步（设置页调用）
 */
function manualSync(callback) {
  const app = _getApp();
  if (!storage.canSync()) {
    const error = app && app.globalData && app.globalData.openid
      ? '当前密码库同步已隔离'
      : '请先登录';
    wx.showToast({ title: error, icon: 'none' });
    if (callback) callback({ success: false, error });
    return;
  }
  
  wx.showLoading({ title: '同步中...' });
  
  storage.syncFromCloud((result) => {
    wx.hideLoading();
    if (result && result.success) {
      wx.showToast({ title: '同步完成', icon: 'success' });
    } else {
      wx.showToast({ title: '同步失败', icon: 'none' });
    }
    if (callback) callback(result);
  });
}

module.exports = {
  autoSync,
  manualSync,
  intervalSync,
  forceSync
};
