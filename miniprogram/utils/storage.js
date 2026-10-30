/**
 * Encrypted local vault storage and owner-scoped cloud sync.
 */

const PREFIX = 'pwd_';
const crypto = require('./crypto');
const demoMode = require('./demo-mode');
const config = require('../config');
const LEGACY_HASH_KEY = 'master_hash';
const LEGACY_SALT_KEY = 'master_salt';
const VAULT_META_KEY = 'vault_meta';
const PASSWORDS_KEY = 'passwords';
const PENDING_SYNC_KEY = 'pending_sync';
const SYNC_OWNER_KEY = 'sync_owner_openid';
const SYNC_BLOCKED_KEY = 'sync_blocked';
const FULL_SYNC_V1_COMPLETE_KEY = 'full_sync_v1_complete';
const ROTATION_JOURNAL_KEY = 'rotation_journal';
const ROTATION_REMOTE_PENDING_KEY = 'rotation_meta_pending';

let syncPromise = null;
let mutationTail = Promise.resolve();

function withMutationLock(operation) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function get(key) {
  try {
    return wx.getStorageSync(PREFIX + key);
  } catch (error) {
    return null;
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(PREFIX + key, value);
    return true;
  } catch (error) {
    console.error('storage set error:', error);
    return false;
  }
}

function setRequired(key, value) {
  wx.setStorageSync(PREFIX + key, value);
}

/**
 * 清空本机密码库数据（不可逆）。用于"清空云端数据"后同步清理本地，
 * 避免本地残留再次被同步回云端。只删本项目使用的键，不动其它设置。
 */
function clearAllLocalData() {
  const extraKeys = ['member_last_order_no'];
  let cleared = 0;
  try {
    const info = typeof wx.getStorageInfoSync === 'function' ? wx.getStorageInfoSync() : { keys: [] };
    (info.keys || []).forEach((storageKey) => {
      if (storageKey.startsWith(PREFIX) || extraKeys.includes(storageKey)) {
        try {
          wx.removeStorageSync(storageKey);
          cleared += 1;
        } catch (e) { /* 单个键失败不影响整体清理 */ }
      }
    });
  } catch (error) {
    console.error('[storage] clearAllLocalData failed:', error && error.message ? error.message : error);
  }

  // 内存态一并重置，防止清空后仍用旧密钥写入
  const app = getAppSafe();
  if (app && app.globalData) {
    app.globalData.masterKey = null;
    app.globalData.masterPassword = null;
    app.globalData.isLocked = true;
    app.globalData.userInfo = null;
  }
  return { success: true, cleared };
}

function remove(key) {
  try {
    wx.removeStorageSync(PREFIX + key);
  } catch (error) {}
}

function getAppSafe() {
  try {
    return getApp();
  } catch (error) {
    return null;
  }
}

function getLockTimeout() {
  return get('lock_timeout') || 300;
}

function setLockTimeout(seconds) {
  set('lock_timeout', seconds);
}

function setLockState(locked) {
  set('is_locked', !!locked);
}

function getLocalVaultMeta() {
  const value = get(VAULT_META_KEY);
  if (!value || typeof value !== 'object') return null;
  return value;
}

function hasLocalVaultData() {
  const passwords = get(PASSWORDS_KEY);
  const pending = get(PENDING_SYNC_KEY);
  return !!(
    getLocalVaultMeta()
    || get(LEGACY_HASH_KEY)
    || get(LEGACY_SALT_KEY)
    || (!!passwords && (!Array.isArray(passwords) || passwords.length))
    || (!!pending && (!Array.isArray(pending) || pending.length))
  );
}

function confirmLoginIdentity(openid) {
  if (typeof openid !== 'string' || !openid.trim()) {
    return { allowed: false, newlyBlocked: false, reason: 'invalid_identity' };
  }

  const owner = get(SYNC_OWNER_KEY);
  const cached = get('openid');
  const wasBlocked = !!get(SYNC_BLOCKED_KEY);
  const mismatch = (!!owner && owner !== openid) || (!!cached && cached !== openid);
  const unknownOwner = !owner && !cached && hasLocalVaultData();

  // 本地没有密码数据时，账号切换保护没有意义（没有可被串号的数据）
  // → 自动解除锁定并重新绑定，避免「换过一次测试号就永久离线」
  const hasData = hasLocalVaultData();
  if (!hasData && (wasBlocked || mismatch || unknownOwner)) {
    remove(SYNC_BLOCKED_KEY);
    set(SYNC_OWNER_KEY, openid);
    set('openid', openid);
    console.log('[identity] 本地无密码数据，已自动解除账号切换锁定');
    return { allowed: true, newlyBlocked: false, reason: 'auto_unblocked_empty_vault' };
  }

  if (wasBlocked || mismatch || unknownOwner) {
    if (!owner && cached && cached !== openid) {
      set(SYNC_OWNER_KEY, cached);
    }
    set(SYNC_BLOCKED_KEY, true);
    return {
      allowed: false,
      newlyBlocked: !wasBlocked,
      reason: mismatch ? 'account_changed' : 'owner_unknown',
    };
  }

  if (!owner && (!set(SYNC_OWNER_KEY, openid) || get(SYNC_OWNER_KEY) !== openid)) {
    return { allowed: false, newlyBlocked: false, reason: 'owner_persist_failed' };
  }
  if (!set('openid', openid) || get('openid') !== openid) {
    return { allowed: false, newlyBlocked: false, reason: 'identity_persist_failed' };
  }

  return { allowed: true, newlyBlocked: false };
}

function canSync() {
  if (demoMode.isActive()) return false;
  const app = getAppSafe();
  const globalData = app && app.globalData;
  const openid = globalData && globalData.openid;
  return !!openid
    && globalData.verifiedOpenid === openid
    && globalData.syncAllowed === true
    && !get(SYNC_BLOCKED_KEY)
    && get(SYNC_OWNER_KEY) === openid;
}

/**
 * 同步诊断：告诉上层「为什么没在同步」。
 * 场景：本地库曾属于其他 openid（换账号/用过测试号）→ 保护机制置 sync_blocked，
 * 界面若不提示，用户会误以为在同步（静默降级）。
 */
function getSyncDiagnostics() {
  const app = getAppSafe();
  const g = (app && app.globalData) || {};
  const owner = get(SYNC_OWNER_KEY) || null;
  const cached = get('openid') || null;
  const blocked = !!get(SYNC_BLOCKED_KEY);
  const pending = get(PENDING_SYNC_KEY) || [];
  let reason = '';
  if (blocked) {
    reason = (owner && g.openid && owner !== g.openid) ? 'account_changed' : 'blocked';
  } else if (!g.syncAllowed) {
    reason = 'not_allowed';
  }
  return {
    canSync: canSync(),
    blocked,
    reason,
    owner,
    cached,
    openid: g.openid || null,
    verified: !!g.verifiedOpenid && g.verifiedOpenid === g.openid,
    syncAllowed: g.syncAllowed === true,
    offline: !!g.offlineMode,
    pendingCount: pending.length,
  };
}

