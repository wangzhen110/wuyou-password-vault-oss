// 云函数 - pay
// 微信支付统一下单（云调用 cloudPay，免鉴权）
// 产品档位（2026-10-18 调整）：
//   permanent_pack  9.9元  永久容量+10条（paid_capacity 上限30，即最多购买3次）
//   yearly_vip      39元   年度会员365天（容量上限500条+加密备份导出）

const { randomBytes } = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ====== 商户配置 ======
const SUB_MCH_ID = '1746458484'; // 微信支付商户号
const PACK_CAPACITY_MAX = 30; // 永久容量包上限：3 次 × 10 条
const MAX_ORDER_NO_ATTEMPTS = 5;

// ====== 产品档位定义（单价单位：分）======
const PRODUCTS = {
  permanent_pack: {
    name: '永久容量补充包',
    desc: '新增10条永久账号容量（产品正常运营期间长期有效）',
    totalFee: 990, // 9.9元
  },
  yearly_vip: {
    name: '年度会员',
    desc: '容量上限500条+加密备份导出，有效期365天',
    totalFee: 3900, // 39元
  },
};

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
      ? '用户权益数据尚未完成迁移，暂无法创建订单'
      : '用户权益数据异常，暂无法创建订单',
  };
}

async function createUniqueOutTradeNo() {
  for (let attempt = 0; attempt < MAX_ORDER_NO_ATTEMPTS; attempt++) {
    const outTradeNo = `PWD${Date.now().toString(36).toUpperCase()}${randomBytes(8).toString('hex')}`;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(outTradeNo)) {
      throw new Error('生成的订单号格式无效');
    }

    const existing = await db.collection('orders')
      .where({ out_trade_no: outTradeNo })
      .limit(2)
      .get();
    if (existing.data.length === 0) return outTradeNo;
  }

  throw new Error('订单号冲突，请重试');
}

function orderPendingResult(productId, outTradeNo) {
  const result = {
    success: false,
    error: '已有订单状态待确认，请勿重复下单',
    code: productId === 'permanent_pack' ? 'PACK_ORDER_PENDING' : 'ORDER_PENDING',
  };
  if (outTradeNo) result.out_trade_no = outTradeNo;
  return result;
}

function getOrderStatusResult(order, callbackResult) {
  const base = { success: true, paid: false, out_trade_no: order.out_trade_no };
  const refundDetected = order.payment_state === 'REFUND'
    || order.refund_review_status === 'manual_review_required'
    || order.entitlement_status === 'frozen';

  if (order.status === 'refunded') {
    return { ...base, status: 'refunded', code: 'ORDER_REFUNDED', payment_state: 'REFUND' };
  }
  if (refundDetected) {
    return {
      ...base,
      status: 'manual_review',
      code: 'REFUND_REQUIRES_MANUAL_REVIEW',
      payment_state: 'REFUND',
    };
  }
  if (order.status === 'closed') {
    return { ...base, status: 'closed', code: 'ORDER_CLOSED', payment_state: order.payment_state };
  }
  if (order.status === 'paid' && order.entitlement_delivered_at) {
    if (callbackResult && callbackResult.errcode === 0) {
      return { ...base, paid: true, status: 'paid', code: 'ORDER_PAID' };
    }
    return {
      ...base,
      status: 'reconciliation_required',
      code: 'ORDER_RECONCILIATION_REQUIRED',
    };
  }
  if (order.status === 'pending') {
    return {
      ...base,
      status: callbackResult && callbackResult.errcode === 0 ? 'pending' : 'reconciliation_required',
      code: callbackResult && callbackResult.errcode === 0
        ? 'ORDER_PENDING'
        : 'ORDER_RECONCILIATION_REQUIRED',
    };
  }
  return { ...base, status: 'unknown', code: 'ORDER_RECONCILIATION_REQUIRED' };
}

/** 仅测试使用：端侧只走 order_status（2026-10-23 审计标注） */
async function getPendingOrder(openid) {
  if (!openid) return { success: false, code: 'USER_NOT_AUTHENTICATED', error: '获取用户身份失败' };
  const result = await db.collection('orders')
    .where({ _openid: openid, status: 'pending' })
    .limit(2)
    .get();
  if (result.data.length > 1) {
    return {
      success: false,
      code: 'ORDER_NOT_FOUND_OR_AMBIGUOUS',
      error: '订单记录重复，暂无法确认状态',
    };
  }
  if (result.data.length === 0) return { success: true, out_trade_no: null };
  const order = result.data[0];
  return {
    success: true,
    out_trade_no: order.out_trade_no,
    product_id: order.product_id,
    created_at: order.created_at || null,
  };
}

