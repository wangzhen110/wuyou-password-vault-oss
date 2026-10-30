const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SESSION_KEY = { encryptionKey: 'session-encryption', macKey: 'session-mac' };

function createWx() {
  const calls = {
    actionSheets: [],
    clipboard: [],
    files: [],
    modals: [],
    relaunches: [],
    sharedFiles: [],
    toasts: [],
  };
  return {
    calls,
    showActionSheet(options) {
      calls.actionSheets.push(options);
    },
    showModal(options) {
      calls.modals.push(options);
    },
    showToast(options) {
      calls.toasts.push(options);
    },
    showLoading(options) {
      calls.loadings = calls.loadings || [];
      calls.loadings.push(options);
    },
    hideLoading() {
      calls.loadingHidden = true;
    },
    setClipboardData(options) {
      calls.clipboard.push(options.data);
      if (options.success) options.success();
    },
    navigateBack() {
      calls.navigatedBack = true;
    },
    reLaunch(options) {
      calls.relaunches.push(options);
    },
    shareFileMessage(options) {
      calls.sharedFiles.push(options);
      if (options.success) options.success({});
    },
    chooseMessageFile(options) {
      calls.chooseMessageFile = options;
    },
    cloud: {
      callFunction(options) {
        if (!Array.isArray(calls.cloudCalls)) calls.cloudCalls = [];
        calls.cloudCalls.push(options);
        calls.cloudCall = options;
        if (options.success) options.success({ result: {
          success: true, invite_code: 'ABCD1234', invite_count: 2,
          can_invite: true, next_reward: '容量',
        } });
      },
    },
    getFileSystemManager() {
      return {
        readFile(options) {
          calls.files.push(options);
          if (options.success) options.success({ data: '{"magic":"PWMA","format":1,"meta":{"kdf":"PBKDF2"},"envelope":{}}' });
        },
        writeFile(options) {
          calls.files.push(options);
          if (options.success) options.success({});
        },
      };
    },
    env: { USER_DATA_PATH: '/user-data' },
    setStorageSync() {},
    removeStorageSync() {},
    getStorageSync() {
      return '';
    },
  };
}

function loadDefinition(relativePath, dependencies, app, wx) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  let definition;
  const sandbox = {
    App() {},
    Component(value) {
      definition = value;
    },
    Page(value) {
      definition = value;
    },
    clearInterval() {},
    clearTimeout() {},
    console: { error() {}, log() {}, warn() {} },
    getApp: () => app,
    require(id) {
      if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
      // 演示模式默认未启用，测试中按关闭处理
      // 页面读取版本号（settings/lock/about 等页 data.version）
      if (id === '../../config') {
        return { VERSION: '4.3.8' };
      }
      if (id === '../../utils/demo-mode') {
        return {
          isActive: () => false,
          enter() {},
          exit() {},
          getEntries: () => [],
          blocked: () => ({ success: false, error: '演示模式仅供体验，不支持修改数据' }),
        };
      }
      throw new Error('Unexpected require: ' + id + ' in ' + relativePath);
    },
    setInterval() {
      return 1;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    wx,
  };
  vm.runInNewContext(source, sandbox, { filename });
  return { definition, source };
}

function createInstance(definition) {
  const data = JSON.parse(JSON.stringify(definition.data || {}));
  const instance = { data };
  Object.assign(instance, definition.methods || definition);
  instance.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.match(/[^.[\]]+/g) || [];
      let target = instance.data;
      while (parts.length > 1) {
        const part = parts.shift();
        if (target[part] === undefined) target[part] = /^\d+$/.test(parts[0]) ? [] : {};
        target = target[part];
      }
      target[parts[0]] = value;
    }
    if (callback) callback();
  };
  instance.triggerEvent = () => {};
  return instance;
}

function baseDependencies(overrides = {}) {
  const passwordGen = {
    generate: async () => 'Generated-Password-1!',
    checkStrength: () => ({ score: 3, label: '强', color: '#22c55e' }),
    ...(overrides.passwordGen || {}),
  };
  const templates = {
    DEFAULT_TYPE: 'login',
    TYPE_ORDER: ['login', 'server'],
    getEntryType: entry => entry.type || 'login',
    getIcon: () => 'key',
    getSubtitle: entry => entry.account || '',
    getTemplate: type => ({
      fields: type === 'server'
        ? [{ key: 'sshkey', label: 'SSH 密钥', concealed: true, input: 'text' }]
        : [],
    }),
    getTypeName: type => type === 'server' ? '服务器' : '登录',
  };
  const theme = {
    getFontSize: () => 'normal',
    getThemeClass: () => '',
    getTheme: () => 'dark',
    getEffectiveTheme: () => 'dark',
    setFontSize() {},
    getThemeList: () => [
      { key: 'auto', label: '跟随系统' },
      { key: 'light', label: '浅色' },
      { key: 'dark', label: '深色' },
    ],
    setTheme() {},
    ...overrides.theme,
  };
  const member = {
    canAdd: () => ({ allowed: true }),
    canEdit: () => ({ allowed: true }),
    getUserEntitlement: () => ({
      freeCapacity: 30,
      inviteCapacity: 0,
      isVip: false,
      paidCapacity: 0,
      permanentCapacity: 30,
      vipExpireAt: null,
    }),
    ...overrides.member,
  };
  return {
    '../../styles/theme': theme,
    '../styles/theme': theme,
    '../../utils/entry-templates': templates,
    '../../utils/member': member,
    // 平台判断：测试环境按 Android 处理（iOS 虚拟支付屏蔽另在 member 页测试覆盖）
    '../../utils/platform': { getPlatform: () => 'android', isIOS: () => false, ...overrides.platform },
    '../../utils/password-gen': passwordGen,
    // 诊断模块：测试里只做空实现，避免依赖真实 wx.getRealtimeLogManager
    '../../utils/diagnostics': {
      init() {},
      stage() {},
      warn() {},
      error() {},
      sanitize: payload => payload || {},
      getDeviceInfo: () => ({}),
      getRecentEvents: () => [],
    },
    '../../utils/sync': { manualSync: callback => callback({ success: true }), ...overrides.sync },
    '../../utils/import': { importEncrypted: async () => ({ success: true, count: 0, skipped: 0 }), ...overrides.importer },
    '../../utils/storage': {
      addPassword: async () => ({}),
      deletePassword: async () => true,
      getAllPasswords: async () => [],
      hasMasterPassword: () => true,
      set() {},
      setLockState() {},
      setMasterKeyCache() {},
      setMasterPassword: async () => ({ success: true, masterKey: SESSION_KEY }),
      togglePin: async () => ({}),
      updatePassword: async () => ({}),
      verifyMasterPassword: async () => ({ success: true, masterKey: SESSION_KEY }),
      ...overrides.storage,
    },
    '../../utils/export': {
      exportEncrypted: async () => 'PWMA:encrypted-backup',
      exportJSON: passwords => JSON.stringify({ passwords }),
      saveToFile: () => '/user-data/backup.pwma',
      shareFile: async () => {},
      ...overrides.export,
    },
    ...overrides.dependencies,
  };
}

