// 云函数 - apiAuth（小程序内调用）
// 开放 API 授权管理：生成一次性授权码、确认第三方接入、设备列表与吊销
// 安全模型：只签发"读取密文"的令牌；云端不持有任何解密密钥

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const CODES = 'api_codes';
const TOKENS = 'api_tokens';
const CODE_TTL_MS = 5 * 60 * 1000;        // 授权码 5 分钟
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;  // 令牌 7 天（一次性交付为主后缩短窗口，2026-10-22）
const MAX_ACTIVE_TOKENS = 5;               // 每个用户最多 5 台设备
const OTP = 'otp_requests';
const OTP_CONSUME_TTL_MS = 60 * 1000;     // 批准后取件窗口 60 秒

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function randomCode() {
  // 8 位纯数字：空间 9000 万（原 6 位仅 90 万，配合无限流可被枚举）
  return String(crypto.randomInt(10000000, 100000000));
}

function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// 开放 API 为会员权益：非会员（会员到期/从未开通）一律拒绝
async function requireVip(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(2).get();
  if (res.data.length !== 1) {
    return { ok: false, code: 'USER_NOT_FOUND', error: '用户信息不存在，请重新进入小程序' };
  }
  const expireAt = res.data[0].vip_expire_at;
  const active = expireAt && new Date(expireAt).getTime() > Date.now();
  if (!active) {
    return { ok: false, code: 'VIP_REQUIRED', error: '开放 API 是会员专属权益，请先开通会员' };
  }
  return { ok: true };
}

async function createCode(openid) {
  const vip = await requireVip(openid);
  if (!vip.ok) return { success: false, ...vip };
  const now = Date.now();
  // 清理过期码，并保证同一用户只保留最新未使用码
  // 不再批量删除旧码：已批准但未被取走的码若被删掉，令牌将永远无法交付。
  // 旧码由 expires_at 自然失效（交换接口会拒绝过期码），无需主动清理。
  const code = randomCode();
  const created = await db.collection(CODES).add({
    data: {
      _openid: openid,
      code,
      used: false,
      status: 'waiting',        // waiting | pending | approved | rejected | used
      device_name: '',
      token_plain: '',
      created_at: now,
      expires_at: now + CODE_TTL_MS,
      expire_at: new Date(now + 24 * 3600 * 1000), // Date 类型，TTL 保留 1 天
    },
  });
  return {
    success: true,
    code_id: created._id,
    code,
    expires_at: now + CODE_TTL_MS,
  };
}

async function findOwnedCode(openid, codeId) {
  const res = await db.collection(CODES).doc(codeId).get().catch(() => ({ data: null }));
  const record = res && res.data;
  if (!record || record._openid !== openid) return null;
  return record;
}

async function pollRequests(openid, codeId) {
  const record = await findOwnedCode(openid, codeId);
  if (!record) return { success: false, error: '授权码不存在' };
  if (record.expires_at < Date.now() && record.status !== 'approved') {
    return { success: true, status: 'expired', device_name: record.device_name || '' };
  }
  return {
    success: true,
    status: record.status,
    device_name: record.device_name || '',
    expires_at: record.expires_at,
  };
}

