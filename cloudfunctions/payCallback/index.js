// 云函数 - payCallback
// Callback fields only identify the order; CloudPay is queried for payment truth.

const { randomBytes } = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const SUB_MCH_ID = '1746458484';

const PRODUCTS = {
  permanent_pack: { totalFee: 990 },
  yearly_vip: { totalFee: 3900 },
};

const ENTITLEMENT_NUMBER_FIELDS = [
  'free_capacity',
  'invite_capacity',
  'paid_capacity',
];

const PACK_CAPACITY = 10;        // 每次购买 +10 条
const PAID_CAPACITY_MAX = 30;    // 最多 3 次
const INVITE_VIP_REFERRAL_DAYS = 90;      // 被邀请人 30 天内买年度会员，邀请人 +3 个月
const INVITE_VIP_REFERRAL_WINDOW_DAYS = 30;
const GRACE_DAYS = 3;
const TERMINAL_NON_SUCCESS_STATES = new Set(['CLOSED', 'REVOKED', 'PAYERROR', 'REFUND']);
const REFUND_REVIEW_STATUS = 'manual_review_required';
const FROZEN_ENTITLEMENT_STATUS = 'frozen';

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

function feeMatches(value, expected) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value === expected;
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) === expected;
}

function getPaymentOpenid(payment) {
  if (typeof payment.subOpenid === 'string' && payment.subOpenid) {
    return payment.subOpenid;
  }
  return payment.openid;
}

function isMatchingPayment(payment, outTradeNo, order, product) {
  if (!payment
    || payment.returnCode !== 'SUCCESS'
    || payment.resultCode !== 'SUCCESS'
    || payment.outTradeNo !== outTradeNo
    || !feeMatches(payment.totalFee, product.totalFee)
    || payment.subMchId !== SUB_MCH_ID) {
    return false;
  }

  const paymentOpenid = getPaymentOpenid(payment);
  return typeof order._openid === 'string'
    && typeof paymentOpenid === 'string'
    && paymentOpenid === order._openid;
}

function isVerifiedPayment(payment, outTradeNo, order, product) {
  return payment.tradeState === 'SUCCESS'
    && typeof payment.transactionId === 'string'
    && payment.transactionId
    && isMatchingPayment(payment, outTradeNo, order, product);
}

function getTerminalOrderStatus(tradeState) {
  return tradeState === 'REFUND' ? 'refunded' : 'closed';
}

function isReconciledTerminalOrder(order) {
  return TERMINAL_NON_SUCCESS_STATES.has(order.payment_state)
    && order.status === getTerminalOrderStatus(order.payment_state);
}