function makePage(name, overrides = {}) {
  const wx = overrides.wx || createWx();
  const app = overrides.app || {
    globalData: { isLocked: false, masterKey: SESSION_KEY, offlineMode: false },
    unlockApp(masterKey) {
      this.globalData.isLocked = false;
      this.globalData.masterKey = masterKey;
    },
  };
  const dependencies = baseDependencies(overrides);
  const loaded = loadDefinition('miniprogram/pages/' + name + '/' + name + '.js', dependencies, app, wx);
  return { ...loaded, app, dependencies, instance: createInstance(loaded.definition), wx };
}

function makeComponent(name, overrides = {}) {
  const wx = overrides.wx || createWx();
  const app = overrides.app || {
    globalData: { isLocked: true, masterKey: null },
  };
  const dependencies = baseDependencies(overrides);
  const loaded = loadDefinition('miniprogram/components/' + name + '/' + name + '.js', dependencies, app, wx);
  return { ...loaded, app, dependencies, instance: createInstance(loaded.definition), wx };
}

test('index awaits decrypted records before filtering', async () => {
  let receivedKey;
  const entry = { id: 'entry-1', account: 'user@example.com', platform: '邮箱' };
  const page = makePage('index', {
    storage: {
      getAllPasswords: async key => {
        receivedKey = key;
        return [entry];
      },
    },
  }).instance;

  await page.loadData();
  assert.equal(receivedKey, SESSION_KEY);
  assert.equal(page.data.passwords[0].id, 'entry-1');
  assert.equal(page.data.loading, false);
});

test('settings cell tap emits one page action and catches the native tap', () => {
  const componentContext = makeComponent('comp-cell');
  const cellWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-cell/comp-cell.wxml'), 'utf8');
  const pageWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxml'), 'utf8');
  assert.match(componentContext.source, /triggerEvent\('tap'\)/);
  assert.match(cellWxml, /catchtap="onTap"/);
  assert.doesNotMatch(cellWxml, /\sbindtap="onTap"/);
  assert.match(pageWxml, /<comp-cell title="修改主密码" arrow bind:tap="onChangePassword"\/>/);

  const emitted = [];
  componentContext.instance.triggerEvent = (...args) => emitted.push(args);
  componentContext.instance.onTap();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'tap');
});

test('settings exposes theme, manual sync, backup import and supported sharing controls', async () => {
  const context = makePage('settings');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxml'), 'utf8');
  assert.match(wxml, /title="主题"/);
  assert.match(wxml, /title="手动同步"/);
  assert.match(wxml, /title="导入加密备份"/);
  assert.match(wxml, /<button[^>]*open-type="share"/);

  context.instance.onShow();
  assert.equal(context.wx.calls.cloudCall.name, 'invite');
  assert.match(context.wx.calls.cloudCall.data.action, /get_invite_info/);
});

test('settings backup export runs directly without a stacking password dialog', async () => {
  let encArgs;
  let saveArgs;
  const context = makePage('settings', {
    storage: {
      getAllPasswords: async () => [{ id: 'backup-entry', password: 'synthetic-secret' }],
      getMasterPassword: () => 'master-pass-1',
    },
    export: {
      exportJSON: entries => JSON.stringify({ data: { passwords: entries } }),
      exportEncrypted: async (text, pw) => { encArgs = [text, pw]; return 'PWMA:encrypted-only'; },
      saveToFile: (text, name) => { saveArgs = [text, name]; return '/user-data/vault.pwma'; },
      shareFile: async file => {},
    },
  });
  // 连续两次触发：免密码流程不再有可堆叠的对话框，只应产生两次独立导出
  await context.instance.onBackup();
  await context.instance.onBackup();
  assert.equal(context.instance.data.backupDialog.visible, false, '不应再打开密码对话框');
  assert.equal(encArgs[1], 'master-pass-1', '备份加密密码=主密码');
  // 落盘内容必须是加密后的载荷（不能把明文写进文件），且文件名带 pwma 后缀
  assert.equal(saveArgs[0], 'PWMA:encrypted-only', '落盘内容应为加密载荷而非明文');
  assert.match(saveArgs[1], /\.pwma$/, '备份文件名应带 .pwma 后缀');
  // 主题切换的 actionSheet 行为不受影响
  context.instance.onTheme();
  context.instance.onTheme();
  assert.equal(context.wx.calls.actionSheets.length, 1);
  context.wx.calls.actionSheets[0].fail({ errMsg: 'showActionSheet:fail cancel' });
  context.instance.onTheme();
  assert.equal(context.wx.calls.actionSheets.length, 2);
});

test('settings password change uses an in-page dialog instead of showModal', () => {
  const context = makePage('settings');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxml'), 'utf8');
  // 统一输入弹窗组件：password 掩码 + 真 placeholder；不再手写 pwd-dialog 节点
  assert.match(wxml, /<comp-input-dialog/);
  assert.match(wxml, /bind:confirm="onPwdConfirm"/);
  assert.doesNotMatch(wxml, /pwd-dialog-mask/);
  assert.doesNotMatch(wxml, /title="修改主密码 · 第 1 步"/);

  context.instance.onChangePassword();
  assert.equal(context.instance.data.changePwdDialog.visible, true);
  assert.equal(context.wx.calls.modals.length, 0, '修改主密码不应再使用 showModal');

  // 锁定时只提示，不开弹窗
  const locked = makePage('settings', { app: { globalData: { isLocked: true, masterKey: null } } });
  locked.instance.onChangePassword();
  assert.equal(locked.instance.data.changePwdDialog.visible, false);
  assert.ok(locked.wx.calls.toasts.length >= 1);
});

test('settings password change submit validates, rotates and updates session key', async () => {
  const NEW_KEY = { encryptionKey: 'new-enc', macKey: 'new-mac' };
  let rotationCall = null;
  let syncCount = 0;
  const context = makePage('settings', {
    storage: {
      changeMasterPassword: async (oldPassword, newPassword) => {
        rotationCall = { oldPassword, newPassword };
        return { success: true, masterKey: NEW_KEY, meta: { salt: 'ff' }, reencrypted: 2 };
      },
    },
    sync: { manualSync: callback => { syncCount += 1; callback({ success: true }); } },
  });
  context.instance.onChangePassword();
  assert.equal(context.instance.data.changePwdDialog.visible, true);

  // 新密码过短：不触发轮换
  await context.instance.onPwdConfirm({ detail: { values: { oldPassword: 'old password', newPassword: '12345' } } });
  assert.equal(rotationCall, null);
  assert.equal(context.instance.data.changePwdDialog.visible, true);

  // 正常提交：调用轮换、更新会话密钥并触发同步
  await context.instance.onPwdConfirm({ detail: { values: { oldPassword: 'old password', newPassword: 'brand new password', confirmPassword: 'brand new password' } } });
  assert.deepEqual(rotationCall, { oldPassword: 'old password', newPassword: 'brand new password' });
  assert.equal(context.app.globalData.masterKey, NEW_KEY);
  assert.equal(syncCount, 1);
  assert.equal(context.instance.data.changePwdDialog.visible, false);
  assert.equal(context.instance.data.changePwdDialog.busy, false);
});

