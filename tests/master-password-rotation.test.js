const assert = require('node:assert/strict');
const test = require('node:test');

const PASSWORDS_KEY = 'pwd_passwords';
const PENDING_SYNC_KEY = 'pwd_pending_sync';
const ROTATION_JOURNAL_KEY = 'pwd_rotation_journal';
const ROTATION_REMOTE_PENDING_KEY = 'pwd_rotation_meta_pending';

function createHarness() {
  const store = {};
  let nextByte = 1;
  const app = {
    globalData: {
      isLocked: false,
      masterKey: null,
      openid: 'rotation-user',
      verifiedOpenid: 'rotation-user',
      syncAllowed: true,
    },
  };
  let remoteMeta = null;
  const uploadRequests = [];
  let uploadFailures = 0;

  global.wx = {
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '';
    },
    setStorageSync(key, value) {
      store[key] = value;
    },
    removeStorageSync(key) {
      delete store[key];
    },
    getRandomValues({ length, success }) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) bytes[index] = nextByte++ & 0xff;
      success({ randomValues: bytes.buffer });
    },
    cloud: {
      callFunction({ data, success, fail }) {
        if (data.action === 'get_vault_meta') {
          success({ result: { success: true, exists: !!remoteMeta, vault_meta: remoteMeta } });
          return;
        }
        if (data.action === 'set_vault_meta') {
          // 模拟云端首写语义：已存在记录时不更新，返回旧值
          if (!remoteMeta) {
            remoteMeta = data.vault_meta;
            success({ result: { success: true, vault_meta: remoteMeta } });
          } else {
            success({ result: { success: true, vault_meta: remoteMeta } });
          }
          return;
        }
        if (data.action === 'rotate_vault_meta') {
          // 模拟云端 CAS 轮换：old 与当前一致才换新
          if (!remoteMeta) {
            success({ result: { success: false, error: 'vault_meta_not_found' } });
            return;
          }
          if (JSON.stringify(data.old_vault_meta) !== JSON.stringify(remoteMeta)) {
            success({ result: { success: false, error: 'vault_meta_mismatch' } });
            return;
          }
          remoteMeta = data.vault_meta;
          success({ result: { success: true, rotated: true, vault_meta: remoteMeta } });
          return;
        }
        if (data.action === 'full_sync') {
          success({
            result: {
              success: true,
              download_success: true,
              downloads: [],
              server_time: new Date().toISOString(),
              confirmed_queue_ids: (data.local_updates || []).map(item => item.queue_id),
            },
          });
          return;
        }
        if (data.action === 'upload') {
          if (uploadFailures > 0) {
            uploadFailures -= 1;
            fail(new Error('simulated upload failure'));
            return;
          }
          uploadRequests.push(data.local_updates);
          success({
            result: {
              success: true,
              confirmed_queue_ids: (data.local_updates || []).map(item => item.queue_id),
            },
          });
          return;
        }
        fail(new Error(`unexpected cloud action: ${data.action}`));
      },
    },
  };
  global.getApp = () => app;
  delete require.cache[require.resolve('../miniprogram/utils/storage')];
  delete require.cache[require.resolve('../miniprogram/utils/crypto')];

  return {
    app,
    store,
    storage: require('../miniprogram/utils/storage'),
    crypto: require('../miniprogram/utils/crypto'),
    setRemoteMeta(value) {
      remoteMeta = value;
    },
    getRemoteMeta() {
      return remoteMeta;
    },
    getUploadRequests() {
      return uploadRequests;
    },
    failNextUploads(count) {
      uploadFailures = count;
    },
  };
}

async function settle(times = 8) {
  for (let index = 0; index < times; index++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function setupVault(harness, { masterPassword = 'rotation old password' } = {}) {
  const { storage, app } = harness;
  assert.equal(storage.confirmLoginIdentity('rotation-user').allowed, true);
  const setup = await storage.setMasterPassword(masterPassword);
  assert.equal(setup.success, true);
  app.globalData.masterKey = setup.masterKey;
  app.globalData.isLocked = false;
  return setup;
}

async function addRecords(harness, count) {
  const { storage, app } = harness;
  for (let index = 0; index < count; index++) {
    const created = await storage.addPassword({
      platform: `平台${index}`,
      account: `user${index}`,
      password: `secret-${index}`,
    }, app.globalData.masterKey);
    assert.ok(created, '添加记录应成功');
  }
}

test('修改主密码：正常轮换后新密钥可解密、旧密钥不可解密，云端元数据随后更新', async () => {
  const harness = createHarness();
  const { storage, crypto } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 2);

  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, true, result.error);
  assert.equal(result.reencrypted, 2);

  // 本地元数据已换成新 meta
  const localMeta = storage.getLocalVaultMeta();
  assert.equal(localMeta.salt, result.meta.salt);
  assert.notEqual(localMeta.salt, setup.meta.salt);

  // 新密钥可解密全部记录，旧密钥不行
  const list = harness.store[PASSWORDS_KEY];
  assert.equal(list.length, 2);
  for (const record of list) {
    await crypto.decryptRecord(record, result.masterKey, record.id);
    await assert.rejects(() => crypto.decryptRecord(record, setup.masterKey, record.id));
  }

  // 上传完成后：全部记录上传、云端元数据换成新 meta、待更新标记清除
  await settle();
  const uploaded = harness.getUploadRequests().flat();
  assert.ok(uploaded.length >= 2, '轮换后应上传全部重加密记录');
  assert.ok(harness.getRemoteMeta(), '上传后云端元数据应存在');
  assert.ok(harness.getRemoteMeta(), '上传后云端元数据应存在');
  assert.equal(harness.getRemoteMeta().salt, result.meta.salt, '云端元数据应换成新 salt');
  assert.equal(harness.store[ROTATION_REMOTE_PENDING_KEY], undefined, '云端元数据确认后应清除待更新标记');
});

