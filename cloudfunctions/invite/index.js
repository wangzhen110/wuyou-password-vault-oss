// 云函数 - invite
// 裂变邀请系统：生成邀请码、验证邀请、发放奖励

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 邀请规则（2026-10-18 调整）：双方各 +5；邀请人最多 3 人（合计 +15）
const INVITE_REWARD_CAPACITY = 5;
const INVITE_MAX_TIMES = 3;
// 满 3 人后继续有效邀请：邀请人每次获得 30 天会员（有会员则顺延）
const VIP_REWARD_DAYS = 30;
// 只认 30 天内注册的新用户为"有效被邀请人"，防止老号互刷
const INVITEE_MAX_AGE_DAYS = 30;

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

function validateUserModel(user) {
  if (!user
    || ENTITLEMENT_NUMBER_FIELDS.some(field => user[field] === undefined)
    || user.vip_expire_at === undefined
    || user.vip_type === undefined
    || user.invite_code === undefined
    || user.invite_count === undefined) {
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
    || (user.vip_type === 1 && user.vip_expire_at === null)
    || !Number.isSafeInteger(user.invite_count)
    || user.invite_count < 0
    || typeof user.invite_code !== 'string'
    || user.invite_code.trim().length === 0
    || (user.invited_by !== null && user.invited_by !== undefined
      && (typeof user.invited_by !== 'string' || user.invited_by.trim().length === 0))) {
    return 'USER_MODEL_INVALID';
  }

  return null;
}

function userModelFailure(code) {
  return {
    success: false,
    code,
    error: code === 'USER_MODEL_MIGRATION_REQUIRED'
      ? '用户权益数据尚未完成迁移，暂无法使用邀请功能'
      : '用户权益数据异常，暂无法使用邀请功能',
  };
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { action, invite_code } = event || {};

  try {
    if (typeof openid !== 'string' || openid.length === 0) {
      return { success: false, code: 'USER_ID_UNAVAILABLE', error: '获取用户身份失败' };
    }

    switch (action) {
      case 'get_my_code':
        return await getMyCode(openid);
      case 'verify_invite': {
        // 建库事实必须服务端自证：不再信任客户端传入的 vault_ready
        const metaRes = await db.collection('vault_meta').where({ _openid: openid }).limit(1).get();
        return await verifyInvite(openid, invite_code, (metaRes.data || []).length === 1);
      }
      case 'get_invite_info':
        return await getInviteInfo(openid);
      default:
        return { success: false, error: '未知操作' };
    }
  } catch (e) {
    console.error('邀请系统错误:', e && e.message ? e.message : e);
    return { success: false, code: 'INVITE_OPERATION_FAILED', error: '操作失败，请稍后重试' };
  }
};

function userLookupFailure(result, notFoundCode) {
  if (result.data.length === 0) {
    return { success: false, code: notFoundCode, error: '用户不存在' };
  }
  if (result.data.length !== 1 || !result.data[0]._id) {
    return { success: false, code: 'USER_NOT_UNIQUE', error: '用户数据异常' };
  }
  return null;
}

/**
 * 获取我的邀请码和邀请统计
 */
async function getMyCode(openid) {
  const userRes = await db.collection('users')
    .where({ _openid: openid })
    .limit(2)
    .get();

  const lookupError = userLookupFailure(userRes, 'USER_NOT_FOUND');
  if (lookupError) return lookupError;

  const user = userRes.data[0];
  const modelError = validateUserModel(user);
  if (modelError) return userModelFailure(modelError);

  return {
    success: true,
    invite_code: user.invite_code,
    invite_count: user.invite_count,
    invite_capacity: user.invite_capacity,
  };
}

/**
 * 验证并使用邀请码
 */
