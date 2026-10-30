// iOS 解锁卡死修复的行为测试（2026-10-25）
// 背景：解锁成功后 unlocked=true，finally 不再复位 submitting；
//       若 wx.reLaunch 静默失败，按钮永久停在「解密中」。没有 iPhone 无法真机验证，
//       这里用桩件真实执行「跳转失败」分支，证明恢复逻辑有效。
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const LOCK_COMPONENT = path.join(__dirname, '..', 'miniprogram', 'components', 'comp-lock-screen', 'comp-lock-screen.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 加载组件定义，依赖全部用桩件替换 */
function loadComponentDefinition(wxStub, storageStub) {
  const originalLoad = Module._load;
  let definition = null;
  global.Component = (def) => { definition = def; };
  global.wx = wxStub;
  global.getApp = () => ({ globalData: {} });

  Module._load = function (request, parent, isMain) {
    if (request.indexOf('utils/storage') >= 0) return storageStub;
    if (request.indexOf('utils/demo-mode') >= 0) return { isDemo: () => false };
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[require.resolve(LOCK_COMPONENT)];
  try {
    require(LOCK_COMPONENT);
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(definition && definition.methods, '组件定义应被捕获');
  return definition;
}

/** 构造只够跑解锁收尾逻辑的实例 */
function makeInstance(definition) {
  const instance = {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch, callback) {
      if (typeof patch === 'function') Object.assign(this.data, patch(this.data));
      else Object.assign(this.data, patch);
      if (typeof callback === 'function') callback();
    },
    _updateCanSubmit() {},
  };
  Object.assign(instance, definition.methods);
  return instance;
}

function baseWx(overrides) {
  return Object.assign({
    setStorageSync() {},
    getStorageSync() { return 0; },
    getPerformance() { return null; },
    showModal() {},
    reLaunch() {},
  }, overrides || {});
}

test('reLaunch 失败时：复位提交态并提示可再次进入（不再永久卡在解密中）', async () => {
  const definition = loadComponentDefinition(
    baseWx({
      reLaunch(options) {
        // 模拟 iOS 上跳转静默失败
        setTimeout(() => { if (options && options.fail) options.fail({ errMsg: 'reLaunch:fail' }); }, 0);
      },
    }),
    { hasMasterPassword: () => true }
  );

  const instance = makeInstance(definition);
  instance.setData({ submitting: true });

  instance._goHomeAfterUnlock('/pages/index/index');
  await sleep(600);

  assert.equal(instance.data.submitting, false, '失败后必须复位 submitting，否则按钮永久「解密中」');
  assert.match(instance.data.errorMsg, /已解锁/, '应提示已解锁并引导再次点击');
});

test('reLaunch 成功时：标记已完成，不得误触发恢复提示', async () => {
  const definition = loadComponentDefinition(
    baseWx({
      reLaunch(options) {
        setTimeout(() => { if (options && options.success) options.success({ errMsg: 'reLaunch:ok' }); }, 0);
      },
    }),
    { hasMasterPassword: () => true }
  );

  const instance = makeInstance(definition);
  instance.setData({ submitting: true, errorMsg: '' });

  instance._goHomeAfterUnlock('/pages/index/index');
  // 必须等过 1.5s 看门狗，确认成功路径不会被误判
  await sleep(1900);

  assert.equal(instance._wentHome, true, '成功跳转后应标记已完成');
  assert.equal(instance.data.errorMsg, '', '成功路径不应出现恢复提示');
});

test('reLaunch 既不 success 也不 fail（静默无回调）时：看门狗兜底恢复', async () => {
  const definition = loadComponentDefinition(
    baseWx({
      // 最坏情况：iOS 上跳转既不回调成功也不回调失败
      reLaunch() {},
    }),
    { hasMasterPassword: () => true }
  );

  const instance = makeInstance(definition);
  instance.setData({ submitting: true });

  instance._goHomeAfterUnlock('/pages/index/index');
  await sleep(1900); // 必须等过 1.5s 看门狗

  assert.equal(instance.data.submitting, false, '看门狗必须在无任何回调时也兜底复位，否则仍会永久卡死');
  assert.match(instance.data.errorMsg, /已解锁/, '应提示已解锁');
});

test('已解锁但跳转失败后，再次点击直接跳转，不重复跑 KDF', async () => {
  let verifyCalls = 0;
  let reLaunchCalls = 0;
  const definition = loadComponentDefinition(
    baseWx({
      reLaunch(options) {
        reLaunchCalls += 1;
        setTimeout(() => { if (options && options.success) options.success({}); }, 0);
      },
    }),
    {
      hasMasterPassword: () => true,
      verifyMasterPassword: async () => { verifyCalls += 1; return { success: false }; },
    }
  );

  const instance = makeInstance(definition);
  instance._unlockedTarget = '/pages/index/index';

  await instance.onSubmit();
  await sleep(400);

  assert.equal(verifyCalls, 0, '已解锁场景不应再次执行密码校验（避免用户二次等待）');
  assert.ok(reLaunchCalls >= 1, '应直接重新跳转');
});