test('修改主密码：旧密码错误时拒绝且密码库不变', async () => {
  const harness = createHarness();
  const { storage, crypto } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);

  const recordsBefore = JSON.stringify(harness.store[PASSWORDS_KEY]);
  const metaBefore = JSON.stringify(storage.getLocalVaultMeta());

  const result = await storage.changeMasterPassword('wrong password', 'brand new password');
  assert.equal(result.success, false);
  assert.ok(result.error);

  assert.equal(JSON.stringify(harness.store[PASSWORDS_KEY]), recordsBefore, '记录不应变化');
  assert.equal(JSON.stringify(storage.getLocalVaultMeta()), metaBefore, '元数据不应变化');
  const list = harness.store[PASSWORDS_KEY];
  await crypto.decryptRecord(list[0], setup.masterKey, list[0].id);
});

test('修改主密码：新密码过短或与旧密码相同被拒绝', async () => {
  const harness = createHarness();
  const { storage } = harness;
  await setupVault(harness);

  const short = await storage.changeMasterPassword('rotation old password', '12345');
  assert.equal(short.success, false);

  const same = await storage.changeMasterPassword('rotation old password', 'rotation old password');
  assert.equal(same.success, false);
});

test('修改主密码：未设置主密码或锁定状态下拒绝', async () => {
  const harness = createHarness();
  const { storage, app } = harness;

  const noVault = await storage.changeMasterPassword('whatever', 'long enough password');
  assert.equal(noVault.success, false);

  await setupVault(harness);
  app.globalData.isLocked = true;
  app.globalData.masterKey = null;
  const locked = await storage.changeMasterPassword('rotation old password', 'long enough password');
  assert.equal(locked.success, false);
  app.globalData.isLocked = false;
});

test('修改主密码：记录损坏时整体中止，不做部分提交', async () => {
  const harness = createHarness();
  const { storage } = harness;
  await setupVault(harness);
  await addRecords(harness, 2);

  const broken = JSON.parse(JSON.stringify(harness.store[PASSWORDS_KEY]));
  broken[1].ciphertext = broken[1].ciphertext.replace(/.{4}$/, 'zzzz');
  harness.store[PASSWORDS_KEY] = broken;

  const recordsBefore = JSON.stringify(harness.store[PASSWORDS_KEY]);
  const metaBefore = JSON.stringify(storage.getLocalVaultMeta());

  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(harness.store[PASSWORDS_KEY]), recordsBefore, '记录不应被部分改写');
  assert.equal(JSON.stringify(storage.getLocalVaultMeta()), metaBefore, '元数据不应变化');
  assert.equal(harness.store[ROTATION_JOURNAL_KEY], undefined, '中止后不应残留轮换日志');
});

test('修改主密码：上传失败时云端元数据保持旧值，标记保留待重试', async () => {
  const harness = createHarness();
  const { storage } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);
  harness.setRemoteMeta({
    version: 1,
    kdf: setup.meta.kdf,
    iterations: setup.meta.iterations,
    salt: setup.meta.salt,
    verifier: setup.meta.verifier,
  });

  harness.failNextUploads(1);
  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, true, result.error);

  await settle();
  assert.equal(harness.getRemoteMeta().salt, setup.meta.salt, '上传失败时云端元数据不应变化');
  assert.equal(harness.store[ROTATION_REMOTE_PENDING_KEY], true, '失败后标记应保留以便重试');

  // 下次同步（手动 syncFromCloud）自动完成重试：先补上传再换云端元数据
  const retry = await storage.syncFromCloud(null, result.masterKey);
  assert.equal(retry.success, true, retry.error && retry.error.message);
  assert.equal(harness.getRemoteMeta().salt, result.meta.salt, '重试后云端元数据应更新');
  assert.equal(harness.store[ROTATION_REMOTE_PENDING_KEY], undefined, '成功后标记应清除');
});

