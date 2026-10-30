// HTTP 云函数 - openapi（第三方程序调用）
// 能力：授权码换取令牌、拉取密文与公开参数
// 安全红线：绝不返回明文；云端不持有解密密钥；令牌只存哈希

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const CODES = 'api_codes';
const TOKENS = 'api_tokens';
const AUDIT = 'api_audit';
const PASSWORDS = 'passwords';
const VAULT_META = 'vault_meta';
const OTP = 'otp_requests';            // 一次性交付请求（AI 发起 → 用户批准 → 取件即焚）
const OTP_PENDING_TTL_MS = 10 * 60 * 1000;  // 待批准超时 10 分钟
const OTP_MAX_PENDING_PER_USER = 3;         // 同一用户同时待批准上限
const OTP_MAX_REQUESTS_PER_IP_MIN = 3;      // 同一 IP 每分钟发起上限

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 与 apiAuth 签发一致（2026-10-22 统一，原 30 天）
const RATE_LIMIT_PER_MIN = 60;
const MAX_PAGE = 100;
const ENVELOPE_FIELDS = ['id', 'crypto_version', 'iv', 'ciphertext', 'mac', 'salt', 'updated_at', 'created_at'];

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event || !event.body) return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {};
  }
}

function getHeader(event, name) {
  const headers = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return '';
}

function getPath(event) {
  const raw = (event && (event.path || event.rawPath)) || '';
  let p = String(raw).split('?')[0].replace(/\/+$/, '');
  // 网关默认会剥掉触发路径前缀（/v1），此处归一化兼容两种形式
  p = p.replace(/^\/api/, '').replace(/^\/v1/, '');
  return p || '/';
}

function clientIp(event) {
  const headers = (event && event.headers) || {};
  const lowered = {};
  Object.keys(headers).forEach(k => { lowered[k.toLowerCase()] = headers[k]; });
  return String(lowered['x-forwarded-for'] || lowered['x-real-ip'] || '').split(',')[0].trim();
}

async function writeAudit(openid, tokenId, action, extra) {
  try {
    await db.collection(AUDIT).add({
      data: {
        _openid: openid,
        token_id: tokenId,
        action,
        created_at: Date.now(),
        expire_at: new Date(Date.now() + 90 * 24 * 3600 * 1000), // Date 类型，TTL 90 天（与 OTP 审计一致）
        ...extra,
      },
    });
  } catch (e) { /* 审计失败不阻断业务 */ }
}

// ===== 授权码尝试限流 =====
// 不按 IP 计数：请求头（如 X-Forwarded-For）可由调用方任意伪造，换一个值就是新计数桶。
// 改为「全局滑动窗口 + 单码失败计数」两个不依赖请求头的维度。
const CODE_ATTEMPT_WINDOW_MS = 60 * 1000;
const CODE_ATTEMPT_GLOBAL_MAX = 300;   // 全局：每分钟码不存在次数上限（仅防大规模枚举）
const CODE_ATTEMPT_MAX_PER_CODE = 5;   // 单码：错 5 次锁定

async function globalFailures() {
  const since = Date.now() - CODE_ATTEMPT_WINDOW_MS;
  const res = await db.collection(AUDIT)
    .where({ action: 'token_code_failed', created_at: _.gt(since) })
    .limit(CODE_ATTEMPT_GLOBAL_MAX + 1)
    .get();
  return (res.data || []).length;
}

async function recordCodeFailure(ip, code) {
  try {
    await db.collection(AUDIT).add({
      data: {
        action: 'token_code_failed',
        ip: String(ip || '').slice(0, 45),
        code_length: String(code).length,
        created_at: Date.now(),
        expire_at: new Date(Date.now() + 90 * 24 * 3600 * 1000), // Date 类型，TTL 90 天
      },
    });
  } catch (e) { /* 审计失败不阻断 */ }
}

