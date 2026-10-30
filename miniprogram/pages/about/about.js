const config = require('../../config');
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');
const app = getApp();

Page({
  data: {
    version: config.VERSION,
  },

  onLoad() {
    // 阅读一次即视为已读：设置页的「必读」红点随即消失
    try { storage.set('about_read', true); } catch (e) { /* 忽略 */ }
  },

  onShow() {
    // 与全站一致：进入本页时同步状态栏前景色
    theme.syncStatusBar();
  },

  onShareAppMessage() {
    // 转发面板与后续跳转聊天会切出小程序，临时豁免锁定
    if (app && typeof app.holdUnlocked === 'function') app.holdUnlocked();
    return { title: '无忧密码本 · 只记一个密码的密码管家', path: '/pages/lock/lock' };
  },
});
