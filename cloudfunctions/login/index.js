// 云函数 - login
// 微信静默授权登录，获取openid并创建/更新用户记录

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const LOGIN_LOCKS = new Map();

// ===== 活跃统计（旁路指标：写失败绝不影响登录） =====
// users.last_active_at        —— 用户级最后活跃时间（随登录写入，与 updated_at 同一次 update）
// counters/dau_YYYY-MM-DD     —— 每日去重活跃用户数（当天首次登录时 +1，管理端直接读）
const ACTIVE_COUNTER_PREFIX = 'dau_';
const STATS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 统计口径固定按北京时间（UTC+8）切日

// 最低支持版本（服务端控制门槛）：低于此版本的端会在 login 后收到强制更新指示。
// 每次发布包含重要修复的版本时，把此值抬升到该版本号。
const MIN_SUPPORTED_VERSION = '4.2.20';

const ENTITLEMENT_NUMBER_FIELDS = [
  'free_capacity',
  'invite_capacity',
  'paid_capacity',
];

function isValidVipExpiration(value) {
  if (value === null) return true;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value === 'number') return Number.isFinite(new Date(value).getTime());
  return typeof value === 'string'
    && value.trim().length > 0
    && Number.isFinite(new Date(value).getTime());
}


function validateEntitlementModel(user) {
  if (!user
    || ENTITLEMENT_NUMBER_FIELDS.some(field => user[field] === undefined)
    || user.vip_expire_at === undefined
    || user.vip_type === undefined) {
    return 'USER_MODEL_MIGRATION_REQUIRED';
  }

  const capacityFieldsAreValid = ENTITLEMENT_NUMBER_FIELDS.every(field => (
    Number.isSafeInteger(user[field]) && user[field] >= 0
  ));
  const totalCapacity = ENTITLEMENT_NUMBER_FIELDS.reduce((total, field) => (
    total + user[field]
  ), 0);
  if (!capacityFieldsAreValid
    || !Number.isSafeInteger(totalCapacity)
    || !isValidVipExpiration(user.vip_expire_at)
    || ![0, 1].includes(user.vip_type)
    || (user.vip_type === 1 && user.vip_expire_at === null)) {
    return 'USER_MODEL_INVALID';
  }

  return null;
}

function userModelFailure(code) {
  return {
    success: false,
    code,
    error: code === 'USER_MODEL_MIGRATION_REQUIRED'
      ? '用户权益数据尚未完成迁移，暂无法登录云端'
      : '用户权益数据异常，暂无法登录云端',
  };
}

exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID;
    if (typeof openid !== 'string' || openid.trim().length === 0) {
      return {
        success: false,
        code: 'USER_ID_UNAVAILABLE',
        error: '获取用户身份失败',
      };
    }

    const outcome = await withLoginLock(openid, () => loginUser(openid));
    if (outcome.firstActiveToday) {
      await bumpDailyActive(outcome.now);
    }
    return outcome.response;
  } catch (e) {
    console.error('登录失败:', e);
    return {
      success: false,
      code: 'LOGIN_FAILED',
      error: '登录失败，请稍后重试',
    };
  }
};

function withLoginLock(openid, operation) {
  const previous = LOGIN_LOCKS.get(openid) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation);
  LOGIN_LOCKS.set(openid, current);
  return current.finally(() => {
    if (LOGIN_LOCKS.get(openid) === current) {
      LOGIN_LOCKS.delete(openid);
    }
  });
}

async function loginUser(openid) {
  if (typeof db.runTransaction === 'function') {
    return db.runTransaction(transaction => (
      loginWithCollection(transaction.collection('users'), openid)
    ));
  }

  // The fallback keeps local mocks deterministic; production uses the transaction above.
  return loginWithCollection(db.collection('users'), openid);
}

/**
 * 返回 { response, firstActiveToday, now }：
 * response 是给端上的登录结果；后两者仅供活跃统计使用，不进入响应体。
 */
async function loginWithCollection(users, openid) {
  const userRes = await users
    .where({ _openid: openid })
    .limit(2)
    .get();

  if (userRes.data.length > 1
    || (userRes.data.length === 1 && !userRes.data[0]._id)) {
    return {
      response: {
        success: false,
        code: 'USER_NOT_UNIQUE',
        error: '用户数据异常',
      },
      firstActiveToday: false,
    };
  }

  const now = new Date();
  let isNewUser = false;
  let firstActiveToday = false;
  let userInfo;

  if (userRes.data.length === 0) {
    isNewUser = true;
    firstActiveToday = true;
    const inviteCode = await generateUniqueInviteCode(db, openid);
    userInfo = createUser(openid, now, inviteCode);
    const created = await users.add({ data: userInfo });
    userInfo = {
      ...userInfo,
      ...(created && created._id ? { _id: created._id } : {}),
    };
  } else {
    userInfo = userRes.data[0];
    // 严格校验：字段缺失/非法一律拒绝（不静默改库，避免掩盖数据损坏）
    const modelError = validateEntitlementModel(userInfo);
    if (modelError) {
      return { response: userModelFailure(modelError), firstActiveToday: false };
    }

    // 当天首次登录才算活跃（北京时间切日），用于日活去重
    firstActiveToday = statsDayKey(userInfo.last_active_at) !== statsDayKey(now);

    // 旧版邀请码（openid 前缀）在同一小程序内大量重复 → 自动换成唯一随机码
    const update = { updated_at: now, last_active_at: now };
    if (isLegacyInviteCode(userInfo.invite_code, openid)) {
      const newCode = await generateUniqueInviteCode(db, openid);
      update.invite_code = newCode;
      userInfo.invite_code = newCode;
      console.log('[login] 已迁移重复邀请码:', newCode);
    }
    await users.doc(userInfo._id).update({ data: update });
  }

  const modelError = validateEntitlementModel(userInfo);
  if (modelError) {
    return { response: userModelFailure(modelError), firstActiveToday: false };
  }

  return {
    response: buildLoginResponse(openid, userInfo, isNewUser, now),
    firstActiveToday,
    now,
  };
}