// ===== 令牌签发：POST /v1/token =====
async function exchangeToken(event) {
  const body = parseBody(event);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim().slice(0, 40) : '未命名设备';
  const ip = clientIp(event);

  // 前置限流：全局窗口（不可伪造维度）
  if ((await globalFailures()) >= CODE_ATTEMPT_GLOBAL_MAX) {
    return json(429, { success: false, error: 'too_many_attempts' });
  }

  if (!/^\d{8}$/.test(code)) {
    // 格式非法不计入全局桶：避免匿名者用垃圾请求把所有人的令牌交换打成 429
    return json(400, { success: false, error: 'invalid_code' });
  }

  const res = await db.collection(CODES).where({ code }).limit(2).get();
  if (res.data.length !== 1) {
    await recordCodeFailure(ip, code);
    return json(404, { success: false, error: 'code_not_found' });
  }
  const record = res.data[0];
  // 命中即清零该码的失败计数（合法用户正常重试不应被判为攻击）
  if ((record.failed_attempts || 0) > 0) {
    await db.collection(CODES).doc(record._id).update({ data: { failed_attempts: 0 } }).catch(() => {});
  }
  if (record.expires_at < Date.now()) {
    await recordCodeFailure(ip, code);
    return json(410, { success: false, error: 'code_expired' });
  }
  if (record.status === 'rejected') return json(403, { success: false, error: 'rejected_by_user' });
  if (record.status === 'used') return json(410, { success: false, error: 'code_used' });
  if (record.locked === true || (record.failed_attempts || 0) >= CODE_ATTEMPT_MAX_PER_CODE) {
    await recordCodeFailure(ip, code);
    return json(410, { success: false, error: 'code_locked' });
  }

  // 首次提交：登记请求，等待用户在小程序确认（属正常流程，不计失败）
  if (record.status === 'waiting') {
    await db.collection(CODES).doc(record._id).update({
      data: { status: 'pending', device_name: '待确认设备', requested_at: Date.now() },
    });
    return json(202, { success: false, status: 'pending_confirmation', message: '请在小程序内确认该设备接入' });
  }

  if (record.status === 'approved' && record.token_plain) {
    const token = record.token_plain;
    // 令牌明文只交付一次，随后清除（云端只保留哈希）
    // 条件更新：仅当仍处于 approved 时消费，防止并发双发令牌
    const consume = await db.collection(CODES)
      .where({ _id: record._id, status: 'approved' })
      .update({ data: { status: 'used', token_plain: '', used_at: Date.now() } });
    if (!(consume.stats && consume.stats.updated === 1)) {
      return json(410, { success: false, error: 'code_used' });
    }
    await writeAudit(record._openid, '', 'token_issued', { device_name: deviceName, ip: clientIp(event) });
    return json(200, {
      success: true,
      token,
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      scopes: ['items:read'],
    });
  }

  // pending 轮询：正常等待，不计失败
  return json(202, { success: false, status: record.status, message: '等待用户确认' });
}

// ===== 令牌校验 + 限流 =====
async function authenticate(event) {
  const auth = getHeader(event, 'authorization');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/i.test(token)) return { error: json(401, { success: false, error: 'unauthorized' }) };

  const hash = sha256(token);
  const res = await db.collection(TOKENS).where({ token_hash: hash }).limit(2).get();
  if (res.data.length !== 1) return { error: json(401, { success: false, error: 'unauthorized' }) };
  const record = res.data[0];
  if (record.revoked === true) return { error: json(403, { success: false, error: 'token_revoked' }) };
  if ((record.expires_at || 0) < Date.now()) return { error: json(403, { success: false, error: 'token_expired' }) };

  // 每分钟限流
  const now = Date.now();
  const windowStart = record.rate_window_start || 0;
  const inWindow = now - windowStart < 60 * 1000;
  const count = inWindow ? (record.rate_count || 0) : 0;
  if (inWindow && count >= RATE_LIMIT_PER_MIN) {
    return { error: json(429, { success: false, error: 'rate_limited' }) };
  }
  // 开放 API 为会员权益：令牌有效期内若会员到期，同步失效
  const userRes = await db.collection('users').where({ _openid: record._openid }).limit(2).get();
  const user = userRes.data.length === 1 ? userRes.data[0] : null;
  const vipActive = !!(user && user.vip_expire_at && new Date(user.vip_expire_at).getTime() > Date.now());
  if (!vipActive) {
    return { error: json(403, { success: false, error: 'vip_required' }) };
  }

  await db.collection(TOKENS).doc(record._id).update({
    data: {
      last_used_at: now,
      rate_window_start: inWindow ? windowStart : now,
      rate_count: count + 1,
    },
  });
  return { record };
}