/**
 * 用户确认后，把本机密码库归属改绑到当前 openid 并解除同步阻断。
 * 安全提示：仅在用户确认「这台手机上的密码库就是当前账号的」时调用，
 * 否则会把其他账号的条目上传到当前账号云端 —— 必须由调用方做二次确认。
 */
function adoptLocalVaultToCurrentUser() {
  const app = getAppSafe();
  const g = (app && app.globalData) || {};
  const openid = g.openid;
  if (!openid || typeof openid !== 'string') return { ok: false, error: 'NO_OPENID' };
  remove(SYNC_BLOCKED_KEY);
  if (!setRequired(SYNC_OWNER_KEY, openid) || get(SYNC_OWNER_KEY) !== openid) {
    return { ok: false, error: 'OWNER_PERSIST_FAILED' };
  }
  set('openid', openid);
  g.syncAllowed = true;
  g.syncBindingPending = false;
  return { ok: true };
}

function toCryptoMeta(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    crypto_version: value.crypto_version === undefined ? value.version : value.crypto_version,
    kdf: value.kdf,
    iterations: value.iterations,
    salt: value.salt,
    verifier: value.verifier,
  };
}

function toCloudMeta(value) {
  return {
    version: value.crypto_version,
    kdf: value.kdf,
    iterations: value.iterations,
    salt: value.salt,
    verifier: value.verifier,
  };
}

function sameMeta(left, right) {
  const a = toCryptoMeta(left);
  const b = toCryptoMeta(right);
  return !!a && !!b
    && a.crypto_version === b.crypto_version
    && a.kdf === b.kdf
    && a.iterations === b.iterations
    && a.salt === b.salt
    && a.verifier === b.verifier;
}

