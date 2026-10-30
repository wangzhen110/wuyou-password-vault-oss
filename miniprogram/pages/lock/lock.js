// pages/lock 锁屏页面
const app = getApp();
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');

Page({
  data: {
    topBarHeight: 70,
    isFirstTime: false,
    unlocked: false,
    themeClass: '',
    masterHint: '',
    forceUpdate: false,
    version: require('../../config').VERSION
  },

  onLoad(options) {
    // 被邀请进入：暂存邀请码，等主密码创建完成后由首页完成绑定
    if (options && options.invite_code) {
      storage.set('pending_invite_code', options.invite_code);
    }
    // 小程序码扫码进入：邀请码在 scene 参数中（2026-10-24 邀请卡片）
    if (options && options.scene) {
      try {
        const scene = decodeURIComponent(options.scene).trim().toUpperCase();
        if (/^[A-Z0-9]{6}$/.test(scene)) storage.set('pending_invite_code', scene);
      } catch (e) { /* scene 非法则忽略 */ }
    }
    // 换设备恢复探测：本地无密码库但云端有 → 进入「恢复模式」（输入原主密码），
    // 而不是误导用户创建新主密码（新主密码解不开云端旧密文）
    this._detectCloudVault();
    const isFirst = !storage.hasMasterPassword();
    // 主题：跟随系统（auto 时按系统深浅解析）或用户固定设置；onThemeChange 广播会实时更新 data.themeClass 并透传组件
    const currentTheme = theme.getTheme();
    const themeClass = 'theme-' + (currentTheme === 'auto' ? theme.getEffectiveTheme() : currentTheme);
    this.setData({ isFirstTime: isFirst, themeClass });

    // 如果已解锁，直接跳转（reLaunch 才能跳 tabBar 页面，redirectTo 会静默失败）
    if (!isFirst && !app.globalData.isLocked) {
      // 老用户点开邀请卡片：把邀请码带过去自动绑定（否则热启动参数会丢）
      const carried = options && options.invite_code
        ? '?invite_code=' + encodeURIComponent(options.invite_code)
        : '';
      wx.reLaunch({ url: '/pages/index/index' + carried });
    }
  },

  /** 登录完成后查询云端是否有密码库；有则让锁屏进入恢复模式 */
  onShow() {
    theme.syncStatusBar();
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const topH = (win.statusBarHeight || 20) + 50;
      if (this.data.topBarHeight !== topH) this.setData({ topBarHeight: topH });
    } catch (e) { /* 保持默认 */ }
    // 主密码提示：登录后由 user_info 缓存带入（云端 users.master_hint）
    try {
      const userInfo = require('../../utils/storage').get('user_info') || {};
      this.setData({ masterHint: typeof userInfo.master_hint === 'string' ? userInfo.master_hint : '' });
    } catch (e) { /* 缓存读取失败按无提示处理 */ }
    this._consumeEnterScene();
    this._syncForceUpdate();
  },

  /**
   * 版本门禁：storage.js 收到云端 VERSION_TOO_OLD 时会把 globalData.forceUpdate 置真，
   * 锁屏页负责把它渲染成遮罩（此前只设标志、无人消费，遮罩永远不出现）。
   */
  _syncForceUpdate() {
    const flagged = !!(app && app.globalData && app.globalData.forceUpdate);
    if (flagged && !this.data.forceUpdate) this.setData({ forceUpdate: true });
  },

  /** 强制更新遮罩点击：有已下载更新则立即重启，否则引导用户手动重进小程序 */
  onForceUpdateTap() {
    const um = typeof wx.getUpdateManager === 'function' ? wx.getUpdateManager() : null;
    if (um && typeof um.applyUpdate === 'function') {
      try { um.applyUpdate(); } catch (e) { /* 无已下载更新时忽略，走下方引导 */ }
    }
    wx.showModal({
      title: '请手动更新',
      content: '请彻底退出小程序后重新打开；若仍提示版本过旧，请在微信「发现 - 小程序」中删除后重新进入。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /**
   * 消费「本次进入」携带的小程序码 scene（=邀请码）。
   * 热启动（小程序在后台时被扫码调起）不会重新执行 onLoad，scene 只能从 getEnterOptionsSync 获取，
   * 否则扫码邀请会静默失效（2026-10-24 用户实测暴露）。
   */
  _consumeEnterScene() {
    try {
      if (typeof wx.getEnterOptionsSync !== 'function') return;
      const opts = wx.getEnterOptionsSync();
      const raw = opts && opts.query && opts.query.scene;
      if (!raw) return;
      const code = decodeURIComponent(raw).trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return;
      if (storage.get('pending_invite_code') !== code) {
        storage.set('pending_invite_code', code);
      }
    } catch (e) {
      console.error('[lock] 解析进入场景失败:', e);
    }
  },

  async _detectCloudVault() {
    const app = getApp();
    // 等 login 出结果（最多 15s）；离线时按本地状态，联网后可重进
    for (let i = 0; i < 30; i++) {
      if (app.globalData.verifiedOpenid || app.globalData.offlineMode) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!app.globalData.verifiedOpenid) return;   // 仍离线：无法查云端
    if (storage.hasMasterPassword()) return;      // 本地已有库：正常解锁流程

    try {
      const remoteMeta = await storage.getRemoteVaultMeta();
      if (!remoteMeta) return;                    // 云端也没有：真正的首次使用
      app.globalData._pendingRemoteMeta = remoteMeta;
      const lockScreen = this.selectComponent('#lockScreen');
      if (lockScreen && typeof lockScreen.setRecoveryMode === 'function') {
        lockScreen.setRecoveryMode(remoteMeta);
      }
    } catch (error) {
      console.warn('[lock] 云端密码库探测失败:', error && error.message ? error.message : error);
    }
  },

  onUnlock(e) {
    console.log('[lock-page] onUnlock called, hasMasterKey=' + !!(e.detail && e.detail.masterKey));
    const { masterKey } = e.detail || {};
    if (!masterKey) {
      console.log('[lock-page] ERROR: no masterKey in event detail');
      return;
    }
    // 存储主密钥到全局（仅内存，不持久化）
    app.unlockApp(masterKey);
    storage.setLockState(false);
    // index 是 tabBar 页，必须 reLaunch（redirectTo 会静默失败，铁律 3）
    wx.reLaunch({ url: '/pages/index/index' });
  }
});