async function verifyInvite(openid, inviteCode, vaultReady) {
  if (typeof inviteCode !== 'string' || inviteCode.trim().length === 0) {
    return { success: false, error: '请输入邀请码' };
  }
  // “实际注册并使用”判定：被邀请人需先完成密码库创建（由客户端在解锁成功后上报）
  if (vaultReady !== true) {
    return { success: false, code: 'VAULT_NOT_READY', error: '请先设置主密码完成密码库创建，再使用邀请码' };
  }
  const normalizedCode = inviteCode.trim().toUpperCase();

  // Resolve document IDs first; all decisions and writes use transaction reads.
  const inviterRes = await db.collection('users')
    .where({ invite_code: normalizedCode })
    .limit(2)
    .get();

  if (inviterRes.data.length === 0) {
    return { success: false, code: 'INVITE_CODE_INVALID', error: '邀请码无效' };
  }
  if (inviterRes.data.length !== 1 || !inviterRes.data[0]._id) {
    return { success: false, code: 'INVITE_CODE_AMBIGUOUS', error: '邀请码数据异常' };
  }

  const inviter = inviterRes.data[0];

  // 不能邀请自己
  if (inviter._openid === openid) {
    return { success: false, code: 'SELF_INVITE', error: '不能邀请自己' };
  }

  // A duplicate openid is ambiguous and must not receive a reward.
  const inviteeRes = await db.collection('users')
    .where({ _openid: openid })
    .limit(2)
    .get();

  if (inviteeRes.data.length === 0) {
    return { success: false, code: 'INVITEE_NOT_REGISTERED', error: '请先完成注册' };
  }
  if (inviteeRes.data.length !== 1 || !inviteeRes.data[0]._id) {
    return { success: false, code: 'USER_NOT_UNIQUE', error: '用户数据异常' };
  }
  const invitee = inviteeRes.data[0];

  return db.runTransaction(async transaction => {
    const users = transaction.collection('users');
    const inviterResInTransaction = await users.doc(inviter._id).get();
    const inviteeResInTransaction = await users.doc(invitee._id).get();
    const currentInviter = inviterResInTransaction.data;
    const currentInvitee = inviteeResInTransaction.data;

    if (!currentInviter
      || currentInviter._openid !== inviter._openid
      || currentInviter.invite_code !== normalizedCode
      || !currentInvitee
      || currentInvitee._openid !== openid) {
      return { success: false, code: 'USER_CHANGED', error: '用户数据已变化，请重试' };
    }

    const inviterModelError = validateUserModel(currentInviter);
    if (inviterModelError) return userModelFailure(inviterModelError);
    const inviteeModelError = validateUserModel(currentInvitee);
    if (inviteeModelError) return userModelFailure(inviteeModelError);
    if (currentInvitee.invited_by !== null) {
      return { success: false, code: 'ALREADY_INVITED', error: '您已使用过邀请码' };
    }

    const now = new Date();
    // 规则（2026-10-18）：双方各 +5；邀请人最多 3 人（+15）；不再有“容量满 50 送 7 天会员”兜底
    const inviteeRewardCapacity = INVITE_REWARD_CAPACITY;
    const inviterRewardCapacity = INVITE_REWARD_CAPACITY;
    // 防刷：被邀请人必须是 30 天内注册的新用户
    const inviteeCreatedAt = currentInvitee.created_at ? new Date(currentInvitee.created_at).getTime() : 0;
    if (!inviteeCreatedAt || now.getTime() - inviteeCreatedAt > INVITEE_MAX_AGE_DAYS * 86400000) {
      return { success: false, code: 'INVITEE_TOO_OLD', error: '仅限新用户使用邀请码' };
    }
    if (!Number.isSafeInteger(currentInviter.invite_count + 1)
      || !Number.isSafeInteger(currentInvitee.invite_capacity + inviteeRewardCapacity)
      || !Number.isSafeInteger(currentInviter.invite_capacity + inviterRewardCapacity)) {
      return userModelFailure('USER_MODEL_INVALID');
    }

    let inviterUpdate;
    if (currentInviter.invite_count >= INVITE_MAX_TIMES) {
      // 邀请满 3 人后：继续有效邀请 → 邀请人获得 30 天会员（现有会员则顺延 30 天）
      const vipBase = (currentInviter.vip_expire_at && new Date(currentInviter.vip_expire_at).getTime() > now.getTime())
        ? new Date(currentInviter.vip_expire_at).getTime()
        : now.getTime();
      inviterUpdate = {
        invite_count: currentInviter.invite_count + 1,
        vip_expire_at: new Date(vipBase + VIP_REWARD_DAYS * 86400000).toISOString(),
        vip_type: 1,
        updated_at: now,
      };
    } else {
      inviterUpdate = {
        invite_count: currentInviter.invite_count + 1,
        invite_capacity: currentInviter.invite_capacity + inviterRewardCapacity,
        updated_at: now,
      };
    }

    await users.doc(currentInviter._id).update({ data: inviterUpdate });
    await users.doc(currentInvitee._id).update({
      data: {
        invited_by: currentInviter.invite_code,
        invited_at: now,
        invite_capacity: currentInvitee.invite_capacity + inviteeRewardCapacity,
        updated_at: now,
      },
    });
    await transaction.collection('invite_records').add({
      data: {
        inviter_openid: currentInviter._openid,
        invitee_openid: openid,
        inviter_code: currentInviter.invite_code,
        created_at: now,
        reward_type: 'capacity',
        reward_value: inviterRewardCapacity,
      },
    });

    return {
      success: true,
      message: '邀请成功',
      inviter_reward: `邀请人获得${inviterRewardCapacity}条永久容量`,
      invitee_reward: `您获得${inviteeRewardCapacity}条永久容量`,
    };
  });
}

/**
 * 获取邀请信息（用于展示）
 */
async function getInviteInfo(openid) {
  const userRes = await db.collection('users')
    .where({ _openid: openid })
    .limit(2)
    .get();

  const lookupError = userLookupFailure(userRes, 'USER_NOT_FOUND');
  if (lookupError) return lookupError;

  const user = userRes.data[0];
  const modelError = validateUserModel(user);
  if (modelError) return userModelFailure(modelError);
  const freeCapacity = user.free_capacity + user.invite_capacity;

  return {
    success: true,
    invite_code: user.invite_code,
    invite_count: user.invite_count,
    can_invite: freeCapacity < 50, // 免费容量未满50条才能继续邀请获得永久容量
    next_reward: freeCapacity < 50 ? '容量' : '会员',
  };
}
