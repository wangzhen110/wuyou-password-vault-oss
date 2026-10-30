// Cloud function entry point for owner-scoped encrypted synchronization.
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = ['passwords'];
const VAULT_META_COLLECTION = 'vault_meta';

// 最低支持版本（服务端硬校验）：低于此版本的同步请求一律拒绝，防旧版数据格式污染云端。
// 与 login 的 MIN_SUPPORTED_VERSION 保持一致，每次发布重要修复版本时同步抬升。
const MIN_SUPPORTED_VERSION = '4.2.20';

function compareClientVersion(v1, v2) {
  const p1 = String(v1 || '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = String(v2 || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/** 同步入口的版本硬校验：缺失（旧版端）或低于门槛一律拒绝 */
function assertClientVersion(event) {
  const clientVersion = typeof event.client_version === 'string' ? event.client_version.trim() : '';
  if (!clientVersion || compareClientVersion(clientVersion, MIN_SUPPORTED_VERSION) < 0) {
    return {
      success: false,
      error: 'VERSION_TOO_OLD',
      min_supported_version: MIN_SUPPORTED_VERSION,
    };
  }
  return null;
}
const VAULT_META_VERSION = 1;
const VAULT_META_KDF = 'PBKDF2-HMAC-SHA256';
const MIN_VAULT_META_ITERATIONS = 600000;
const MAX_VAULT_META_ITERATIONS = 2000000;
const ENVELOPE_FIELDS = [
  'id',
  'crypto_version',
  'iv',
  'ciphertext',
  'mac',
  'salt',
  'updated_at',
  'created_at',
];
// 可选字段：明文删除标记（配额统计与开放 API 过滤用），旧封套可以不带
const OPTIONAL_ENVELOPE_FIELDS = ['is_deleted', 'seq'];
const ENVELOPE_FIELD_SET = new Set(ENVELOPE_FIELDS);
const VAULT_META_FIELDS = ['version', 'kdf', 'iterations', 'salt', 'verifier'];
const VAULT_META_FIELD_SET = new Set(VAULT_META_FIELDS);
const FORBIDDEN_FIELDS = new Set([
  'account',
  'password',
  'notes',
  'fields',
  'custom_fields',
  '_openid',
  '_id',
  '_synced_at',
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_SYNC_TIME = '2000-01-01T00:00:00.000Z';
const DOWNLOAD_PAGE_SIZE = 100;

exports.main = async event => {
  try {
    const openid = cloud.getWXContext().OPENID;
    if (typeof openid !== 'string' || !openid) {
      return { success: false, error: 'unauthenticated' };
    }

    const request = event && typeof event === 'object' ? event : {};
    const { action, last_sync, local_updates } = request;

    // 数据同步入口的版本硬校验（2026-10-23）：缺失或低于门槛一律拒绝
  const SYNC_DATA_ACTIONS = ['full_sync', 'upload', 'download', 'check_consistency', 'create_backup_link'];
  if (SYNC_DATA_ACTIONS.indexOf(event.action) !== -1) {
    const tooOld = assertClientVersion(event);
    if (tooOld) return tooOld;
  }

  switch (action) {
      case 'full_sync':
        return await handleFullSync(openid, last_sync, local_updates);
      case 'upload':
        return await handleUpload(openid, local_updates);
      case 'download':
        return await handleDownload(openid, last_sync);
      case 'check_consistency':
        return await checkConsistency(openid);
      case 'get_vault_meta':
        return await getVaultMeta(openid);
      case 'set_vault_meta':
        return await setVaultMeta(openid, request.vault_meta);
      case 'rotate_vault_meta':
        return await rotateVaultMeta(openid, request.old_vault_meta, request.vault_meta);
      case 'init_indexes':
        return initIndexes();
      case 'purge_vault':
        return await purgeVault(openid, request.confirm);
      case 'set_master_hint':
        return await setMasterHint(openid, request.hint);
      case 'create_backup_link':
        return await createBackupLink(openid, event);
      case 'update_profile':
        return await updateProfile(openid, request.profile);
      default:
        return { success: false, error: 'unknown_action' };
    }
  } catch (error) {
    console.error('sync cloud function failed:', error);
    return { success: false, error: 'server_error' };
  }
};

async function handleFullSync(openid, lastSync, localUpdates) {
  // 全量同步同样是写入路径，必须走同一套配额校验
  const quota = await enforceCapacity(openid, localUpdates);
  if (!quota.ok) {
    const uploadResults = (Array.isArray(localUpdates) ? localUpdates : []).map(item => ({
      queue_id: item && item.queue_id ? item.queue_id : null,
      id: item && (item.id || (item.data && item.data.id)) || null,
      collection: null,
      success: false,
      error: quota.error,
    }));
    return {
      ...uploadSummary(uploadResults),
      capacity_exceeded: quota.error === 'CAPACITY_EXCEEDED',
      capacity: quota.capacity || 0,
      downloads: [],
      success: false,
      download_success: false,
    };
  }
  const upload = await processUploads(openid, localUpdates);
  const serverTime = new Date().toISOString();
  try {
    const download = await collectDownloads(openid, lastSync, serverTime);
    // 存量条目补编号（历史条目在编号功能上线前已同步，不会再有 upload 事件）
    try {
      const backfilled = await backfillMissingSeq(openid);
      if (Object.keys(backfilled).length > 0) {
        for (const item of download.downloads) {
          if (!item.seq && backfilled[item.id]) item.seq = backfilled[item.id];
        }
        download.backfilled_seq = backfilled;
      }
    } catch (e) {
      console.error('[sync] 补编号失败（不影响同步）:', e && e.message);
    }
    return {
      ...upload,
      success: upload.success,
      download_success: true,
      downloads: download.downloads,
      server_time: download.server_time,
      backfilled_seq: download.backfilled_seq || {},
    };
  } catch (error) {
    console.error('full sync download failed:', error);
    return {
      ...upload,
      success: false,
      download_success: false,
      downloads: [],
      error: 'download_failed',
      server_time: serverTime,
    };
  }
}

// ===== 容量强制（服务端唯一可信点） =====
const VIP_CAPACITY = 500;
const DEFAULT_FREE_CAPACITY = 10; // 与 login:208 统一（2026-10-22 立项，10-23 复核补齐）
// 单次上传条数上限：防止一次调用打满函数超时与数据库配额
const MAX_BATCH_ITEMS = 100;
// 墓碑上限：已删除文档仍占存储，防止用 is_deleted 占位无限写入
const TOMBSTONE_SLACK = 50;

async function resolveCapacity(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(2).get();
  if (res.data.length !== 1) return { ok: false, capacity: 0 };
  const user = res.data[0];
  const vipActive = user.vip_expire_at && new Date(user.vip_expire_at).getTime() > Date.now();
  // 永久容量（邀请 + 已购）在会员期内同样有效，叠加在 500 条基础上限之上
  const permanentAdd = (user.invite_capacity || 0) + (user.paid_capacity || 0);
  if (vipActive) return { ok: true, capacity: VIP_CAPACITY + permanentAdd };
  const capacity = (user.free_capacity || DEFAULT_FREE_CAPACITY) + permanentAdd;
  return { ok: true, capacity };
}

/**
 * 统计本次上传中"新增"的条目数（已存在同 id 的视为更新，不占新额度）。
 * 任一密码集合超容量则整体拒绝，避免部分写入导致状态不一致。
 */
async function enforceCapacity(openid, localUpdates) {
  if (!Array.isArray(localUpdates) || localUpdates.length === 0) return { ok: true };

  const { ok, capacity } = await resolveCapacity(openid);
  if (!ok) return { ok: false, error: 'USER_NOT_FOUND' };

  const counts = await db.collection('passwords')
    .where({ _openid: openid, is_deleted: _.neq(true) })
    .count();
  const current = counts.total || 0;

  // 墓碑（已删除文档）总量上限：防止把条目全部标成删除来绕过配额统计
  const allCounts = await db.collection('passwords').where({ _openid: openid }).count();
  const all = allCounts.total || 0;

  // 找出本次是新增的 id
  const candidateIds = [];
  for (const item of localUpdates) {
    const id = item && (item.id || (item.data && item.data.id));
    if (typeof id === 'string' && id) candidateIds.push(id);
  }
  const uniqueIds = [...new Set(candidateIds)];

  let existing = 0;
  if (uniqueIds.length) {
    // 分批查询已存在的 id（单次 in 查询有上限）
    for (let i = 0; i < uniqueIds.length; i += 100) {
      const chunk = uniqueIds.slice(i, i + 100);
      const res = await db.collection('passwords')
        .where({ _openid: openid, id: _.in(chunk) })
        .limit(100)
        .get();
      existing += (res.data || []).length;
    }
  }

  const incoming = Math.max(0, uniqueIds.length - existing);
  // 纯更新 / 删除（不新增条目）不占额度，永远放行；否则用户满额后将无法删除任何东西
  if (incoming > 0 && current + incoming > capacity) {
    return { ok: false, error: 'CAPACITY_EXCEEDED', capacity, current, incoming };
  }
  // 墓碑上限同样只拦新增：满额用户删除/编辑条目必须始终可用
  if (incoming > 0 && all > capacity + TOMBSTONE_SLACK) {
    return { ok: false, error: 'TOMBSTONE_LIMIT', capacity, current, incoming };
  }
  return { ok: true, capacity, current, incoming };
}

/**
 * 彻底删除当前用户的云端数据（不可逆）。
 * - 必须显式传 confirm: 'DELETE_MY_VAULT'，防止误触
 * - 仅删除 WXContext.OPENID 名下的数据，不接受任何外部 openid
 * - 返回各集合删除数量，便于前端提示
 */
async function purgeVault(openid, confirm) {
  if (confirm !== 'DELETE_MY_VAULT') {
    return { success: false, error: 'CONFIRM_REQUIRED' };
  }

  const removed = {};
  for (const collection of ['passwords', 'vault_meta']) {
    let deleted = 0;
    // 文档数据库单次批量删除有上限，循环直到清空
    for (let round = 0; round < 20; round++) {
      const res = await db.collection(collection).where({ _openid: openid }).limit(100).get();
      const docs = res.data || [];
      if (docs.length === 0) break;
      for (const doc of docs) {
        await db.collection(collection).doc(doc._id).remove().catch(() => {});
        deleted += 1;
      }
      if (docs.length < 100) break;
    }
    removed[collection] = deleted;
  }

  // 订单与审计保留（财务与合规留痕），仅在响应中说明
  return { success: true, removed, note: 'orders_and_audit_retained_for_compliance' };
}

/**
 * 更新个人资料（昵称、头像文件ID）。
 * 只允许改自己的记录；字段白名单 + 长度/格式校验。
 */
async function updateProfile(openid, profile) {
  if (!profile || typeof profile !== 'object') {
    return { success: false, error: 'PROFILE_REQUIRED' };
  }
  const update = {};

  if (profile.nick_name !== undefined) {
    const name = String(profile.nick_name || '').trim();
    if (name.length < 1 || name.length > 20) {
      return { success: false, error: 'NICKNAME_INVALID' };
    }
    // 去掉换行与控制字符，避免展示异常
    update.nick_name = name.replace(/\s+/g, ' ').slice(0, 20);
  }

  if (profile.avatar_file_id !== undefined) {
    const fileId = String(profile.avatar_file_id || '');
    if (fileId && !fileId.startsWith('cloud://')) {
      return { success: false, error: 'AVATAR_INVALID' };
    }
    update.avatar_file_id = fileId;
  }

  if (Object.keys(update).length === 0) {
    return { success: false, error: 'NOTHING_TO_UPDATE' };
  }
  update.updated_at = db.serverDate();

  const res = await db.collection('users').where({ _openid: openid }).limit(2).get();
  if (res.data.length !== 1) return { success: false, error: 'USER_NOT_FOUND' };
  await db.collection('users').doc(res.data[0]._id).update({ data: update });
  return { success: true, profile: { nick_name: update.nick_name, avatar_file_id: update.avatar_file_id } };
}

async function handleUpload(openid, localUpdates) {
  const quota = await enforceCapacity(openid, localUpdates);
  if (!quota.ok) {
    if (quota.error === 'CAPACITY_EXCEEDED') {
      const uploadResults = (Array.isArray(localUpdates) ? localUpdates : []).map(item => ({
        queue_id: item && item.queue_id ? item.queue_id : null,
        id: item && (item.id || (item.data && item.data.id)) || null,
        collection: null,
        success: false,
        error: 'CAPACITY_EXCEEDED',
      }));
      return {
        ...uploadSummary(uploadResults),
        capacity_exceeded: true,
        capacity: quota.capacity,
        current: quota.current,
        incoming: quota.incoming,
        downloads: [],
      };
    }
    const uploadResults = [{
      queue_id: null,
      id: null,
      collection: null,
      success: false,
      error: quota.error,
    }];
    return { ...uploadSummary(uploadResults), downloads: [] };
  }

  const result = await processUploads(openid, localUpdates);
  return { ...result, downloads: [] };
}

/** 原子分配条目编号：counters/entry_seq 事务自增（首次自动建文档） */
async function allocateEntrySeq() {
  const counters = db.collection('counters');
  const docId = 'entry_seq';
  try {
    const existing = await counters.doc(docId).get();
    if (!existing || !existing.data) throw new Error('missing');
  } catch (e) {
    await counters.add({ data: { _id: docId, value: 0 } }).catch(() => {});
  }
  return db.runTransaction(async (t) => {
    const ref = t.collection('counters').doc(docId);
    const snap = await ref.get();
    const value = Number(snap && snap.data && snap.data.value) || 0;
    const updated = value + 1;
    await ref.update({ data: { value: updated } });
    return updated;
  });
}

/**
 * 为存量条目补编号：扫描该用户 passwords 中缺 seq 的记录，
 * 逐条从 counters 取号并回写，返回 { entryId: seq } 映射。
 * 幂等：已有 seq 的记录跳过；每次 full_sync 调用一次（条目少，成本可忽略）。
 */
async function backfillMissingSeq(openid) {
  const map = {};
  const PAGE = 100;
  let offset = 0;
  for (;;) {
    let res;
    try {
      res = await db.collection('passwords')
        .where({ _openid: openid })
        .skip(offset)
        .limit(PAGE)
        .get();
    } catch (e) {
      break;
    }
    const rows = (res && res.data) || [];
    for (const row of rows) {
      if (Number(row.seq) > 0) continue;
      const seq = await allocateEntrySeq();
      await db.collection('passwords').doc(row._id)
        .update({ data: { seq } })
        .catch(() => {});
      map[row.id || row._id] = seq;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return map;
}

async function processUploads(openid, localUpdates) {
  if (localUpdates === undefined || localUpdates === null) {
    return uploadSummary([]);
  }
  if (Array.isArray(localUpdates) && localUpdates.length > MAX_BATCH_ITEMS) {
    const uploadResults = [{
      queue_id: null,
      id: null,
      collection: null,
      success: false,
      error: 'BATCH_TOO_LARGE',
    }];
    return uploadSummary(uploadResults);
  }
  if (!Array.isArray(localUpdates)) {
    const uploadResults = [{
      queue_id: null,
      id: null,
      collection: null,
      success: false,
      error: 'local_updates_must_be_array',
    }];
    return uploadSummary(uploadResults);
  }

  const queueCounts = new Map();
  for (const item of localUpdates) {
    if (item && typeof item.queue_id === 'string' && item.queue_id.trim()) {
      queueCounts.set(item.queue_id, (queueCounts.get(item.queue_id) || 0) + 1);
    }
  }

  const uploadResults = [];
  for (const item of localUpdates) {
    const queueId = item && typeof item.queue_id === 'string' && item.queue_id.trim()
      ? item.queue_id
      : null;
    const itemId = getReportedId(item);
    const collection = item && item.collection === undefined
      ? 'passwords'
      : item && typeof item.collection === 'string'
        ? item.collection
        : null;

    if (!queueId) {
      uploadResults.push(uploadFailure(null, itemId, collection, 'missing_queue_id'));
      continue;
    }
    if (queueCounts.get(queueId) > 1) {
      uploadResults.push(uploadFailure(queueId, itemId, collection, 'duplicate_queue_id'));
      continue;
    }

    try {
      if (!collection || !COLLECTIONS.includes(collection)) {
        throw uploadError('invalid_collection');
      }
      if (item.action !== undefined && !['add', 'update', 'delete'].includes(item.action)) {
        throw uploadError('invalid_mutation');
      }
      const envelope = validateEntry(item);
      // 编号：passwords 才分配；已有编号沿用（幂等），否则从 counters 原子取号
      let assignedSeq = null;
      if (collection === 'passwords') {
        const priorRes = await db.collection('passwords')
          .where({ _openid: openid, id: envelope.id })
          .limit(1)
          .get();
        const prior = priorRes && priorRes.data && priorRes.data[0];
        if (prior && Number(prior.seq) > 0) {
          envelope.seq = Number(prior.seq);
        } else {
          envelope.seq = await allocateEntrySeq();
        }
        assignedSeq = envelope.seq;
      }
      await upsertOwnedRecord(openid, collection, envelope.id, envelope);
      uploadResults.push({
        queue_id: queueId,
        id: envelope.id,
        collection,
        success: true,
        seq: assignedSeq,
      });
    } catch (error) {
      const code = error && error.code ? error.code : 'write_failed';
      uploadResults.push(uploadFailure(queueId, itemId, collection, code));
    }
  }

  return uploadSummary(uploadResults);
}

function uploadSummary(uploadResults) {
  const confirmed = uploadResults
    .filter(result => result.success)
    .map(({ queue_id, id, collection, seq }) => ({ queue_id, id, collection, seq: seq === undefined ? null : seq }));
  return {
    success: uploadResults.every(result => result.success),
    uploads_ok: confirmed.length,
    upload_results: uploadResults,
    confirmed_queue_ids: confirmed.map(result => result.queue_id),
  };
}

function uploadFailure(queueId, id, collection, error) {
  return { queue_id: queueId, id, collection, success: false, error };
}

function getReportedId(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id === 'string') return item.id;
  if (item.data && typeof item.data === 'object' && typeof item.data.id === 'string') {
    return item.data.id;
  }
  return null;
}

function validateEntry(item) {
  if (!isPlainObject(item)) throw uploadError('invalid_envelope');
  if (containsForbiddenField(item)) throw uploadError('forbidden_field');

  const data = item.data === undefined ? {} : item.data;
  if (!isPlainObject(data)) throw uploadError('invalid_envelope');

  const allowedOuterFields = new Set([
    'queue_id',
    'action',
    'collection',
    'data',
    ...ENVELOPE_FIELDS,
    ...OPTIONAL_ENVELOPE_FIELDS,
  ]);
  if (Object.keys(item).some(key => !allowedOuterFields.has(key))) {
    throw uploadError('unsupported_field');
  }
  if (Object.keys(data).some(key => !ENVELOPE_FIELD_SET.has(key) && !OPTIONAL_ENVELOPE_FIELDS.includes(key))) {
    throw uploadError('unsupported_field');
  }

  const envelope = {};
  for (const field of ENVELOPE_FIELDS) {
    const values = [];
    if (Object.prototype.hasOwnProperty.call(item, field)) values.push(item[field]);
    if (Object.prototype.hasOwnProperty.call(data, field)) values.push(data[field]);
    if (!values.length) throw uploadError('invalid_envelope');

    const normalized = values.map(value => (
      field === 'updated_at' || field === 'created_at'
        ? toIsoTimestamp(value)
        : value
    ));
    if (normalized.some(value => value === null)
      || normalized.some(value => value !== normalized[0])) {
      throw uploadError('invalid_envelope');
    }
    envelope[field] = normalized[0];
  }

  if (typeof envelope.id !== 'string' || !envelope.id.trim()) {
    throw uploadError('invalid_envelope');
  }
  if (envelope.crypto_version !== 1) throw uploadError('unsupported_crypto_version');
  if (typeof envelope.salt !== 'string' || !/^[0-9a-f]{32}$/i.test(envelope.salt)) {
    throw uploadError('invalid_envelope');
  }
  if (typeof envelope.iv !== 'string' || !/^[0-9a-f]{32}$/i.test(envelope.iv)) {
    throw uploadError('invalid_envelope');
  }
  if (typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    throw uploadError('invalid_envelope');
  }
  if (typeof envelope.ciphertext !== 'string'
      || !/^(?:[0-9a-f]{2})+$/i.test(envelope.ciphertext)
      || envelope.ciphertext.length < 32
      || envelope.ciphertext.length % 32 !== 0) {
    throw uploadError('invalid_envelope');
  }
  if (!envelope.updated_at || !envelope.created_at) {
    throw uploadError('invalid_envelope');
  }

  // 可选：明文删除标记（不参与 MAC，仅作云端索引）
  const hasDeleted = Object.prototype.hasOwnProperty.call(item, 'is_deleted')
    || Object.prototype.hasOwnProperty.call(data, 'is_deleted');
  if (hasDeleted) {
    const deletedValue = item.is_deleted !== undefined ? item.is_deleted : data.is_deleted;
    if (typeof deletedValue !== 'boolean') throw uploadError('invalid_envelope');
    envelope.is_deleted = deletedValue;
  }
  return envelope;
}

function containsForbiddenField(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || value instanceof Date || seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key) || containsForbiddenField(child, seen)) return true;
  }
  return false;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function uploadError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function upsertOwnedRecord(openid, collectionName, id, envelope) {
  const collection = db.collection(collectionName);
  const canonical = await findRecordById(collection, id);
  if (canonical && canonical._openid !== openid) throw uploadError('owner_mismatch');

  // Older documents can have a generated _id while retaining the business id.
  const matches = await collection.where({ _openid: openid, id }).limit(2).get();
  const aliases = matches.data || [];
  if (aliases.length > 1 || (canonical && aliases[0] && canonical._id !== aliases[0]._id)) {
    throw uploadError('record_id_conflict');
  }
  const existing = canonical || aliases[0];

  if (existing) {
    if (existing.id && existing.id !== id) throw uploadError('record_id_conflict');
    await collection.doc(existing._id).set({
      data: {
        _openid: openid,
        ...envelope,
        _synced_at: db.serverDate(),
      },
    });
    return;
  }

  await collection.add({
    data: {
      _id: id,
      _openid: openid,
      ...envelope,
      _synced_at: db.serverDate(),
    },
  });
}

async function findRecordById(collection, id) {
  const result = await collection.where({ _id: id }).limit(1).get();
  return result.data && result.data.length ? result.data[0] : null;
}

/** 仅测试/运维使用：端侧同步只走 full_sync（2026-10-23 审计标注） */
async function handleDownload(openid, lastSync) {
  const serverTime = new Date().toISOString();
  try {
    const result = await collectDownloads(openid, lastSync, serverTime);
    return {
      success: true,
      downloads: result.downloads,
      server_time: result.server_time,
    };
  } catch (error) {
    console.error('download failed:', error);
    return {
      success: false,
      downloads: [],
      error: 'download_failed',
      server_time: serverTime,
    };
  }
}

async function collectDownloads(openid, lastSync, serverTime) {
  const syncTime = lastSync === undefined || lastSync === null || lastSync === ''
    ? DEFAULT_SYNC_TIME
    : toIsoTimestamp(lastSync);
  if (!syncTime) throw new Error('invalid_last_sync');

  const downloads = [];
  const seen = new Set();
  const highWaterMark = serverTime || new Date().toISOString();
  const highWaterDate = new Date(highWaterMark);
  for (const collectionName of COLLECTIONS) {
    for (const [timestamp, upperBound] of [
      [syncTime, highWaterMark],
      [new Date(syncTime), highWaterDate],
    ]) {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await db.collection(collectionName)
          .where({
            _openid: openid,
            updated_at: _.and(
              _.gt(timestamp),
              _.lte(upperBound),
            ),
          })
          .skip(offset)
          .limit(DOWNLOAD_PAGE_SIZE)
          .orderBy('updated_at', 'asc')
          .orderBy('_id', 'asc')
          .get();

        for (const record of result.data) {
          const recordId = record._id || record.id;
          const key = `${collectionName}:${recordId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const data = Object.fromEntries(
            ENVELOPE_FIELDS.map(field => [
              field,
              field === 'id' ? (record.id || recordId) : record[field],
            ]),
          );
          downloads.push({
            id: recordId,
            collection: collectionName,
            data,
            // 编号随下载返回，端侧缓存到 entry_seq_map
            seq: collectionName === 'passwords' ? (Number(record.seq) > 0 ? Number(record.seq) : null) : null,
          });
        }

        hasMore = result.data.length >= DOWNLOAD_PAGE_SIZE;
        offset += DOWNLOAD_PAGE_SIZE;
      }
    }
  }
  return { downloads, server_time: highWaterMark };
}


/**
 * 一致性检测（只读轻量）：返回云端密码库元数据摘要与条目统计，
 * 供端上定时对比本地状态（meta 不一致 / 云端更新 / 待上传）。
 * 注意：不返回 verifier 以外的密钥材料——verifier 本就是恢复流程必需字段。
 */
async function checkConsistency(openid) {
  const metaRes = await db.collection('vault_meta')
    .where({ _openid: openid })
    .limit(2)
    .get();
  if (metaRes.data.length > 1) {
    return { success: false, code: 'VAULT_META_AMBIGUOUS', error: '密码库元数据异常' };
  }
  const meta = metaRes.data[0] || null;
  const aliveFilter = { _openid: openid, is_deleted: db.command.neq(true) };
  const countRes = await db.collection('passwords').where(aliveFilter).count();
  const latestRes = await db.collection('passwords')
    .where(aliveFilter)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .get();
  const latestDoc = latestRes.data[0] || null;
  return {
    success: true,
    exists: !!meta,
    vault_meta: meta
      ? { kdf: meta.kdf, salt: meta.salt, iterations: meta.iterations, version: meta.version, verifier: meta.verifier }
      : null,
    entry_count: (countRes.total !== undefined) ? countRes.total : (countRes.count || 0),
    latest_updated_at: latestDoc && latestDoc.updated_at ? latestDoc.updated_at : null,
  };
}

async function getVaultMeta(openid) {
  try {
    const existing = await findRecordById(db.collection(VAULT_META_COLLECTION), openid);
    if (!existing) return { success: true, exists: false, vault_meta: null };
    if (existing._openid !== openid) return { success: false, error: 'owner_mismatch' };
    return {
      success: true,
      exists: true,
      vault_meta: publicVaultMeta(existing),
    };
  } catch (error) {
    console.error('get vault metadata failed:', error);
    return { success: false, error: 'vault_meta_read_failed' };
  }
}

/**
 * 备份取件登记（2026-10-23）：加密备份上传云存储后，登记取件信息并生成取件 ID。
 * 下载页（/bk?id=xxx）凭 id + 备份密码换取限时下载直链；密码校验用 verifier（PBKDF2 结果），
 * verifier 只存云端不下发，网页/攻击者无法离线爆破。
 */
async function createBackupLink(openid, event) {
  const fileId = typeof event.file_id === 'string' ? event.file_id.trim() : '';
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : null;
  const verifier = meta && typeof meta.verifier === 'string' ? meta.verifier.trim() : '';
  const salt = meta && typeof meta.salt === 'string' ? meta.salt.trim() : '';
  const iterations = meta && Number.isFinite(Number(meta.iterations)) ? Number(meta.iterations) : 0;
  const kdf = meta && typeof meta.kdf === 'string' ? meta.kdf.trim() : 'PBKDF2-HMAC-SHA256';

  if (!fileId || !verifier || !salt || iterations < 1000) {
    return { success: false, error: 'INVALID_BACKUP_META' };
  }

  const chars = '0123456789abcdef';
  const linkId = Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * 16)]).join('');
  const now = db.serverDate();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 分钟有效（2026-10-23 用户调整）

  await db.collection('backup_links').add({
    data: {
      _openid: openid,
      link_id: linkId,
      file_id: fileId,
      kdf,
      salt,
      iterations,
      verifier,
      created_at: now,
      expires_at: expiresAt,
      downloads: 0,
      status: 'active',
    },
  });

  return { success: true, link_id: linkId, expires_at: expiresAt.toISOString() };
}

async function setMasterHint(openid, hint) {
  const value = typeof hint === 'string' ? hint.trim().slice(0, 200) : ''; // 上限 200 字（2026-10-23 由 60 放宽）
  const collection = db.collection('users');
  // users 的 _id 是随机串而非 openid，必须按 _openid 字段查询（不能用 findRecordById 按 _id 找）
  const userRes = await collection.where({ _openid: openid }).limit(2).get();
  if (userRes.data.length !== 1) return { success: false, error: 'USER_NOT_FOUND' };
  const user = userRes.data[0];
  await collection.doc(user._id).update({ data: { master_hint: value, updated_at: Date.now() } });
  return { success: true, master_hint: value };
}

async function setVaultMeta(openid, value) {
  try {
    const metadata = validateVaultMeta(value);
    const collection = db.collection(VAULT_META_COLLECTION);
    const existing = await findRecordById(collection, openid);
    if (existing) {
      if (existing._openid !== openid) return { success: false, error: 'owner_mismatch' };
      return {
        success: true,
        created: false,
        version: existing.version,
        vault_meta: publicVaultMeta(existing),
      };
    }

    try {
      await collection.add({
        data: {
          _id: openid,
          _openid: openid,
          ...metadata,
        },
      });
      return { success: true, created: true, vault_meta: metadata };
    } catch (error) {
      // A concurrent first-write may have won; never replace its metadata.
      const concurrent = await findRecordById(collection, openid);
      if (!concurrent || concurrent._openid !== openid) {
        return { success: false, error: 'vault_meta_write_failed' };
      }
      return {
        success: true,
        created: false,
        version: concurrent.version,
        vault_meta: publicVaultMeta(concurrent),
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error && error.code ? error.code : 'vault_meta_write_failed',
    };
  }
}

/**
 * 轮换 vault_meta（CAS）：仅当 old_vault_meta 与云端当前记录完全一致时才允许换新。
 * 安全模型：openid 所有权 + old 精确匹配（持有当前主密码的客户端才能拿到当前 meta）；
 * 密文重加密由客户端协议保证（全部记录确认上传后才调用本 action）。
 */
async function rotateVaultMeta(openid, oldVaultMetaValue, nextVaultMetaValue) {
  try {
    const next = validateVaultMeta(nextVaultMetaValue);
    const old = validateVaultMeta(oldVaultMetaValue);
    const collection = db.collection(VAULT_META_COLLECTION);
    const existing = await findRecordById(collection, openid);
    if (!existing) return { success: false, error: 'vault_meta_not_found' };
    if (existing._openid !== openid) return { success: false, error: 'owner_mismatch' };
    const current = publicVaultMeta(existing);
    if (JSON.stringify(current) !== JSON.stringify(old)) {
      return { success: false, error: 'vault_meta_mismatch' };
    }
    await collection.doc(existing._id).update({
      data: { salt: next.salt, verifier: next.verifier, iterations: next.iterations },
    });
    return { success: true, rotated: true, vault_meta: next };
  } catch (error) {
    return {
      success: false,
      error: error && error.code ? error.code : 'vault_meta_write_failed',
    };
  }
}

function validateVaultMeta(value) {
  if (!isPlainObject(value)
    || Object.keys(value).length !== VAULT_META_FIELDS.length
    || Object.keys(value).some(key => !VAULT_META_FIELD_SET.has(key))) {
    throw uploadError('invalid_vault_meta');
  }
  if (value.version !== VAULT_META_VERSION
    || value.kdf !== VAULT_META_KDF
    || !Number.isInteger(value.iterations)
    || value.iterations < MIN_VAULT_META_ITERATIONS
    || value.iterations > MAX_VAULT_META_ITERATIONS
    || typeof value.salt !== 'string'
    || !/^[0-9a-f]{32}$/i.test(value.salt)
    || typeof value.verifier !== 'string'
    || !/^[0-9a-f]{64}$/i.test(value.verifier)) {
    throw uploadError('invalid_vault_meta');
  }
  return Object.fromEntries(VAULT_META_FIELDS.map(field => [field, value[field]]));
}

function publicVaultMeta(record) {
  return Object.fromEntries(VAULT_META_FIELDS.map(field => [field, record[field]]));
}

function initIndexes() {
  return {
    success: true,
    indexes_needed: [
      { collection: 'passwords', field: 'updated_at', order: 'desc' },
    ],
    note: '仅按当前增量下载查询模型列出 updated_at；不会创建索引，是否需要额外索引必须以目标环境的实际查询计划为准',
  };
}