async function confirmRequest(openid, codeId, allow) {
  // 确认时再校验一次，避免授权码有效期内会员到期后继续签发令牌
  const vip = await requireVip(openid);
  if (!vip.ok) return { success: false, ...vip };
  const record = await findOwnedCode(openid, codeId);
  if (!record) return { success: false, error: '授权码不存在' };
  if (record.status !== 'pending') return { success: false, error: '该请求已处理或未发起' };
  if (record.expires_at < Date.now()) return { success: false, error: '授权码已过期' };

  const codeRef = db.collection(CODES).doc(codeId);
  if (!allow) {
    await codeRef.update({ data: { status: 'rejected' } });
    return { success: true, status: 'rejected' };
  }

  // 设备数上限
  const activeRes = await db.collection(TOKENS)
    .where({ _openid: openid, revoked: false })
    .limit(MAX_ACTIVE_TOKENS + 1)
    .get();
  const active = (activeRes.data || []).filter(t => t.expires_at > Date.now());
  if (active.length >= MAX_ACTIVE_TOKENS) {
    return { success: false, error: `最多同时授权 ${MAX_ACTIVE_TOKENS} 台设备，请先吊销不用的设备` };
  }

  // 生成令牌：明文暂存于授权码记录，等第三方轮询取走；取走后只保留哈希
  const token = randomToken();
  await codeRef.update({
    data: {
      status: 'approved',
      token_plain: token,
      approved_at: Date.now(),
    },
  });
  await db.collection(TOKENS).add({
    data: {
      _openid: openid,
      token_hash: sha256(token),
      device_name: safeText(record.device_name, 40) || '未命名设备',
      scopes: ['items:read'],
      created_at: Date.now(),
      expires_at: Date.now() + TOKEN_TTL_MS,
      expire_at: new Date(Date.now() + TOKEN_TTL_MS), // Date 类型，TTL 自动清理过期令牌
      revoked: false,
      last_used_at: 0,
      rate_window_start: 0,
      rate_count: 0,
    },
  });
  return { success: true, status: 'approved' };
}

async function listDevices(openid) {
  const res = await db.collection(TOKENS)
    .where({ _openid: openid })
    .limit(20)
    .get();
  const now = Date.now();
  const devices = (res.data || [])
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map(item => ({
      id: item._id,
      device_name: item.device_name,
      scopes: item.scopes || ['items:read'],
      created_at: item.created_at,
      expires_at: item.expires_at,
      revoked: item.revoked === true,
      expired: (item.expires_at || 0) < now,
      last_used_at: item.last_used_at || 0,
    }));
  return { success: true, devices };
}

async function revokeDevice(openid, deviceId) {
  const res = await db.collection(TOKENS).doc(deviceId).get().catch(() => ({ data: null }));
  const record = res && res.data;
  if (!record || record._openid !== openid) return { success: false, error: '设备不存在' };
  await db.collection(TOKENS).doc(deviceId).update({ data: { revoked: true, revoked_at: Date.now() } });
  return { success: true };
}

/** 待批准的「一次性读取」请求（ai_key_hex 仅返回给条目所有者，供端侧重加密交付内容） */
async function listOtpRequests(openid) {
  const now = Date.now();
  const res = await db.collection(OTP)
    .where({ _openid: openid, status: 'pending', approve_deadline: _.gt(now) })
    .orderBy('created_at', 'desc')
    .limit(10)
    .get();
  const requests = (res.data || []).map((item) => ({
    request_id: item.request_id,
    entry_id: item.entry_id,
    client_name: item.client_name,
    purpose: item.purpose,
    curve: item.curve || 'symmetric',        // 协议版本：p256（v2，ECDH）| symmetric（旧对称）
    ai_key_hex: item.ai_key_hex,             // symmetric 协议：端侧用它重新加密；仅返回给条目所有者
    ai_pubkey_hex: item.ai_pubkey_hex,       // p256 协议：AI 公钥，端侧 ECDH 协商；仅返回给条目所有者
    created_at: item.created_at,
    expires_at: item.approve_deadline,
  }));
  return { success: true, requests };
}

/**
 * 批准或拒绝一次性请求。
 * allow 时必须带 delivery（端侧已用 AI 的一次性 key 重新加密的该条明文）：
 *   { iv: 32 hex, ciphertext: string }
 */
