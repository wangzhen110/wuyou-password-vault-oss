const assert = require('node:assert/strict');

function createHarness() {
  const store = {};
  let nextByte = 1;
  const app = {
    globalData: {
      isLocked: false,
      masterKey: null,
      openid: 'sync-user',
      verifiedOpenid: 'sync-user',
      syncAllowed: true,
    },
  };
  let fullSyncResult = null;
  let remoteMeta = null;
  const fullSyncRequests = [];

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
          remoteMeta = data.vault_meta;
          success({ result: { success: true, vault_meta: remoteMeta } });
          return;
        }
        if (data.action === 'full_sync') {
          fullSyncRequests.push({
            last_sync: data.last_sync,
            local_updates: data.local_updates,
          });
          const result = typeof fullSyncResult === 'function'
            ? fullSyncResult(data)
            : fullSyncResult;
          success({ result });
          return;
        }
        if (data.action === 'upload') {
          success({ result: { success: true, confirmed_queue_ids: [] } });
          return;
        }
        fail(new Error(`unexpected cloud action: ${data.action}`));
      },
    },
  };
  global.getApp = () => app;
  delete require.cache[require.resolve('../miniprogram/utils/storage')];

  return {
    app,
    store,
    storage: require('../miniprogram/utils/storage'),
    setFullSyncResult(value) {
      fullSyncResult = value;
    },
    setRemoteMeta(value) {
      remoteMeta = value;
    },
    getFullSyncRequests() {
      return fullSyncRequests;
    },
  };
}

async function createVault(storage, crypto) {
  const identity = storage.confirmLoginIdentity('sync-user');
  assert.equal(identity.allowed, true);
  const setup = await storage.setMasterPassword('storage sync regression password');
  assert.equal(setup.success, true);
  return { keys: setup.masterKey, meta: setup.meta, crypto };
}

async function testMergePreservesConcurrentLocalWrites() {
  const { store, storage } = createHarness();
  const crypto = require('../miniprogram/utils/crypto');
  const { keys, meta } = await createVault(storage, crypto);
  await storage.addPassword({ platform: 'existing', password: 'existing-secret' }, keys);

  const remote = await crypto.encryptRecord({
    id: 'remote-entry',
    platform: 'remote',
    password: 'remote-secret',
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:00:00.000Z',
  }, keys, meta);

  const originalDecrypt = crypto.decryptRecord;
  let announceDecrypt;
  let resumeDecrypt;
  const decryptStarted = new Promise(resolve => {
    announceDecrypt = resolve;
  });
  const decryptGate = new Promise(resolve => {
    resumeDecrypt = resolve;
  });
  crypto.decryptRecord = async (...args) => {
    if (args[0] && args[0].id === 'remote-entry') {
      announceDecrypt();
      await decryptGate;
    }
    return originalDecrypt(...args);
  };

  try {
    const merge = storage.mergeCloudData([{
      id: remote.id,
      collection: 'passwords',
      data: remote,
    }], keys, meta);
    await decryptStarted;
    const concurrentlyAdded = await storage.addPassword({
      platform: 'added-during-merge',
      password: 'concurrent-secret',
    }, keys);
    resumeDecrypt();
    await merge;

    const saved = store['pwd_passwords'];
    assert.equal(saved.some(item => item.id === concurrentlyAdded.id), true);
    assert.equal(saved.some(item => item.id === 'remote-entry'), true);
  } finally {
    resumeDecrypt();
    crypto.decryptRecord = originalDecrypt;
  }
}

async function testDownloadFailureDoesNotAdvanceCursor() {
  const {
    store,
    storage,
    setFullSyncResult,
    setRemoteMeta,
    getFullSyncRequests,
  } = createHarness();
  const crypto = require('../miniprogram/utils/crypto');
  const { keys, meta } = await createVault(storage, crypto);
  setRemoteMeta({
    version: meta.crypto_version,
    kdf: meta.kdf,
    iterations: meta.iterations,
    salt: meta.salt,
    verifier: meta.verifier,
  });
  store['pwd_last_sync_time'] = '2026-09-29T00:00:00.000Z';
  setFullSyncResult({
    success: false,
    download_success: false,
    downloads: [],
    error: 'download_failed',
    server_time: '2026-09-30T12:00:00.000Z',
  });

  const result = await storage.syncFromCloud(null, keys);
  assert.equal(result.success, false);
  assert.equal(getFullSyncRequests()[0].last_sync, null);
  assert.equal(store['pwd_last_sync_time'], '2026-09-29T00:00:00.000Z');
  assert.notEqual(store['pwd_full_sync_v1_complete'], true);
}

