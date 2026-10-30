// pages/add 新增/编辑 V4.0 - 类型选择器 + 模板动态表单 + 自定义字段
// 加密/云调用逻辑不变：保存统一走 storage.addPassword / updatePassword
const app = getApp();
const storage = require('../../utils/storage');
const pwGen = require('../../utils/password-gen');
const theme = require('../../styles/theme');
const member = require('../../utils/member');
const templates = require('../../utils/entry-templates');

const PLATFORMS = [
  { name: '微信', letter: 'W', bg: '#07C160', color: '#FFFFFF', hint: '微信号/手机号/QQ号' },
  { name: '抖音', letter: 'D', bg: '#FE2C55', color: '#FFFFFF', hint: '手机号/抖音号' },
  { name: '淘宝', letter: 'T', bg: '#FF5000', color: '#FFFFFF', hint: '手机号/淘宝会员名' },
  { name: '支付宝', letter: 'Z', bg: '#1677FF', color: '#FFFFFF', hint: '手机号/邮箱' },
  { name: 'QQ', letter: 'Q', bg: '#12B7F5', color: '#FFFFFF', hint: 'QQ号/手机号' },
  { name: '邮箱', letter: '@', bg: '#7C3AED', color: '#FFFFFF', hint: '邮箱地址' },
  { name: '游戏', letter: 'G', bg: '#EF4444', color: '#FFFFFF', hint: '游戏账号/手机号' },
  { name: '会员', letter: 'V', bg: '#ED6A0C', color: '#FFFFFF', hint: '手机号/邮箱' },
  { name: '办公', letter: 'B', bg: '#3B82F6', color: '#FFFFFF', hint: '企业账号/邮箱' },
  { name: '其他', letter: '+', bg: '#969799', color: '#FFFFFF', hint: '任意账号' }
];