test('settings password change failure keeps the vault and dialog state clean', async () => {
  const context = makePage('settings', {
    storage: {
      changeMasterPassword: async () => ({ success: false, error: '当前主密码不正确' }),
    },
  });
  const beforeKey = context.app.globalData.masterKey;
  context.instance.onChangePassword();
  await context.instance.onPwdConfirm({ detail: { values: { oldPassword: 'wrong', newPassword: 'brand new password' } } });
  assert.equal(context.app.globalData.masterKey, beforeKey, '失败不应改会话密钥');
  assert.equal(context.instance.data.changePwdDialog.visible, true, '失败后弹窗保留供重试');
  assert.equal(context.instance.data.changePwdDialog.busy, false);
  assert.ok(context.instance.data.changePwdDialog.error, '失败原因应展示给用户');
});

test('settings backup flow exports directly with the master password', async () => {
  let encArgs;
  let saveArgs;
  const context = makePage('settings', {
    storage: {
      getAllPasswords: async () => [{ id: 'backup-entry', password: 'synthetic-secret' }],
      getMasterPassword: () => 'master-pass-1',
    },
    export: {
      exportJSON: entries => JSON.stringify({ data: { passwords: entries } }),
      exportEncrypted: async (text, pw) => { encArgs = [text, pw]; return 'PWMA:encrypted-only'; },
      saveToFile: (text, name) => { saveArgs = [text, name]; return '/user-data/vault.pwma'; },
      shareFile: async file => {},
    },
  });
  await context.instance.onBackup();
  assert.equal(context.instance.data.backupDialog.visible, false, '免密码流程不再打开对话框');
  assert.equal(encArgs[1], 'master-pass-1', '备份加密密码=主密码');
  assert.equal(saveArgs[0], 'PWMA:encrypted-only');
  assert.match(saveArgs[1], /\.pwma$/);
  assert.deepEqual(context.wx.calls.clipboard, []);
});

test('all password prompts use the shared input dialog component', () => {
  // 组件文件齐全
  for (const file of ['comp-input-dialog.js', 'comp-input-dialog.wxml', 'comp-input-dialog.wxss', 'comp-input-dialog.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'miniprogram/components/comp-input-dialog', file)));
  }
  const compJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-input-dialog/comp-input-dialog.json'), 'utf8'));
  assert.equal(compJson.component, true);

  // 页面注册 + 节点
  for (const pageName of ['settings', 'detail']) {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, `miniprogram/pages/${pageName}/${pageName}.json`), 'utf8'));
    assert.equal(json.usingComponents['comp-input-dialog'], '/components/comp-input-dialog/comp-input-dialog');
    const wxml = fs.readFileSync(path.join(ROOT, `miniprogram/pages/${pageName}/${pageName}.wxml`), 'utf8');
    assert.match(wxml, /<comp-input-dialog/, `${pageName} 应有输入弹窗节点`);
  }

  // 全项目不再有 editable showModal（placeholder 实字 + 窄输入框问题源头）
  for (const js of ['miniprogram/pages/settings/settings.js', 'miniprogram/pages/detail/detail.js']) {
    const source = fs.readFileSync(path.join(ROOT, js), 'utf8');
    assert.doesNotMatch(source, /editable:\s*true/, `${js} 不应再使用 editable showModal`);
  }

  // 遮罩定位不用 inset（小程序 WebView 兼容性）
  const settingsWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxss'), 'utf8');
  assert.doesNotMatch(settingsWxss, /inset:/);
  const compWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-input-dialog/comp-input-dialog.wxss'), 'utf8');
  assert.match(compWxss, /top:\s*0/);
  assert.doesNotMatch(compWxss, /inset:/);
});

test('vip capacity is capped at 500 and permanent capacity uses new rules', async () => {
  const memberUtil = require(path.join(ROOT, 'miniprogram/utils/member.js'));
  assert.equal(memberUtil.RULES.INITIAL_FREE_CAPACITY, 10);
  assert.equal(memberUtil.RULES.VIP_CAPACITY, 500);
  assert.equal(memberUtil.RULES.INVITE_MAX_TIMES, 3);
  assert.equal(memberUtil.RULES.PACK_CAPACITY, 10);
  assert.equal(memberUtil.RULES.PACK_MAX_TIMES, 3);

  // 非会员：免费 20 + 邀请 30 + 付费 30 = 80
  assert.equal(memberUtil.computePermanentCapacity({
    free_capacity: 20, invite_capacity: 30, paid_capacity: 30,
  }), 80);
});

test('member purchase entry is gated by the payEnabled flag', async () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');
  assert.match(wxml, /wx:if="\{\{payEnabled\}\}"/, '支付区块应受 payEnabled 开关控制');
  assert.match(wxml, /即将开放/);

  const page = makePage('member');
  assert.equal(typeof page.instance.data.payEnabled, 'boolean', 'payEnabled 开关应存在');

  // 关闭态下点支付：只提示，不下单（审核版发布时该开关为 false）
  page.instance.data.payEnabled = false;
  await page.instance.onPay();
  assert.ok(page.wx.calls.toasts.some(item => /即将开放/.test(item.title)));
  assert.equal(page.wx.calls.cloudCall, undefined);
});

test('member page uses the shared custom navigation bar', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.json'), 'utf8'));
  assert.match(wxml, /<comp-nav-bar[^>]*title="会员升级"/);
  assert.equal(json.usingComponents['comp-nav-bar'], '/components/comp-nav-bar/comp-nav-bar');
});

test('lock first-time setup passes an optional invite code to the index page', async () => {
  const componentContext = makeComponent('comp-lock-screen');
  const component = componentContext.instance;
  component.data.isFirstUse = true;
  component.data.step = 1;
  component.data.password = 'new-master-password';
  component.data.confirmPassword = 'new-master-password';
  component.data.inviteCode = ' abcd1234 ';
  component.data.canSubmit = true;
  await component.onSubmit();
  assert.equal(componentContext.wx.calls.relaunches.length, 1);
  assert.match(componentContext.wx.calls.relaunches[0].url, /invite_code=abcd1234/);

  // 未填邀请码：URL 不带参数
  const plain = makeComponent('comp-lock-screen');
  plain.instance.data.isFirstUse = true;
  plain.instance.data.step = 1;
  plain.instance.data.password = 'new-master-password';
  plain.instance.data.confirmPassword = 'new-master-password';
  plain.instance.data.canSubmit = true;
  await plain.instance.onSubmit();
  assert.doesNotMatch(plain.wx.calls.relaunches[0].url, /invite_code/);

  // wxml 有邀请码输入（选填）
  const lockWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');
  assert.match(lockWxml, /邀请码/);
  assert.match(lockWxml, /选填/);
});