async function deliverEntitlement(transaction, order, payment, userId, referrer) {
  const orderRef = transaction.collection('orders').doc(order._id);
  const orderRes = await orderRef.get();
  const currentOrder = orderRes.data;

  if (!currentOrder
    || currentOrder.out_trade_no !== order.out_trade_no
    || currentOrder._openid !== order._openid
    || currentOrder.product_id !== order.product_id
    || currentOrder.total_fee !== order.total_fee) {
    throw new Error('ORDER_CHANGED');
  }

  if (currentOrder.status === 'paid' && currentOrder.entitlement_delivered_at) {
    return;
  }
  if (currentOrder.status !== 'pending') {
    // Legacy paid orders lack a delivery marker, so replaying them could double-grant VIP time.
    throw new Error('ORDER_STATUS_NOT_DELIVERABLE');
  }

  const userRef = transaction.collection('users').doc(userId);
  const userRes = await userRef.get();
  const user = userRes.data;
  if (!user || user._openid !== currentOrder._openid) {
    throw new Error('USER_NOT_FOUND_OR_CHANGED');
  }
  const userModelError = validateEntitlementModel(user);
  if (userModelError) throw new Error(userModelError);

  const now = new Date();
  let userUpdate;

  if (currentOrder.product_id === 'permanent_pack') {
    const currentCapacity = user.paid_capacity;
    if (currentCapacity + PACK_CAPACITY > PAID_CAPACITY_MAX) {
      throw new Error('PACK_CAPACITY_ALREADY_USED');
    }
    userUpdate = {
      paid_capacity: currentCapacity + PACK_CAPACITY,
      updated_at: now,
    };
  } else if (currentOrder.product_id === 'yearly_vip') {
    let baseTime = now;
    if (user.vip_expire_at) {
      const expireTime = new Date(user.vip_expire_at);
      if (!Number.isFinite(expireTime.getTime())) {
        throw new Error('INVALID_VIP_EXPIRATION');
      }
      const graceEnd = expireTime.getTime() + GRACE_DAYS * 24 * 3600 * 1000;
      if (now.getTime() <= graceEnd) baseTime = expireTime;
    }
    userUpdate = {
      vip_expire_at: new Date(baseTime.getTime() + 365 * 24 * 3600 * 1000),
      vip_type: 1,
      updated_at: now,
    };
  } else {
    throw new Error('UNKNOWN_PRODUCT');
  }

  if (user.pending_payment_order
    && user.pending_payment_order.out_trade_no === currentOrder.out_trade_no) {
    // 必须删除字段而非置 null：null 是标量，后续下单写入嵌套对象会报
    // "Cannot create field ... in element {pending_payment_order: null}"
    userUpdate.pending_payment_order = db.command.remove();
  }

  await userRef.update({ data: userUpdate });
  await orderRef.update({
    data: {
      status: 'paid',
      paid_at: db.serverDate(),
      entitlement_delivered_at: db.serverDate(),
      transaction_id: payment.transactionId,
    },
  });

  // 推荐奖励：被邀请人在绑定后 30 天内购买年度会员 → 邀请人 +3 个月会员（无上限）
  if (currentOrder.product_id === 'yearly_vip' && referrer && referrer.inviterId) {
    if (user.referral_vip_rewarded !== true) {
      const inviterRef = transaction.collection('users').doc(referrer.inviterId);
      const inviterRes = await inviterRef.get();
      const inviter = inviterRes.data;
      if (inviter && inviter._openid === referrer.inviterOpenid) {
        const inviterModelError = validateEntitlementModel(inviter);
        if (inviterModelError) throw new Error(inviterModelError);
        const inviterExpire = inviter.vip_expire_at ? new Date(inviter.vip_expire_at) : null;
        const baseTime = inviterExpire && Number.isFinite(inviterExpire.getTime()) && inviterExpire > now
          ? inviterExpire
          : now;
        await inviterRef.update({
          data: {
            vip_expire_at: new Date(baseTime.getTime() + INVITE_VIP_REFERRAL_DAYS * 24 * 3600 * 1000),
            vip_type: 1,
            updated_at: now,
          },
        });
        await userRef.update({ data: { referral_vip_rewarded: true } });
      }
    }
  }
}

async function reconcileTerminalPayment(transaction, order, payment, userId) {
  const orderRef = transaction.collection('orders').doc(order._id);
  const orderRes = await orderRef.get();
  const currentOrder = orderRes.data;

  if (!currentOrder
    || currentOrder.out_trade_no !== order.out_trade_no
    || currentOrder._openid !== order._openid
    || currentOrder.product_id !== order.product_id
    || currentOrder.total_fee !== order.total_fee) {
    throw new Error('ORDER_CHANGED');
  }
  if (isReconciledTerminalOrder(currentOrder)) {
    return;
  }
  if (currentOrder.status !== 'pending') {
    throw new Error('ORDER_STATUS_NOT_RECONCILABLE');
  }

  const userRef = transaction.collection('users').doc(userId);
  const userRes = await userRef.get();
  const user = userRes.data;
  if (!user || user._openid !== currentOrder._openid) {
    throw new Error('USER_NOT_FOUND_OR_CHANGED');
  }

  const orderUpdate = {
    status: getTerminalOrderStatus(payment.tradeState),
    payment_state: payment.tradeState,
  };
  const timestampField = payment.tradeState === 'REFUND' ? 'refunded_at' : 'closed_at';
  orderUpdate[timestampField] = db.serverDate();
  if (typeof payment.transactionId === 'string' && payment.transactionId) {
    orderUpdate.transaction_id = payment.transactionId;
  }

  const userUpdate = {};
  if (user.pending_payment_order
    && user.pending_payment_order.out_trade_no === currentOrder.out_trade_no) {
    // 同样必须删除字段而非置 null（见 deliverEntitlement 注释）
    userUpdate.pending_payment_order = db.command.remove();
  }

  if (Object.keys(userUpdate).length > 0) {
    await userRef.update({ data: userUpdate });
  }
  await orderRef.update({ data: orderUpdate });
}

