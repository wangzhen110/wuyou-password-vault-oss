const assert = require('node:assert/strict');
const test = require('node:test');
const nodeCrypto = require('node:crypto');
const CryptoJS = require('../miniprogram/utils/crypto-js.min');
const crypto = require('../miniprogram/utils/crypto');

async function harness(options = {}) {
  const keys = {
    encryptionKey: CryptoJS.enc.Hex.parse('11'.repeat(32)),
    macKey: CryptoJS.enc.Hex.parse('22'.repeat(32)),
  };
  const meta = {
    crypto_version: 1, kdf: crypto.KDF, iterations: crypto.KDF_ITERATIONS,
    salt: '33'.repeat(16),
    verifier: CryptoJS.HmacSHA256('vault-verifier:v1', keys.macKey).toString(),
  };
  const app = { globalData: {
    openid: 'current-user', verifiedOpenid: 'current-user',
    masterKey: keys, isLocked: false, syncAllowed: false,
  } };
  const store = { pwd_vault_meta: meta, pwd_passwords: [], pwd_pending_sync: [], pwd_sync_blocked: true };
  const calls = [];
  let remoteMeta = options.remoteMeta || null;
  global.getApp = () => app;
  global.wx = {
    getStorageSync: key => Object.hasOwn(store, key) ? store[key] : '',
    setStorageSync(key, value) {
      if (options.failWrite && options.failWrite(key, value)) throw new Error('storage write failed');
      store[key] = value;
    },
    removeStorageSync: key => { delete store[key]; },
    getRandomValues({ length, success }) {
      success({ randomValues: Uint8Array.from(nodeCrypto.randomBytes(length)).buffer });
    },
    cloud: { callFunction(request) {
      calls.push(request.data.action);
      if (options.onCloud && options.onCloud(request, { store, app, meta }) === false) return;
      if (request.data.action === 'get_vault_meta') {
        request.success({ result: { success: true, exists: !!remoteMeta, vault_meta: remoteMeta } });
      } else if (request.data.action === 'set_vault_meta') {
        remoteMeta = options.concurrentMeta || remoteMeta || request.data.vault_meta;
        request.success({ result: { success: true, vault_meta: remoteMeta } });
      } else { throw new Error('Binding must not upload password records'); }
    } },
  };
  const envelope = await crypto.encryptRecord({ id: 'test-record', password: 'synthetic-only' }, keys, meta);
  store.pwd_passwords = [envelope];
  store.pwd_pending_sync = [{ queue_id: 'q1', collection: 'passwords', id: envelope.id, action: 'update', data: envelope }];
  delete require.cache[require.resolve('../miniprogram/utils/storage')];
  const storage = require('../miniprogram/utils/storage');
  return { store, app, keys, meta, calls, storage,
    claim: () => storage.claimLocalVaultOwner('current-user', keys, meta) };
}

test('binding preserves encrypted records and the pending queue', async () => {
  const h = await harness();
  const records = JSON.stringify(h.store.pwd_passwords);
  const queue = JSON.stringify(h.store.pwd_pending_sync);
  assert.equal((await h.claim()).success, true);
  assert.equal(h.storage.canSync(), true);
  assert.deepEqual(h.calls, ['get_vault_meta', 'set_vault_meta']);
  assert.equal(JSON.stringify(h.store.pwd_passwords), records);
  assert.equal(JSON.stringify(h.store.pwd_pending_sync), queue);
});

test('both owner markers must agree with the verified account', async () => {
  const h = await harness();
  h.store.pwd_sync_owner_openid = 'current-user';
  h.store.pwd_openid = 'another-user';
  assert.equal((await h.claim()).success, false);
  assert.deepEqual(h.calls, []);
});

test('a locked or unverified session cannot bind', async () => {
  const h = await harness();
  h.app.globalData.isLocked = true;
  assert.equal((await h.claim()).success, false);
  h.app.globalData.isLocked = false;
  h.app.globalData.openid = 'another-user';
  assert.equal((await h.claim()).success, false);
  assert.deepEqual(h.calls, []);
});

test('different cloud metadata keeps local records and isolation', async () => {
  const h = await harness({ remoteMeta: { version: 1, salt: '44'.repeat(16) } });
  assert.equal((await h.claim()).reason, 'remote_vault_conflict');
  assert.equal(h.store.pwd_sync_blocked, true);
  assert.equal(h.store.pwd_passwords.length, 1);
  assert.deepEqual(h.calls, ['get_vault_meta']);
});

test('a concurrent cloud vault creation cannot be overwritten', async () => {
  const h = await harness({ concurrentMeta: { version: 1, salt: '55'.repeat(16) } });
  assert.equal((await h.claim()).success, false);
  assert.equal(h.store.pwd_sync_blocked, true);
  assert.equal(h.store.pwd_sync_owner_openid, undefined);
});

test('identity changes during the metadata read never authorize binding', async () => {
  const h = await harness({ onCloud(request, { app }) {
    app.globalData.openid = 'another-user';
    app.globalData.verifiedOpenid = 'another-user';
  } });
  assert.equal((await h.claim()).success, false);
  assert.equal(h.store.pwd_sync_owner_openid, undefined);
  assert.equal(h.app.globalData.syncAllowed, false);
  assert.deepEqual(h.calls, ['get_vault_meta']);
});

test('locking while the cloud write is pending never clears isolation', async () => {
  const h = await harness({ onCloud(request, { app }) {
    if (request.data.action === 'set_vault_meta') app.globalData.isLocked = true;
  } });
  assert.equal((await h.claim()).success, false);
  assert.equal(h.store.pwd_sync_blocked, true);
  assert.equal(h.app.globalData.syncAllowed, false);
});

test('malformed records and queues cannot be bound', async () => {
  const h = await harness();
  h.store.pwd_pending_sync[0].collection = 'users';
  assert.equal((await h.claim()).success, false);
  assert.deepEqual(h.calls, []);
});

test('even an empty vault requires keys matching its verifier', async () => {
  const h = await harness();
  h.store.pwd_passwords = [];
  h.store.pwd_pending_sync = [];
  h.keys.macKey = CryptoJS.enc.Hex.parse('99'.repeat(32));
  assert.equal((await h.claim()).success, false);
  assert.deepEqual(h.calls, []);
});

test('a failed local ownership write leaves isolation enabled', async () => {
  const h = await harness({ failWrite: key => key === 'pwd_openid' });
  assert.equal((await h.claim()).success, false);
  assert.equal(h.store.pwd_sync_blocked, true);
  assert.equal(h.app.globalData.syncAllowed, false);
  assert.equal(h.store.pwd_sync_owner_openid, undefined);
});