test('settings invite card accepts a manually entered invite code', async () => {
  const context = makePage('settings');
  context.instance.onOpenInviteInput();
  assert.equal(context.instance.data.inviteDialog.visible, true);

  // 空码不提交：提交前先记一次云调用数，提交后数量必须不变
  const cloudBeforeBlank = context.wx.calls.cloudCalls ? context.wx.calls.cloudCalls.length : 0;
  await context.instance.onInviteCodeConfirm({ detail: { values: { inviteCode: '  ' } } });
  assert.ok(context.instance.data.inviteDialog.error);
  const cloudAfterBlank = context.wx.calls.cloudCalls ? context.wx.calls.cloudCalls.length : 0;
  assert.equal(cloudAfterBlank, cloudBeforeBlank, '空码不应发起云调用');

  await context.instance.onInviteCodeConfirm({ detail: { values: { inviteCode: 'ABCD1234' } } });
  const cloudCalls = context.wx.calls.cloudCalls || [];
  const verifyCall = cloudCalls.find(c => c.data && c.data.action === 'verify_invite');
  assert.ok(verifyCall, '应调用 verify_invite');
  assert.equal(verifyCall.data.invite_code, 'ABCD1234');
  assert.equal(context.instance.data.inviteDialog.visible, false);
  assert.ok(context.wx.calls.toasts.some(item => /邀请/.test(item.title)));
});

test('cloud function deploys run through the unattended cli channel', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['deploy:function'], '应提供单函数自动部署脚本');
  const script = fs.readFileSync(path.join(ROOT, 'scripts/deploy-function.ps1'), 'utf8');
  assert.match(script, /cli\.bat/, '部署脚本应走官方 cli.bat（免 IDE 逐次确认）');
  assert.match(script, /cloud functions deploy/);
});

test('tab pages sync the tab bar theme on show and after theme switch', () => {
  // settings：onShow 与切主题成功后都同步 tab-bar
  const refreshCalls = { count: 0 };
  const context = makePage('settings');
  context.instance.getTabBar = () => ({ refreshTheme: () => { refreshCalls.count += 1; } });
  context.instance.onShow();
  assert.ok(refreshCalls.count >= 1, '设置页 onShow 应同步 tab-bar 主题');
  const before = refreshCalls.count;
  context.instance.onTheme();
  context.wx.calls.actionSheets[0].success({ tapIndex: 0 });
  assert.ok(refreshCalls.count > before, '切换主题后应立即同步 tab-bar');

  // index：onShow 同步
  const indexContext = makePage('index');
  let indexSynced = 0;
  indexContext.instance.getTabBar = () => ({
    setData() {},
    refreshTheme: () => { indexSynced += 1; },
  });
  indexContext.instance.onShow();
  assert.ok(indexSynced >= 1, '主页 onShow 应同步 tab-bar 主题');

  // 无 getTabBar 环境不崩（老基础库/非 tab 页）
  const bare = makePage('settings');
  delete bare.instance.getTabBar;
  assert.doesNotThrow(() => bare.instance.onShow());
});

test('member page buttons center text with flex instead of line-height', () => {
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxss'), 'utf8');
  const paySection = wxss.slice(wxss.indexOf('.pay-btn'), wxss.indexOf('.order-status'));
  assert.match(paySection, /display:\s*flex/);
  assert.match(paySection, /align-items:\s*center/);
  assert.match(paySection, /justify-content:\s*center/);
  assert.doesNotMatch(paySection, /line-height:\s*96rpx/);
  const recoverSection = wxss.slice(wxss.indexOf('.recover-btn'));
  assert.match(recoverSection, /display:\s*flex/);
  assert.match(recoverSection, /align-items:\s*center/);
  assert.doesNotMatch(recoverSection, /line-height:\s*96rpx/);
});

