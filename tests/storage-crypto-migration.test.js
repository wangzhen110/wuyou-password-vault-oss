const assert = require('node:assert/strict');
const CryptoJS = require('../miniprogram/utils/crypto-js.min');

function createHarness(seed = {}) {
  const store = { ...seed };
  let nextByte = 1;
  let failWriteKey = null;
  const app = { globalData: { isLocked: false, masterKey: null, openid: null } };

  global.wx = {
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '';
    },
    setStorageSync(key, value) {
      if (failWriteKey === key) {
        failWriteKey = null;
        throw new Error('simulated storage write failure');
      }
      store[key] = value;
    },
    removeStorageSync(key) {
      delete store[key];
    },
    getRandomValues({ length, success }) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        bytes[index] = nextByte++ & 0xff;
      }
      success({ randomValues: bytes.buffer });
    },
    cloud: {
      callFunction({ fail }) {
        if (fail) fail(new Error('cloud unavailable'));
      },
    },
  };
  global.getApp = () => app;
  delete require.cache[require.resolve('../miniprogram/utils/storage')];

  return {
    app,
    store,
    storage: require('../miniprogram/utils/storage'),
    failNextWrite(key) {
      failWriteKey = key;
    },
  };
}

function legacyHash(password, salt) {
  let hash = CryptoJS.SHA256(password + ':' + salt);
  for (let index = 0; index < 500; index++) {
    hash = CryptoJS.SHA256(hash.toString() + ':' + salt);
  }
  return hash.toString();
}