async function flagDeliveredRefundForReview(transaction, order, payment) {
  const orderRef = transaction.collection('orders').doc(order._id);
  const orderRes = await orderRef.get();
  const currentOrder = orderRes.data;

  if (!currentOrder
    || currentOrder.out_trade_no !== order.out_trade_no
    || currentOrder._openid !== order._openid
    || currentOrder.product_id !== order.product_id
    || currentOrder.total_fee !== order.total_fee) {
    throw new Error('ORDER_CHANGED');
  }
  if (currentOrder.status !== 'paid' || !currentOrder.entitlement_delivered_at) {
    throw new Error('ORDER_STATUS_NOT_REFUND_REVIEWABLE');
  }
  if (currentOrder.refund_review_status === REFUND_REVIEW_STATUS
    && currentOrder.entitlement_status === FROZEN_ENTITLEMENT_STATUS) {
    return;
  }

  const orderUpdate = {
    payment_state: 'REFUND',
    refund_review_status: REFUND_REVIEW_STATUS,
    entitlement_status: FROZEN_ENTITLEMENT_STATUS,
    refund_detected_at: db.serverDate(),
  };
  if (typeof payment.transactionId === 'string' && payment.transactionId) {
    orderUpdate.transaction_id = payment.transactionId;
  }
  await orderRef.update({ data: orderUpdate });
}