test('custom tab bar follows the in-app theme instead of white fallback', () => {
  const wx = createWx();
  const deps = baseDependencies();
  const loaded = loadDefinition('miniprogram/custom-tab-bar/index.js', deps, {
    globalData: {},
  }, wx);
  const instance = createInstance(loaded.definition);

  // 暗色（默认）：根节点无 light class
  instance.refreshTheme();
  assert.equal(instance.data.themeClass, '');

  // 浅色：跟随应用内主题
  deps['../styles/theme'].getEffectiveTheme = () => 'light';
  instance.refreshTheme();
  assert.equal(instance.data.themeClass, 'theme-light');
  deps['../styles/theme'].getEffectiveTheme = () => 'dark';
  instance.refreshTheme();
  assert.equal(instance.data.themeClass, '');

  // 页面 show 时刷新（主题切换后回到 tab 页同步）
  assert.ok(loaded.definition.pageLifetimes && loaded.definition.pageLifetimes.show);

  // wxss：根节点带主题 class，且暗色为默认变量、浅色有覆盖
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/custom-tab-bar/index.wxss'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/custom-tab-bar/index.wxml'), 'utf8');
  assert.match(wxml, /class="tab-bar \{\{themeClass\}\}"/);
  assert.match(wxss, /\.tab-bar\.theme-light/);
  assert.match(wxss, /--bg-card:\s*#1E1E1E/);
  assert.doesNotMatch(wxss, /var\(--bg-card,\s*#FFFFFF\)/);
});

test('settings backup import rejects locked vaults before opening the file picker', () => {
  const context = makePage('settings', { app: { globalData: { isLocked: true, masterKey: null } } });
  context.instance.onRestoreBackup();
  assert.equal(context.wx.calls.chooseMessageFile, undefined);
  assert.ok(context.wx.calls.toasts.some(item => /解锁/.test(item.title)));
});

test('settings theme control persists the chosen supported theme and refreshes class', () => {
  let selectedTheme = '';
  const context = makePage('settings', {
    theme: {
      getFontSize: () => 'normal', getThemeClass: () => '', getTheme: () => 'dark',
      setTheme: value => { selectedTheme = value; },
      getThemeList: () => [
        { key: 'auto', label: '跟随系统' },
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
      ],
    },
  });
  context.instance.onTheme();
  assert.deepEqual(context.wx.calls.actionSheets[0].itemList, ['跟随系统', '浅色', '深色']);
  context.wx.calls.actionSheets[0].success({ tapIndex: 1 });
  assert.equal(selectedTheme, 'light');
  assert.equal(context.instance.data.themeClass, 'theme-light');
});

test('auto theme resolves through system appearance on every page', () => {
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/styles/theme.js'), 'utf8');
  let definition;
  const systemTheme = { value: 'light' };
  vm.runInNewContext(source, {
    module: { exports: {} },
    require: () => ({ get: key => key === 'theme' ? 'auto' : 'normal' }),
    wx: { getSystemInfoSync: () => ({ theme: systemTheme.value }) },
  });
  const themePath = require.resolve('../miniprogram/styles/theme');
  const originalLoad = require('node:module')._load;
  const Module = require('node:module');
  Module._load = function load(request, parent, isMain) {
    if (request === '../utils/storage') return { get: key => key === 'theme' ? 'auto' : 'normal' };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[themePath];
    const themeModule = require(themePath);
    global.wx = { getSystemInfoSync: () => ({ theme: systemTheme.value }) };
    assert.equal(themeModule.getThemeClass(), 'theme-light');
    systemTheme.value = 'dark';
    assert.equal(themeModule.getThemeClass(), 'theme-dark');
  } finally {
    Module._load = originalLoad;
    delete require.cache[themePath];
  }
});

test('manual sync prevents duplicate invocation and reports the result', async () => {
  let finishSync;
  let syncCalls = 0;
  const context = makePage('settings', {
    sync: { manualSync: callback => { syncCalls++; finishSync = callback; } },
  });
  const first = context.instance.onManualSync();
  const second = context.instance.onManualSync();
  assert.equal(syncCalls, 1);
  assert.equal(context.instance.data.syncBusy, true);
  finishSync({ success: true });
  await Promise.all([first, second]);
  assert.equal(context.instance.data.syncBusy, false);
  assert.match(context.instance.data.syncStatus, /刚刚同步/);
});

test('manual sync failure surfaces the concrete reason instead of a generic label', async () => {
  const context = makePage('settings', {
    sync: { manualSync: callback => callback({ success: false, error: new Error('云端与本地密码库加密参数不一致') }) },
  });
  await context.instance.onManualSync();
  assert.match(context.instance.data.syncDetail, /加密参数不一致/, '失败原因应展示在同步副文案里（状态位保持简短）');
  assert.equal(context.wx.calls.toasts.length, 0, '失败原因不应被一闪而过的 toast 吞掉');

  const blocked = makePage('settings', {
    sync: { manualSync: callback => callback({ success: false, error: new Error('微信身份未确认或密码库同步已隔离') }) },
  });
  await blocked.instance.onManualSync();
  assert.match(blocked.instance.data.syncDetail, /身份未确认/);
});

test('password change requires the new password twice and rejects mismatches', async () => {
  const rotationCalls = [];
  const context = makePage('settings', {
    storage: {
      changeMasterPassword: async (oldPassword, newPassword) => {
        rotationCalls.push({ oldPassword, newPassword });
        return { success: true, masterKey: { encryptionKey: 'k', macKey: 'm' } };
      },
    },
  });
  // 字段定义含确认新密码
  const confirmField = context.instance.data.changePwdFields.find(f => f.key === 'confirmPassword');
  assert.ok(confirmField, 'changePwdFields 应包含 confirmPassword 字段');
  assert.equal(confirmField.password, true);

  context.instance.onChangePassword();
  // 两次输入不一致：不轮换
  await context.instance.onPwdConfirm({ detail: { values: { oldPassword: 'old password', newPassword: 'brand new password', confirmPassword: 'brand new passw0rd' } } });
  assert.equal(rotationCalls.length, 0);
  assert.match(context.instance.data.changePwdDialog.error, /两次输入的.*不一致|不一致/);

  // 一致后正常轮换
  await context.instance.onPwdConfirm({ detail: { values: { oldPassword: 'old password', newPassword: 'brand new password', confirmPassword: 'brand new password' } } });
  assert.equal(rotationCalls.length, 1);
});

test('backup export is encrypted with the master password and shares it instead of copying plaintext', async () => {
  let encArgs;
  let saveArgs;
  const context = makePage('settings', {
    storage: {
      getAllPasswords: async () => [{ id: 'backup-entry', password: 'synthetic-secret' }],
      getMasterPassword: () => 'master-pass-1',
    },
    export: {
      exportJSON: entries => JSON.stringify({ data: { passwords: entries } }),
      exportEncrypted: async (text, pw) => { encArgs = [text, pw]; return 'PWMA:encrypted-only'; },
      saveToFile: (text, name) => { saveArgs = [text, name]; return '/user-data/vault.pwma'; },
      shareFile: async file => {},
    },
  });
  await context.instance.onBackup();
  assert.equal(context.instance.data.backupDialog.visible, false, '免密码流程不再打开对话框');
  assert.equal(encArgs[1], 'master-pass-1', '备份加密密码=主密码');
  assert.equal(saveArgs[0], 'PWMA:encrypted-only');
  assert.match(saveArgs[1], /\.pwma$/);
  assert.deepEqual(context.wx.calls.clipboard, []);
});

test('encrypted backup restore reads only a selected .pwma file and requires its password', async () => {
  let importArgs;
  const context = makePage('settings', {
    importer: { importEncrypted: async (...args) => { importArgs = args; return { success: true, count: 2, skipped: 1 }; } },
  });
  context.instance.onRestoreBackup();
  const picker = context.wx.calls.chooseMessageFile;
  assert.deepEqual(Array.from(picker.extension), ['pwma']);
  const picked = picker.success({ tempFiles: [{ path: '/tmp/selected.pwma', name: 'selected.pwma' }] });
  await Promise.resolve();
  await picked;
  assert.equal(context.instance.data.importDialog.visible, true, '读取文件后应打开导入密码弹窗');
  await context.instance.onImportConfirm({ detail: { values: { filePassword: 'separate-backup-pass' } } });
  assert.deepEqual(importArgs, ['{"magic":"PWMA","format":1,"meta":{"kdf":"PBKDF2"},"envelope":{}}', 'separate-backup-pass', SESSION_KEY]);
  assert.ok(context.wx.calls.toasts.some(item => /导入 2 条/.test(item.title)));
  assert.equal(context.instance.data.importDialog.visible, false);
});

test('index awaits pin mutation with the session key before reloading', async () => {
  let resolveMutation;
  let mutationArgs;
  let reloadCount = 0;
  const pageContext = makePage('index', {
    storage: {
      togglePin: (...args) => {
        mutationArgs = args;
        return new Promise(resolve => { resolveMutation = resolve; });
      },
    },
  });
  const page = pageContext.instance;
  page.loadData = async () => { reloadCount++; };
  page.onPasswordLongPress({
    currentTarget: { dataset: { item: { id: 'entry-1', platform: '邮箱', pinned: false } } },
  });

  const operation = pageContext.wx.calls.actionSheets[0].success({ tapIndex: 0 });
  const reloadedBeforeMutation = reloadCount > 0;
  resolveMutation({ pinned: true });
  await operation;

  assert.deepEqual(mutationArgs, ['entry-1', SESSION_KEY]);
  assert.equal(reloadedBeforeMutation, false);
  assert.equal(reloadCount, 1);
});

test('index does not report a failed deletion as successful', async () => {
  let deleteArgs;
  const pageContext = makePage('index', {
    storage: {
      deletePassword: async (...args) => {
        deleteArgs = args;
        return false;
      },
      getAllPasswords: async () => [],
    },
  });
  const page = pageContext.instance;
  page.onPasswordLongPress({
    currentTarget: { dataset: { item: { id: 'entry-2', platform: '邮箱', pinned: false } } },
  });
  pageContext.wx.calls.actionSheets[0].success({ tapIndex: 1 });
  const operation = pageContext.wx.calls.modals[0].success({ confirm: true });
  await operation;

  assert.deepEqual(deleteArgs, ['entry-2', SESSION_KEY]);
  assert.equal(pageContext.wx.calls.toasts.some(item => item.icon === 'success'), false);
});

test('add page awaits edit load and restores the security answer', async () => {
  const page = makePage('add', {
    storage: {
      getAllPasswords: async () => [{
        id: 'entry-3',
        platform: '邮箱',
        account: 'user@example.com',
        password: 'secret',
        securityQuestion: '母亲的名字',
        securityAnswer: '编辑回显答案',
      }],
    },
  }).instance;

  await page.onLoad({ id: 'entry-3' });
  assert.equal(page.data.form.securityAnswer, '编辑回显答案');
});

test('add page waits for asynchronous password generation', async () => {
  const page = makePage('add', {
    passwordGen: { generate: async () => 'Generated-Password-2!' },
  }).instance;

  await page.onGeneratePassword();
  assert.equal(page.data.form.password, 'Generated-Password-2!');
});

test('add and edit saves pass the session key and suppress success on failure', async t => {
  for (const isEdit of [false, true]) {
    await t.test(isEdit ? 'edit' : 'add', async () => {
      let writeArgs;
      const pageContext = makePage('add', {
        storage: {
          getAllPasswords: async () => [],
          addPassword: (...args) => {
            writeArgs = args;
            const rejected = Promise.reject(new Error('write failed'));
            rejected.catch(() => {});
            return rejected;
          },
          updatePassword: (...args) => {
            writeArgs = args;
            const rejected = Promise.reject(new Error('write failed'));
            rejected.catch(() => {});
            return rejected;
          },
        },
      });
      const page = pageContext.instance;
      page.data.isEdit = isEdit;
      page.data.editId = 'entry-4';
      page.data.form = {
        account: 'user@example.com',
        alias: '',
        bindPhone: '',
        notes: '',
        password: 'secret',
        platform: '邮箱',
        securityAnswer: 'answer',
        securityQuestion: 'question',
      };
      page.data.customFields = [];

      await page.onSave();
      assert.equal(writeArgs[isEdit ? 2 : 1], SESSION_KEY);
      assert.equal(pageContext.wx.calls.toasts.some(item => item.icon === 'success'), false);
      assert.equal(pageContext.wx.calls.navigatedBack, undefined);
    });
  }
});

function fillSaveForm(page, isEdit = false) {
  page.data.isEdit = isEdit;
  page.data.editId = isEdit ? 'entry-save-once' : '';
  page.data.form = {
    platform: '邮箱', account: 'save-once@example.com', password: 'test-save-secret',
    alias: '', notes: '', bindPhone: '', securityQuestion: '', securityAnswer: '',
  };
  page.data.canSave = true;
}

test('add saves only once while capacity is being read and after success', async () => {
  let finishCapacityRead;
  let readCount = 0;
  let writeCount = 0;
  const capacityRead = new Promise(resolve => { finishCapacityRead = resolve; });
  const context = makePage('add', {
    storage: {
      getAllPasswords: () => { readCount++; return capacityRead; },
      addPassword: async () => { writeCount++; return { id: 'entry-save-once' }; },
    },
  });
  const page = context.instance;
  fillSaveForm(page);
  const first = page.onSave();
  const repeated = page.onSave();
  finishCapacityRead([]);
  await Promise.all([first, repeated]);
  await page.onSave();

  assert.equal(readCount, 1);
  assert.equal(writeCount, 1);
  assert.equal(context.wx.calls.toasts.filter(item => item.icon === 'success').length, 1);
});

test('editing saves only once while a write is pending', async () => {
  let finishWrite;
  let writeCount = 0;
  const pendingWrite = new Promise(resolve => { finishWrite = resolve; });
  const context = makePage('add', {
    storage: { updatePassword: () => { writeCount++; return pendingWrite; } },
  });
  const page = context.instance;
  fillSaveForm(page, true);
  const first = page.onSave();
  const repeated = page.onSave();
  finishWrite({ id: 'entry-save-once' });
  await Promise.all([first, repeated]);

  assert.equal(writeCount, 1);
  assert.equal(context.wx.calls.toasts.filter(item => item.icon === 'success').length, 1);
});

test('save failures release submission state so the same form can be retried', async t => {
  for (const failure of ['read', 'capacity', 'write', 'empty-result']) {
    await t.test(failure, async () => {
      let shouldFail = true;
      let successfulWrites = 0;
      const context = makePage('add', {
        storage: {
          getAllPasswords: async () => {
            if (failure === 'read' && shouldFail) throw new Error('simulated read failure');
            return [];
          },
          addPassword: async () => {
            if (shouldFail && failure === 'write') throw new Error('simulated write failure');
            if (shouldFail && failure === 'empty-result') return null;
            successfulWrites++;
            return { id: 'entry-save-once' };
          },
        },
        member: { canAdd: () => ({ allowed: !(shouldFail && failure === 'capacity') }) },
      });
      const page = context.instance;
      fillSaveForm(page);
      await page.onSave();
      assert.equal(page.data.saving, false);
      assert.equal(context.wx.calls.toasts.some(item => item.icon === 'success'), false);
      shouldFail = false;
      await page.onSave();
      assert.equal(successfulWrites, 1);
      assert.equal(context.wx.calls.toasts.filter(item => item.icon === 'success').length, 1);
    });
  }
});

test('button stops the native tap before emitting its one public tap', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-btn/comp-btn.wxml'), 'utf8');
  assert.match(wxml, /catchtap="onTap"/);
  assert.doesNotMatch(wxml, /\sbindtap="onTap"/);

  let definition;
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-btn/comp-btn.js'), 'utf8');
  vm.runInNewContext(source, { Component(value) { definition = value; } });
  const events = [];
  const button = {
    data: { disabled: false },
    triggerEvent: (...args) => events.push(args),
  };
  definition.methods.onTap.call(button, { detail: { x: 12, y: 34 } });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'tap');
  button.data.disabled = true;
  definition.methods.onTap.call(button, { detail: {} });
  assert.equal(events.length, 1);
});