async function getOrderStatus(openid, outTradeNo) {
  if (!openid || typeof outTradeNo !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(outTradeNo)) {
    return { success: false, error: '无效的订单查询' };
  }

  const orderRes = await db.collection('orders')
    .where({ _openid: openid, out_trade_no: outTradeNo })
    .limit(2)
    .get();
  if (orderRes.data.length === 0) {
    return { success: false, code: 'ORDER_NOT_FOUND', error: '订单不存在' };
  }
  if (orderRes.data.length !== 1) {
    return {
      success: false,
      code: 'ORDER_NOT_FOUND_OR_AMBIGUOUS',
      error: '订单记录缺失或重复，暂无法确认状态',
    };
  }

  try {
    const callbackRes = await cloud.callFunction({
      name: 'payCallback',
      data: { out_trade_no: outTradeNo },
    });
    const reread = await db.collection('orders')
      .where({ _openid: openid, out_trade_no: outTradeNo })
      .limit(2)
      .get();
    if (reread.data.length !== 1) {
      return {
        success: false,
        code: 'ORDER_NOT_FOUND_OR_AMBIGUOUS',
        error: '订单状态变更后无法唯一确认',
      };
    }
    return getOrderStatusResult(reread.data[0], callbackRes && callbackRes.result);
  } catch (error) {
    return {
      ...getOrderStatusResult(orderRes.data[0], null),
      paid: false,
      status: 'reconciliation_required',
      code: 'ORDER_RECONCILIATION_REQUIRED',
    };
  }
}

