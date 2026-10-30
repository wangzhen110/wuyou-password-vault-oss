// pages/profile-edit 编辑个人资料
// 微信官方「头像昵称填写能力」标准形态：独立页面 + form 收集
// （页面形态下键盘弹出时 adjust-position 自动生效，输入框不被遮挡，昵称快捷填入可靠出现）
const app = getApp();
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');

Page({
  data: {
    themeClass: '',
    isFirst: false,
    nickName: '',
    avatarFileId: '',
    draftAvatarPath: '',
    saving: false,
  },

  onLoad(options) {
    // 首次注册引导模式：注册成功后先进本页完善资料（可跳过），完成/跳过后进主页
    const isFirst = !!(options && options.first === '1');
    this._inviteCode = (options && options.invite_code) || '';
    this._fromFirst = isFirst;
    const user = (app.globalData && app.globalData.userInfo) || storage.get('user_info') || {};
    this.setData({
      isFirst,
      themeClass: theme.getThemeClass(),
      nickName: typeof user.nick_name === 'string' ? user.nick_name : '',
      avatarFileId: typeof user.avatar_file_id === 'string' ? user.avatar_file_id : '',
    });
  },

  /** 进主页（携带首次注册的邀请码参数，保持 verify_invite 自动绑定链路） */
  _goHome() {
    const url = this._inviteCode
      ? '/pages/index/index?invite_code=' + encodeURIComponent(this._inviteCode)
      : '/pages/index/index';
    wx.reLaunch({ url });
  },

  onSkip() {
    this._goHome();
  },

  /** 微信头像选择：拿到本地临时路径，保存时上传 */
  onChooseAvatar(e) {
    const path = e && e.detail && e.detail.avatarUrl;
    if (path) this.setData({ draftAvatarPath: path });
  },

  onNickInput(e) {
    this._nick = e.detail.value;
  },

  /** form submit 收集（官方推荐：避免 onBlur 安全检测清空导致的丢值） */
  async onProfileSave(e) {
    if (this.data.saving) return;
    const formValue = e && e.detail && e.detail.value ? e.detail.value.nickname : '';
    const nickName = String(formValue || this._nick || this.data.nickName || '').trim();
    if (nickName.length < 1 || nickName.length > 20) {
      wx.showToast({ title: '昵称需 1-20 个字', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      let avatarFileId = this.data.avatarFileId;
      // 有新选头像才上传，避免每次保存都占存储
      if (this.data.draftAvatarPath) {
        const openid = (app.globalData && app.globalData.openid) || 'user';
        const cloudPath = `avatars/${openid}_${Date.now()}.png`;
        const uploaded = await wx.cloud.uploadFile({ cloudPath, filePath: this.data.draftAvatarPath });
        avatarFileId = uploaded.fileID;
      }
      const res = await wx.cloud.callFunction({
        name: 'sync',
        data: { action: 'update_profile', profile: { nick_name: nickName, avatar_file_id: avatarFileId } },
      });
      const result = res && res.result;
      if (!result || !result.success) throw new Error((result && result.error) || 'SAVE_FAILED');

      if (app.globalData && app.globalData.userInfo) {
        app.globalData.userInfo.nick_name = nickName;
        app.globalData.userInfo.avatar_file_id = avatarFileId;
        storage.set('user_info', app.globalData.userInfo);
      }
      this.setData({ saving: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      // 首次引导模式：保存后进主页；账户页入口：返回上一页
      if (this._fromFirst) {
        setTimeout(() => this._goHome(), 600);
      } else {
        setTimeout(() => wx.navigateBack(), 600);
      }
    } catch (error) {
      console.error('[profile-edit] 保存资料失败:', error && error.message ? error.message : error);
      this.setData({ saving: false });
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },
});