// ===== GET /v1/vault/meta =====
async function getVaultMeta(record, event) {
  const res = await db.collection(VAULT_META).where({ _id: record._openid }).limit(2).get();
  if (res.data.length !== 1) return json(404, { success: false, error: 'vault_not_initialized' });
  const meta = res.data[0];
  await writeAudit(record._openid, record._id, 'read_meta', { ip: clientIp(event) });
  return json(200, {
    success: true,
    vault_meta: {
      version: meta.version,
      kdf: meta.kdf,
      iterations: meta.iterations,
      salt: meta.salt,
      // verifier 不对外暴露：它是"离线验证猜测主密码"的凭据，
      // 第三方解密只需要 salt + iterations，多暴露一个字段就多一个爆破靶子
    },
  });
}

// ===== GET /v1/items?since=&limit= =====
async function listItems(record, event) {
  const query = (event && event.queryStringParameters) || {};
  const since = Number(query.since) || 0;
  const limit = Math.min(Math.max(Number(query.limit) || MAX_PAGE, 1), MAX_PAGE);

  // since 必须下推到查询条件：若在 limit 之后再过滤，单页外更早但晚于 since 的更新会被静默丢弃
  const where = { _openid: record._openid };
  if (since > 0) {
    where.updated_at = _.gt(new Date(since));
  }
  const coll = db.collection(PASSWORDS);
  // 增量同步语义：按 updated_at 升序（旧→新），配合 since 下推与 next_since 游标翻页，保证不重不漏
  const res = await coll.where(where).orderBy('updated_at', 'asc').limit(limit).get();
  const raw = res.data || [];
  const items = raw
    // 已删除条目不对外提供（字段缺失视为未删除）
    .filter(item => item.is_deleted !== true)
    .map(item => {
      const envelope = {};
      ENVELOPE_FIELDS.forEach(field => { if (item[field] !== undefined) envelope[field] = item[field]; });
        return envelope;
    });

  // 游标：本页未满说明已取完（next_since=null）；满页返回本页最新一条时间，供下次增量继续
  let nextSince = null;
  if (raw.length >= limit && raw.length > 0) {
    const newest = raw[raw.length - 1];
    const t = new Date(newest.updated_at).getTime();
    if (!isNaN(t)) nextSince = t;
  }

  await writeAudit(record._openid, record._id, 'read_items', {
    ip: clientIp(event),
    item_count: items.length,
  });
  return json(200, { success: true, items, next_since: nextSince, server_time: Date.now() });
}

/**
 * POST /v1/request —— AI 发起"一次性读取某条"请求（无需长期令牌）
 * body: { client_name, purpose, entry_id, key_hex }
 * 返回: { request_id, claim_secret, expires_in }，AI 凭 claim_secret 取件一次
 */
/** 首次使用时自动创建一次性交付集合（云开发不会自动建表） */
let otpCollectionReady = false;
async function ensureOtpCollection() {
  if (otpCollectionReady) return;
  try {
    await db.createCollection(OTP);
  } catch (e) {
    // 已存在会抛错，忽略
  }
  otpCollectionReady = true;
}