async function listOrders(openid) {
  if (!openid) return { success: false, code: 'USER_NOT_AUTHENTICATED', error: '获取用户身份失败' };
  const result = await db.collection('orders')
    .where({ _openid: openid })
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();
  return {
    success: true,
    orders: result.data.map(order => ({
      out_trade_no: order.out_trade_no || '',
      product_id: order.product_id || '',
      product_name: order.product_name || '',
      total_fee: Number(order.total_fee) || 0,
      status: order.status || 'unknown',
      created_at: order.created_at || null,
      paid_at: order.paid_at || null,
    })),
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext() || {};
  const openid = wxContext.OPENID;
  const { product_id } = event;

  if (event.action === 'list_orders') {
    return listOrders(openid);
  }
  if (event.action === 'get_order_status') {
    return getOrderStatus(openid, event.out_trade_no);
  }
  if (event.action === 'get_pending_order') {
    return getPendingOrder(openid);
  }

  if (!openid) {
    return { success: false, error: '获取用户身份失败' };
  }

  const product = PRODUCTS[product_id];
  if (!product) {
    return { success: false, error: '无效的产品' };
  }

  const envId = typeof wxContext.ENV === 'string' ? wxContext.ENV.trim() : '';
  if (!envId) {
    return {
      success: false,
      error: '获取支付环境信息失败',
      code: 'ENV_ID_UNAVAILABLE',
    };
  }

  let reservedOrderNo = null;
  try {
    // ====== 购买前置校验 ======
    const userRes = await db.collection('users')
      .where({ _openid: openid })
      .limit(2)
      .get();

    if (userRes.data.length === 0) {
      return { success: false, error: '用户不存在，请重新进入小程序' };
    }
    if (userRes.data.length !== 1) {
      return {
        success: false,
        code: 'USER_NOT_FOUND_OR_AMBIGUOUS',
        error: '用户记录缺失或重复，暂无法创建订单',
      };
    }
    const user = userRes.data[0];
    const userModelError = validateEntitlementModel(user);
    if (userModelError) return userModelFailure(userModelError);

    const pendingOrderRes = await db.collection('orders')
      .where({ _openid: openid, status: 'pending' })
      .limit(2)
      .get();
    if (pendingOrderRes.data.length > 1) {
      return {
        success: false,
        code: 'ORDER_NOT_FOUND_OR_AMBIGUOUS',
        error: '订单记录重复，暂无法创建订单',
      };
    }
    if (pendingOrderRes.data.length === 1 || user.pending_payment_order) {
      const pendingOrder = pendingOrderRes.data[0];
      return orderPendingResult(
        product_id,
        pendingOrder && pendingOrder.out_trade_no
          || user.pending_payment_order && user.pending_payment_order.out_trade_no,
      );
    }

    if (product_id === 'permanent_pack') {
      // 规则：每次 +10 条，最多购买 3 次（paid_capacity 上限 30）
      if (user.paid_capacity >= PACK_CAPACITY_MAX) {
        return {
          success: false,
          error: '永久容量补充包最多购买 3 次，已达上限',
          code: 'PACK_LIMIT',
        };
      }
    }

    // Generate all secure identifiers before any order state is persisted.
    const nonceStr = randomBytes(16).toString('hex');
    const outTradeNo = await createUniqueOutTradeNo();

    await db.runTransaction(async transaction => {
      const userRef = transaction.collection('users').doc(user._id);
      const currentUserRes = await userRef.get();
      const currentUser = currentUserRes.data;
      if (!currentUser || currentUser._openid !== openid) {
        throw new Error('用户不存在，请重新进入小程序');
      }
      const currentUserModelError = validateEntitlementModel(currentUser);
      if (currentUserModelError) {
        const error = new Error(currentUserModelError);
        error.code = currentUserModelError;
        throw error;
      }
      if (currentUser.pending_payment_order) {
        const error = new Error('已有订单状态待确认，请勿重复下单');
        error.code = 'ORDER_PENDING';
        error.out_trade_no = currentUser.pending_payment_order.out_trade_no;
        throw error;
      }
      if (product_id === 'permanent_pack' && currentUser.paid_capacity >= PACK_CAPACITY_MAX) {
        const error = new Error('永久容量补充包最多购买 3 次，已达上限');
        error.code = 'PACK_LIMIT';
        throw error;
      }

      const createdAt = db.serverDate();
      await transaction.collection('orders').add({
        data: {
          _openid: openid,
          out_trade_no: outTradeNo,
          product_id,
          product_name: product.name,
          total_fee: product.totalFee,
          status: 'pending',
          created_at: createdAt,
          paid_at: null,
          transaction_id: null,
        },
      });
      await userRef.update({
        data: {
          // 整体替换该字段（兼容历史数据里该字段为 null 的记录：逐字段写入会在 null 下建子字段而失败）
          pending_payment_order: db.command.set({
            out_trade_no: outTradeNo,
            product_id,
            created_at: createdAt,
          }),
        },
      });
    });
    reservedOrderNo = outTradeNo;

    // ====== 云调用统一下单 ======
    const payRes = await cloud.cloudPay.unifiedOrder({
      body: product.desc,
      outTradeNo: outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId: SUB_MCH_ID,
      totalFee: product.totalFee,
      envId, // 支付回调所在云环境
      functionName: 'payCallback',       // 支付回调云函数名
      nonceStr,
      tradeType: 'JSAPI',
    });

    if (!payRes || !payRes.payment) {
      throw new Error('微信统一下单失败');
    }

    // payRes.payment 含 timeStamp/nonceStr/package/signType/paySign，直接传给 wx.requestPayment
    return {
      success: true,
      out_trade_no: outTradeNo,
      payment: payRes.payment,
    };
  } catch (e) {
    console.error('下单失败:', e);
    if (e.code === 'ORDER_PENDING') return orderPendingResult(product_id, e.out_trade_no);
    if (e.code === 'USER_MODEL_MIGRATION_REQUIRED' || e.code === 'USER_MODEL_INVALID') {
      return userModelFailure(e.code);
    }
    if (e.code === 'PACK_LIMIT') {
      return { success: false, error: e.message, code: 'PACK_LIMIT' };
    }
    if (reservedOrderNo) {
      return {
        success: false,
        error: '订单状态暂无法确认，请勿重复下单',
        code: 'ORDER_RECONCILIATION_REQUIRED',
        out_trade_no: reservedOrderNo,
      };
    }
    // 审计 F2（2026-10-25）：不再把内部错误原文回传客户端，对外只给通用提示
    return { success: false, error: '下单失败，请稍后重试', code: 'ORDER_CREATE_FAILED' };
  }
};