async function main() {
  {
    const { app, store, storage } = createHarness();
    const password = 'correct horse battery staple';
    const setup = await storage.setMasterPassword(password);

    assert.equal(setup.success, true);
    assert.ok(setup.masterKey && setup.masterKey.encryptionKey && setup.masterKey.macKey);
    assert.equal(app.globalData.masterKey, null);
    assert.equal(JSON.stringify(store).includes(password), false);
    assert.equal(Object.keys(store).some(key => /master_key_cache/i.test(key)), false);

    const created = await storage.addPassword({
      platform: '邮箱',
      account: 'user@example.com',
      password: 'entry-secret',
      securityQuestion: 'Question',
      securityAnswer: 'Answer-secret',
      notes: 'Private note',
      fields: [{ key: 'secret', value: 'field-secret', concealed: true }],
    }, setup.masterKey);
    assert.equal(created.securityAnswer, 'Answer-secret');
    assert.equal(JSON.stringify(store['pwd_passwords']).includes('entry-secret'), false);
    assert.equal(JSON.stringify(store['pwd_passwords']).includes('Answer-secret'), false);
    assert.deepEqual(await storage.getAllPasswords(setup.masterKey), [created]);

    const encryptedRecord = store['pwd_passwords'][0];
    assert.equal(encryptedRecord.crypto_version, 1);
    assert.equal(encryptedRecord.salt, setup.meta.salt);
    assert.equal('account' in encryptedRecord, false);
    assert.equal('password' in encryptedRecord, false);

    const updated = await storage.updatePassword(created.id, {
      ...created,
      password: 'updated-secret',
    }, setup.masterKey);
    assert.equal(updated.password, 'updated-secret');
    assert.equal(JSON.stringify(store['pwd_passwords']).includes('updated-secret'), false);
    assert.deepEqual(await storage.getAllPasswords(setup.masterKey), [updated]);
    await assert.rejects(storage.getAllPasswords(), /密钥|解锁/);
    assert.equal(storage.getMasterKey(), null);
  }

  {
    const password = 'legacy master password';
    const salt = 'legacy-salt';
    const legacyEntry = {
      id: 'legacy-entry',
      platform: '旧条目',
      account: 'legacy-user',
      password: 'legacy-secret',
      securityAnswer: 'legacy-answer',
      created_at: '2025-01-01 10:00',
      updated_at: '2025-01-02 10:00',
    };
    const { store, storage } = createHarness({
      'pwd_master_hash': legacyHash(password, salt),
      'pwd_master_salt': salt,
      'pwd_passwords': [legacyEntry],
    });

    const unlock = await storage.verifyMasterPassword(password);
    assert.equal(unlock.success, true);
    assert.equal(unlock.legacy, true);
    assert.ok(unlock.masterKey);

    const first = unlock.migration;
    assert.deepEqual(first.migrated_ids, ['legacy-entry']);
    assert.deepEqual(first.failed_ids, []);
    assert.equal(JSON.stringify(store['pwd_passwords']).includes('legacy-secret'), false);
    assert.equal(JSON.stringify(store['pwd_passwords']).includes('legacy-answer'), false);
    assert.deepEqual(await storage.getAllPasswords(unlock.masterKey), [{
      ...legacyEntry,
      api_access: false,
      created_at: new Date(legacyEntry.created_at).toISOString(),
      updated_at: new Date(legacyEntry.updated_at).toISOString(),
      created_timestamp: new Date(legacyEntry.created_at).getTime(),
    }]);

    const second = await storage.migrateLegacyPasswords(unlock.masterKey, unlock.meta);
    assert.deepEqual(second.migrated_ids, []);
    assert.deepEqual(second.failed_ids, []);
    assert.deepEqual(await storage.getAllPasswords(unlock.masterKey), [{
      ...legacyEntry,
      api_access: false,
      created_at: new Date(legacyEntry.created_at).toISOString(),
      updated_at: new Date(legacyEntry.updated_at).toISOString(),
      created_timestamp: new Date(legacyEntry.created_at).getTime(),
    }]);
    assert.equal('master_hash' in store, false);
  }

  {
    const { app, store, storage } = createHarness();
    const oldPassword = 'original master password';
    const created = await storage.setMasterPassword(oldPassword);
    app.globalData.masterKey = created.masterKey;
    await storage.addPassword({
      platform: 'rotation-regression',
      account: 'user',
      password: 'preserve-this-secret',
    }, created.masterKey);
    const beforeMeta = JSON.stringify(store['pwd_vault_meta']);
    const beforeRecords = JSON.stringify(store['pwd_passwords']);
    const beforeQueue = JSON.stringify(store['pwd_pending_sync'] || []);

    const result = await storage.changeMasterPassword(oldPassword, 'replacement master password');

    // 主密码轮换已实现：成功后记录重加密、内容保留、旧密码失效、新密码可用。
    assert.equal(result.success, true, result.error);
    assert.equal(result.reencrypted, 1);
    assert.notEqual(JSON.stringify(store['pwd_vault_meta']), beforeMeta);
    assert.notEqual(JSON.stringify(store['pwd_passwords']), beforeRecords);
    assert.equal((await storage.verifyMasterPassword(oldPassword)).success, false);
    assert.equal((await storage.verifyMasterPassword('replacement master password')).success, true);
    const entries = await storage.getAllPasswords(result.masterKey);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].password, 'preserve-this-secret');
    // storage 不擅自改会话密钥；页面负责把 globalData.masterKey 换成 result.masterKey
    assert.equal(app.globalData.masterKey, created.masterKey);
    // 换主密码后，待同步队列必须满足三条：
    // ① 原有未上传任务不能丢（条目数不减）
    // ② 新增 update 任务重传重新加密的数据（否则云端留着旧密钥密文，新密码解不开）
    // ③ 队列内容随主密码变化（密文确实被重加密）
    const queueAfter = store['pwd_pending_sync'] || [];
    const queueBefore = JSON.parse(beforeQueue);
    assert.ok(queueAfter.length >= queueBefore.length,
      '待同步队列不能丢条目（未上传改动不得静默丢失）');
    assert.ok(queueAfter.some(q => q.action === 'update'),
      '换主密码后应新增 update 任务，重传重新加密的数据');
    assert.notEqual(JSON.stringify(queueAfter), beforeQueue,
      '待同步队列的密文必须随主密码重新加密');
  }

  {
    const legacyEntry = {
      id: 'keep-on-failure',
      platform: '保留',
      account: 'user',
      password: 'source-secret',
    };
    const { store, storage, failNextWrite } = createHarness({
      'pwd_passwords': [legacyEntry],
    });
    const crypto = require('../miniprogram/utils/crypto');
    const { meta, keys } = await crypto.createVaultMeta('migration password');
    failNextWrite('pwd_passwords');

    const result = await storage.migrateLegacyPasswords(keys, meta);
    assert.deepEqual(result.migrated_ids, []);
    assert.deepEqual(result.failed_ids, ['keep-on-failure']);
    assert.deepEqual(store['pwd_passwords'], [legacyEntry]);
  }

  {
    const { app, storage } = createHarness();
    await assert.rejects(storage.getAllPasswords(), /密钥|解锁/);
    app.globalData.isLocked = true;
    await assert.rejects(storage.getAllPasswords({ encryptionKey: {}, macKey: {} }), /锁定/);
  }

  console.log('storage-crypto-migration: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