async function createOtpRequest(event) {
  const body = parseBody(event);
  const clientName = String(body.client_name || '').trim();
  const purpose = String(body.purpose || '').trim();
  const entryId = String(body.entry_id || '').trim();
  const keyHex = String(body.key_hex || '').trim();
  // 协议版本：'p256' = ECDH 密钥协商（v2，云端零密钥）；缺省/'symmetric' = 旧对称协议（兼容，deprecated）
  const curve = String(body.curve || 'symmetric').toLowerCase();
  const aiPubkey = String(body.ai_pubkey || '').trim();

  if (clientName.length < 1 || clientName.length > 40) {
    return json(400, { success: false, error: 'invalid_client_name' });
  }
  if (purpose.length < 1 || purpose.length > 80) {
    return json(400, { success: false, error: 'invalid_purpose' });
  }
  if (!/^[0-9a-f]{32}$/i.test(entryId)) {
    return json(400, { success: false, error: 'invalid_entry_id' });
  }
  if (curve !== 'symmetric' && curve !== 'p256') {
    return json(400, { success: false, error: 'invalid_curve' });
  }
  if (curve === 'symmetric' && !/^[0-9a-f]{64}$/i.test(keyHex)) {
    return json(400, { success: false, error: 'invalid_key' });
  }
  if (curve === 'p256' && !/^(04)?[0-9a-f]{128}$/i.test(aiPubkey)) {
    return json(400, { success: false, error: 'invalid_pubkey' });
  }

  // 条目必须存在且唯一（据此确定申请归属用户）
  const entryRes = await db.collection(PASSWORDS).where({ id: entryId }).limit(2).get();
  if (entryRes.data.length !== 1) {
    return json(404, { success: false, error: 'entry_not_found' });
  }
  const ownerOpenid = entryRes.data[0]._openid;
  if (!ownerOpenid) {
    return json(404, { success: false, error: 'entry_not_found' });
  }

  const ip = clientIp(event);
  const now = Date.now();

  // 集合可能尚未创建（首次使用）——必须在任何查询之前确保存在
  await ensureOtpCollection();

  // 限流：同 IP 每分钟最多 N 次
  const ipRes = await db.collection(OTP)
    .where({ create_ip: ip, created_at: _.gt(now - 60 * 1000) })
    .count();
  if ((ipRes.total || 0) >= OTP_MAX_REQUESTS_PER_IP_MIN) {
    return json(429, { success: false, error: 'rate_limited' });
  }

  // 上限：同一用户待批请求不超过 N 个
  const pendingRes = await db.collection(OTP)
    .where({ _openid: ownerOpenid, status: 'pending', approve_deadline: _.gt(now) })
    .count();
  if ((pendingRes.total || 0) >= OTP_MAX_PENDING_PER_USER) {
    return json(429, { success: false, error: 'too_many_pending' });
  }

  const requestId = crypto.randomBytes(16).toString('hex');
  const claimSecret = crypto.randomBytes(32).toString('hex');

  await db.collection(OTP).add({
    data: {
      request_id: requestId,
      _openid: ownerOpenid,
      entry_id: entryId,
      client_name: clientName,
      purpose,
      curve,
      ...(curve === 'p256'
        ? { ai_pubkey_hex: ('04' + aiPubkey.toLowerCase()).slice(-130) }
        : { ai_key_hex: keyHex.toLowerCase() }),
      claim_secret_hash: sha256(claimSecret),
      status: 'pending',
      delivery: {},
      create_ip: ip,
      created_at: now,
      approve_deadline: now + OTP_PENDING_TTL_MS,
      expire_at: new Date(now + 7 * 24 * 3600 * 1000), // Date 类型，TTL 保留 7 天
      consume_deadline: null,
      decided_at: null,
      consumed_at: null,
    },
  });

  await writeOtpAudit(ownerOpenid, 'otp_request_created', {
    request_id: requestId,
    entry_id: entryId,
    client_name: clientName,
  });

  return json(200, {
    success: true,
    request_id: requestId,
    claim_secret: claimSecret,
    expires_in: Math.floor(OTP_PENDING_TTL_MS / 1000),
    next: '等待用户在小程序内批准；随后 GET /v1/otp?request_id=... 取件一次（60 秒内）',
  });
}

/**
 * GET /v1/otp?request_id= —— 取走一次性交付（取件即焚）
 * header: X-Claim-Secret
 */