test('detail awaits decrypted records before rendering', async () => {
  const page = makePage('detail', {
    storage: {
      getAllPasswords: async key => {
        assert.equal(key, SESSION_KEY);
        return [{ id: 'entry-5', platform: '邮箱', account: 'user@example.com' }];
      },
    },
    member: { canCopy: () => ({ allowed: true }) },
  }).instance;
  page.data.id = 'entry-5';

  await page.loadDetail();
  assert.equal(page.data.account, 'user@example.com');
});

test('concealed field copy requires awaited master-password reauthentication', async () => {
  let resolveVerification;
  let verifyArgs;
  const pageContext = makePage('detail', {
    storage: {
      verifyMasterPassword: (...args) => {
        verifyArgs = args;
        return new Promise(resolve => { resolveVerification = resolve; });
      },
    },
  });
  const page = pageContext.instance;
  page.data.displayFields = [{
    concealed: true,
    isCardno: false,
    label: 'SSH 密钥',
    rePrompt: true,
    value: 'concealed-secret',
  }];
  const operation = page.onCopyField({ currentTarget: { dataset: { index: 0 } } });

  assert.equal(pageContext.wx.calls.clipboard.length, 0);
  assert.equal(page.data.repromptDialog.visible, true);
  const promptOperation = page.onRepromptConfirm({
    detail: { values: { password: 'entered-master-password' } },
  });
  resolveVerification({ success: true, masterKey: SESSION_KEY });
  await Promise.all([operation, promptOperation]);

  assert.deepEqual(verifyArgs, ['entered-master-password']);
  assert.deepEqual(pageContext.wx.calls.clipboard, ['concealed-secret']);
});