async function testSuccessfulDownloadAdvancesCursorAfterPartialUploadFailure() {
  const {
    store,
    storage,
    setFullSyncResult,
    setRemoteMeta,
  } = createHarness();
  const crypto = require('../miniprogram/utils/crypto');
  const { keys, meta } = await createVault(storage, crypto);
  setRemoteMeta({
    version: meta.crypto_version,
    kdf: meta.kdf,
    iterations: meta.iterations,
    salt: meta.salt,
    verifier: meta.verifier,
  });
  store['pwd_last_sync_time'] = '2026-09-29T00:00:00.000Z';
  setFullSyncResult({
    success: false,
    download_success: true,
    downloads: [],
    upload_results: [{ queue_id: 'failed-upload', success: false }],
    server_time: '2026-09-30T12:00:00.000Z',
  });

  const result = await storage.syncFromCloud(null, keys);
  assert.equal(result.success, false);
  assert.equal(store['pwd_last_sync_time'], '2026-09-30T12:00:00.000Z');
  assert.equal(store['pwd_full_sync_v1_complete'], true);
}

async function testFirstEncryptedSyncDownloadsCloudHistoryBeforeSavedCursor() {
  const { store, storage, setFullSyncResult, getFullSyncRequests } = createHarness();
  const identity = storage.confirmLoginIdentity('sync-user');
  assert.equal(identity.allowed, true);
  store['pwd_last_sync_time'] = '2026-09-29T00:00:00.000Z';
  store['pwd_passwords'] = [{
    id: 'legacy-local-entry',
    platform: 'legacy-local',
    password: 'legacy-local-secret',
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
  }];

  const setup = await storage.setMasterPassword('storage sync regression password');
  assert.equal(setup.success, true);
  const crypto = require('../miniprogram/utils/crypto');
  const historical = await crypto.encryptRecord({
    id: 'historical-cloud-entry',
    platform: 'historical-cloud',
    password: 'historical-cloud-secret',
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
  }, setup.masterKey, setup.meta);

  setFullSyncResult(data => ({
    success: true,
    download_success: true,
    downloads: !data.last_sync || new Date(historical.updated_at) > new Date(data.last_sync)
      ? [{ id: historical.id, collection: 'passwords', data: historical }]
      : [],
    server_time: '2026-09-30T12:00:00.000Z',
  }));

  const result = await storage.syncFromCloud(null, setup.masterKey);
  assert.equal(result.success, true);
  assert.equal(getFullSyncRequests()[0].last_sync, null);
  const passwords = await storage.getAllPasswords(setup.masterKey);
  assert.equal(passwords.some(item => item.id === historical.id), true);
  assert.equal(store['pwd_full_sync_v1_complete'], true);
}

async function testSyncEchoDoesNotDuplicateSavedRecord() {
  const { store, storage, setFullSyncResult, getFullSyncRequests } = createHarness();
  const crypto = require('../miniprogram/utils/crypto');
  const { keys, meta } = await createVault(storage, crypto);
  const entry = await storage.addPassword({
    platform: 'sync-echo-test', account: 'synthetic-account', password: 'synthetic-secret',
  }, keys);
  const envelope = store['pwd_passwords'][0];
  const echo = { id: entry.id, collection: 'passwords', data: envelope };
  setFullSyncResult(data => ({
    success: true,
    download_success: true,
    confirmed_queue_ids: data.local_updates.map(item => item.queue_id),
    downloads: [echo, echo],
    server_time: '2026-10-16T12:00:00.000Z',
  }));

  assert.equal((await storage.syncFromCloud(null, keys)).success, true);
  assert.equal((await storage.syncFromCloud(null, keys)).success, true);
  const concurrent = await Promise.all([
    storage.syncFromCloud(null, keys),
    storage.syncFromCloud(null, keys),
  ]);
  assert.equal(concurrent.every(result => result.success), true);
  assert.equal(getFullSyncRequests()[0].local_updates.length, 1);
  assert.equal(store['pwd_passwords'].length, 1);
  assert.equal(store['pwd_pending_sync'].length, 0);
  assert.deepEqual((await storage.getAllPasswords(keys)).map(item => item.id), [entry.id]);
  assert.equal(store['pwd_vault_meta'].salt, meta.salt);
}

async function testCloudDocumentAliasesKeepTheAuthenticatedRecordId() {
  const { store, storage } = createHarness();
  const crypto = require('../miniprogram/utils/crypto');
  const { keys, meta } = await createVault(storage, crypto);
  const entry = await storage.addPassword({ platform: 'alias-test', password: 'synthetic-secret' }, keys);
  const envelope = store['pwd_passwords'][0];
  store['pwd_pending_sync'] = [];
  await storage.mergeCloudData([
    { id: 'legacy-document-id', collection: 'passwords', data: envelope },
    { id: 'another-document-id', collection: 'passwords', data: envelope },
  ], keys, meta);
  assert.equal(store['pwd_passwords'].length, 1);
  assert.equal(store['pwd_passwords'][0].id, entry.id);
  assert.deepEqual((await storage.getAllPasswords(keys)).map(item => item.id), [entry.id]);
}

async function main() {
  await testMergePreservesConcurrentLocalWrites();
  await testDownloadFailureDoesNotAdvanceCursor();
  await testSuccessfulDownloadAdvancesCursorAfterPartialUploadFailure();
  await testFirstEncryptedSyncDownloadsCloudHistoryBeforeSavedCursor();
  await testSyncEchoDoesNotDuplicateSavedRecord();
  await testCloudDocumentAliasesKeepTheAuthenticatedRecordId();
  console.log('storage-sync: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
