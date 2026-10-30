const assert = require('node:assert/strict');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'miniprogram', 'app.js');
const SYNC_PATH = path.join(__dirname, '..', 'miniprogram', 'utils', 'sync.js');
const STORAGE_PATH = path.join(__dirname, '..', 'miniprogram', 'utils', 'storage.js');
const PASSWORD = 'account switch regression password';

function createHarness(seed = {}) {
  const store = { ...seed };
  const cloudCalls = [];
  let nextByte = 1;
  let loginResult = null;
  let loginHandler = null;
  let remoteMeta = null;
  let modal = null;
  let app;

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
    getStorageInfoSync() {
      return { keys: Object.keys(store) };
    },
    getRandomValues({ length, success }) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        bytes[index] = nextByte++ & 0xff;
      }
      success({ randomValues: bytes.buffer });
    },
    showModal(options) {
      modal = options;
      if (options.success) options.success({ confirm: true });
    },
    reLaunch() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
    cloud: {
      callFunction(options) {
        cloudCalls.push({ name: options.name, data: options.data });
        if (options.name === 'login') {
          if (loginHandler) {
            loginHandler(options);
            return;
          }
          if (loginResult) options.success({ result: loginResult });
          else options.fail(new Error('simulated login failure'));
          return;
        }
        if (options.name !== 'sync') {
          options.fail(new Error(`unexpected cloud function: ${options.name}`));
          return;
        }
        const action = options.data.action;
        if (action === 'get_vault_meta') {
          options.success({
            result: {
              success: true,
              exists: !!remoteMeta,
              vault_meta: remoteMeta,
            },
          });
        } else if (action === 'set_vault_meta') {
          remoteMeta = options.data.vault_meta;
          options.success({ result: { success: true, vault_meta: remoteMeta } });
        } else if (action === 'full_sync') {
          options.success({
            result: {
              success: true,
              download_success: true,
              downloads: [],
              confirmed_queue_ids: (options.data.local_updates || []).map(item => item.queue_id),
              server_time: '2026-09-30T00:00:00.000Z',
            },
          });
        } else if (action === 'upload') {
          options.success({
            result: {
              success: true,
              confirmed_queue_ids: (options.data.local_updates || []).map(item => item.queue_id),
            },
          });
        } else {
          options.fail(new Error(`unexpected sync action: ${action}`));
        }
      },
    },
  };

  global.App = definition => {
    app = definition;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];

  [APP_PATH, SYNC_PATH, STORAGE_PATH].forEach(file => {
    delete require.cache[require.resolve(file)];
  });

  require(APP_PATH);
  const storage = require(STORAGE_PATH);
  const sync = require(SYNC_PATH);

  return {
    app,
    store,
    storage,
    sync,
    cloudCalls,
    getModal: () => modal,
    setLoginResult(value) {
      loginResult = value;
    },
    setLoginHandler(handler) {
      loginHandler = handler;
    },
    setRemoteMeta(value) {
      remoteMeta = value;
    },
  };
}

function successfulLogin(openid) {
  return {
    success: true,
    openid,
    capacity: 30,
    is_new_user: false,
    user: { openid },
    invite_code: 'invite',
  };
}

async function createLocalVault(harness) {
  const { app, storage } = harness;
  app.globalData.isLocked = true;
  const setup = await storage.setMasterPassword(PASSWORD);
  assert.equal(setup.success, true);
  app.globalData.isLocked = false;
  const entry = await storage.addPassword({
    platform: '邮箱',
    account: 'user@example.com',
    password: 'account-switch-secret',
  }, setup.masterKey);
  app.globalData.isLocked = true;
  app.globalData.masterKey = null;
  return { ...setup, entry };
}

async function testCachedIdentityDoesNotAuthorizeSyncAfterLoginFailure() {
  const harness = createHarness({ 'pwd_openid': 'cached-account' });
  const { app, sync, cloudCalls } = harness;
  app.globalData.isLocked = false;
  app.globalData.masterKey = { encryptionKey: {}, macKey: {} };

  app._login();
  assert.equal(app.globalData.openid, null);
  assert.equal(app.globalData.verifiedOpenid, null);

  await sync.autoSync();
  let manualResult;
  sync.manualSync(result => {
    manualResult = result;
  });

  assert.equal(manualResult.success, false);
  assert.deepEqual(cloudCalls.map(call => call.name), ['login']);
}