test('concealed and rePrompt fields both require reauthentication before copy', async t => {
  for (const field of [
    { concealed: true, rePrompt: false, label: 'SSH 私钥', value: 'private-key' },
    { concealed: false, rePrompt: true, label: '卡号', value: '1234567890123456' },
  ]) {
    await t.test(field.label, async () => {
      const pageContext = makePage('detail');
      const page = pageContext.instance;
      page.data.displayFields = [field];

      page.onCopyField({ currentTarget: { dataset: { index: 0 } } });

      assert.equal(pageContext.wx.calls.clipboard.length, 0);
      assert.equal(page.data.repromptDialog.visible, true);
      const operation = page.onRepromptConfirm({
        detail: { values: { password: 'entered-master-password' } },
      });
      await operation;
      assert.deepEqual(pageContext.wx.calls.clipboard, [field.value]);
    });
  }
});

test('concealed custom-field copy requires master-password reauthentication', async () => {
  const pageContext = makePage('detail');
  const page = pageContext.instance;
  page.data.customFields = [{
    concealed: true,
    label: '恢复码',
    value: 'recovery-secret',
  }];

  page.onCopyCustom({ currentTarget: { dataset: { index: 0 } } });

  assert.equal(pageContext.wx.calls.clipboard.length, 0);
  assert.equal(page.data.repromptDialog.visible, true);
  await page.onRepromptConfirm({
    detail: { values: { password: 'entered-master-password' } },
  });
  assert.deepEqual(pageContext.wx.calls.clipboard, ['recovery-secret']);
});

test('detail does not report a failed deletion as successful', async () => {
  let deleteArgs;
  const pageContext = makePage('detail', {
    storage: {
      deletePassword: async (...args) => {
        deleteArgs = args;
        return false;
      },
    },
  });
  const page = pageContext.instance;
  page.data.id = 'entry-6';
  page.data.title = '邮箱';
  page.onDelete();
  const operation = pageContext.wx.calls.modals[0].success({ confirm: true });
  await operation;

  assert.deepEqual(deleteArgs, ['entry-6', SESSION_KEY]);
  assert.equal(pageContext.wx.calls.toasts.some(item => item.icon === 'success'), false);
  assert.equal(pageContext.wx.calls.navigatedBack, undefined);
});

test('member refresh awaits decrypted records', async () => {
  const page = makePage('member', {
    storage: {
      getAllPasswords: async key => {
        assert.equal(key, SESSION_KEY);
        return [{ id: 'entry-7', is_deleted: false }];
      },
    },
  }).instance;

  await page.refresh();
  assert.match(page.data.capacityText, /已用 1 条/);
});

test('member payment rejection always clears paying and warns against duplicate orders', async () => {
  const rejected = Promise.reject(new Error('payment status unavailable'));
  rejected.catch(() => {});
  const pageContext = makePage('member', {
    member: {
      requestPay: () => rejected,
    },
  });
  const page = pageContext.instance;
  page.data.payEnabled = true; // 模拟上线后购买开放状态

  await page.onPay();

  assert.equal(page.data.paying, false);
  assert.equal(pageContext.wx.calls.modals.length, 1);
  assert.match(pageContext.wx.calls.modals[0].content, /支付状态可能仍在确认|勿重复下单/);
});

test('member payment synchronous throw always clears paying and warns against duplicate orders', async () => {
  const pageContext = makePage('member', {
    member: {
      requestPay: () => {
        throw new Error('payment setup failed');
      },
    },
  });
  const page = pageContext.instance;
  page.data.payEnabled = true; // 模拟上线后购买开放状态

  await page.onPay();

  assert.equal(page.data.paying, false);
  assert.equal(pageContext.wx.calls.modals.length, 1);
  assert.equal(pageContext.wx.calls.modals[0].title, '支付状态待确认');
  assert.match(pageContext.wx.calls.modals[0].content, /支付状态可能仍在确认|勿重复下单/);
  assert.equal(pageContext.wx.calls.toasts.length, 0);
});

test('settings export uses the master password and passes backup meta for pickup registration', async () => {
  let exportArgs;
  const pageContext = makePage('settings', {
    storage: {
      getAllPasswords: async key => {
        assert.equal(key, SESSION_KEY);
        return [{ id: 'entry-8', password: 'vault-secret', is_deleted: false }];
      },
      getMasterPassword: () => SESSION_KEY,
    },
    export: {
      exportEncrypted: async (...args) => {
        exportArgs = args;
        return 'PWMA:encrypted-backup';
      },
    },
  });

  await pageContext.instance.onBackup();
  assert.equal(exportArgs[1], SESSION_KEY, '备份加密密码=主密码');
  assert.equal(exportArgs[1], pageContext.instance.data ? exportArgs[1] : exportArgs[1]);
  assert.deepEqual(pageContext.wx.calls.clipboard, []);
});

test('settings does not copy anything when encrypted backup generation fails', async () => {
  const pageContext = makePage('settings', {
    storage: {
      getAllPasswords: async () => [{ id: 'entry-9', password: 'secret' }],
      getMasterPassword: () => 'master-pass-1',
    },
    export: {
      exportEncrypted: async () => { throw new Error('encryption failed'); },
    },
  });

  await pageContext.instance.onBackup();

  assert.deepEqual(pageContext.wx.calls.clipboard, []);
  assert.ok(pageContext.wx.calls.modals.some(m => /encryption failed/.test(m.content || '')), '真实错误经 modal 透传');
});

test('settings does not fall back to plaintext when encrypted export is unavailable', async () => {
  const pageContext = makePage('settings', {
    storage: {
      getAllPasswords: async () => [{ id: 'entry-10', password: 'secret' }],
      getMasterPassword: () => 'master-pass-1',
    },
    export: { exportEncrypted: undefined },
  });

  await pageContext.instance.onBackup();

  assert.deepEqual(pageContext.wx.calls.clipboard, []);
  assert.ok(pageContext.wx.calls.modals.some(m => /加密导出不可用/.test(m.content || '')), '真实错误经 modal 透传');
});