exports.main = async (event) => {
  const outTradeNo = event && event.out_trade_no;
  if (typeof outTradeNo !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(outTradeNo)) {
    return { errcode: 1, errmsg: 'INVALID_CALLBACK' };
  }

  try {
    const orderRes = await db.collection('orders')
      .where({ out_trade_no: outTradeNo })
      .limit(2)
      .get();
    if (orderRes.data.length === 0) {
      return { errcode: 1, errmsg: 'ORDER_NOT_FOUND' };
    }
    if (orderRes.data.length !== 1) {
      return { errcode: 1, errmsg: 'ORDER_NOT_FOUND_OR_AMBIGUOUS' };
    }

    const order = orderRes.data[0];
    const product = PRODUCTS[order.product_id];
    if (!product || order.total_fee !== product.totalFee || !order._id) {
      return { errcode: 1, errmsg: 'ORDER_INVALID' };
    }
    if (isReconciledTerminalOrder(order)) {
      return { errcode: 0, errmsg: 'OK' };
    }
    if (order.status === 'paid' && order.entitlement_delivered_at) {
      if (order.payment_state === 'REFUND'
        || order.refund_review_status === REFUND_REVIEW_STATUS
        || order.entitlement_status === FROZEN_ENTITLEMENT_STATUS) {
        return { errcode: 1, errmsg: 'REFUND_REQUIRES_MANUAL_REVIEW' };
      }
      const payment = await cloud.cloudPay.queryOrder({
        outTradeNo,
        subMchId: SUB_MCH_ID,
        nonceStr: randomBytes(16).toString('hex'),
      });

      if (!payment || payment.returnCode !== 'SUCCESS' || payment.resultCode !== 'SUCCESS') {
        throw new Error('PAYMENT_QUERY_UNVERIFIED');
      }
      if (payment.tradeState === 'REFUND') {
        if (!isMatchingPayment(payment, outTradeNo, order, product)) {
          throw new Error('PAYMENT_ORDER_MISMATCH');
        }
        await db.runTransaction(transaction => (
          flagDeliveredRefundForReview(transaction, order, payment)
        ));
        return { errcode: 1, errmsg: 'REFUND_REQUIRES_MANUAL_REVIEW' };
      }
      if (!isVerifiedPayment(payment, outTradeNo, order, product)) {
        throw new Error('PAYMENT_ORDER_MISMATCH');
      }
      return { errcode: 0, errmsg: 'OK' };
    }
    if (order.status !== 'pending') {
      return { errcode: 1, errmsg: 'ORDER_STATUS_NOT_DELIVERABLE' };
    }

    const payment = await cloud.cloudPay.queryOrder({
      outTradeNo,
      subMchId: SUB_MCH_ID,
      nonceStr: randomBytes(16).toString('hex'),
    });

    if (!payment || payment.returnCode !== 'SUCCESS' || payment.resultCode !== 'SUCCESS') {
      throw new Error('PAYMENT_QUERY_UNVERIFIED');
    }
    if (payment.tradeState !== 'SUCCESS') {
      if (TERMINAL_NON_SUCCESS_STATES.has(payment.tradeState)) {
        if (!isMatchingPayment(payment, outTradeNo, order, product)) {
          throw new Error('PAYMENT_ORDER_MISMATCH');
        }

        const userRes = await db.collection('users')
          .where({ _openid: order._openid })
          .limit(2)
          .get();
        if (userRes.data.length !== 1 || !userRes.data[0]._id) {
          throw new Error('USER_NOT_FOUND_OR_AMBIGUOUS');
        }

        await db.runTransaction(transaction => (
          reconcileTerminalPayment(transaction, order, payment, userRes.data[0]._id)
        ));
        return { errcode: 0, errmsg: 'OK' };
      }
      throw new Error('PAYMENT_STATE_UNVERIFIED');
    }
    if (!isVerifiedPayment(payment, outTradeNo, order, product)) {
      throw new Error('PAYMENT_ORDER_MISMATCH');
    }

    const userRes = await db.collection('users')
      .where({ _openid: order._openid })
      .limit(2)
      .get();
    if (userRes.data.length !== 1 || !userRes.data[0]._id) {
      throw new Error('USER_NOT_FOUND_OR_AMBIGUOUS');
    }

    // 事务内不支持 where 查询：先在事务外定位推荐人
    let referrer = null;
    if (order.product_id === 'yearly_vip') {
      const invitee = userRes.data[0];
      if (invitee.invited_by && invitee.referral_vip_rewarded !== true) {
        const invitedAtRaw = invitee.invited_at || invitee.created_at;
        const invitedAt = invitedAtRaw ? new Date(invitedAtRaw) : null;
        const nowMs = Date.now();
        const withinWindow = invitedAt && Number.isFinite(invitedAt.getTime())
          && (nowMs - invitedAt.getTime()) <= INVITE_VIP_REFERRAL_WINDOW_DAYS * 24 * 3600 * 1000;
        if (withinWindow) {
          const inviterRes = await db.collection('users')
            .where({ invite_code: invitee.invited_by })
            .limit(2)
            .get();
          if (inviterRes.data.length === 1 && inviterRes.data[0]._id) {
            referrer = {
              inviterId: inviterRes.data[0]._id,
              inviterOpenid: inviterRes.data[0]._openid,
            };
          }
        }
      }
    }

    await db.runTransaction(transaction => (
      deliverEntitlement(transaction, order, payment, userRes.data[0]._id, referrer)
    ));
    return { errcode: 0, errmsg: 'OK' };
  } catch (error) {
    console.error('支付回调处理异常:', error && error.message ? error.message : error);
    return { errcode: 1, errmsg: 'PROCESS_ERROR' };
  }
};