async function consumeOtpDelivery(event) {
  const requestId = String((event.queryStringParameters && event.queryStringParameters.request_id)
    || (event.queryString && event.queryString.request_id)
    || '').trim();
  const claim = String(getHeader(event, 'x-claim-secret') || '').trim();

  if (!/^[0-9a-f]{32}$/i.test(requestId)) {
    return json(400, { success: false, error: 'invalid_request_id' });
  }
  if (!/^[0-9a-f]{64}$/i.test(claim)) {
    return json(401, { success: false, error: 'unauthorized' });
  }

  const res = await db.collection(OTP).where({ request_id: requestId }).limit(2).get();
  if (res.data.length !== 1) {
    return json(404, { success: false, error: 'request_not_found' });
  }
  const record = res.data[0];

  if (record.claim_secret_hash !== sha256(claim)) {
    return json(401, { success: false, error: 'unauthorized' });
  }

  const now = Date.now();
  if (record.status === 'denied') {
    return json(403, { success: false, error: 'denied_by_user' });
  }
  if (record.status === 'pending') {
    return json(409, { success: false, error: 'waiting_for_user' });
  }
  if (record.status === 'consumed') {
    return json(409, { success: false, error: 'already_consumed' });
  }
  if (record.status !== 'approved' || !record.delivery) {
    return json(410, { success: false, error: 'expired' });
  }
  if (!record.consume_deadline || now > record.consume_deadline) {
    await db.collection(OTP).doc(record._id)
      .update({ data: { status: 'expired', delivery: null } })
      .catch(() => {});
    return json(410, { success: false, error: 'expired' });
  }

  const delivery = record.delivery;
  // 取件即焚：条件更新（仅 approved 可消费），两个并发取件只有一个 updated===1
  const consume = await db.collection(OTP)
    .where({ _id: record._id, status: 'approved' })
    .update({ data: { status: 'consumed', delivery: _.set(null), consumed_at: now } });
  if (!(consume.stats && consume.stats.updated === 1)) {
    return json(409, { success: false, error: 'already_consumed' });
  }

  await writeOtpAudit(record._openid, 'otp_consumed', {
    request_id: requestId,
    entry_id: record.entry_id,
    client_name: record.client_name,
  });

  return json(200, {
    success: true,
    entry_id: record.entry_id,
    alg: delivery.alg || 'AES-256-CBC',
    iv: delivery.iv,
    ciphertext: delivery.ciphertext,
    note: '交付已消费并删除；本响应仅此一次',
  });
}

async function writeOtpAudit(openid, action, detail) {
  try {
    await db.collection(AUDIT).add({
      data: {
        _openid: openid,
        action,
        detail: detail || {},
        created_at: Date.now(),
        expire_at: new Date(Date.now() + 90 * 24 * 3600 * 1000), // Date 类型，TTL 90 天
      },
    });
  } catch (e) {
    console.error('[audit] 写入失败:', e && e.message);
  }
}

exports.main = async (event = {}) => {
  const method = String((event && (event.httpMethod || event.requestContext && event.requestContext.httpMethod)) || 'GET').toUpperCase();
  const path = getPath(event);

  try {
    if (path === '/token' && (method === 'GET' || method === 'POST')) {
      return await exchangeToken(event);
    }
    if (method === 'GET' && path === '/vault/meta') {
      const auth = await authenticate(event);
      if (auth.error) return auth.error;
      return await getVaultMeta(auth.record, event);
    }
    if (method === 'POST' && path === '/request') {
      return await createOtpRequest(event);
    }
    if (method === 'GET' && path === '/otp') {
      return await consumeOtpDelivery(event);
    }
    if (method === 'GET' && path === '/items') {
      const auth = await authenticate(event);
      if (auth.error) return auth.error;
      return await listItems(auth.record, event);
    }
    return json(404, { success: false, error: 'not_found' });
  } catch (error) {
    console.error('openapi 失败:', error && error.message ? error.message : error);
    return json(500, { success: false, error: 'internal_error' });
  }
};