async function testAccountSwitchKeepsLocalVaultAndItCanStillBeUnlocked() {
  const harness = createHarness({ 'pwd_openid': 'account-a' });
  const { app, storage, store } = harness;
  const vault = await createLocalVault(harness);
  const originalPasswords = JSON.stringify(store['pwd_passwords']);
  const originalMeta = JSON.stringify(store['pwd_vault_meta']);
  const originalPending = JSON.stringify(store['pwd_pending_sync']);
  const originalPwdKeys = Object.keys(store).filter(key => key.startsWith('pwd_'));

  harness.setLoginResult(successfulLogin('account-b'));
  app._login();

  assert.deepEqual(store['pwd_passwords'], JSON.parse(originalPasswords));
  assert.equal(JSON.stringify(store['pwd_vault_meta']), originalMeta);
  assert.equal(JSON.stringify(store['pwd_pending_sync']), originalPending);
  for (const key of originalPwdKeys) assert.ok(Object.hasOwn(store, key), `${key} was removed`);
  assert.equal(app.globalData.openid, 'account-b');
  assert.equal(app.globalData.verifiedOpenid, 'account-b');
  assert.equal(app.globalData.syncAllowed, false);
  assert.equal(store['pwd_sync_blocked'], true);
  assert.ok(harness.getModal());

  const unlocked = await storage.verifyMasterPassword(PASSWORD);
  assert.equal(unlocked.success, true);
  app.globalData.masterKey = unlocked.masterKey;
  app.globalData.isLocked = false;
  assert.deepEqual(await storage.getAllPasswords(unlocked.masterKey), [vault.entry]);
}

async function testSwitchedAccountCannotSyncUntilAnExplicitMigrationExists() {
  const harness = createHarness({ 'pwd_openid': 'account-a' });
  const { app, storage, sync, cloudCalls } = harness;
  const vault = await createLocalVault(harness);
  harness.setLoginResult(successfulLogin('account-b'));
  app._login();

  await sync.autoSync();
  let manualResult;
  sync.manualSync(result => {
    manualResult = result;
  });
  await storage._doSync();

  assert.equal(manualResult.success, false);
  app.globalData.masterKey = vault.masterKey;
  app.globalData.isLocked = false;
  const directResult = await storage.syncFromCloud(null, vault.masterKey);
  assert.equal(directResult.success, false);
  assert.deepEqual(cloudCalls.filter(call => call.name === 'sync'), []);

  app._login();
  await sync.autoSync();
  assert.deepEqual(cloudCalls.filter(call => call.name === 'sync'), []);
  assert.equal(storeHasSwitchBlock(harness.store), true);
  assert.equal(vault.entry.password, 'account-switch-secret');
}

function storeHasSwitchBlock(store) {
  return store['pwd_sync_blocked'] === true;
}

async function testUnknownOwnerWithMalformedLocalDataStaysIsolated() {
  const malformedPasswords = { encrypted_records: 'unrecognized-format' };
  const malformedQueue = 'unrecognized-queue-format';
  const harness = createHarness({
    'pwd_passwords': malformedPasswords,
    'pwd_pending_sync': malformedQueue,
  });
  const { app, sync, cloudCalls, store } = harness;
  harness.setLoginResult(successfulLogin('account-new'));
  app._login();

  await sync.autoSync();
  let manualResult;
  sync.manualSync(result => {
    manualResult = result;
  });

  assert.equal(store['pwd_passwords'], malformedPasswords);
  assert.equal(store['pwd_pending_sync'], malformedQueue);
  assert.equal(store['pwd_sync_blocked'], true);
  assert.equal(Object.hasOwn(store, 'pwd_sync_owner_openid'), false);
  assert.equal(manualResult.success, false);
  assert.deepEqual(cloudCalls.map(call => call.name), ['login']);
}

async function testUnknownOwnerCanBeClaimedAfterMasterPasswordVerification() {
  const harness = createHarness();
  const { app, storage, sync, store, cloudCalls } = harness;
  const vault = await createLocalVault(harness);

  harness.setLoginResult(successfulLogin('account-current'));
  app._login();
  assert.equal(app.globalData.syncAllowed, false);
  assert.equal(store['pwd_sync_blocked'], true);

  const unlocked = await storage.verifyMasterPassword(PASSWORD);
  assert.equal(unlocked.success, true);
  app.globalData.masterKey = unlocked.masterKey;
  app.globalData.isLocked = false;

  const claim = await storage.claimLocalVaultOwner(
    'account-current',
    unlocked.masterKey,
    unlocked.meta,
  );
  assert.equal(claim.success, true);
  assert.equal(store['pwd_sync_owner_openid'], 'account-current');
  assert.equal(store['pwd_openid'], 'account-current');
  assert.equal(store['pwd_sync_blocked'], false);
  assert.equal(app.globalData.syncAllowed, true);

  await sync.autoSync();
  assert.equal(storage.canSync(), true);
  assert.equal(store['pwd_passwords'].length, 1);
  assert.deepEqual(await storage.getAllPasswords(unlocked.masterKey), [vault.entry]);
  assert.ok(cloudCalls.some(call => call.name === 'sync' && call.data.action === 'set_vault_meta'));
  assert.ok(cloudCalls.some(call => call.name === 'sync' && call.data.action === 'full_sync'));
}

