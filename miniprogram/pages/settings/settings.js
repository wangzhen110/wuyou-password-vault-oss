// 设置：密码库备份、外观、同步与邀请。
const app = getApp();
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');
const member = require('../../utils/member');
const sync = require('../../utils/sync');
const exportUtil = require('../../utils/export');
const importer = require('../../utils/import');

Page({
  data: {
    topBarHeight: 70,
    version: require('../../config').VERSION,
    lastBackupText: '',
    pickupModal: { visible: false, url: '', filename: '' },
    themeClass: '',
    inviteCode: '',
    inviteCount: 0,
    invitePercent: 0,
    inviteCapacity: 0,
    canInvite: true,
    isVip: false,
    vipExpireText: '',
    themeLabel: '深色',
    syncBusy: false,
    syncStatus: '检测中',
    syncDetail: '',
    aboutRead: false,
    syncOnline: false,
    inviteLoading: false,
    changePwdDialog: { visible: false, busy: false, error: '' },
    backupDialog: { visible: false, busy: false, error: '' },
    importDialog: { visible: false, busy: false, error: '' },
    inviteDialog: { visible: false, busy: false, error: '' },
    hintDialog: { visible: false, busy: false, error: '' },
    hintFields: [{ key: 'masterHint', label: '主密码提示', placeholder: '一句只有你懂的话（不含密码本身），最多 200 字', multiline: true, maxlength: 200 }],
    changePwdFields: [
      { key: 'oldPassword', label: '当前主密码', placeholder: '请输入当前主密码', password: true },
      { key: 'newPassword', label: '新主密码', placeholder: '至少 6 位', password: true },
      { key: 'confirmPassword', label: '确认新主密码', placeholder: '再次输入新主密码', password: true },
    ],
    backupFields: [
      { key: 'filePassword', label: '备份文件密码', placeholder: '至少 8 位（12 位以下需字母+数字）', password: true },
    ],
    importFields: [
      { key: 'filePassword', label: '备份文件密码', placeholder: '请输入该文件的密码', password: true },
    ],
    // 个人资料
    nickName: '',
    avatarFileId: '',
    inviteFields: [
      { key: 'inviteCode', label: '邀请码', placeholder: '输入好友的邀请码', password: false },
    ],
  },

  onLoad() {
    // 主题初始化在 onShow 统一处理（onShow 必在 onLoad 后执行，不再重复 setData）
  },

  onShow() {
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const topH = (win.statusBarHeight || 20) + 50;
      if (this.data.topBarHeight !== topH) this.setData({ topBarHeight: topH });
    } catch (e) { /* 保持默认 */ }
    this.setData({
      themeClass: theme.getThemeClass(),
      themeLabel: this._themeLabel(theme.getTheme()),
      // 「必读」未读状态：读过产品介绍后红点消失（从产品介绍页返回时刷新）
      aboutRead: typeof storage.get === 'function' ? !!storage.get('about_read') : false,
    });

    // tab-bar 组件在页面 DOM 外，pageLifetimes 不可靠，页面 show 时主动同步主题
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      // 必须同步选中项，否则切到设置页后底部仍高亮「密码」，看着像点击没反馈
      if (typeof tabBar.setData === 'function') tabBar.setData({ selected: 1 });
      if (typeof tabBar.refreshTheme === 'function') tabBar.refreshTheme();
    }

    // 会员状态
    const ent = member.getUserEntitlement();
    let vipExpireText = '';
    if (ent.vipExpireAt) {
      const d = new Date(ent.vipExpireAt);
      vipExpireText = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }
    this.setData({ isVip: ent.isVip, vipExpireText });
    this._loadProfile();
    this._loadLastBackup();
    this._refreshSyncState();

    // 加载邀请信息
    this._loadInviteInfo();
  },

  /** 读取本地缓存的个人资料 */
  /** 刷新联网与同步状态：让用户随时知道"现在是离线还是在线、有没有同步成功" */
  _refreshSyncState() {
    const app = getApp();
    const g = (app && app.globalData) || {};
    // 同步被「换账号保护」阻断时，必须让用户看见，否则会误以为已同步
    const diag = typeof storage.getSyncDiagnostics === 'function' ? storage.getSyncDiagnostics() : null;
    this._syncDiag = diag;
    if (diag && diag.blocked) {
      const pendingText = diag.pendingCount > 0 ? `${diag.pendingCount} 条待同步，点此修复` : '已暂停，点此修复';
      this.setData({ syncStatus: '待修复', syncDetail: pendingText, syncOnline: false });
      return;
    }
    const offline = !!g.offlineMode;
    const syncedAt = Number((g.userInfo && g.userInfo._synced_at) || 0);
    if (offline) {
      this.setData({ syncStatus: '离线', syncDetail: '数据仅存本机', syncOnline: false });
      return;
    }
    if (syncedAt) {
      const d = new Date(syncedAt);
      const pad = n => (n < 10 ? '0' + n : String(n));
      let detail = `上次同步 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      // 附加最近一次云端/本地一致性检测结果（放在副文案，避免右侧被撑破）
      const lastCheck = typeof storage.get === 'function' ? storage.get('last_consistency') : null;
      if (lastCheck && lastCheck.checked_at) {
        detail += lastCheck.status === 'meta_mismatch' ? ' · 参数不一致' : ' · 一致性正常';
      }
      this.setData({ syncStatus: '已连接', syncDetail: detail, syncOnline: true });
      return;
    }
    this.setData({ syncStatus: '已连接', syncDetail: '', syncOnline: true });
  },

  /** 最近一次备份：显示文件名与查找位置，解决"备份完不知道文件去哪了" */
  _loadLastBackup() {
    let record = null;
    try {
      record = typeof storage.get === 'function' ? storage.get('last_backup') : null;
    } catch (error) {
      record = null;
    }
    if (!record || !record.file_name) {
      this.setData({ lastBackup: null, lastBackupText: '' });
      return;
    }
    const d = new Date(record.created_at || 0);
    const pad = n => (n < 10 ? '0' + n : String(n));
    const time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const MODE_TEXT = {
      cloudlink: '已生成取件链接',
      disk: '已保存到本机',
      clipboard: '已复制到剪贴板',
      failed: '生成失败',
    };
    const where = MODE_TEXT[record.mode] || '已生成';
    this.setData({
      lastBackup: record,
      lastBackupText: `上次备份 ${time} · ${where}`,
    });
  },

  _loadProfile() {
    const app = getApp();
    const cached = typeof storage.get === 'function' ? storage.get('user_info') : null;
    const user = (app && app.globalData && app.globalData.userInfo) || cached || {};
    const nickName = typeof user.nick_name === 'string' ? user.nick_name : '';
    const avatarFileId = typeof user.avatar_file_id === 'string' ? user.avatar_file_id : '';
    this.setData({
      nickName,
      avatarFileId,
      // 无头像时用昵称首字兜底（去掉"匿名同修"这种前缀）
    });
  },

  /** 进入「我的账户」：容量明细 + 会员状态 */
  onGoAccount() {
    wx.navigateTo({ url: '/pages/account/account' });
  },


  _loadInviteInfo() {
    if (this.data.inviteLoading) return;
    this.setData({ inviteLoading: true });
    wx.cloud.callFunction({
      name: 'invite',
      data: { action: 'get_invite_info' },
      success: (res) => {
        if (res.result && res.result.success) {
          const count = Number(res.result.invite_count) || 0;
          this.setData({
            inviteCode: res.result.invite_code,
            inviteCount: count,
            canInvite: res.result.can_invite,
            invitePercent: Math.min(100, Math.round((count / 3) * 100)),
            inviteLoading: false,
          });
        } else {
          this.setData({ inviteLoading: false });
        }
      },
      fail: () => this.setData({ inviteLoading: false }),
    });
  },

  _themeLabel(themeName) {
    const option = theme.getThemeList().find(item => item.key === themeName);
    return option ? option.label : '深色';
  },

  _showDialog(method, options) {
    if (this._dialogBusy) return;
    this._dialogBusy = true;
    try {
      wx[method]({
        ...options,
        success: async result => {
          try {
            if (options.success) return await options.success(result);
          } finally {
            this._dialogBusy = false;
          }
        },
        fail: error => {
          this._dialogBusy = false;
          if (options.fail) options.fail(error);
        },
      });
    } catch (error) {
      this._dialogBusy = false;
      wx.showToast({ title: '窗口打开失败，请重试', icon: 'none' });
    }
  },

  _setThemeClass(themeName) {
    const effectiveTheme = themeName === 'auto' && typeof theme.getEffectiveTheme === 'function'
      ? theme.getEffectiveTheme()
      : themeName;
    this.setData({ themeClass: `theme-${effectiveTheme}` });
  },

  onTheme() {
    const options = theme.getThemeList();
    this._showDialog('showActionSheet', {
      itemList: options.map(item => item.label),
      success: (res) => {
        const selected = options[res.tapIndex];
        if (!selected) return;
        theme.setTheme(selected.key);
        this._setThemeClass(selected.key);
        this.setData({ themeLabel: selected.label });
        // 当前页的 tab-bar 立即跟随主题
        if (typeof this.getTabBar === 'function' && this.getTabBar()) {
          const tabBar = this.getTabBar();
          if (typeof tabBar.refreshTheme === 'function') tabBar.refreshTheme();
        }
      },
    });
  },

  /** 提取同步失败的简短原因，供状态栏展示 */
  _syncErrorText(error) {
    const raw = error && error.message ? error.message : (typeof error === 'string' ? error : '');
    if (!raw) return '请检查网络后重试';
    if (/身份未确认|同步已隔离/.test(raw)) return '身份未确认（未登录或已离线）';
    if (/加密参数不一致/.test(raw)) return '云端与本地加密参数不一致';
    if (/network|timeout|fail/i.test(raw)) return '网络连接失败，请稍后重试';
    return raw.length > 20 ? raw.slice(0, 20) + '…' : raw;
  },

  onManualSync() {
    const diag = (typeof storage.getSyncDiagnostics === 'function')
      ? storage.getSyncDiagnostics()
      : null;
    if (diag && diag.blocked) {
      wx.showModal({
        title: '恢复同步',
        content: '本机密码库此前绑定的是另一个微信账号，为防止串号已暂停同步。\n\n如果你确认这台手机上的密码库属于当前账号，可重新绑定并恢复同步；否则请先导出备份再切换账号。',
        confirmText: '恢复绑定',
        cancelText: '暂不处理',
        success: (res) => {
          if (!res.confirm) return;
          const adopted = storage.adoptLocalVaultToCurrentUser();
          if (!adopted || !adopted.ok) {
            wx.showToast({ title: '恢复失败，请重试', icon: 'none' });
            return;
          }
          this._refreshSyncState();
          wx.showToast({ title: '已恢复同步', icon: 'success' });
          setTimeout(() => this._doManualSync(), 300);
        },
      });
      return;
    }
    this._doManualSync();
  },

  /** 真正执行一次手动同步（原 onManualSync 逻辑） */
  _doManualSync() {
    if (this.data.syncBusy && this._syncPromise) return this._syncPromise;

    let resolveSync;
    let rejectSync;
    const operation = new Promise((resolve, reject) => {
      resolveSync = resolve;
      rejectSync = reject;
    });
    this._syncPromise = operation;
    this.setData({ syncBusy: true, syncStatus: '同步中', syncDetail: '正在与云端同步数据' });

    try {
      sync.manualSync((result) => {
        const success = !!(result && result.success);
        // 失败时透出具体原因（如"身份未确认""加密参数不一致"），不再笼统显示"同步失败"
        const reason = success ? '' : this._syncErrorText(result && result.error);
        this.setData({
          syncBusy: false,
          syncStatus: success ? '刚刚同步' : '失败',
          syncDetail: success ? '所有数据已同步' : reason,
        });
        if (this._syncPromise === operation) this._syncPromise = null;
        resolveSync(result);
      });
    } catch (error) {
      this.setData({ syncBusy: false, syncStatus: '失败', syncDetail: '点击重试' });
      if (this._syncPromise === operation) this._syncPromise = null;
      rejectSync(error);
    }
    return operation;
  },

  /** 清空云端数据（不可逆）：二次确认 → 服务端删除 → 清本机 → 回锁屏 */
  onPurgeCloud() {
    wx.showModal({
      title: '清空云端数据',
      content: '将永久删除云端备份与本机全部密码条目，且无法恢复。确定继续？',
      confirmText: '继续',
      confirmColor: '#E54D42',
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '删除后无法找回，包括会员与邀请获得的容量记录（已购买订单仍保留在服务端用于对账）。',
          confirmText: '确认删除',
          confirmColor: '#E54D42',
          success: async (second) => {
            if (!second.confirm) return;
            wx.showLoading({ title: '正在删除...', mask: true });
            try {
              const res = await wx.cloud.callFunction({
                name: 'sync',
                data: { action: 'purge_vault', confirm: 'DELETE_MY_VAULT' },
              });
              const result = res && res.result;
              if (!result || !result.success) {
                throw new Error((result && result.error) || 'PURGE_FAILED');
              }
              storage.clearAllLocalData && storage.clearAllLocalData();
              wx.hideLoading();
              wx.showToast({ title: '云端与本机数据已清空', icon: 'none' });
              setTimeout(() => {
                wx.reLaunch({ url: '/pages/lock/lock' });
              }, 1200);
            } catch (error) {
              wx.hideLoading();
              console.error('[settings] purge failed:', error && error.message ? error.message : error);
              wx.showToast({ title: '删除失败，请稍后重试', icon: 'none' });
            }
          },
        });
      },
    });
  },

  onChangePassword() {
    const masterKey = app.globalData.masterKey;
    if (!masterKey || app.globalData.isLocked) {
      wx.showToast({ title: '请先解锁密码本', icon: 'none' });
      return;
    }
    // 通用输入弹窗（comp-input-dialog）：真 placeholder、宽输入框。
    this.setData({ changePwdDialog: { visible: true, busy: false, error: '' } });
  },

  onPwdClose() {
    if (this.data.changePwdDialog.busy) return;
    this.setData({ 'changePwdDialog.visible': false, 'changePwdDialog.error': '' });
  },

  onHintOpen() {
    const hint = (app.globalData.userInfo && app.globalData.userInfo.master_hint) || '';
    this.setData({
      hintDialog: { visible: true, busy: false, error: '' },
      hintFields: [{ key: 'masterHint', label: '主密码提示', placeholder: '一句只有你懂的话（不含密码本身），最多 200 字', value: hint, multiline: true, maxlength: 200 }],
    });
  },

  onHintClose() {
    this.setData({ 'hintDialog.visible': false });
  },

  async onHintConfirm(event) {
    const values = (event.detail && event.detail.values) || {};
    const hint = String(values.masterHint || '').trim();
    if (hint.length > 200) {
      this.setData({ 'hintDialog.error': '提示最多 200 字' });
      return;
    }
    this.setData({ 'hintDialog.busy': true, 'hintDialog.error': '' });
    try {
      const res = await new Promise(resolve => {
        wx.cloud.callFunction({
          name: 'sync',
          data: { action: 'set_master_hint', hint },
          success: r => resolve(r.result || { success: false }),
          fail: () => resolve({ success: false, error: '网络错误' }),
        });
      });
      if (!res.success) throw new Error(res.error || '保存失败');
      if (app.globalData.userInfo) app.globalData.userInfo.master_hint = hint;
      const cached = storage.get('user_info') || {};
      cached.master_hint = hint;
      storage.set('user_info', cached);
      this.setData({ 'hintDialog.visible': false, 'hintDialog.busy': false });
      wx.showToast({ title: hint ? '已保存' : '已清除', icon: 'success' });
    } catch (error) {
      this.setData({ 'hintDialog.busy': false, 'hintDialog.error': (error && error.message) || '保存失败' });
    }
  },

  async onPwdConfirm(event) {
    const values = (event.detail && event.detail.values) || {};
    const oldPassword = values.oldPassword || '';
    const newPassword = values.newPassword || '';
    if (this.data.changePwdDialog.busy) return;
    if (!oldPassword) {
      this.setData({ 'changePwdDialog.error': '请输入当前主密码' });
      return;
    }
    if (newPassword.length < 6) {
      this.setData({ 'changePwdDialog.error': '新主密码至少需要 6 位' });
      return;
    }
    if (values.confirmPassword !== newPassword) {
      this.setData({ 'changePwdDialog.error': '两次输入的新主密码不一致' });
      return;
    }
    const sessionKey = app.globalData.masterKey;
    this.setData({ 'changePwdDialog.busy': true, 'changePwdDialog.error': '' });
    try {
      const result = await storage.changeMasterPassword(oldPassword, newPassword);
      if (!result.success) {
        this.setData({ 'changePwdDialog.busy': false, 'changePwdDialog.error': result.error || '修改未完成，密码库未更改' });
        return;
      }
      // 会话密钥同步换成新密钥，避免认领校验用旧密钥
      if (app.globalData.masterKey === sessionKey) {
        app.globalData.masterKey = result.masterKey;
      }
      this.setData({ 'changePwdDialog.visible': false, 'changePwdDialog.busy': false });
      wx.showToast({ title: '主密码已修改，正在同步', icon: 'success' });
      this.onManualSync();
    } catch (error) {
      this.setData({ 'changePwdDialog.busy': false, 'changePwdDialog.error': '修改失败，请重试' });
    }
  },

  /** 上次备份时间的人性化描述（设置页 cell 副文案） */
  _formatLastBackup(record) {
    if (!record || !record.created_at) return '尚未备份';
    const days = Math.floor((Date.now() - record.created_at) / 86400000);
    if (days <= 0) return '今天已备份';
    if (days === 1) return '昨天已备份';
    if (days < 30) return `${days} 天前已备份`;
    return `${Math.floor(days / 30)} 个月前已备份`;
  },

  async onBackup() {
    const masterKey = app.globalData.masterKey;
    if (!masterKey || app.globalData.isLocked) {
      wx.showToast({ title: '请先解锁密码本', icon: 'none' });
      return;
    }
    // 生成备份需加密+上传+云端登记，真机约 5 秒：先给即时反馈，避免用户以为卡死
    wx.showLoading({ title: '正在加密链接', mask: true });
    try {
      await this._doExport(masterKey);
    } finally {
      wx.hideLoading();
    }
  },

  noop() {},

  onCopyPickupLink() {
    const url = this.data.pickupModal && this.data.pickupModal.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'success' }),
    });
  },

  onClosePickupModal() {
    this.setData({ 'pickupModal.visible': false });
  },

  onAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  onBackupClose() {
    if (this.data.backupDialog.busy) return;
    this.setData({ 'backupDialog.visible': false, 'backupDialog.error': '' });
  },

  async _doExport(masterKey) {
    this.setData({ backupDialog: { visible: false, busy: true, error: '' } });
    try {
      if (app.globalData.isLocked || app.globalData.masterKey !== masterKey) {
        throw new Error('密码本已锁定，请重新解锁后备份');
      }
      if (typeof exportUtil.exportEncrypted !== 'function') {
        throw new Error('加密导出不可用');
      }
      const passwords = (await storage.getAllPasswords(masterKey))
        .filter(p => !p.is_deleted);
      const json = typeof exportUtil.exportJSON === 'function'
        ? exportUtil.exportJSON(passwords, {})
        : JSON.stringify(passwords);
      // 备份密码=主密码（加密强度同主密码库：PBKDF2 60 万次）
      const masterPassword = storage.getMasterPassword();
      if (!masterPassword) throw new Error('请先使用主密码解锁密码本后再备份');
      // 旧版设置的主密码可能不足 8 位（4.2.9 强度策略之前）：引导升级而不是报错
      if (masterPassword.length < 8) {
        throw new Error('您的主密码不足 8 位，无法生成安全备份。请先在「修改主密码」中升级主密码（至少 8 位）后再导出');
      }
      const encrypted = await exportUtil.exportEncrypted(json, masterPassword);
      // meta（salt/iterations/verifier）在备份 JSON 内：取件登记用（下载页凭主密码校验）
      let backupMeta = null;
      try { backupMeta = (JSON.parse(encrypted) || {}).meta || null; } catch (e) { backupMeta = null; }
      if (typeof encrypted !== 'string' || !encrypted) {
        throw new Error('加密导出结果无效');
      }

      const filename = `password-vault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.pwma`;
      const filePath = exportUtil.saveToFile(encrypted, filename);

      let saved = { mode: 'share' };
      if (typeof exportUtil.saveBackupFile === 'function') {
        saved = await exportUtil.saveBackupFile(filePath, filename, backupMeta);
      } else {
        await Promise.resolve(exportUtil.shareFile(filePath));
      }

      const backupRecord = {
        file_name: filename,
        created_at: Date.now(),
        mode: saved.mode,
      };
      storage.set('last_backup', backupRecord);
      this.setData({
        lastBackup: backupRecord,
        lastBackupText: this._formatLastBackup(backupRecord),
        'backupDialog.visible': false,
        'backupDialog.busy': false,
      });

      if (saved.mode === 'cloudlink' && saved.url) {
        // 取件链接模式（2026-10-23 用户拍板）：品牌自定义弹窗 + 复制按钮
        this.setData({
          pickupModal: { visible: true, url: saved.url, filename },
        });
      } else if (saved.mode === 'clipboard') {
        wx.showModal({
          title: '备份内容已复制到剪贴板',
          content: `文件名：${filename}

当前环境不支持直接保存文件，备份内容已复制到剪贴板：
1. 打开记事本（或任意文本编辑器），粘贴（Ctrl+V）
2. 将文件「另存为」${filename}（保存类型选"所有文件"）

导入时选择该 .pwma 文件，输入主密码即可。`,
          showCancel: false,
          confirmText: '知道了',
        });
      } else if (saved.mode === 'disk') {
        wx.showModal({
          title: '备份已保存',
          content: `文件名：${filename}
保存位置：你刚才在「另存为」里选择的位置。

⚠️ 备份文件已加密保护（密码=主密码），请妥善保管，勿通过不可信渠道传输。`,
          showCancel: false,
          confirmText: '知道了',
        });
      } else {
        // saved.mode 为 failed 或未知：明确告知失败，不再给出"文件传输助手"等已退役路径
        wx.showModal({
          title: '备份未完成',
          content: `文件名：${filename}

备份文件已生成，但当前环境无法交付。请检查网络后重试；
若多次失败，可先把手机连上网络再试一次。`,
          showCancel: false,
          confirmText: '知道了',
        });
      }
    } catch (error) {
      console.error('[backup] 导出失败:', error);
      this.setData({
        backupDialog: { visible: false, busy: false, error: '' },
        'backupDialog.error': (error && error.message) ? error.message : '导出失败，请重试',
      });
      wx.showModal({
        title: '导出失败',
        content: (error && error.message) ? error.message : '导出失败，请重试',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },

  onRestoreBackup() {
    const masterKey = app.globalData.masterKey;
    if (!masterKey || app.globalData.isLocked) {
      wx.showToast({ title: '请先解锁密码本', icon: 'none' });
      return;
    }
    if (this._dialogBusy || this._choosingFile) return;
    this._choosingFile = true;
    // 选文件必然切到后台：临时豁免「切后台立即锁定」，否则选完文件回来已锁、导入中断
    app.globalData.keepUnlocked = true;
    const releaseUnlock = () => {
      setTimeout(() => { try { app.globalData.keepUnlocked = false; } catch (e) {} }, 60 * 1000);
    };
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pwma'],
      success: async (res) => {
        this._choosingFile = false;
        const selected = res.tempFiles && res.tempFiles[0];
        if (!selected || !selected.path || !/\.pwma$/i.test(selected.name || selected.path)) {
          wx.showToast({ title: '请选择 .pwma 加密备份', icon: 'none' });
          return { success: false };
        }
        if (selected.size > 10 * 1024 * 1024) {
          wx.showToast({ title: '备份文件不能超过 10MB', icon: 'none' });
          return { success: false };
        }

        try {
          const content = await new Promise((resolve, reject) => {
            wx.getFileSystemManager().readFile({
              filePath: selected.path,
              encoding: 'utf8',
              success: result => resolve(result.data),
              fail: reject,
            });
          });
          // 预检外层格式（提前到输密码之前，避免无效文件白输一次密码）
          let preParsed;
          try {
            preParsed = JSON.parse(content);
          } catch (e) {
            wx.showToast({ title: '不是有效的加密备份文件', icon: 'none' });
            return { success: false };
          }
          if (!preParsed || preParsed.magic !== 'PWMA' || preParsed.format !== 1
              || !preParsed.meta || !preParsed.envelope) {
            wx.showToast({ title: '不是有效的加密备份文件', icon: 'none' });
            return { success: false };
          }
          // 文件读取成功后打开通用输入弹窗索取该文件的密码
          this._importContent = content;
          this.setData({ importDialog: { visible: true, busy: false, error: '' } });
        } catch (error) {
          console.error('[backup] 读取备份文件失败:', error);
          wx.showToast({ title: '备份文件读取失败', icon: 'none' });
        }
      },
      fail: () => { this._choosingFile = false; },
      // 无论成功、失败还是用户取消，都在此处安排豁免回收（延迟 60s 覆盖导入解析过程）
      complete: () => { releaseUnlock(); },
    });
  },

  onImportClose() {
    if (this.data.importDialog.busy) return;
    this.setData({ 'importDialog.visible': false, 'importDialog.error': '' });
  },

  async onImportConfirm(event) {
    const values = (event.detail && event.detail.values) || {};
    const filePassword = values.filePassword || '';
    if (this.data.importDialog.busy) return;
    if (filePassword.length < 6) {
      this.setData({ 'importDialog.error': '备份密码至少需要 6 位' });
      return;
    }
    const masterKey = app.globalData.masterKey;
    if (app.globalData.isLocked || !masterKey) {
      this.setData({ 'importDialog.busy': false, 'importDialog.error': '密码本已锁定，请重新解锁后导入' });
      return;
    }
    this.setData({ 'importDialog.busy': true, 'importDialog.error': '' });
    try {
      const result = await importer.importEncrypted(
        this._importContent,
        filePassword,
        masterKey,
      );
      if (!result || !result.success) {
        this.setData({
          'importDialog.busy': false,
          'importDialog.error': (result && result.error) ? result.error : '导入失败',
        });
        return;
      }
      wx.showToast({
        title: result.skipped > 0 ? `导入 ${result.count} 条，跳过 ${result.skipped} 条` : `导入 ${result.count} 条`,
        icon: 'success',
      });
      this.setData({ 'importDialog.visible': false, 'importDialog.busy': false });
    } catch (error) {
      console.error('[backup] 导入失败:', error);
      this.setData({ 'importDialog.busy': false, 'importDialog.error': '导入失败，请检查文件' });
    }
  },

  /** 开放 API 授权入口 */
  onOpenApiAccess() {
    wx.navigateTo({ url: '/pages/api-access/api-access' });
  },

  onAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement?tab=agreement' });
  },

  /** 邀请卡：手动输入好友的邀请码 */
  onOpenInviteInput() {
    this.setData({ inviteDialog: { visible: true, busy: false, error: '' } });
  },

  onInviteCodeClose() {
    if (this.data.inviteDialog.busy) return;
    this.setData({ 'inviteDialog.visible': false, 'inviteDialog.error': '' });
  },

  onInviteCodeConfirm(event) {
    const values = (event.detail && event.detail.values) || {};
    const code = (values.inviteCode || '').trim();
    if (this.data.inviteDialog.busy) return;
    if (!code) {
      this.setData({ 'inviteDialog.error': '请输入邀请码' });
      return;
    }
    this.setData({ 'inviteDialog.busy': true, 'inviteDialog.error': '' });
    wx.cloud.callFunction({
      name: 'invite',
      data: { action: 'verify_invite', invite_code: code },
      success: (res) => {
        const result = res && res.result;
        if (result && result.success) {
          this.setData({ 'inviteDialog.visible': false, 'inviteDialog.busy': false });
          wx.showToast({ title: result.invitee_reward || '邀请成功，容量已到账', icon: 'none', duration: 3000 });
          this._loadInviteInfo();
          if (typeof app.refreshUserInfo === 'function') app.refreshUserInfo();
        } else {
          this.setData({
            'inviteDialog.busy': false,
            'inviteDialog.error': (result && result.error) || '邀请码无效',
          });
        }
      },
      fail: () => {
        this.setData({ 'inviteDialog.busy': false, 'inviteDialog.error': '网络错误，请稍后重试' });
      },
    });
  },

  /** 会员升级入口 */
  onGoMember() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  /**
   * 邀请好友 - 复制邀请码
   */
  onCopyInviteCode() {
    if (!this.data.inviteCode) {
      wx.showToast({ title: '邀请码加载中...', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => {
        wx.showToast({ title: '邀请码已复制', icon: 'success' });
      }
    });
  },

  /**
   * 邀请好友 - 分享
   */
  onShareInvite() {
    // 分享会拉起转发面板、用户还可能跳到聊天继续操作 → 临时豁免「切后台立即锁定」，
    // 否则分享完回来要重新输主密码（2026-10-24）
    this._holdUnlocked();
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
  },

  /**
   * 临时豁免「切后台立即锁定」：邀请分享、图片预览保存等场景会切出小程序，
   * 若此时锁定会打断用户正在完成的操作。60 秒后自动恢复锁定策略。
   */
  _holdUnlocked() {
    if (app && typeof app.holdUnlocked === 'function') app.holdUnlocked();
  },

  /** 生成邀请卡片图片：背景 + 痛点文案 + 邀请码 + 真小程序码 */
  async generateInviteImage() {
    const inviteCode = this.data.inviteCode;
    if (!inviteCode) {
      wx.showToast({ title: '邀请码还没加载好', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '正在生成', mask: true });
    try {
      // 邀请码固定指向正式版（2026-10-24 用户要求）：不再随运行环境切换，
      // 避免体验版生成的码把好友带到体验版（无正式身份、数据隔离混乱）。
      const envVersion = 'release';

      const qrResult = await new Promise((resolve, reject) => {
        wx.cloud.callFunction({
          name: 'inviteQrcode',
          data: { invite_code: inviteCode, env_version: envVersion },
          success: res => resolve(res.result || {}),
          fail: reject,
        });
      });
      if (!qrResult || !qrResult.success || !qrResult.base64) {
        throw new Error((qrResult && qrResult.error) || '小程序码生成失败');
      }

      const fs = wx.getFileSystemManager();
      const qrPath = `${wx.env.USER_DATA_PATH}/invite-qr-${Date.now()}.png`;
      fs.writeFileSync(qrPath, qrResult.base64, 'base64');

      const W = 768;
      const H = 1365;
      const { canvas, ctx } = await new Promise((resolve, reject) => {
        wx.createSelectorQuery().in(this)
          .select('#inviteCanvas')
          .fields({ node: true, size: true })
          .exec(res => {
            const item = res && res[0];
            if (!item || !item.node) return reject(new Error('画布未就绪，请重试'));
            const node = item.node;
            node.width = W;
            node.height = H;
            resolve({ canvas: node, ctx: node.getContext('2d') });
          });
      });

      const loadImage = src => new Promise((resolve, reject) => {
        const img = canvas.createImage();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = src;
      });

      const bg = await loadImage('/images/invite-bg.jpg');
      ctx.drawImage(bg, 0, 0, W, H);

      // 品牌（顶部：logo + 名称，水平居中组合）
      let logoW = 0;
      try {
        const logo = await loadImage('/images/app-logo.png');
        const logoSize = 44;
        const nameFont = 'bold 26px sans-serif';
        ctx.font = nameFont;
        const nameW = ctx.measureText('无忧密码本').width;
        const gap = 14;
        const totalW = logoSize + gap + nameW;
        const startX = (W - totalW) / 2;
        ctx.drawImage(logo, startX, 66, logoSize, logoSize);
        logoW = totalW;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#0e8a4f';
        ctx.font = nameFont;
        ctx.fillText('无忧密码本', startX + logoSize + gap, 98);
      } catch (e) {
        // logo 加载失败时退回纯文字品牌，不阻断出图
        ctx.textAlign = 'center';
        ctx.fillStyle = '#0e8a4f';
        ctx.font = 'bold 26px sans-serif';
        ctx.fillText('无忧密码本', W / 2, 96);
        logoW = 0;
      }

      // 关键：品牌行把 textAlign 改成了 left，必须恢复 center，
      // 否则后续所有文案会以画布中心为「左起点」向右溢出被裁（2026-10-24 真机截图暴露）
      ctx.textAlign = 'center';

      // 痛点两行
      ctx.fillStyle = '#14261c';
      ctx.font = 'bold 46px sans-serif';
      ctx.fillText('你还在用同一个密码', W / 2, 214);
      ctx.fillText('登录所有网站吗？', W / 2, 272);

      // 后果
      ctx.fillStyle = '#c73e33';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('一次泄露，全部沦陷', W / 2, 338);

      // 分隔线
      ctx.strokeStyle = 'rgba(14,138,79,0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 70, 388);
      ctx.lineTo(W / 2 + 70, 388);
      ctx.stroke();

      // 方案
      ctx.fillStyle = '#0e8a4f';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillText('只记一个主密码，其余它替你管', W / 2, 448);

      // 三条特色（居中）
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4a5c51';
      ctx.font = '26px sans-serif';
      ['· 换手机、换设备，一条不丢', '· 随时导出带走，数据永远是自己的', '· 开放 API 对接，只返回加密数据']
        .forEach((line, index) => ctx.fillText(line, W / 2, 516 + index * 50));

      // 邀请码
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8a9a91';
      ctx.font = '24px sans-serif';
      ctx.fillText('我的邀请码', W / 2, 696);

      ctx.fillStyle = '#0e8a4f';
      ctx.font = 'bold 64px sans-serif';
      ctx.fillText(inviteCode, W / 2, 772);

      // 行动 + 对方利益
      ctx.fillStyle = '#5a6b61';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('扫码注册，你也得 5 条容量', W / 2, 828);

      // 小程序码（对准背景预留白块）
      const qr = await loadImage(qrPath);
      const qrSize = 250;
      ctx.drawImage(qr, (W - qrSize) / 2, 996, qrSize, qrSize);

      // 底部
      ctx.fillStyle = '#5a7a68';
      ctx.font = '22px sans-serif';
      ctx.fillText('微信扫码 · 免费开始', W / 2, 1300);

      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W, height: H,
          destWidth: W * 2, destHeight: H * 2,
          success: res => resolve(res.tempFilePath),
          fail: reject,
        });
      });

      wx.hideLoading();
      // 预览页可长按保存/发送给朋友，会切出小程序 → 临时豁免锁定
      this._holdUnlocked();
      wx.previewImage({ urls: [tempPath], current: tempPath });
    } catch (error) {
      wx.hideLoading();
      console.error('[invite] 生成邀请图失败:', error);
      wx.showModal({
        title: '生成失败',
        content: (error && error.message) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    // 转发面板与后续跳转聊天会切出小程序，临时豁免锁定
    this._holdUnlocked();
    const inviteCode = this.data.inviteCode;
    return {
      title: '账号密码总记不住？用它安全保管，还送你 5 条容量',
      // 指向首屏 lock：新用户必须先设置主密码，不能直接进密码库
      path: `/pages/lock/lock?invite_code=${inviteCode}`,
      // 静态预存海报（邀请码在链接里自动带，图上无需展示）
      imageUrl: '/assets/share-invite.png',
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const inviteCode = this.data.inviteCode;
    return {
      title: '无忧密码本 - 安全管理你的账号密码',
      query: `invite_code=${inviteCode}`,
    };
  }
});
