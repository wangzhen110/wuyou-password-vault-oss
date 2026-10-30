// pages/detail 密码详情 V4.0 - 按类型渲染 + concealed/re-prompt + 格式化复制
const app = getApp();
const storage = require('../../utils/storage');
const member = require('../../utils/member');
const theme = require('../../styles/theme');
const templates = require('../../utils/entry-templates');

const PLATFORM_COLORS = {
  '微信': '#07C160', '抖音': '#FE2C55', '淘宝': '#FF5000', '支付宝': '#1677FF',
  '服务器': '#6366F1', '银行卡': '#F59E0B', '安全笔记': '#969799', 'API密钥': '#7C3AED',
  'QQ': '#12B7F5', '邮箱': '#7C3AED', '游戏': '#EF4444', '会员': '#ED6A0C',
  '办公': '#3B82F5', '其他': '#969799'
};

Page({
  data: {
    id: '',
    themeClass: '',
    entryType: 'login',
    typeName: '登录',
    title: '',            // 列表标题：login=platform，其他=第一非敏感字段
    iconBg: '#969799',
    repromptDialog: { visible: false, busy: false, error: '' },
    repromptFields: [
      { key: 'password', label: '主密码', placeholder: '输入主密码', password: true },
    ],
    // login 扁平字段
    account: '',
    password: '',
    showPassword: false,
    securityQuestion: '',
    securityAnswer: '',
    bindPhone: '',
    notes: '',
    // 非 login 类型渲染数组
    displayFields: [],    // [{key,label,value,concealed,revealed,rePrompt,isCardno,isMulti,flatValue}]
    customFields: [],     // [{label,value,concealed,revealed}]
    createTime: '',
    updateTime: '',
  },

  onLoad(options) {
    this.setData({ themeClass: theme.getThemeClass() });
    if (app.globalData.isLocked) {
      wx.reLaunch({ url: '/pages/lock/lock' });
      return;
    }
    this.setData({ id: options.id });
    this.loadDetail();
  },

  async loadDetail() {
    const masterKey = app.globalData.masterKey;
    let passwords;
    try {
      passwords = await storage.getAllPasswords(masterKey);
    } catch (error) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const pwd = passwords.find(p => p.id === this.data.id);

    if (!pwd) {
      wx.showToast({ title: '条目不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    // 到期降级：超出永久容量的条目不可复制（2026-10-23 产品调整）
    this.setData({ entryReadOnly: !member.canCopy(passwords, this.data.id).allowed });

    const type = templates.getEntryType(pwd);
    const title = type === 'login'
      ? (pwd.platform || '其他')
      : (templates.getSubtitle(pwd) || templates.getTypeName(type));
    const iconBg = PLATFORM_COLORS[title] || PLATFORM_COLORS[templates.getTypeName(type)] || PLATFORM_COLORS['其他'];

    const patch = {
      entryType: type,
      typeName: templates.getTypeName(type),
      title,
      iconBg,
      createTime: pwd.created_at || '',
      updateTime: pwd.updated_at || '',
    };

    if (type === 'login') {
      patch.account = pwd.account || '';
      patch.password = pwd.password || '';
      patch.securityQuestion = pwd.securityQuestion || '';
      patch.securityAnswer = pwd.securityAnswer || '';
      patch.bindPhone = pwd.bindPhone || '';
      patch.notes = pwd.notes || '';
    } else {
      const tpl = templates.getTemplate(type);
      patch.displayFields = (tpl.fields.length ? tpl.fields : [{ key: 'body', label: '内容', concealed: false, input: 'textarea' }]).map(f => {
        // 模板字段驱动；note 类型兜底
        const cur = (pwd.fields || []).find(s => s.key === f.key);
        const value = cur ? (cur.value || '') : '';
        return {
          key: f.key,
          label: f.label,
          concealed: !!f.concealed,
          rePrompt: !!f.rePrompt,
          revealed: false,
          isCardno: f.format === 'cardno',
          isMulti: f.input === 'textarea',
          masked: f.format === 'cardno' ? this._maskCardno(value) : '',
          value,
        };
      });
    }
    patch.customFields = (pwd.custom_fields || []).map(f => ({
      label: f.label || '',
      value: f.value || '',
      concealed: !!f.concealed,
      revealed: false,
    }));

    this.setData(patch);
  },

  /** 卡号掩码：•••• 1234 */
  _maskCardno(num) {
    const clean = (num || '').replace(/\s+/g, '');
    return clean ? '•••• ' + clean.slice(-4) : '';
  },

  /** 卡号显示格式：4 位分段 */
  _formatCardno(num) {
    const clean = (num || '').replace(/\s+/g, '');
    return clean.replace(/(.{4})/g, '$1 ').trim();
  },

  // ===== login 既有行为（不变） =====
  onTogglePassword() {
    if (this.data.showPassword) {
      this.setData({ showPassword: false });
    } else {
      this.setData({ showPassword: true });
      setTimeout(() => {
        this.setData({ showPassword: false });
      }, 30000);
    }
  },

  onCopyAccount() {
    this._copy(this.data.account, '账号已复制');
  },

  onCopyBindPhone() {
    this._copy(this.data.bindPhone, '已复制');
  },

  onCopyPassword() {
    this._rePromptThen(() => {
      this._copy(this.data.password, '密码已复制', () => {
        setTimeout(() => { wx.setClipboardData({ data: '' }); }, 30000);
      });
    });
  },

  // ===== 通用字段行为 =====
  /** 眼睛切换：re-prompt 字段先重验（生物 → 主密码） */
  onToggleField(e) {
    const idx = e.currentTarget.dataset.index;
    const field = this.data.displayFields[idx];
    if (!field) return;
    if (field.revealed) {
      this.setData({ ['displayFields[' + idx + '].revealed']: false });
      return;
    }
    this._rePromptThen(() => {
      this.setData({ ['displayFields[' + idx + '].revealed']: true });
      // 30s 自动隐藏
      setTimeout(() => {
        const cur = this.data.displayFields[idx];
        if (cur && cur.revealed) this.setData({ ['displayFields[' + idx + '].revealed']: false });
      }, 30000);
    });
  },

  onCopyField(e) {
    const idx = e.currentTarget.dataset.index;
    const field = this.data.displayFields[idx];
    if (!field || !field.value) return;
    const out = field.isCardno ? field.value.replace(/\s+/g, '') : field.value;
    const copy = () => this._copy(out, field.label + '已复制');
    if (field.concealed || field.rePrompt) this._rePromptThen(copy);
    else copy();
  },

  onToggleCustom(e) {
    const idx = e.currentTarget.dataset.index;
    const f = this.data.customFields[idx];
    if (!f) return;
    if (f.revealed) {
      this.setData({ ['customFields[' + idx + '].revealed']: false });
      return;
    }
    if (f.concealed) {
      this._rePromptThen(() => this.setData({ ['customFields[' + idx + '].revealed']: true }));
    } else {
      this.setData({ ['customFields[' + idx + '].revealed']: true });
    }
  },

  onCopyCustom(e) {
    const idx = e.currentTarget.dataset.index;
    const f = this.data.customFields[idx];
    if (!f || !f.value) return;
    const copy = () => this._copy(f.value, f.label + '已复制');
    if (f.concealed) this._rePromptThen(copy);
    else copy();
  },

  /** 服务器类型：一键复制 host:port */
  onCopyHostPort() {
    const host = this._fieldValue('host');
    const port = this._fieldValue('port');
    if (!host) return;
    this._copy(port ? host + ':' + port : host, '地址已复制');
  },

  _fieldValue(key) {
    const f = this.data.displayFields.find(x => x.key === key);
    return f ? f.value : '';
  },

  /** Sensitive content always requires the vault password, never device biometrics. */
  _rePromptThen(success) {
    this._repromptSuccess = success;
    this.setData({ repromptDialog: { visible: true, busy: false, error: '' } });
  },

  onRepromptClose() {
    if (this.data.repromptDialog.busy) return;
    this.setData({ 'repromptDialog.visible': false, 'repromptDialog.error': '' });
  },

  async onRepromptConfirm(event) {
    const values = (event.detail && event.detail.values) || {};
    const password = values.password || '';
    if (this.data.repromptDialog.busy) return;
    if (!password) {
      this.setData({ 'repromptDialog.error': '请输入主密码' });
      return;
    }
    this.setData({ 'repromptDialog.busy': true, 'repromptDialog.error': '' });
    try {
      const check = await storage.verifyMasterPassword(password);
      if (check && check.success) {
        const success = this._repromptSuccess;
        this._repromptSuccess = null;
        this.setData({ 'repromptDialog.visible': false, 'repromptDialog.busy': false });
        if (typeof success === 'function') success();
        return;
      }
      this.setData({ 'repromptDialog.busy': false, 'repromptDialog.error': '主密码不正确' });
    } catch (error) {
      this.setData({ 'repromptDialog.busy': false, 'repromptDialog.error': '验证失败，请重试' });
    }
  },

  _copy(text, tip, extra) {
    if (!text) return;
    if (this.data.entryReadOnly) {
      wx.showToast({ title: '会员已到期，此条目超出永久容量，续费后可复制', icon: 'none', duration: 2500 });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: tip, icon: 'success', duration: 2000 });
        if (extra) extra();
      },
    });
  },

  onEdit() {
    wx.navigateTo({ url: '/pages/add/add?id=' + this.data.id });
  },

  onDelete() {
    wx.showModal({
      title: '删除条目',
      content: '确定要删除「' + this.data.title + '」吗？删除后不可恢复。',
      confirmColor: '#F06058',
      success: async (res) => {
        if (res.confirm) {
          try {
            const deleted = await storage.deletePassword(this.data.id, app.globalData.masterKey);
            if (!deleted) {
              wx.showToast({ title: '删除失败，请重试', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 800);
          } catch (error) {
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          }
        }
      }
    });
  }
});
