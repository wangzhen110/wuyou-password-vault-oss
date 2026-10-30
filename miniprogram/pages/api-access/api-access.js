// pages/api-access —— 开放 API 授权管理（生成授权码、确认第三方接入、设备吊销）
const app = getApp();
const theme = require('../../styles/theme');
const fb = require('../../utils/feedback');
const member = require('../../utils/member');
const storage = require('../../utils/storage');
const crypto = require('../../utils/crypto');

Page({
  data: {
    // 固定文档地址（静态托管同名文件覆盖更新，URL 不变）
    docUrl: 'https://your-cloud-env-id-1448869858.tcloudbaseapp.com/api-doc.html',
    docModal: { visible: false },
    themeClass: '',
    code: '',
    codeId: '',
    expiresText: '',
    status: '',           // waiting | pending | approved | rejected | expired
    pendingDevice: '',
    devices: [],
    otpRequests: [],   // 待批准的一次性读取请求
    otpBusy: false,    // 处理中防重复点击（allow 需解密+加密，约 1-2 秒）
    loading: false,
    polling: false,
    message: '',
  },

  onLoad() {
    this.setData({ themeClass: theme.getThemeClass() });
  },

  onShow() {

    this.loadOtpRequests();
    this.startOtpPolling();
    const ent = member.getUserEntitlement();
    this.setData({ themeClass: theme.getThemeClass(), isVip: ent.isVip });
    if (ent.isVip) this.loadDevices();
  },

  /** 非会员：开放 API 是会员权益 */
  onGoVip() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  onHide() {
    this.stopPolling();
    this.stopOtpPolling();
  },

  onUnload() {
    this.stopPolling();
    this.stopOtpPolling();
  },

  call(action, data = {}) {
    return new Promise(resolve => {
      wx.cloud.callFunction({
        name: 'apiAuth',
        data: { action, ...data },
        success: res => resolve(res.result || { success: false }),
        fail: () => resolve({ success: false, error: '网络错误，请稍后重试' }),
      });
    });
  },

  async onCreateCode() {
    if (!this.data.isVip) {
      wx.showToast({ title: '开放 API 为会员专属权益', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true, message: '' });
    const result = await this.call('create_code');
    this.setData({ loading: false });
    if (!result.success) {
      wx.showToast({ title: result.error || '生成失败', icon: 'none' });
      return;
    }
    const minutes = Math.max(1, Math.round((result.expires_at - Date.now()) / 60000));
    this.setData({
      code: result.code,
      codeId: result.code_id,
      status: 'waiting',
      pendingDevice: '',
      expiresText: `有效期 ${minutes} 分钟，仅可使用一次`,
    });
    this.startPolling();
  },

  /** 一次性请求轮询：AI 新发起的请求不用退出重进就能出现（8 秒一次，onHide 停止） */
  startOtpPolling() {
    this.stopOtpPolling();
    this.otpTimer = setInterval(() => {
      if (this._otpLoading) return;
      this.loadOtpRequests();
    }, 8000);
  },

  stopOtpPolling() {
    if (this.otpTimer) {
      clearInterval(this.otpTimer);
      this.otpTimer = null;
    }
  },

  startPolling() {
    this.stopPolling();
    this.setData({ polling: true });
    this.timer = setInterval(async () => {
      if (!this.data.codeId) return this.stopPolling();
      const result = await this.call('poll_requests', { code_id: this.data.codeId });
      if (!result.success) return;
      if (result.status === 'pending' && result.device_name) {
        this.setData({ status: 'pending', pendingDevice: result.device_name });
      } else if (result.status === 'expired') {
        this.setData({ status: 'expired', message: '授权码已过期，请重新生成' });
        this.stopPolling();
      } else if (result.status === 'approved' || result.status === 'rejected') {
        this.setData({ status: result.status });
        if (result.status === 'approved') this.loadDevices();
        this.stopPolling();
      }
    }, 2000);
  },

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.data.polling) this.setData({ polling: false });
  },

  async onAllow() {
    if (!this.data.codeId) return;
    const result = await this.call('confirm_request', { code_id: this.data.codeId, allow: true });
    if (!result.success) {
      wx.showToast({ title: result.error || '操作失败', icon: 'none' });
      return;
    }
    this.setData({ status: 'approved', message: '已授权，请让第三方程序重新提交授权码以获取令牌' });
    this.stopPolling();
    this.loadDevices();
  },

  async onDeny() {
    if (!this.data.codeId) return;
    await this.call('confirm_request', { code_id: this.data.codeId, allow: false });
    this.setData({ status: 'rejected', message: '已拒绝该设备接入' });
    this.stopPolling();
  },

  async loadDevices() {
    const result = await this.call('list_devices');
    if (!result.success) return;
    this.setData({
      devices: (result.devices || []).map(item => ({
        ...item,
        createdText: this.formatTime(item.created_at),
        lastUsedText: item.last_used_at ? this.formatTime(item.last_used_at) : '从未使用',
        stateText: item.revoked ? '已吊销' : (item.expired ? '已过期' : '生效中'),
      })),
    });
  },

  formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  async onRevoke(e) {
    const { id, name } = e.currentTarget.dataset;
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '吊销该设备？',
        content: `${name} 将立即失去访问权限，需要重新授权才能再次接入。`,
        confirmText: '吊销',
        confirmColor: '#F06058',
        success: res => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirm) return;
    const result = await this.call('revoke_device', { device_id: id });
    if (!result.success) {
      wx.showToast({ title: result.error || '吊销失败', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已吊销', icon: 'success' });
    this.loadDevices();
  },

  /** 拉取待批准的一次性读取请求，并附上本机条目标题（需已解锁） */
  async loadOtpRequests() {
    if (this._otpLoading) return;
    this._otpLoading = true;
    try { await this._loadOtpRequestsInner(); }
    finally { this._otpLoading = false; }
  },

  async _loadOtpRequestsInner() {
    const res = await this.call('list_otp_requests');
    if (!res || !res.success) { this.setData({ otpRequests: [] }); return; }
    const requests = res.requests || [];
    if (!requests.length) { this.setData({ otpRequests: [] }); return; }

    const masterKey = app.globalData.masterKey;
    if (!masterKey) {
      requests.forEach(r => { r.title = '请先解锁密码本'; r.localMissing = true; });
      this.setData({ otpRequests: requests });
      return;
    }
    try {
      const all = await storage.getAllPasswords(masterKey);
      const byId = {};
      (all || []).forEach(e => { byId[e.id] = e; });
      requests.forEach(r => {
        const e = byId[r.entry_id];
        if (e) {
          r.title = `${e.platform || '未命名'} · ${e.account || ''}`;
          r.localMissing = false;
        } else {
          r.title = '该条目不在本机，无法批准';
          r.localMissing = true;
        }
      });
    } catch (e) {
      requests.forEach(r => { r.title = '解锁后才能确认条目'; r.localMissing = true; });
    }
    this.setData({ otpRequests: requests });
  },

  /** 拒绝：不向 AI 交付任何内容 */
  async onOtpDeny(e) {
    const rid = e.currentTarget.dataset.rid;
    if (!rid || this.data.otpBusy) return;
    this.setData({ otpBusy: true });
    const res = await this.call('decide_otp_request', { request_id: rid, allow: false });
    if (res && res.success) {
      wx.showToast({ title: '已拒绝', icon: 'none' });
      this.loadOtpRequests();
    } else {
      wx.showToast({ title: (res && res.error) || '操作失败', icon: 'none' });
    }
    this.setData({ otpBusy: false });
  },

  /** 仅本次允许：端侧单条解密 → 用 AI 的一次性 key 重新加密 → 上报交付 */
  async onOtpAllow(e) {
    const rid = e.currentTarget.dataset.rid;
    if (!rid || this.data.otpBusy) return;
    this.setData({ otpBusy: true });
    const req = (this.data.otpRequests || []).find(x => x.request_id === rid);
    if (!req) { this.setData({ otpBusy: false }); return; }
    if (req.localMissing) {
      this.setData({ otpBusy: false });
      wx.showToast({ title: '该条目不在本机，无法批准', icon: 'none' });
      return;
    }
    const masterKey = app.globalData.masterKey;
    if (!masterKey) {
      this.setData({ otpBusy: false });
      wx.showModal({ title: '无法交付', content: '密码库处于锁定状态，请回主页解锁后再试', showCancel: false });
      return;
    }
    wx.showLoading({ title: '加密交付中', mask: true });
    let debugDelivery = '';
    try {
      const all = await storage.getAllPasswords(masterKey);
      const entry = (all || []).find(x => x.id === req.entry_id);
      if (!entry) throw new Error('条目不在本机');

      // 端侧单条解密（内存中），按协议重加密：p256 = ECDH 协商（云端零密钥）；symmetric = 旧对称 key
      let delivery;
      if (req.curve === 'p256') {
        delivery = await crypto.otpEcdhEncrypt(JSON.stringify(entry), req.ai_pubkey_hex);
      } else {
        delivery = await crypto.encryptWithKey(JSON.stringify(entry), req.ai_key_hex);
      }
      debugDelivery = `iv_len=${(delivery.iv || '').length} iv=${delivery.iv}`;
      const res = await this.call('decide_otp_request', {
        request_id: rid,
        allow: true,
        delivery: {
          alg: delivery.alg,
          iv: delivery.iv,
          ciphertext: delivery.ciphertext,
          ...(delivery.mac ? { mac: delivery.mac } : {}),
          ...(delivery.my_pubkey ? { my_pubkey: delivery.my_pubkey } : {}),
        },
      });
      if (!res || !res.success) throw new Error(`${res && res.error || '交付失败'} | ${debugDelivery}`);

      // 先关 loading 再弹 toast：两者共用原生视图，顺序反了会吞掉成功提示
      wx.hideLoading();
      wx.showToast({ title: '已交付 · 60 秒内有效', icon: 'success' });
      this.loadOtpRequests();
    } catch (err) {
      // 失败用弹窗展示（toast 一闪而过，用户无法反馈具体原因）；附带端侧 delivery 调试信息
      wx.showModal({
        title: '交付失败',
        content: `${String((err && err.message) || err)}${debugDelivery ? ' | ' + debugDelivery : ''}`,
        showCancel: false,
      });
    } finally {
      wx.hideLoading();
      this.setData({ otpBusy: false });
    }
  },

  onOpenDocs() {
    wx.navigateTo({ url: '/pages/api-docs/api-docs' });
  },

  /** 复制静态文档页链接：开发者可直接浏览器打开，或整段丢给 AI 读 */
  onCopyDocLink() {
    const url = this.data.docUrl;
    wx.setClipboardData({
      data: url,
      // 成功/失败都弹自定义弹窗：地址常显、可长按选中，不依赖系统剪贴板提示
      success: () => this.setData({ docModal: { visible: true } }),
      fail: (err) => {
        console.error('[api-access] 复制文档链接失败:', err);
        this.setData({ docModal: { visible: true } });
      },
    });
  },

  /** 空方法：弹窗内阻止事件穿透 */
  noop() {},

  onCloseDocModal() {
    this.setData({ docModal: { visible: false } });
  },

  onCopyGuide() {
    wx.setClipboardData({
      data: 'GET /v1/vault/meta\nGET /v1/items?since=0&limit=100\nAuthorization: Bearer <token>\n\n提示：云端只返回密文，需在本地解密。完整文档：https://your-cloud-env-id-1448869858.tcloudbaseapp.com/api-doc.html',
      success: () => fb.toast('接口示例已复制'),
      fail: () => fb.fail('复制失败，请重试'),
    });
  },
});