test('修改主密码：云端已有旧元数据时轮换经 CAS 换新，手动同步自愈', async () => {
  const harness = createHarness();
  const { storage } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);

  // 模拟改密码前已同步：云端存在旧 salt 的元数据（set_vault_meta 首写语义）
  harness.setRemoteMeta({
    version: 1,
    kdf: setup.meta.kdf,
    iterations: setup.meta.iterations,
    salt: setup.meta.salt,
    verifier: setup.meta.verifier,
  });

  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, true, result.error);
  await settle();

  // 上传完成后 finalize 应经 rotate（CAS）把云端旧元数据换成新值
  assert.equal(harness.getRemoteMeta().salt, result.meta.salt, '云端元数据应已轮换为新值');
  assert.equal(harness.store[ROTATION_REMOTE_PENDING_KEY], undefined, '轮换收尾后标记应清除');

  // 手动同步不再报"加密参数不一致"
  const sync = await storage.syncFromCloud(null, result.masterKey);
  assert.equal(sync.success, true, sync.error && sync.error.message);
});

test('修改主密码：队列已空的收尾窗口由手动同步兜底完成', async () => {
  const harness = createHarness();
  const { storage } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);

  // 先同步一次让云端持有旧元数据（模拟日常使用）
  assert.equal((await storage.syncFromCloud(null, setup.masterKey)).success, true);

  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, true, result.error);
  await settle();

  // 模拟"上传确认后、收尾前"的中断残留：云端仍是旧值 + 标记保留 + 队列已空
  harness.setRemoteMeta({
    version: 1,
    kdf: setup.meta.kdf,
    iterations: setup.meta.iterations,
    salt: setup.meta.salt,
    verifier: setup.meta.verifier,
  });
  harness.store[ROTATION_REMOTE_PENDING_KEY] = true;
  assert.equal((harness.store[PENDING_SYNC_KEY] || []).length, 0, '队列应为空（收尾窗口特征）');

  // 手动同步必须能完成收尾（修复前：_doSync 队列空直接返回，收尾永不执行）
  const sync = await storage.syncFromCloud(null, result.masterKey);
  assert.equal(sync.success, true, sync.error && sync.error.message);
  assert.equal(harness.getRemoteMeta().salt, result.meta.salt, '云端元数据应更新为新值');
  assert.equal(harness.store[ROTATION_REMOTE_PENDING_KEY], undefined, '标记应清除');
});

test('轮换崩溃恢复：记录已是新密文时前滚补齐元数据与队列', async () => {
  const harness = createHarness();
  const { storage } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);

  const result = await storage.changeMasterPassword('rotation old password', 'brand new password');
  assert.equal(result.success, true);
  await settle();

  // 模拟崩溃残留：日志存在且 new_records 与当前记录一致
  const passwordsNow = harness.store[PASSWORDS_KEY];
  const pendingNow = harness.store[PENDING_SYNC_KEY] || [];
  harness.store[ROTATION_JOURNAL_KEY] = {
    old_meta: setup.meta,
    new_meta: storage.getLocalVaultMeta(),
    old_records: [],
    new_records: passwordsNow,
    old_pending: [],
    new_pending: pendingNow,
  };

  const recovery = storage.recoverInterruptedRotation();
  assert.equal(recovery.action, 'rolled_forward');
  assert.equal(harness.store[ROTATION_JOURNAL_KEY], undefined, '恢复后日志应清除');
  assert.equal(JSON.stringify(harness.store[PASSWORDS_KEY]), JSON.stringify(passwordsNow));
  assert.equal(JSON.stringify(harness.store[PENDING_SYNC_KEY]), JSON.stringify(pendingNow));
});

test('轮换崩溃恢复：记录仍为旧密文时回滚到一致旧状态', async () => {
  const harness = createHarness();
  const { storage, crypto } = harness;
  const setup = await setupVault(harness);
  await addRecords(harness, 1);

  const oldRecords = JSON.parse(JSON.stringify(harness.store[PASSWORDS_KEY]));
  harness.store[ROTATION_JOURNAL_KEY] = {
    old_meta: setup.meta,
    new_meta: {
      crypto_version: 1,
      kdf: 'PBKDF2-HMAC-SHA256',
      iterations: 600000,
      salt: 'a'.repeat(32),
      verifier: 'b'.repeat(64),
    },
    old_records: oldRecords,
    new_records: [],
    old_pending: [],
    new_pending: [],
  };

  const recovery = storage.recoverInterruptedRotation();
  assert.equal(recovery.action, 'rolled_back');
  assert.equal(harness.store[ROTATION_JOURNAL_KEY], undefined, '恢复后日志应清除');
  assert.equal(JSON.stringify(harness.store[PASSWORDS_KEY]), JSON.stringify(oldRecords), '记录应回到旧密文');
  assert.equal(storage.getLocalVaultMeta().salt, setup.meta.salt, '元数据应回到旧值');

  // 回滚后旧密钥仍可解密，密码库仍可用
  const list = harness.store[PASSWORDS_KEY];
  await crypto.decryptRecord(list[0], setup.masterKey, list[0].id);
});

test('轮换崩溃恢复：无日志时报告 none', async () => {
  const harness = createHarness();
  const { storage } = harness;
  await setupVault(harness);
  assert.equal(storage.recoverInterruptedRotation().action, 'none');
});