test('lock component awaits master-password setup and verification', async t => {
  const lockWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'),
    'utf8'
  );
  assert.doesNotMatch(lockWxml, /type="number"/);
  assert.equal((lockWxml.match(/type="text"/g) || []).length, 3);

  await t.test('first-time setup stores only the returned session key', async () => {
    const componentContext = makeComponent('comp-lock-screen');
    const component = componentContext.instance;
    component.data.isFirstUse = true;
    component.data.step = 1;
    component.data.password = 'new-master-password';
    component.data.confirmPassword = 'new-master-password';
    component.data.canSubmit = true;

    await component.onSubmit();
    assert.equal(componentContext.app.globalData.masterKey, SESSION_KEY);
    assert.equal(componentContext.app.globalData.isLocked, false);
    assert.equal(componentContext.wx.calls.relaunches.length, 1);
  });

  await t.test('prevents duplicate submission while deriving the key', async () => {
    let resolveSetup;
    let setupCalls = 0;
    const componentContext = makeComponent('comp-lock-screen', {
      storage: {
        setMasterPassword: () => {
          setupCalls++;
          return new Promise(resolve => {
            resolveSetup = resolve;
          });
        },
      },
    });
    const component = componentContext.instance;
    component.data.isFirstUse = true;
    component.data.step = 1;
    component.data.password = 'new-master-password';
    component.data.confirmPassword = 'new-master-password';
    component.data.canSubmit = true;

    const firstSubmit = component.onSubmit();
    const secondSubmit = component.onSubmit();
    assert.equal(setupCalls, 1);
    assert.equal(component.data.submitting, true);
    resolveSetup({ success: true, masterKey: SESSION_KEY });
    await Promise.all([firstSubmit, secondSubmit]);
    assert.equal(componentContext.wx.calls.relaunches.length, 1);
  });

  await t.test('shows migration failures instead of counting them as wrong passwords', async () => {
    const componentContext = makeComponent('comp-lock-screen', {
      storage: {
        setMasterPassword: async () => ({
          success: false,
          migration: { failed_ids: ['legacy-entry'] },
        }),
      },
    });
    const component = componentContext.instance;
    component.data.isFirstUse = true;
    component.data.step = 1;
    component.data.password = 'new-master-password';
    component.data.confirmPassword = 'new-master-password';
    component.data.canSubmit = true;

    await component.onSubmit();
    assert.match(component.data.errorMsg, /迁移未完成/);
    assert.equal(component.data.attemptCount, 0);
    assert.equal(component.data.submitting, false);
  });

  await t.test('existing password verification awaits its result', async () => {
    const componentContext = makeComponent('comp-lock-screen', {
      storage: {
        verifyMasterPassword: async password => ({
          success: password === 'existing-master-password',
          masterKey: SESSION_KEY,
        }),
      },
    });
    const component = componentContext.instance;
    component.data.isFirstUse = false;
    component.data.password = 'existing-master-password';
    component.data.canSubmit = true;

    await component.onSubmit();
    assert.equal(componentContext.app.globalData.masterKey, SESSION_KEY);
    assert.equal(componentContext.app.globalData.isLocked, false);
    assert.equal(componentContext.wx.calls.relaunches.length, 1);
  });
});

test('unwrapped biometric unlock entrances and promises are absent from scoped UI', () => {
  const settingsWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxml'), 'utf8');
  const lockWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');
  const detailJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/detail/detail.js'), 'utf8');
  const memberJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  const payJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/pay/index.js'), 'utf8');
  const lock = makeComponent('comp-lock-screen');
  const settings = makePage('settings');

  assert.doesNotMatch(settingsWxml, /生物解锁|指纹\/面容解锁|onBiometricToggle/);
  assert.doesNotMatch(lockWxml, /canBiometric|生物识别|指纹\s*\/\s*面容/);
  assert.doesNotMatch(detailJs, /startSoterAuthentication|_biometric_enabled/);
  assert.doesNotMatch(memberJs, /指纹\/面容解锁/);
  assert.doesNotMatch(payJs, /指纹|面容|生物识别/);
  assert.equal(typeof settings.definition.onBiometricToggle, 'undefined');
  assert.equal(typeof lock.definition.methods.onBiometric, 'undefined');
});

test('member expiry notice avoids unconditional retention and access promises', () => {
  const memberWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');

  assert.doesNotMatch(memberWxml, /已存内容永久保留、随时可看可导出/);
  assert.match(memberWxml, /会员到期后.*新增和部分编辑.*可能受限/);
  assert.match(memberWxml, /查看、复制、导出、删除.*当前服务状态/);
  assert.match(memberWxml, /云端或备份.*另行核实/);
});

test('security answer is bound in the add/edit form', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/add/add.wxml'), 'utf8');
  assert.match(wxml, /value="\{\{form\.securityAnswer\}\}"/);
  assert.match(wxml, /bindinput="onSecAInput"/);
});

test('in-app API reference doc covers endpoints, crypto format and is reachable', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  assert.ok(appJson.pages.includes('pages/api-docs/api-docs'), '文档页应注册到 app.json');

  const docJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/api-docs/api-docs.js'), 'utf8');
  for (const token of ['/v1/token', '/v1/vault/meta', '/v1/items', 'PBKDF2-HMAC-SHA256', 'vault-verifier:v1', 'rate_limited', 'encryptionKey']) {
    assert.ok(docJs.includes(token), `文档应覆盖 ${token}`);
  }

  // 授权页有入口
  const accessJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/api-access/api-access.js'), 'utf8');
  const accessWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/api-access/api-access.wxml'), 'utf8');
  assert.match(accessJs, /pages\/api-docs\/api-docs/);
  assert.match(accessWxml, /在小程序内查看文档/);
  // 静态文档页入口（可复制链接发给 AI，2026-10-24 新增）
  assert.match(accessWxml, /一键复制链接/);
  assert.match(accessJs, /api-doc\.html/);

  // 仓库文档存在且含关键规范
  const md = fs.readFileSync(path.join(ROOT, 'docs/openapi-reference.md'), 'utf8');
  assert.match(md, /PBKDF2-HMAC-SHA256/);
  assert.match(md, /AAD/);
  assert.match(md, /code_expired/);
});

test('virtual payment available on all platforms (no iOS gating, must use wx.requestVirtualPayment)', () => {
  // 微信规则（2026 审核口径）：虚拟商品购买必须接入小程序虚拟支付能力，该能力已支持 iOS；
  // 不得在 iOS 端屏蔽购买入口（会被判定"提供虚拟商品但未接入虚拟支付能力"）。
  const memberJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  const memberUtil = fs.readFileSync(
    path.join(ROOT, 'miniprogram/utils/member.js'), 'utf8');
  assert.match(memberUtil, /requestVirtualPayment/, '支付必须走官方虚拟支付能力');
  assert.doesNotMatch(memberJs, /payEnabled\s*=\s*false/, '不得按平台关闭购买入口');
  assert.doesNotMatch(memberJs, /platform\.isIOS\(\)/, '会员页不得按平台分支屏蔽购买');
  const apiWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/api-access/api-access.wxml'), 'utf8');
  assert.doesNotMatch(apiWxml, /hideVipCta/, '开放 API 页不得在 iOS 隐藏开通入口');
});