async function testUnknownOwnerClaimRejectsDifferentRemoteVault() {
  const harness = createHarness();
  const { app, storage, store } = harness;
  const local = await createLocalVault(harness);
  const crypto = require('../miniprogram/utils/crypto');
  const remote = await crypto.createVaultMeta('different remote password');

  harness.setRemoteMeta({
    version: remote.meta.crypto_version,
    kdf: remote.meta.kdf,
    iterations: remote.meta.iterations,
    salt: remote.meta.salt,
    verifier: remote.meta.verifier,
  });
  harness.setLoginResult(successfulLogin('account-current'));
  app._login();

  const unlocked = await storage.verifyMasterPassword(PASSWORD);
  assert.equal(unlocked.success, true);
  app.globalData.masterKey = unlocked.masterKey;
  app.globalData.isLocked = false;
  const claim = await storage.claimLocalVaultOwner(
    'account-current',
    unlocked.masterKey,
    unlocked.meta,
  );
  assert.equal(claim.success, false);
  assert.match(claim.error, /云端已有其他密码库/);
  assert.equal(store['pwd_sync_blocked'], true);
  assert.equal(Object.hasOwn(store, 'pwd_sync_owner_openid'), false);
  assert.equal(local.entry.password, 'account-switch-secret');
}

async function testVerifiedUnchangedAccountCanSyncAutomaticallyAndManually() {
  const harness = createHarness({ 'pwd_openid': 'account-a' });
  const { app, storage, sync, cloudCalls } = harness;
  const vault = await createLocalVault(harness);
  harness.setRemoteMeta({
    version: vault.meta.crypto_version,
    kdf: vault.meta.kdf,
    iterations: vault.meta.iterations,
    salt: vault.meta.salt,
    verifier: vault.meta.verifier,
  });
  harness.setLoginResult(successfulLogin('account-a'));
  app.globalData.masterKey = vault.masterKey;
  app.globalData.isLocked = false;
  app._login();

  assert.equal(app.globalData.verifiedOpenid, 'account-a');
  assert.equal(app.globalData.syncAllowed, true);
  await sync.autoSync();
  let manualResult;
  await new Promise(resolve => {
    sync.manualSync(result => {
      manualResult = result;
      resolve();
    });
  });

  assert.equal(manualResult.success, true);
  assert.equal(cloudCalls.filter(call => call.name === 'sync' && call.data.action === 'full_sync').length, 2);
  assert.equal(storage.canSync(), true);
}

async function testUnresponsiveLoginFallsBackToOfflineMode() {
  const harness = createHarness();
  const { app } = harness;
  app._loginTimeoutMs = 10;
  harness.setLoginHandler(() => {});

  app._login();
  assert.equal(app.globalData.openid, null);
  assert.equal(app.globalData.syncAllowed, false);

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(app.globalData.offlineMode, true);
  assert.equal(app.globalData.openid, null);
  assert.equal(app.globalData.verifiedOpenid, null);
  assert.equal(app.globalData.syncAllowed, false);
}

async function testLateResponseFromAnOlderLoginAttemptIsIgnored() {
  const harness = createHarness();
  const { app } = harness;
  const pending = [];
  harness.setLoginHandler(options => pending.push(options));

  app._login();
  app._login();
  assert.equal(pending.length, 2);

  pending[1].success({ result: successfulLogin('current-account') });
  pending[0].success({ result: successfulLogin('stale-account') });

  assert.equal(app.globalData.openid, 'current-account');
  assert.equal(app.globalData.verifiedOpenid, 'current-account');
  assert.equal(app.globalData.syncAllowed, true);
}

async function main() {
  await testCachedIdentityDoesNotAuthorizeSyncAfterLoginFailure();
  await testAccountSwitchKeepsLocalVaultAndItCanStillBeUnlocked();
  await testSwitchedAccountCannotSyncUntilAnExplicitMigrationExists();
  await testUnknownOwnerWithMalformedLocalDataStaysIsolated();
  await testUnknownOwnerCanBeClaimedAfterMasterPasswordVerification();
  await testUnknownOwnerClaimRejectsDifferentRemoteVault();
  await testVerifiedUnchangedAccountCanSyncAutomaticallyAndManually();
  await testUnresponsiveLoginFallsBackToOfflineMode();
  await testLateResponseFromAnOlderLoginAttemptIsIgnored();
  console.log('account-switch: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