function callCloud(name, data) {
  if (!canSync()) {
    return Promise.reject(new Error('微信身份未确认或密码库同步已隔离'));
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(new Error('CLOUD_UNAVAILABLE'));
  }
  // 同步请求自动携带端侧版本：服务端据此拒绝过旧版本的同步（防旧版数据格式污染云端）
  const payload = name === 'sync' ? Object.assign({ client_version: config.VERSION }, data) : data;
  return new Promise((resolve, reject) => {
    try {
      wx.cloud.callFunction({
        name,
        data: payload,
        success: (res) => {
          try {
            // 服务端判定版本过旧：触发全局强制更新（遮罩 + 弹窗）
            const result = res && res.result;
            if (result && result.error === 'VERSION_TOO_OLD') {
              const app = getAppSafe();
              if (app && app.globalData) app.globalData.forceUpdate = true;
            }
          } catch (e) { /* 诊断处理失败不影响主流程 */ }
          resolve(res);
        },
        fail: reject,
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 定时一致性检测（轻量只读）：对比本地与云端的加密元数据和条目统计。
 * 返回 status：
 *   meta_mismatch  云端加密参数与本地不同（另一设备可能改了主密码）——严重，需人工处理
 *   cloud_ahead    云端比本地新（另一设备有改动）——可自动拉取
 *   pending_upload 本地有未上传的改动——可自动上传
 *   in_sync        一致
 */
async function checkConsistency() {
  const response = await callCloud('sync', { action: 'check_consistency' });
  if (!response.result || !response.result.success) {
    const err = new Error('CONSISTENCY_CHECK_FAILED');
    err.code = (response.result && response.result.code) || 'UNKNOWN';
    throw err;
  }
  const remote = response.result;
  const localMetaObj = toCryptoMeta(getLocalVaultMeta());
  const remoteMetaObj = remote.vault_meta ? toCryptoMeta(remote.vault_meta) : null;

  const passwords = get(PASSWORDS_KEY);
  const localCount = Array.isArray(passwords)
    ? passwords.filter((record) => !record || record.is_deleted !== true).length
    : 0;
  const pending = get(PENDING_SYNC_KEY);
  const pendingCount = Array.isArray(pending) ? pending.length : 0;

  let localLatest = 0;
  (Array.isArray(passwords) ? passwords : []).forEach((record) => {
    if (!record || record.is_deleted === true) return;
    const t = record.updated_at ? new Date(record.updated_at).getTime() : 0;
    if (t > localLatest) localLatest = t;
  });
  const remoteLatest = remote.latest_updated_at ? new Date(remote.latest_updated_at).getTime() : 0;

  let status = 'in_sync';
  if (localMetaObj && remoteMetaObj && !sameMeta(localMetaObj, remoteMetaObj)) {
    status = 'meta_mismatch';
  } else if ((remote.entry_count || 0) > localCount || remoteLatest > localLatest + 1000) {
    status = 'cloud_ahead';
  } else if (pendingCount > 0) {
    status = 'pending_upload';
  }

  return {
    success: true,
    status,
    remoteCount: remote.entry_count || 0,
    localCount,
    pendingCount,
    cloudExists: !!remote.exists,
    checkedAt: Date.now(),
  };
}

async function getRemoteVaultMeta() {
  const response = await callCloud('sync', { action: 'get_vault_meta' });
  if (!response.result || !response.result.success) {
    throw new Error('VAULT_META_READ_FAILED');
  }
  return response.result.exists ? toCryptoMeta(response.result.vault_meta) : null;
}

async function setRemoteVaultMeta(meta) {
  const response = await callCloud('sync', {
    action: 'set_vault_meta',
    vault_meta: toCloudMeta(meta),
  });
  if (!response.result || !response.result.success || !response.result.vault_meta) {
    throw new Error('VAULT_META_WRITE_FAILED');
  }
  return toCryptoMeta(response.result.vault_meta);
}

/** 轮换云端元数据（云端 CAS 校验 old_vault_meta 匹配后才换新） */
async function rotateRemoteVaultMeta(oldMeta, meta) {
  const response = await callCloud('sync', {
    action: 'rotate_vault_meta',
    old_vault_meta: toCloudMeta(oldMeta),
    vault_meta: toCloudMeta(meta),
  });
  if (!response.result || !response.result.success || !response.result.vault_meta) {
    throw new Error('VAULT_META_ROTATE_FAILED');
  }
  return toCryptoMeta(response.result.vault_meta);
}

function callCloudForVerifiedIdentity(name, data, expectedOpenid) {
  const app = getAppSafe();
  const openid = app && app.globalData && app.globalData.openid;
  const verifiedOpenid = app && app.globalData && app.globalData.verifiedOpenid;
  if (!openid || openid !== verifiedOpenid || openid !== expectedOpenid) {
    return Promise.reject(new Error('微信身份未确认'));
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(new Error('CLOUD_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const current = getAppSafe();
      const identity = current && current.globalData;
      if (!identity || identity.openid !== expectedOpenid
          || identity.verifiedOpenid !== expectedOpenid) {
        reject(new Error('IDENTITY_CHANGED'));
      } else if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(new Error('CLOUD_TIMEOUT')), 8000);
    try {
      wx.cloud.callFunction({ name, data,
        success: result => finish(null, result), fail: error => finish(error) });
    } catch (error) {
      finish(error);
    }
  });
}

async function claimLocalVaultOwner(openid, masterKey, meta) {
  const app = getAppSafe();
  const globalData = app && app.globalData;
  const activeOpenid = globalData && globalData.verifiedOpenid;
  if (typeof openid !== 'string' || !openid || activeOpenid !== openid
      || globalData.openid !== openid || globalData.isLocked
      || globalData.masterKey !== masterKey) {
    return { success: false, reason: 'identity_unverified', error: '微信身份未确认' };
  }

  const owner = get(SYNC_OWNER_KEY);
  const cached = get('openid');
  const identityValues = [owner, cached];
  if (identityValues.some(value => value && (
    typeof value !== 'string' || value.trim() !== openid
  ))) {
    return { success: false, reason: 'account_mismatch', error: '本地密码库属于其他微信账号' };
  }

  const localMeta = toCryptoMeta(meta || getLocalVaultMeta());
  if (!localMeta) {
    return { success: false, reason: 'vault_meta_missing', error: '本地密码库加密元数据缺失' };
  }
  if (!sameMeta(localMeta, getLocalVaultMeta())) {
    return { success: false, reason: 'local_meta_mismatch', error: '本地密码库状态不一致' };
  }

  const passwords = get(PASSWORDS_KEY) || [];
  const pending = get(PENDING_SYNC_KEY) || [];
  const localSnapshot = JSON.stringify([localMeta, passwords, pending, owner, cached]);
  const loginRequestId = app._loginRequestId;
  const isCurrentSession = () => globalData.openid === openid
    && globalData.verifiedOpenid === openid
    && app._loginRequestId === loginRequestId
    && !globalData.isLocked && globalData.masterKey === masterKey
    && JSON.stringify([toCryptoMeta(getLocalVaultMeta()), get(PASSWORDS_KEY) || [],
      get(PENDING_SYNC_KEY) || [], get(SYNC_OWNER_KEY), get('openid')]) === localSnapshot;
  if (!Array.isArray(passwords) || !Array.isArray(pending)) {
    return { success: false, reason: 'local_data_invalid', error: '本地密码库数据格式异常' };
  }
  try {
    requireMasterKey(masterKey);
    const CryptoJS = require('./crypto-js.min');
    if (masterKey.encryptionKey.sigBytes !== 32 || masterKey.macKey.sigBytes !== 32
        || CryptoJS.HmacSHA256('vault-verifier:v1', masterKey.macKey).toString() !== localMeta.verifier) {
      throw new Error('密码库会话密钥无效');
    }
    for (const record of passwords) {
      await crypto.decryptRecord(record, masterKey, record && record.id);
    }
    for (const item of pending) {
      if (!item || item.collection !== 'passwords' || !item.data) {
        throw new Error('同步队列格式无效');
      }
      await crypto.decryptRecord(item.data, masterKey, item.id);
    }
  } catch (error) {
    return { success: false, reason: 'local_data_invalid', error: '本地加密数据校验失败' };
  }

  try {
    if (!isCurrentSession()) throw new Error('SESSION_CHANGED');
    const response = await callCloudForVerifiedIdentity('sync', { action: 'get_vault_meta' }, openid);
    if (!isCurrentSession()) throw new Error('SESSION_CHANGED');
    if (!response || !response.result || !response.result.success
        || typeof response.result.exists !== 'boolean') {
      return { success: false, reason: 'remote_meta_read_failed', error: '云端密码库读取失败' };
    }
    const remoteMeta = response.result.exists ? toCryptoMeta(response.result.vault_meta) : null;
    if (response.result.exists && !sameMeta(remoteMeta, localMeta)) {
      return { success: false, reason: 'remote_vault_conflict', error: '云端已有其他密码库，请输入对应主密码' };
    }

    if (!remoteMeta) {
      const created = await callCloudForVerifiedIdentity('sync', {
        action: 'set_vault_meta',
        vault_meta: toCloudMeta(localMeta),
      }, openid);
      if (!isCurrentSession()) throw new Error('SESSION_CHANGED');
      const createdMeta = created && created.result && created.result.vault_meta;
      if (!created || !created.result || !created.result.success || !sameMeta(createdMeta, localMeta)) {
        return { success: false, reason: 'remote_meta_write_failed', error: '云端密码库初始化失败' };
      }
    }

    if (!isCurrentSession()) throw new Error('SESSION_CHANGED');
    const original = [SYNC_OWNER_KEY, 'openid', SYNC_BLOCKED_KEY].map(key => [key, get(key)]);
    globalData.syncAllowed = false;
    try {
      setRequired(SYNC_BLOCKED_KEY, true);
      setRequired(SYNC_OWNER_KEY, openid);
      setRequired('openid', openid);
      if (get(SYNC_OWNER_KEY) !== openid || get('openid') !== openid) {
        throw new Error('OWNER_WRITE_FAILED');
      }
      setRequired(SYNC_BLOCKED_KEY, false);
      if (get(SYNC_BLOCKED_KEY) !== false) throw new Error('OWNER_WRITE_FAILED');
      globalData.syncAllowed = true;
    } catch (error) {
      for (const [key, value] of original) {
        try {
          if (value === '' || value === undefined || value === null) wx.removeStorageSync(PREFIX + key);
          else setRequired(key, value);
        } catch (restoreError) { /* syncAllowed remains false if storage cannot be restored. */ }
      }
      throw error;
    }
    return { success: true, created: !remoteMeta, meta: localMeta };
  } catch (error) {
    return { success: false, reason: 'remote_meta_unavailable', error: '云端密码库暂不可用' };
  }
}

function requireMasterKey(masterKey, allowLocked = false) {
  const app = getAppSafe();
  const key = masterKey || (app && app.globalData && app.globalData.masterKey);
  if (!allowLocked && app && app.globalData && app.globalData.isLocked) {
    throw new Error('密码库已锁定');
  }
  if (!key || !key.encryptionKey || !key.macKey) {
    throw new Error('请先解锁密码库并提供会话密钥');
  }
  return key;
}

function normalizeTimestamp(value, fallback) {
  const time = value ? new Date(value) : fallback;
  return Number.isFinite(time.getTime()) ? time.toISOString() : fallback.toISOString();
}

function normalizeEntry(entry) {
  const now = new Date();
  const normalized = { ...entry };
  if (typeof normalized.id !== 'string' || !normalized.id.trim()) {
    throw new Error('密码条目缺少有效 ID');
  }
  normalized.created_at = normalizeTimestamp(normalized.created_at, now);
  normalized.updated_at = normalizeTimestamp(normalized.updated_at, now);
  if (!Number.isFinite(Number(normalized.created_timestamp))) {
    normalized.created_timestamp = new Date(normalized.created_at).getTime();
  }
  // 旧条目无此字段时补默认值：不可 API 访问
  normalized.api_access = typeof normalized.api_access === 'boolean'
    ? normalized.api_access
    : false;
  return normalized;
}

async function createId() {
  const bytes = await crypto.randomBytes(16);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function migrateLegacyPasswordsWithKey(masterKey, meta, allowLocked) {
  const keys = requireMasterKey(masterKey, allowLocked);
  const cryptoMeta = toCryptoMeta(meta || getLocalVaultMeta());
  if (!cryptoMeta) throw new Error('密码库加密元数据缺失');
  const current = get(PASSWORDS_KEY) || [];
  if (!Array.isArray(current)) throw new Error('本地密码数据格式无效');

  const migratedIds = [];
  const failedIds = [];

  for (let index = 0; index < current.length; index++) {
    const record = current[index];
    const id = record && typeof record.id === 'string' ? record.id : '';
    try {
      if (record && record.crypto_version === crypto.CRYPTO_VERSION) {
        await crypto.decryptRecord(record, keys, id);
        continue;
      }

      const legacyEntry = normalizeEntry(record || {});
      const envelope = await crypto.encryptRecord(legacyEntry, keys, cryptoMeta);
      await crypto.decryptRecord(envelope, keys, legacyEntry.id);
      const queueId = await createId();

      await withMutationLock(async () => {
        const latest = get(PASSWORDS_KEY) || [];
        const currentIndex = latest.findIndex(item => item && item.id === legacyEntry.id);
        if (currentIndex === -1) throw new Error('MIGRATION_SOURCE_CHANGED');
        if (latest[currentIndex].crypto_version === crypto.CRYPTO_VERSION) {
          await crypto.decryptRecord(latest[currentIndex], keys, legacyEntry.id);
          return;
        }
        if (JSON.stringify(latest[currentIndex]) !== JSON.stringify(record)) {
          throw new Error('MIGRATION_SOURCE_CHANGED');
        }

        const pending = get(PENDING_SYNC_KEY) || [];
        if (!Array.isArray(pending)) throw new Error('同步队列格式无效');
        const updated = [...latest];
        updated[currentIndex] = envelope;
        const nextPending = pending.concat([{
          queue_id: queueId,
          id: envelope.id,
          collection: 'passwords',
          action: 'update',
          data: envelope,
        }]);

        setRequired(PENDING_SYNC_KEY, nextPending);
        try {
          setRequired(PASSWORDS_KEY, updated);
          const verified = (get(PASSWORDS_KEY) || []).find(item => item.id === legacyEntry.id);
          await crypto.decryptRecord(verified, keys, legacyEntry.id);
        } catch (error) {
          try {
            setRequired(PASSWORDS_KEY, latest);
          } finally {
            setRequired(PENDING_SYNC_KEY, pending);
          }
          throw error;
        }
        migratedIds.push(legacyEntry.id);
      });
    } catch (error) {
      failedIds.push(id || `index:${index}`);
    }
  }

  if (failedIds.length === 0) {
    remove(LEGACY_HASH_KEY);
    remove(LEGACY_SALT_KEY);
    if (migratedIds.length) _doSync();
  }
  return { migrated_ids: migratedIds, failed_ids: failedIds };
}

async function migrateLegacyPasswords(masterKey, meta) {
  return migrateLegacyPasswordsWithKey(masterKey, meta, false);
}

async function setMasterPassword(password) {
  remove('master_key_cache');
  recoverInterruptedRotation();
  const existingMeta = getLocalVaultMeta();
  if (existingMeta) {
    const verification = await crypto.verifyVaultPassword(password, toCryptoMeta(existingMeta));
    if (!verification.success) return { success: false };
    const migration = await migrateLegacyPasswordsWithKey(verification.keys, existingMeta, true);
    return {
      success: migration.failed_ids.length === 0,
      masterKey: verification.keys,
      meta: toCryptoMeta(existingMeta),
      migration,
    };
  }

  if (canSync()) {
    try {
      const remoteMeta = await getRemoteVaultMeta();
      if (remoteMeta) {
        const verification = await crypto.verifyVaultPassword(password, remoteMeta);
        if (!verification.success) {
          return { success: false, remoteVaultExists: true, error: '已有云端密码库，请输入原主密码' };
        }
        setRequired(VAULT_META_KEY, remoteMeta);
        const migration = await migrateLegacyPasswordsWithKey(verification.keys, remoteMeta, true);
        return {
          success: migration.failed_ids.length === 0,
          masterKey: verification.keys,
          meta: remoteMeta,
          migration,
        };
      }
    } catch (error) {
      console.warn('[vault] 云端元数据暂不可用，先使用本地密码库');
    }
  }

  const created = await crypto.createVaultMeta(password);
  setRequired(VAULT_META_KEY, created.meta);

  if (canSync()) {
    try {
      const remoteMeta = await setRemoteVaultMeta(created.meta);
      if (!sameMeta(remoteMeta, created.meta)) {
        remove(VAULT_META_KEY);
        return { success: false, remoteVaultExists: true, error: '云端已有其他密码库，请输入原主密码' };
      }
    } catch (error) {
      console.warn('[vault] 云端元数据保存失败，将在下次同步重试');
    }
  }

  const migration = await migrateLegacyPasswordsWithKey(created.keys, created.meta, true);
  stashMasterPassword(password);
  return {
    success: migration.failed_ids.length === 0,
    masterKey: created.keys,
    meta: created.meta,
    migration,
  };
}

function legacyHash(password, salt) {
  const CryptoJS = require('./crypto-js.min');
  let hash = CryptoJS.SHA256(password + ':' + salt);
  for (let index = 0; index < 500; index++) {
    hash = CryptoJS.SHA256(hash.toString() + ':' + salt);
  }
  return hash.toString();
}

async function verifyMasterPassword(password, remoteMeta, hooks) {
  const onProgress = hooks && typeof hooks.onProgress === 'function' ? hooks.onProgress : undefined;
  remove('master_key_cache');
  recoverInterruptedRotation();
  const localMeta = getLocalVaultMeta();
  const selectedMeta = toCryptoMeta(remoteMeta || localMeta);

  if (selectedMeta) {
    if (localMeta && remoteMeta && !sameMeta(localMeta, remoteMeta)) {
      return { success: false, error: '本地与云端密码库元数据不一致' };
    }
    const verification = await crypto.verifyVaultPassword(password, selectedMeta, onProgress);
    if (!verification.success) return { success: false };
    if (!localMeta) setRequired(VAULT_META_KEY, selectedMeta);

    const migration = await migrateLegacyPasswordsWithKey(verification.keys, selectedMeta, true);
    if (migration.failed_ids.length) {
      return {
        success: false,
        legacy: true,
        masterKey: verification.keys,
        meta: selectedMeta,
        migration,
        error: '旧数据迁移未完成',
      };
    }
    // 备份密码=主密码：解锁成功在内存保留原文（锁定时清除），供加密导出/取件校验复用
    stashMasterPassword(password);
    return {
      success: true,
      masterKey: verification.keys,
      meta: selectedMeta,
      legacy: false,
      migration,
    };
  }

  const salt = get(LEGACY_SALT_KEY) || '';
  const storedHash = get(LEGACY_HASH_KEY);
  if (!storedHash || !salt || legacyHash(password, salt) !== storedHash) {
    return { success: false };
  }

  const created = await crypto.createVaultMeta(password);
  setRequired(VAULT_META_KEY, created.meta);
  const migration = await migrateLegacyPasswordsWithKey(created.keys, created.meta, true);
  return {
    success: migration.failed_ids.length === 0,
    masterKey: created.keys,
    meta: created.meta,
    legacy: true,
    migration,
    error: migration.failed_ids.length ? '旧数据迁移未完成' : undefined,
  };
}

async function changeMasterPassword(oldPassword, newPassword) {
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string'
      || newPassword.length < 8) {
    return { success: false, error: '新主密码至少需要 8 个字符' };
  }
  if (newPassword.length < 12 && (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword))) {
    return { success: false, error: '12 位以下的主密码需同时包含字母和数字' };
  }

  // 轮换必须在已解锁会话中进行，且需先验证旧主密码。
  try {
    requireMasterKey();
  } catch (error) {
    return { success: false, error: error.message };
  }
  const localMeta = getLocalVaultMeta();
  if (!localMeta) return { success: false, error: '尚未设置主密码' };

  const oldVerification = await crypto.verifyVaultPassword(
    oldPassword,
    toCryptoMeta(localMeta)
  );
  if (!oldVerification.success) {
    return { success: false, error: '当前主密码不正确' };
  }
  if (oldPassword === newPassword) {
    return { success: false, error: '新主密码不能与当前主密码相同' };
  }

  recoverInterruptedRotation();

  const current = get(PASSWORDS_KEY) || [];
  if (!Array.isArray(current)) throw new Error('本地密码数据格式无效');
  const pending = get(PENDING_SYNC_KEY) || [];
  if (!Array.isArray(pending)) throw new Error('同步队列格式无效');

  const rotation = await crypto.createVaultMeta(newPassword);
  const newMeta = rotation.meta;
  const oldKeys = oldVerification.keys;
  const newKeys = rotation.keys;

  // 先在内存中重建全部记录封套；任一记录失败即整体中止，不落盘。
  const prepared = [];
  try {
    for (const record of current) {
      const id = record && typeof record.id === 'string' ? record.id : '';
      let entry;
      if (record && record.crypto_version === crypto.CRYPTO_VERSION) {
        entry = await crypto.decryptRecord(record, oldKeys, id);
      } else {
        entry = normalizeEntry(record || {});
      }
      const envelope = await crypto.encryptRecord(entry, newKeys, newMeta);
      await crypto.decryptRecord(envelope, newKeys, envelope.id);
      const queueId = await createId();
      prepared.push({
        source: record,
        envelope,
        queueItem: {
          queue_id: queueId,
          id: envelope.id,
          collection: 'passwords',
          action: 'update',
          data: envelope,
        },
      });
    }
  } catch (error) {
    return { success: false, error: '密码记录解密失败，已中止轮换，密码库未更改' };
  }

  const nextPasswords = current.map(record => {
    const match = prepared.find(item => item.source === record);
    return match ? match.envelope : record;
  });
  const nextPending = pending.concat(prepared.map(item => item.queueItem));

  // 崩溃一致性：先写日志（含新旧完整快照），再提交三段状态，成功后清日志。
  // 意外中断后由 recoverInterruptedRotation 依据当前记录与快照的比对结果前滚或回滚。
  const journal = {
    old_meta: localMeta,
    new_meta: newMeta,
    old_records: current,
    new_records: nextPasswords,
    old_pending: pending,
    new_pending: nextPending,
  };

  try {
    await withMutationLock(async () => {
      const latestRecords = get(PASSWORDS_KEY) || [];
      const latestPending = get(PENDING_SYNC_KEY) || [];
      if (JSON.stringify(latestRecords) !== JSON.stringify(current)
          || JSON.stringify(latestPending) !== JSON.stringify(pending)) {
        throw new Error('VAULT_CHANGED_DURING_ROTATION');
      }
      setRequired(ROTATION_JOURNAL_KEY, journal);
      try {
        setRequired(PASSWORDS_KEY, nextPasswords);
        setRequired(PENDING_SYNC_KEY, nextPending);
        setRequired(VAULT_META_KEY, newMeta);
      } catch (error) {
        try {
          setRequired(PASSWORDS_KEY, current);
          setRequired(PENDING_SYNC_KEY, pending);
          setRequired(VAULT_META_KEY, localMeta);
        } finally {
          remove(ROTATION_JOURNAL_KEY);
        }
        throw error;
      }
      remove(ROTATION_JOURNAL_KEY);
    });
  } catch (error) {
    return { success: false, error: '本地轮换提交失败，密码库未更改' };
  }

  // 记录上传完成后再更新云端元数据（协议顺序：先记录、后元数据）。
  // 期间 _doSync 的 upload 路径不校验 vault_meta，队列会自然收敛。
  setRequired(ROTATION_REMOTE_PENDING_KEY, true);
  _doSync();

  return {
    success: true,
    masterKey: newKeys,
    meta: newMeta,
    reencrypted: prepared.length,
  };
}

function recoverInterruptedRotation() {
  const journal = get(ROTATION_JOURNAL_KEY);
  if (!journal || typeof journal !== 'object' || !Array.isArray(journal.old_records)
      || !Array.isArray(journal.new_records)) {
    return { action: 'none' };
  }

  const recordsJson = JSON.stringify(get(PASSWORDS_KEY) || []);
  const forward = recordsJson === JSON.stringify(journal.new_records);
  // 记录与任一快照都不一致（写入序列中断的含糊状态）时按回滚处理，
  // 恢复到旧密码可用的一致旧状态，用户可用旧主密码重试。
  const target = forward
    ? {
        action: 'rolled_forward',
        meta: journal.new_meta,
        records: journal.new_records,
        pending: Array.isArray(journal.new_pending) ? journal.new_pending : [],
      }
    : {
        action: 'rolled_back',
        meta: journal.old_meta,
        records: journal.old_records,
        pending: Array.isArray(journal.old_pending) ? journal.old_pending : [],
      };

  setRequired(VAULT_META_KEY, target.meta);
  setRequired(PASSWORDS_KEY, target.records);
  setRequired(PENDING_SYNC_KEY, target.pending);
  remove(ROTATION_JOURNAL_KEY);
  if (!forward) remove(ROTATION_REMOTE_PENDING_KEY);
  return { action: target.action };
}

async function finalizeRotationRemoteMeta() {
  if (get(ROTATION_REMOTE_PENDING_KEY) !== true) return false;
  if (!canSync()) return false;
  const pending = get(PENDING_SYNC_KEY) || [];
  if (pending.length) return false; // 等待全部记录上传完成后再换云端元数据
  try {
    const meta = getLocalVaultMeta();
    if (!meta) return false;
    let remote;
    try {
      remote = await setRemoteVaultMeta(meta);
    } catch (error) {
      console.warn('[vault] 轮换后云端元数据写入失败，将在下次同步重试');
      return false;
    }
    if (sameMeta(remote, meta)) {
      remove(ROTATION_REMOTE_PENDING_KEY);
      return true;
    }
    // 云端已有改密码前的旧元数据（set_vault_meta 是首写语义）：走 CAS 轮换换新
    try {
      remote = await rotateRemoteVaultMeta(remote, meta);
    } catch (error) {
      console.warn('[vault] 轮换云端元数据 CAS 更新失败，将在下次同步重试');
      return false;
    }
    if (sameMeta(remote, meta)) {
      remove(ROTATION_REMOTE_PENDING_KEY);
      return true;
    }
  } catch (error) {
    console.warn('[vault] 轮换后云端元数据更新失败，将在下次同步重试');
  }
  return false;
}

function hasMasterPassword() {
  return !!(getLocalVaultMeta() || get(LEGACY_HASH_KEY));
}

// Biometric unlock is unavailable until a platform-protected key wrapper exists.
function getMasterKey() {
  remove('master_key_cache');
  return null;
}

function setMasterKeyCache() {
  remove('master_key_cache');
  return false;
}

/** 单条解密：从本地封套数组直读目标条目并解密，避免“改一条解密整库”（性能审计 P-2） */
async function findDecryptedById(id, keys) {
  if (demoMode.isActive()) {
    return demoMode.getEntries().find(e => e && e.id === id) || null;
  }
  const records = get(PASSWORDS_KEY) || [];
  if (!Array.isArray(records)) throw new Error('本地密码数据格式无效');
  const record = records.find(r => r && r.id === id);
  if (!record) return null;
  if (record.crypto_version !== crypto.CRYPTO_VERSION) {
    throw new Error('旧密码数据尚未完成加密迁移');
  }
  return crypto.decryptRecord(record, keys, record.id);
}

async function getAllPasswords(masterKey) {
  // 演示模式：只返回内存中的示例数据，绝不读取真实密码库
  if (demoMode.isActive()) return demoMode.getEntries();
  const keys = requireMasterKey(masterKey);
  const records = get(PASSWORDS_KEY) || [];
  if (!Array.isArray(records)) throw new Error('本地密码数据格式无效');

  const entries = [];
  for (const record of records) {
    if (!record || record.crypto_version !== crypto.CRYPTO_VERSION) {
      throw new Error('旧密码数据尚未完成加密迁移');
    }
    entries.push(await crypto.decryptRecord(record, keys, record.id));
  }
  return entries;
}

function createDisplayDate(date) {
  return date.toISOString();
}

async function makeEntry(data, id, createdAt) {
  const templates = require('./entry-templates');
  const now = new Date();
  const formattedDate = createDisplayDate(now);
  const type = templates.getEntryType({ type: data.type });
  const entry = {
    id,
    platform: data.platform || '',
    account: data.account || '',
    password: data.password || '',
    alias: data.alias || '',
    notes: data.notes || '',
    securityQuestion: data.securityQuestion || '',
    securityAnswer: data.securityAnswer || '',
    bindPhone: data.bindPhone || '',
    pinned: !!data.pinned,
    is_deleted: !!data.is_deleted,
    // 开发者 API 访问打标预埋（V2 中台）：默认不可 API 访问，用户显式开启
    api_access: !!data.api_access,
    type,
    created_at: createdAt || formattedDate,
    updated_at: formattedDate,
    created_timestamp: createdAt ? new Date(createdAt).getTime() : now.getTime(),
  };

  if (type !== templates.DEFAULT_TYPE) {
    entry.fields = Array.isArray(data.fields) ? data.fields : [];
  }
  if (Array.isArray(data.custom_fields) && data.custom_fields.length > 0) {
    entry.custom_fields = data.custom_fields;
  }
  return entry;
}

async function queueSyncEnvelope(envelope, action) {
  const queueId = await createId();
  await withMutationLock(() => {
    const pending = get(PENDING_SYNC_KEY) || [];
    if (!Array.isArray(pending)) throw new Error('同步队列格式无效');
    pending.push({
      queue_id: queueId,
      id: envelope.id,
      collection: 'passwords',
      action,
      data: envelope,
    });
    setRequired(PENDING_SYNC_KEY, pending);
  });
  _doSync();
  return queueId;
}

async function writeEntry(entry, masterKey, action) {
  const keys = requireMasterKey(masterKey);
  const meta = toCryptoMeta(getLocalVaultMeta());
  if (!meta) throw new Error('密码库加密元数据缺失');
  const envelope = await crypto.encryptRecord(entry, keys, meta);
  await crypto.decryptRecord(envelope, keys, entry.id);
  const queueId = await createId();

  return withMutationLock(async () => {
    const previousRecords = get(PASSWORDS_KEY) || [];
    const previousPending = get(PENDING_SYNC_KEY) || [];
    if (!Array.isArray(previousRecords)) throw new Error('本地密码数据格式无效');
    if (!Array.isArray(previousPending)) throw new Error('同步队列格式无效');

    const index = previousRecords.findIndex(record => record.id === entry.id);
    const nextRecords = [...previousRecords];
    if (index < 0) nextRecords.unshift(envelope);
    else nextRecords[index] = envelope;
    const nextPending = previousPending.concat([{
      queue_id: queueId,
      id: envelope.id,
      collection: 'passwords',
      action,
      data: envelope,
    }]);

    setRequired(PENDING_SYNC_KEY, nextPending);
    try {
      setRequired(PASSWORDS_KEY, nextRecords);
      const readback = (get(PASSWORDS_KEY) || []).find(record => record.id === entry.id);
      return await crypto.decryptRecord(readback, keys, entry.id);
    } catch (error) {
      try {
        setRequired(PASSWORDS_KEY, previousRecords);
      } finally {
        setRequired(PENDING_SYNC_KEY, previousPending);
      }
      throw error;
    }
  });
}

async function importPasswords(entries, masterKey) {
  if (demoMode.isActive()) return demoMode.blocked();
  const keys = requireMasterKey(masterKey);
  if (!Array.isArray(entries)) throw new Error('导入数据必须为数组');

  const normalizedEntries = [];
  const inputIds = new Set();
  let skipped = 0;
  for (const source of entries) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('导入条目格式无效');
    }
    const id = typeof source.id === 'string' && source.id.trim()
      ? source.id
      : await createId();
    if (inputIds.has(id)) {
      skipped++;
      continue;
    }
    inputIds.add(id);
    normalizedEntries.push(normalizeEntry({ ...source, id }));
  }
  if (!normalizedEntries.length) return { count: 0, skipped };

  const meta = toCryptoMeta(getLocalVaultMeta());
  if (!meta) throw new Error('密码库加密元数据缺失');

  return withMutationLock(async () => {
    const previousRecords = get(PASSWORDS_KEY) || [];
    const previousPending = get(PENDING_SYNC_KEY) || [];
    if (!Array.isArray(previousRecords)) throw new Error('本地密码数据格式无效');
    if (!Array.isArray(previousPending)) throw new Error('同步队列格式无效');

    const existingIds = new Set(previousRecords.map(record => record && record.id));
    const envelopes = [];
    for (const entry of normalizedEntries) {
      if (existingIds.has(entry.id)) {
        skipped++;
        continue;
      }
      existingIds.add(entry.id);
      const envelope = await crypto.encryptRecord(entry, keys, meta);
      await crypto.decryptRecord(envelope, keys, entry.id);
      envelopes.push(envelope);
    }
    if (!envelopes.length) return { count: 0, skipped };

    const queueItems = [];
    for (const envelope of envelopes) {
      queueItems.push({
        queue_id: await createId(),
        id: envelope.id,
        collection: 'passwords',
        action: 'add',
        data: envelope,
      });
    }
    const nextRecords = envelopes.concat(previousRecords);
    const nextPending = previousPending.concat(queueItems);

    setRequired(PENDING_SYNC_KEY, nextPending);
    try {
      setRequired(PASSWORDS_KEY, nextRecords);
      const readback = get(PASSWORDS_KEY) || [];
      for (const envelope of envelopes) {
        const stored = readback.find(record => record.id === envelope.id);
        await crypto.decryptRecord(stored, keys, envelope.id);
      }
    } catch (error) {
      try {
        setRequired(PASSWORDS_KEY, previousRecords);
      } finally {
        setRequired(PENDING_SYNC_KEY, previousPending);
      }
      throw error;
    }

    _doSync();
    return { count: envelopes.length, skipped };
  });
}

async function addPassword(data, masterKey) {
  if (demoMode.isActive()) return demoMode.blocked();
  const keys = requireMasterKey(masterKey);
  const id = await createId();
  const entry = await makeEntry(data || {}, id);
  return writeEntry(entry, keys, 'add');
}

async function updatePassword(id, data, masterKey) {
  if (demoMode.isActive()) return demoMode.blocked();
  const keys = requireMasterKey(masterKey);
  const existing = await findDecryptedById(id, keys);
  if (!existing) return null;

  const templates = require('./entry-templates');
  const updated = normalizeEntry({
    ...existing,
    ...(data || {}),
    id,
    created_at: existing.created_at,
    created_timestamp: existing.created_timestamp,
    updated_at: new Date().toISOString(),
  });
  if (templates.getEntryType(updated) === templates.DEFAULT_TYPE && !(data && data.fields)) {
    delete updated.fields;
  }
  return writeEntry(updated, keys, 'update');
}

async function deletePassword(id, masterKey) {
  if (demoMode.isActive()) return demoMode.blocked();
  const keys = requireMasterKey(masterKey);
  const existing = await findDecryptedById(id, keys);
  if (!existing) return false;
  existing.is_deleted = true;
  existing.updated_at = new Date().toISOString();
  await writeEntry(existing, keys, 'delete');
  return true;
}

async function togglePin(id, masterKey) {
  if (demoMode.isActive()) return demoMode.blocked();
  const keys = requireMasterKey(masterKey);
  const existing = await findDecryptedById(id, keys);
  if (!existing) return null;
  existing.pinned = !existing.pinned;
  existing.updated_at = new Date().toISOString();
  return writeEntry(existing, keys, 'update');
}

function getUserCapacity() {
  const app = getAppSafe();
  if (app && app.globalData && app.globalData.totalCapacity) {
    return app.globalData.totalCapacity;
  }
  return get('total_capacity') || 30;
}

function removeConfirmedQueueItems(queueIds) {
  if (!Array.isArray(queueIds) || queueIds.length === 0) return;
  const confirmed = new Set(queueIds);
  const pending = get(PENDING_SYNC_KEY) || [];
  setRequired(PENDING_SYNC_KEY, pending.filter(item => !confirmed.has(item.queue_id)));
}

// ===== 条目编号映射（服务端 counters 分配，本地只缓存 id -> seq）=====
const SEQ_MAP_KEY = 'entry_seq_map';

/** 把服务端返回的 {id, seq} 写入本地映射；编号不入加密库、不入同步队列 */
function applySeqMapping(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return;
  const map = get(SEQ_MAP_KEY) || {};
  let changed = false;
  for (const item of pairs) {
    if (!item || typeof item.id !== 'string') continue;
    const seq = Number(item.seq);
    if (!Number.isFinite(seq) || seq <= 0) continue;
    if (map[item.id] !== seq) {
      map[item.id] = seq;
      changed = true;
    }
  }
  if (changed) set(SEQ_MAP_KEY, map);
}

/**
 * 解锁会话期间在内存（globalData，不落盘）保留主密码原文：
 * 2026-10-23 产品决策"备份密码=主密码"——加密导出/取件校验直接复用主密码，
 * 用户从始至终只记一个密码。锁定/清除会话时同步清除原文。
 */
function stashMasterPassword(password) {
  const app = getAppSafe();
  if (app && app.globalData) app.globalData.masterPassword = password;
}

/** 读取解锁会话中的主密码原文（仅内存；未解锁/已锁定返回空串） */
function getMasterPassword() {
  const app = getAppSafe();
  const pwd = app && app.globalData ? app.globalData.masterPassword : null;
  return typeof pwd === 'string' ? pwd : '';
}

/** 读取 id -> seq 映射（列表渲染用） */
function getSeqMap() {
  return get(SEQ_MAP_KEY) || {};
}

async function _doSync() {
  if (syncPromise) return syncPromise;
  const app = getAppSafe();
  const pending = get(PENDING_SYNC_KEY) || [];
  if (!pending.length || !app || !canSync()) return null;

  syncPromise = (async () => {
    try {
      if (!canSync()) return null;
      const response = await callCloud('sync', {
        action: 'upload',
        local_updates: pending,
      });
      const result = response.result || {};
      removeConfirmedQueueItems(result.confirmed_queue_ids);
      applySeqMapping(result.upload_results);
      await finalizeRotationRemoteMeta();
      return result;
    } catch (error) {
      console.error('[sync] 上传失败，保留待办队列:', error);
      // 服务端拒绝：版本过旧 → 全局强制更新（遮罩 + 弹窗）
      const errObj = error && error.result && error.result.result;
      if (errObj && errObj.error === 'VERSION_TOO_OLD') {
        const app = getAppSafe();
        if (app && app.globalData) app.globalData.forceUpdate = true;
      }
      return { success: false, error };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

function timeValue(value) {
  const result = new Date(value || 0).getTime();
  return Number.isFinite(result) ? result : 0;
}

async function mergeCloudData(downloads, masterKey, meta) {
  const keys = requireMasterKey(masterKey);
  const prepared = [];

  for (const item of downloads || []) {
    if (item.collection !== 'passwords' || !item.data) continue;
    // The envelope id is authenticated; the outer id can be a legacy cloud document id.
    const remote = { ...item.data, id: item.data.id || item.id };

    let envelope;
    let plaintext;
    let queueId = null;
    if (remote.crypto_version === crypto.CRYPTO_VERSION) {
      plaintext = await crypto.decryptRecord(remote, keys, remote.id);
      envelope = remote;
    } else {
      plaintext = normalizeEntry(remote);
      envelope = await crypto.encryptRecord(plaintext, keys, meta);
      await crypto.decryptRecord(envelope, keys, plaintext.id);
      queueId = await createId();
    }

    prepared.push({ envelope, plaintext, queueId });
  }

  let queuedLegacyUpdates = false;
  await withMutationLock(async () => {
    const current = get(PASSWORDS_KEY) || [];
    const pending = get(PENDING_SYNC_KEY) || [];
    if (!Array.isArray(current)) throw new Error('本地密码数据格式无效');
    if (!Array.isArray(pending)) throw new Error('同步队列格式无效');

    const pendingIds = new Set(pending.map(item => item.id));
    const byId = new Map(current.map(item => [item.id, item]));
    const nextPending = [...pending];

    for (const candidate of prepared) {
      const { envelope, plaintext, queueId } = candidate;
      if (pendingIds.has(envelope.id)) continue;

      const local = byId.get(envelope.id);
      if (local) {
        const localEntry = local.crypto_version === crypto.CRYPTO_VERSION
          ? await crypto.decryptRecord(local, keys, local.id)
          : normalizeEntry(local);
        if (timeValue(localEntry.updated_at) > timeValue(plaintext.updated_at)) {
          continue;
        }
      }

      byId.set(envelope.id, envelope);
      if (queueId) {
        nextPending.push({
          queue_id: queueId,
          id: envelope.id,
          collection: 'passwords',
          action: 'update',
          data: envelope,
        });
        queuedLegacyUpdates = true;
      }
    }

    const nextPasswords = Array.from(byId.values());
    const passwordsChanged = JSON.stringify(nextPasswords) !== JSON.stringify(current);
    const pendingChanged = nextPending.length !== pending.length;
    if (!passwordsChanged && !pendingChanged) return;

    if (pendingChanged) setRequired(PENDING_SYNC_KEY, nextPending);
    try {
      if (passwordsChanged) setRequired(PASSWORDS_KEY, nextPasswords);
    } catch (error) {
      try {
        if (passwordsChanged) setRequired(PASSWORDS_KEY, current);
      } finally {
        if (pendingChanged) setRequired(PENDING_SYNC_KEY, pending);
      }
      throw error;
    }
  });

  if (queuedLegacyUpdates) _doSync();
}

async function syncFromCloud(callback, masterKey) {
  if (!canSync()) {
    const blocked = {
      success: false,
      error: new Error('微信身份未确认或密码库同步已隔离'),
    };
    if (typeof callback === 'function') callback(blocked);
    return blocked;
  }

  let result;
  try {
    const keys = requireMasterKey(masterKey);
    const meta = toCryptoMeta(getLocalVaultMeta());
    if (!meta) throw new Error('密码库加密元数据缺失');

    // 轮换窗口期（记录已排队、云端元数据待更新）先完成上传与元数据收尾，
    // 否则下面的元数据一致性检查会在云端元数据仍是旧值时阻塞手动同步。
    if (get(ROTATION_REMOTE_PENDING_KEY) === true) {
      await _doSync();
      // _doSync 在队列为空时直接返回，不触发收尾；此处兜底调用
      await finalizeRotationRemoteMeta();
    }

    const remoteMeta = await getRemoteVaultMeta();
    if (remoteMeta && !sameMeta(remoteMeta, meta)) {
      throw new Error('云端与本地密码库加密参数不一致');
    }
    if (!remoteMeta) {
      const createdMeta = await setRemoteVaultMeta(meta);
      if (!sameMeta(createdMeta, meta)) {
        throw new Error('云端已有不同的密码库加密参数');
      }
    }

    const pending = get(PENDING_SYNC_KEY) || [];
    const response = await callCloud('sync', {
      action: 'full_sync',
      last_sync: get(FULL_SYNC_V1_COMPLETE_KEY) === true
        ? get('last_sync_time') || null
        : null,
      local_updates: pending,
    });
    const data = response.result || {};
    removeConfirmedQueueItems(data.confirmed_queue_ids);
    applySeqMapping(data.downloads);
    if (data.backfilled_seq && typeof data.backfilled_seq === 'object') {
      applySeqMapping(Object.keys(data.backfilled_seq).map(id => ({ id, seq: data.backfilled_seq[id] })));
    }

    const downloadSucceeded = Array.isArray(data.downloads)
      && (data.download_success === true
        || (data.download_success === undefined && data.error !== 'download_failed'));
    if (downloadSucceeded) {
      await mergeCloudData(data.downloads, keys, meta);
      if (typeof data.server_time === 'string'
        && Number.isFinite(new Date(data.server_time).getTime())) {
        setRequired('last_sync_time', data.server_time);
        if (get(FULL_SYNC_V1_COMPLETE_KEY) !== true) {
          setRequired(FULL_SYNC_V1_COMPLETE_KEY, true);
          if (get(FULL_SYNC_V1_COMPLETE_KEY) !== true) {
            throw new Error('FULL_SYNC_CHECKPOINT_WRITE_FAILED');
          }
        }
      }
    }
    result = {
      success: !!data.success,
      count: (data.downloads || []).length,
      error: data.error,
    };
    if (result.success) _doSync();
  } catch (error) {
    console.error('[sync] 同步失败，保留未确认队列:', error);
    result = { success: false, error };
  }

  if (typeof callback === 'function') callback(result);
  return result;
}

module.exports = {
  get,
  set,
  remove,
  getLockTimeout,
  setLockTimeout,
  setLockState,
  getLocalVaultMeta,
  getRemoteVaultMeta,
  claimLocalVaultOwner,
  confirmLoginIdentity,
  canSync,
  setMasterPassword,
  verifyMasterPassword,
  getMasterPassword,
  clearAllLocalData,
  changeMasterPassword,
  recoverInterruptedRotation,
  migrateLegacyPasswords,
  getAllPasswords,
  findDecryptedById,
  addPassword,
  updatePassword,
  importPasswords,
  deletePassword,
  togglePin,
  getUserCapacity,
  syncFromCloud,
  getSeqMap,
  getSyncDiagnostics,
  adoptLocalVaultToCurrentUser,
  checkConsistency,
  _doSync,
  hasMasterPassword,
  getMasterKey,
  setMasterKeyCache,
  mergeCloudData,
};