async function decideOtpRequest(openid, requestId, allow, delivery) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/i.test(requestId)) {
    return { success: false, error: '请求标识无效' };
  }
  const res = await db.collection(OTP)
    .where({ request_id: requestId, _openid: openid })
    .limit(2)
    .get();
  if (res.data.length !== 1) {
    return { success: false, error: '请求不存在' };
  }
  const record = res.data[0];
  const now = Date.now();

  if (record.status !== 'pending') {
    return { success: false, error: '请求已处理或已过期' };
  }
  if (!record.approve_deadline || now > record.approve_deadline) {
    await db.collection(OTP).doc(record._id)
      .update({ data: { status: 'expired' } })
      .catch(() => {});
    return { success: false, error: '请求已过期' };
  }

  if (!allow) {
    const denied = await db.collection(OTP)
      .where({ _id: record._id, status: 'pending' })
      .update({ data: { status: 'denied', decided_at: now, delivery: _.set(null), ai_key_hex: _.set(null) } });
    if (!(denied.stats && denied.stats.updated === 1)) {
      return { success: false, error: '请求已处理或已过期' };
    }
    await writeAudit(openid, 'otp_denied', { request_id: requestId, entry_id: record.entry_id });
    return { success: true, status: 'denied' };
  }

  // delivery 字段解构与校验（此前重构时误删，2026-10-23 补回——node --check 不查未定义变量）
  const deliveryData = delivery && typeof delivery === 'object' ? delivery : {};
  const iv = typeof deliveryData.iv === 'string' ? deliveryData.iv.trim() : '';
  const ciphertext = typeof deliveryData.ciphertext === 'string' ? deliveryData.ciphertext.trim() : '';
  const mac = typeof deliveryData.mac === 'string' ? deliveryData.mac.trim() : '';
  const myPubkey = typeof deliveryData.my_pubkey === 'string' ? deliveryData.my_pubkey.trim() : '';
  const alg = typeof deliveryData.alg === 'string' && deliveryData.alg.trim()
    ? deliveryData.alg.trim() : 'AES-256-CBC';
  if (!/^[0-9a-f]{32}$/i.test(iv)) {
    return { success: false, error: '加密参数无效（iv）' };
  }
  if (ciphertext.length < 16 || ciphertext.length > 64 * 1024) {
    return { success: false, error: '加密内容无效' };
  }

  // 条件更新：仅 pending 可批准（防拒绝后“复活”与重复批准延长窗口）；
  // delivery 生成后 ai_key_hex 立即清除，缩小密钥落库窗口
  const approved = await db.collection(OTP)
    .where({ _id: record._id, status: 'pending' })
    .update({
      data: {
        status: 'approved',
        decided_at: now,
        consume_deadline: now + OTP_CONSUME_TTL_MS,
        delivery: _.set({
          alg,
          iv: iv.toLowerCase(),
          ciphertext,
          ...(mac ? { mac } : {}),           // EtM 完整性校验由 AI 侧完成，云端透传
          ...(myPubkey ? { my_pubkey: myPubkey.toLowerCase() } : {}), // p256 协议：端侧临时公钥
        }),
        ai_key_hex: _.set(null),
        ai_pubkey_hex: _.set(null),          // p256 协议：批准后公钥同清
      },
    });
  if (!(approved.stats && approved.stats.updated === 1)) {
    return { success: false, error: '请求已处理或已过期' };
  }
  await writeAudit(openid, 'otp_approved', {
    request_id: requestId,
    entry_id: record.entry_id,
    client_name: record.client_name,
  });
  return { success: true, status: 'approved', consume_expires_in: Math.floor(OTP_CONSUME_TTL_MS / 1000) };
}

async function writeAudit(openid, action, detail) {
  try {
    await db.collection('api_audit').add({
      data: {
        _openid: openid,
        action,
        detail: detail || {},
        created_at: Date.now(),
        // Date 类型，供控制台 TTL 索引（保留 90 天）使用
        expire_at: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
  } catch (e) {
    console.error('[audit] 写入失败:', e && e.message);
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext() || {};
  const openid = wxContext.OPENID;
  if (!openid) return { success: false, error: '获取用户身份失败' };

  try {
    switch (event.action) {
      case 'create_code':
        return await createCode(openid);
      case 'poll_requests':
        return await pollRequests(openid, event.code_id);
      case 'confirm_request':
        return await confirmRequest(openid, event.code_id, event.allow === true);
      case 'list_devices':
        return await listDevices(openid);
      case 'revoke_device':
        return await revokeDevice(openid, event.device_id);
      case 'list_otp_requests':
        return await listOtpRequests(openid);
      case 'decide_otp_request':
        return await decideOtpRequest(
          openid,
          event.request_id,
          event.allow === true,
          event.delivery,
        );
      default:
        return { success: false, error: '未知操作' };
    }
  } catch (error) {
    console.error('apiAuth 失败:', error && error.message ? error.message : error);
    return { success: false, error: '操作失败，请稍后重试' };
  }
};