// 邀请码字符集：去掉 0/O/1/I/L 等易混淆字符，便于口头分享
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomInviteCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 旧版邀请码是用 openid 前 8 位生成的，同一小程序内大量重复，需自动迁移 */
function isLegacyInviteCode(code, openid) {
  if (typeof code !== 'string' || !code) return true;
  const prefix = String(openid || '').substring(0, 6).toUpperCase();
  return prefix.length >= 6 && code.toUpperCase().startsWith(prefix);
}

/** 生成一个库内唯一的邀请码（最多重试 5 次） */
async function generateUniqueInviteCode(db, openid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomInviteCode(6);
    const res = await db.collection('users').where({ invite_code: code }).limit(1).get();
    if (!res.data || res.data.length === 0) return code;
  }
  // 极端兜底：用时间戳后 6 位保证唯一性
  return String(Date.now()).slice(-6);
}

function createUser(openid, now, inviteCode) {
  return {
    _openid: openid,
    created_at: now,
    updated_at: now,
    last_active_at: now,
    free_capacity: 10,        // 新用户初始空间（2026-10-20 由 20 调整为 10；邀请 +5/人、权益包 +10/次可扩容）
    invite_capacity: 0,
    paid_capacity: 0,
    vip_expire_at: null,
    vip_type: 0,
    biometric_enabled: false,
    invite_code: inviteCode,
    invited_by: null,
    invite_count: 0,
  };
}

/** 统计用日期键（北京时间 YYYY-MM-DD）；非法值返回 null，绝不抛错 */
function statsDayKey(value) {
  // 兼容 Date / 时间戳 / ISO 字符串三种落库形态（历史数据与不同 SDK 版本）
  let time = NaN;
  if (value instanceof Date) time = value.getTime();
  else if (typeof value === 'number') time = value;
  else if (typeof value === 'string' && value) time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time + STATS_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 当日活跃计数 +1（counters/dau_YYYY-MM-DD）。
 * 指标是旁路数据：任何失败都只记日志，绝不影响登录结果。
 */
async function bumpDailyActive(now) {
  const dayKey = statsDayKey(now);
  if (!dayKey) return;

  const docId = ACTIVE_COUNTER_PREFIX + dayKey;
  const counters = db.collection('counters');
  try {
    const res = await counters.doc(docId).update({
      data: { value: _.inc(1), updated_at: now },
    });
    const updated = res && (typeof res.updated === 'number' ? res.updated : res.stats && res.stats.updated);
    if (updated === 0) throw new Error('COUNTER_DOC_MISSING');
  } catch (e) {
    try {
      await counters.add({
        data: {
          _id: docId,
          value: 1,
          date: dayKey,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (addError) {
      console.error('[login] 日活计数写入失败:', addError && addError.errCode ? addError.errCode : 'UNKNOWN');
    }
  }
}

function buildLoginResponse(openid, userInfo, isNewUser, now) {
  const totalCapacity = userInfo.free_capacity
    + userInfo.invite_capacity
    + userInfo.paid_capacity;
  const isVip = userInfo.vip_expire_at !== null
    && new Date(userInfo.vip_expire_at) > now;

  return {
    success: true,
    openid,
    is_new_user: isNewUser,
    capacity: totalCapacity,
    is_vip: isVip,
    invite_code: userInfo.invite_code,
    min_supported_version: MIN_SUPPORTED_VERSION,
    user: {
      free_capacity: userInfo.free_capacity,
      invite_capacity: userInfo.invite_capacity,
      paid_capacity: userInfo.paid_capacity,
      vip_expire_at: userInfo.vip_expire_at,
      vip_type: userInfo.vip_type,
      biometric_enabled: userInfo.biometric_enabled,
      invite_count: userInfo.invite_count,
      // 个人资料必须回传，否则端上缓存的头像/昵称每次登录都会被清空
      nick_name: typeof userInfo.nick_name === 'string' ? userInfo.nick_name : '',
      master_hint: typeof userInfo.master_hint === 'string' ? userInfo.master_hint : '',
      avatar_file_id: typeof userInfo.avatar_file_id === 'string' ? userInfo.avatar_file_id : '',
    },
  };
}
