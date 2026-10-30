const app = getApp();
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');
const member = require('../../utils/member');

Page({
  data: {
    themeClass: '',
    nickName: '',
    avatarFileId: '',
    isVip: false,
    vipExpireText: '',
    freeCapacity: 10,
    inviteCapacity: 0,
    paidCapacity: 0,
    permanentCapacity: 10,
    memberCapacity: 500,
    effectiveCapacity: 10,
    usedCount: 0,
    remainCount: 10,
    usedPercent: 0,
    topPlaceholderHeight: 96,
    saving: false,
    inviteCode: '',
    inviteCount: 0,
    wechatTail: '',
  },

  onLoad() {
    // 顶部占位 = 状态栏高度 + 胶囊高度 + 间距（全面屏/普通机自适应，避免与胶囊重叠）
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
      const statusBar = (win && win.statusBarHeight) || 24;
      let navHeight = 44; // 默认导航行高
      if (menu && menu.top && menu.height) {
        // 胶囊上沿到状态栏下沿的间隙 + 胶囊高 + 下间隙
        navHeight = (menu.top - statusBar) * 2 + menu.height;
      }
      this.setData({ topPlaceholderHeight: statusBar + navHeight });
    } catch (e) {
      this.setData({ topPlaceholderHeight: 96 });
    }
  },

  onShow() {
    this.setData({
      themeClass: theme.getThemeClass ? theme.getThemeClass() : '',
    });
    this.refresh();
  },

  refresh() {
    const ent = member.getUserEntitlement();
    const user = (app.globalData && app.globalData.userInfo) || storage.get('user_info') || {};

    // 本地条目数（不解密，只统计；条目含软删除标记的要过滤）
    let usedCount = 0;
    const records = storage.get('passwords');
    if (Array.isArray(records)) {
      usedCount = records.filter((r) => r && r.is_deleted !== true).length;
    }

    const remain = Math.max(0, ent.effectiveCapacity - usedCount);
    this.setData({
      nickName: typeof user.nick_name === 'string' ? user.nick_name : '',
      avatarFileId: typeof user.avatar_file_id === 'string' ? user.avatar_file_id : '',
      inviteCode: app.globalData.inviteCode
        || (typeof user.invite_code === 'string' ? user.invite_code : '')
        || storage.get('invite_code') || '',
      inviteCount: Number(user.invite_count) || 0,
      isVip: ent.isVip,
      vipExpireText: ent.vipExpireText || '',
      freeCapacity: ent.freeCapacity,
      inviteCapacity: ent.inviteCapacity,
      paidCapacity: ent.paidCapacity,
      permanentCapacity: ent.permanentCapacity,
      memberCapacity: ent.memberCapacity,
      effectiveCapacity: ent.effectiveCapacity,
      usedCount: usedCount,
      remainCount: remain,
      usedPercent: ent.effectiveCapacity > 0
        ? Math.min(100, Math.round((usedCount / ent.effectiveCapacity) * 100))
        : 0,
      // 微信身份尾号：登录是静默完成的，显式展示增强"微信账号已登录"感知
      wechatTail: typeof (app.globalData && app.globalData.verifiedOpenid) === 'string'
        && app.globalData.verifiedOpenid.length >= 4
        ? app.globalData.verifiedOpenid.slice(-4)
        : '',
    });
  },

  /** 复制邀请码 */
  onCopyInviteCode() {
    const code = this.data.inviteCode;
    if (!code) { wx.showToast({ title: '邀请码加载中', icon: 'none' }); return; }
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  /** 点资料卡 → 进入「编辑资料」页（官方头像昵称填写形态，独立页面无键盘遮挡问题） */
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' });
  },
});