Page({
  data: {
    isEdit: false,
    editId: '',
    themeClass: '',
    // 类型选择器（V4）
    typeList: [],           // [{type, name, icon, selected}]
    currentType: 'login',
    // 登录类扁平表单（存量结构，零变化）
    form: {
      platform: '', account: '', password: '', alias: '', notes: '',
      securityQuestion: '', securityAnswer: '', bindPhone: ''
    },
    platforms: PLATFORMS,
    selectedPlatform: '',
    // 4.3.14 平台自动补全（候选取自用户已存记录）
    recentPlatforms: [],
    platformSuggestions: [],
    showSuggest: false,
    accountHint: '用户名/邮箱/手机号',
    showPassword: false,
    showMore: false,
    passwordStrength: -1,
    // 非 login 类型动态表单
    tplFields: [],          // 模板元数据 + 当前值合并后的渲染数组
    // 自定义字段（任意类型可加）
    customFields: [],       // [{label, value, concealed}]
    canSave: false,
    saving: false,
    pageName: '添加密码',
  },

  async onLoad(options) {
    const typeOrder = templates.TYPE_ORDER;
    this.setData({
      themeClass: theme.getThemeClass(),
      typeList: typeOrder.map(t => ({
        type: t,
        name: templates.getTypeName(t),
        icon: templates.getIcon(t),
        selected: t === templates.DEFAULT_TYPE,
      })),
    });

    if (app.globalData.isLocked) {
      wx.reLaunch({ url: '/pages/lock/lock' });
      return;
    }

    if (options.id) {
      const masterKey = app.globalData.masterKey;
      let passwords;
      try {
        passwords = await storage.getAllPasswords(masterKey);
      } catch (error) {
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
        return;
      }
      const pwd = passwords.find(p => p.id === options.id);
      if (pwd) {
        const editCheck = member.canEdit(passwords, options.id);
        if (!editCheck.allowed) {
          wx.showModal({
            title: '无法编辑',
            content: editCheck.reason,
            confirmText: '升级会员',
            cancelText: '知道了',
            success: (res) => {
              if (res.confirm) wx.navigateTo({ url: '/pages/member/member' });
              setTimeout(() => wx.navigateBack(), 600);
            },
          });
          return;
        }
        const type = templates.getEntryType(pwd);
        this.setData({
          isEdit: true,
          editId: pwd.id,
          pageName: '编辑条目',
          currentType: type,
          typeList: typeOrder.map(t => ({ type: t, name: templates.getTypeName(t), icon: templates.getIcon(t), selected: t === type })),
          form: {
            platform: pwd.platform || '', account: pwd.account || '', password: pwd.password || '',
            alias: pwd.alias || '', notes: pwd.notes || '',
            securityQuestion: pwd.securityQuestion || '', securityAnswer: pwd.securityAnswer || '',
            bindPhone: pwd.bindPhone || ''
          },
          selectedPlatform: pwd.platform || '',
          customFields: Array.isArray(pwd.custom_fields)
            ? pwd.custom_fields.map(f => ({ label: f.label || '', value: f.value || '', concealed: !!f.concealed }))
            : [],
        }, () => this._buildTplFields(type, pwd));
      }
    }

    // 4.3.14：加载平台补全候选（失败静默，不阻塞录入）
    this._loadPlatformStats();
  },

  /** 模板元数据 + 存值 合并成渲染数组 */
  _buildTplFields(type, entry) {
    const tpl = templates.getTemplate(type);
    const saved = (entry && Array.isArray(entry.fields)) ? entry.fields : [];
    const tplFields = tpl.fields.map(f => {
      const cur = saved.find(s => s.key === f.key);
      return {
        key: f.key,
        label: f.label,
        concealed: !!f.concealed,
        input: f.input || 'text',
        options: f.options || null,
        value: cur ? (cur.value || '') : '',
        revealed: !f.concealed, // concealed 字段表单态默认显示明文（编辑者自己填的）
      };
    });
    this.setData({ tplFields }, () => this._checkCanSave());
  },

  /** 类型切换：重建动态表单（确认弹窗防误触丢数据） */
  onTypeSelect(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.currentType) return;

    const hasData = this.data.tplFields.some(f => f.value) || this.data.customFields.some(f => f.value);
    const doSwitch = () => {
      this.setData({
        currentType: type,
        typeList: this.data.typeList.map(t => ({ ...t, selected: t.type === type })),
      }, () => this._buildTplFields(type, null));
    };

    if (this.data.isEdit || hasData) {
      wx.showModal({
        title: '切换类型',
        content: '切换类型将清空当前类型专属字段的内容，确定继续？',
        confirmText: '继续',
        cancelText: '取消',
        success: (res) => { if (res.confirm) doSwitch(); },
      });
    } else {
      doSwitch();
    }
  },

  // ===== 登录类扁平字段（逻辑不变） =====
  onPlatformSelect(e) {
    const name = e.currentTarget.dataset.name;
    const platform = PLATFORMS.find(p => p.name === name);
    this.setData({
      'form.platform': name,
      selectedPlatform: name,
      accountHint: platform ? platform.hint : '任意账号'
    }, () => this._checkCanSave());
  },

  onPlatformInput(e) {
    const value = e.detail.value;
    this.setData({
      'form.platform': value,
      platformSuggestions: this._matchPlatforms(value),
    }, () => this._checkCanSave());
  },

  /** 4.3.14：平台补全候选来自用户已存记录（去重 + 按条数降序） */
  async _loadPlatformStats() {
    const masterKey = app.globalData.masterKey;
    if (!masterKey) return;
    let passwords = [];
    try {
      passwords = await storage.getAllPasswords(masterKey);
    } catch (error) {
      return; // 补全失败不阻塞录入
    }
    const stat = {};
    passwords.forEach((p) => {
      if (p.is_deleted || !p.platform) return;
      const name = String(p.platform).trim();
      if (!name) return;
      stat[name] = (stat[name] || 0) + 1;
    });
    const list = Object.keys(stat).map((name) => {
      const cfg = PLATFORMS.find((x) => x.name === name);
      return {
        name,
        count: stat[name],
        letter: name.charAt(0),
        bg: cfg ? cfg.bg : 'rgba(150,150,150,0.14)',
        color: cfg ? cfg.color : '#9AA0A6',
      };
    }).sort((a, b) => b.count - a.count);

    this._allPlatforms = list; // 全量放实例变量，避免大数组进 setData
    this.setData({ recentPlatforms: list.slice(0, 6) });
  },

  _matchPlatforms(keyword) {
    const all = this._allPlatforms || [];
    const k = String(keyword || '').trim().toLowerCase();
    if (!k) return all.slice(0, 6);
    return all.filter((p) => p.name.toLowerCase().indexOf(k) >= 0).slice(0, 8);
  },

  onPlatformFocus() {
    this.setData({
      showSuggest: true,
      platformSuggestions: this._matchPlatforms(this.data.form.platform),
    });
  },

  onPlatformBlur() {
    // 延迟隐藏，避免点击建议项时先触发 blur 导致选不中
    setTimeout(() => this.setData({ showSuggest: false }), 160);
  },

  /** 点选建议 / 最近使用：同时写入 form.platform（修掉旧版选完还要再输一次的缺陷） */
  onPickSuggestion(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    const platform = PLATFORMS.find((p) => p.name === name);
    this.setData({
      'form.platform': name,
      selectedPlatform: name,
      accountHint: platform ? platform.hint : '任意账号',
      showSuggest: false,
    }, () => this._checkCanSave());
  },

  onAccountInput(e) {
    this.setData({ 'form.account': e.detail.value }, () => this._checkCanSave());
  },

  onPasswordInput(e) {
    this.setData(
      { 'form.password': e.detail.value, passwordStrength: this._strength(e.detail.value) },
      () => this._checkCanSave()
    );
  },

  async onGeneratePassword() {
    if (typeof pwGen.generate !== 'function') return;
    try {
      const pwd = await pwGen.generate({ length: 16 });
      if (pwd) {
        this.setData(
          { 'form.password': pwd, showPassword: true, passwordStrength: this._strength(pwd) },
          () => {
            this._checkCanSave();
            wx.showToast({ title: '已生成密码', icon: 'none' });
          }
        );
      }
    } catch (error) {
      wx.showToast({ title: '密码生成失败，请重试', icon: 'none' });
    }
  },

  onToggleMore() {
    this.setData({ showMore: !this.data.showMore });
  },

  onSecQInput(e) { this.setData({ 'form.securityQuestion': e.detail.value }); },
  onSecAInput(e) { this.setData({ 'form.securityAnswer': e.detail.value }); },
  onBindPhoneInput(e) { this.setData({ 'form.bindPhone': e.detail.value }); },
  onNotesInput(e) { this.setData({ 'form.notes': e.detail.value }); },

  // ===== 动态字段（非 login 类型） =====
  onTplFieldInput(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['tplFields[' + idx + '].value']: e.detail.value }, () => this._checkCanSave());
  },

  onTplFieldReveal(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['tplFields[' + idx + '].revealed']: !this.data.tplFields[idx].revealed });
  },

  onTplFieldPick(e) {
    const idx = e.currentTarget.dataset.index;
    const i = Number(e.currentTarget.dataset.i);
    this.setData(
      { ['tplFields[' + idx + '].value']: this.data.tplFields[idx].options[i] },
      () => this._checkCanSave()
    );
  },

  // ===== 自定义字段 =====
  onAddCustomField() {
    this.setData({
      customFields: this.data.customFields.concat([{ label: '', value: '', concealed: false }]),
    });
  },

  onRemoveCustomField(e) {
    const idx = e.currentTarget.dataset.index;
    const list = this.data.customFields.slice();
    list.splice(idx, 1);
    this.setData({ customFields: list });
  },

  onCustomLabel(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['customFields[' + idx + '].label']: e.detail.value });
  },

  onCustomValue(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['customFields[' + idx + '].value']: e.detail.value });
  },

  onCustomToggle(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['customFields[' + idx + '].concealed']: !this.data.customFields[idx].concealed });
  },

  /** 强度：长度+字符种类 粗评 0/1/2 */
  _strength(v) {
    if (!v) return -1;
    let kinds = 0;
    if (/[a-z]/.test(v)) kinds++;
    if (/[A-Z]/.test(v)) kinds++;
    if (/[0-9]/.test(v)) kinds++;
    if (/[^a-zA-Z0-9]/.test(v)) kinds++;
    if (v.length >= 14 && kinds >= 3) return 2;
    if (v.length >= 8 && kinds >= 2) return 1;
    return 0;
  },

  _checkCanSave() {
    const d = this.data;
    let ok;
    if (d.currentType === 'login') {
      const f = d.form;
      ok = !!(f.platform && f.platform.trim() && f.account && f.account.trim() && f.password && f.password.trim());
    } else {
      // 非登录类型：任一非 concealed 字段有值即可（第一字段视为标题字段）
      ok = d.tplFields.some(f => f.value && f.value.trim());
    }
    if (ok !== this.data.canSave) {
      this.setData({ canSave: ok });
    }
  },

  async onSave() {
    if (this._saving) return;
    const d = this.data;
    const masterKey = app.globalData.masterKey;
    if (!masterKey) {
      wx.showToast({ title: '请先解锁密码本', icon: 'none' });
      return;
    }
    let payload;

    if (d.currentType === 'login') {
      const f = d.form;
      if (!f.platform.trim()) { wx.showToast({ title: '请选择或输入平台名称', icon: 'none' }); return; }
      if (!f.account.trim()) { wx.showToast({ title: '请输入账号', icon: 'none' }); return; }
      if (!f.password.trim()) { wx.showToast({ title: '请输入密码', icon: 'none' }); return; }
      payload = { ...f, type: 'login' };
      // login + 自定义字段
      if (d.customFields.length > 0) payload.custom_fields = d.customFields;
    } else {
      const fields = d.tplFields.map(f => ({ key: f.key, label: f.label, value: f.value, concealed: f.concealed }));
      if (!fields.some(f => f.value && f.value.trim())) {
        wx.showToast({ title: '请至少填写一项内容', icon: 'none' });
        return;
      }
      payload = {
        type: d.currentType,
        platform: templates.getTypeName(d.currentType), // 列表标题字段沿用 platform
        account: '',
        password: '',
        alias: '',
        notes: '',
        securityQuestion: '',
        bindPhone: '',
        fields,
      };
      if (d.customFields.length > 0) payload.custom_fields = d.customFields;
    }

    // Lock before the first await; setData rendering can lag behind another tap.
    this._saving = true;
    this.setData({ saving: true });
    let saved = false;
    try {
      if (!d.isEdit) {
        let passwords;
        try {
          passwords = (await storage.getAllPasswords(masterKey)).filter(p => !p.is_deleted);
        } catch (error) {
          wx.showToast({ title: '读取容量失败，请重试', icon: 'none' });
          return;
        }
        const check = member.canAdd(passwords.length);
        if (!check.allowed) {
          wx.showModal({
            title: '容量已满',
            content: '免费容量已用完。开通年度会员即可无限新增，已存内容不受影响。',
            confirmText: '升级会员',
            cancelText: '暂不',
            success: (res) => {
              if (res.confirm) wx.reLaunch({ url: '/pages/member/member' });
            },
          });
          return;
        }
      }
      const result = d.isEdit
        ? await storage.updatePassword(d.editId, payload, masterKey)
        : await storage.addPassword(payload, masterKey);
      if (!result || result.success === false) {
        wx.showToast({ title: d.isEdit ? '更新失败，请重试' : '保存失败，请重试', icon: 'none' });
        return;
      }
      saved = true;
      wx.showToast({ title: d.isEdit ? '已更新' : '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      wx.showToast({ title: d.isEdit ? '更新失败，请重试' : '保存失败，请重试', icon: 'none' });
    } finally {
      // A successful save stays guarded through the delayed navigation back.
      if (!saved) {
        this._saving = false;
        this.setData({ saving: false });
      }
    }
  }
});
