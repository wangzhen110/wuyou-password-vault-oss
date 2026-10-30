/**
 * 会员权益模块 V1.0
 * 职责：会员状态判断 / 有效容量计算 / 新增与编辑权限拦截 / 发起支付
 *
 * 规则（对齐 PRD）：
 * - 永久容量 = 免费10 + 邀请(≤15) + 付费包(≤30)，封顶 55（2026-10-23 与 RULES 对齐）
 * - 年度会员有效期内：容量上限 500 条 + 开放 API（备份导出对所有用户开放，不作为会员权益）
 * - 会员到期降级：已存条目数 > 永久容量时，超出条目只读（可查看/复制/导出/删除，禁止新增/编辑）
 * - 到期3天内续费，会员时长顺延（服务端 payCallback 已实现）
 */

const storage = require('./storage');

// ====== 产品常量 ======
const PAYMENT_FLOW_TIMEOUT_MS = 15 * 1000;
const STATUS_RETRY_DELAY_MS = 2000;
// 微信发货推送实测到达约 10s，轮询窗口给到 16s，避免已到账却显示确认中
const MAX_STATUS_RETRIES = 8;
const LAST_ORDER_STORAGE_KEY = 'member_last_order_no';

// ====== 用户权益信息 ======

/**
 * 获取用户权益信息（含会员状态与容量）
 * 优先 globalData，降级缓存
 */

/** 容量与奖励规则（与云函数保持一致，修改需同步 login/invite/pay/payCallback） */
const RULES = {
  INITIAL_FREE_CAPACITY: 10,   // 新用户初始空间（2026-10-22 与 login:208 统一）
  INVITE_REWARD: 5,            // 每邀请一人双方各 +5
  INVITE_MAX_TIMES: 3,         // 邀请人最多 3 人（+15）
  PACK_CAPACITY: 10,           // 永久包每次 +10
  PACK_MAX_TIMES: 3,           // 永久包最多 3 次（+30）
  VIP_CAPACITY: 500,           // 年度会员容量上限（暂时 500 条）
  REFERRAL_VIP_DAYS: 90,       // 被邀请人 30 天内买年度会员，邀请人 +3 个月
  REFERRAL_WINDOW_DAYS: 30,
};

function getUserEntitlement() {
  const app = getApp();
  const user = (app && app.globalData.userInfo) || storage.get('user_info') || {};

  const isVip = checkVip(user);
  const permanentCapacity = computePermanentCapacity(user);

  // 权益是服务端权威数据：离线或长时间未同步时标注 stale，UI 需提示"以联网后为准"
  const syncedAt = Number(user._synced_at || 0);
  const STALE_MS = 10 * 60 * 1000;
  const offline = !!(app && app.globalData && app.globalData.offlineMode);
  const stale = offline || !syncedAt || (Date.now() - syncedAt > STALE_MS);
  const staleReason = offline ? 'offline' : (!syncedAt ? 'never_synced' : 'expired');

  return {
    isVip,
    vipExpireAt: user.vip_expire_at || null,
    freeCapacity: user.free_capacity || RULES.INITIAL_FREE_CAPACITY,
    inviteCapacity: user.invite_capacity || 0,
    paidCapacity: user.paid_capacity || 0,
    permanentCapacity,                      // 永久有效总容量
    // 会员提供 500 条基础上限；已购永久容量与邀请容量**叠加**，不会被会员覆盖
    memberCapacity: RULES.VIP_CAPACITY + (user.invite_capacity || 0) + (user.paid_capacity || 0),
    effectiveCapacity: isVip
      ? RULES.VIP_CAPACITY + (user.invite_capacity || 0) + (user.paid_capacity || 0)
      : permanentCapacity,
    stale,                                  // 权益可能不是最新
    staleReason,
    syncedAt: syncedAt || null,
  };
}

/** 会员是否有效 */
function checkVip(user) {
  if (!user || !user.vip_expire_at) return false;
  return new Date(user.vip_expire_at).getTime() > Date.now();
}

/** 永久有效总容量（会员到期后仍可用的容量） */
function computePermanentCapacity(user) {
  const free = (user && user.free_capacity) || RULES.INITIAL_FREE_CAPACITY;
  const invite = (user && user.invite_capacity) || 0;
  const paid = (user && user.paid_capacity) || 0;
  return free + invite + paid;
}

// ====== 权限拦截 ======

/**
 * 能否新增账号
 * @param {number} activeCount 当前有效（未删除）条目数
 * @returns {{allowed: boolean, reason?: string, code?: string}}
 */
function canAdd(activeCount) {
  const ent = getUserEntitlement();
  if (ent.isVip) return { allowed: true };
  if (activeCount < ent.permanentCapacity) return { allowed: true };
  return {
    allowed: false,
    code: ent.inviteCapacity < 15 ? 'CAPACITY_LIMIT' : 'CAPACITY_FULL', // 邀请上限 3×5=15，20 永不可达
    reason: '容量已满',
  };
}

/**
 * 能否编辑指定条目（到期降级只读规则）
 * 超出永久容量的条目按添加时间倒序判定为"超出部分"，只读
 * @param {Array} allPasswords 全部未删除条目
 * @param {string} id 目标条目 id
 */
/** 超出永久容量的条目 id 集合（非会员；按添加时间倒序，最旧的超出） */
function getOverflowIds(allPasswords) {
  const ent = getUserEntitlement();
  if (ent.isVip) return new Set();
  const active = (allPasswords || [])
    .filter(p => !p.is_deleted)
    .sort((a, b) => (b.created_timestamp || 0) - (a.created_timestamp || 0));
  if (active.length <= ent.permanentCapacity) return new Set();
  return new Set(active.slice(ent.permanentCapacity).map(p => p.id));
}

function canEdit(allPasswords, id) {
  const ent = getUserEntitlement();
  if (ent.isVip) return { allowed: true };
  const overflowIds = getOverflowIds(allPasswords);
  if (overflowIds.has(id)) {
    return {
      allowed: false,
      code: 'READONLY',
      reason: '会员已到期，超出永久容量的条目仅可查看、导出、删除（4.2.17 起复制也已禁用）',
    };
  }
  return { allowed: true };
}

/**
 * 到期降级的复制拦截（2026-10-23 产品调整）：
 * 超出永久容量的条目不可复制（查看/导出/删除仍允许），引导续费。
 */
function canCopy(allPasswords, id) {
  const ent = getUserEntitlement();
  if (ent.isVip) return { allowed: true };
  const overflowIds = getOverflowIds(allPasswords);
  if (overflowIds.has(id)) {
    return {
      allowed: false,
      code: 'READONLY',
      reason: '会员已到期，此条目超出永久容量，续费后可复制',
    };
  }
  return { allowed: true };
}

// ====== 支付 ======

/**
 * 发起微信支付
 * @param {string} productId 'permanent_pack' | 'yearly_vip'
 * @returns {Promise<{success: boolean, error?: string, code?: string}>}
 */
function requestPay(productId, hooks) {
  // 兜底：演示模式禁止发起支付（防止绕过页面开关直接调用；演示数据不落库，支付会产生真实订单）
  try {
    const demoMode = require('./demo-mode');
    if (demoMode.isActive()) {
      return Promise.reject(new Error('演示模式不支持购买'));
    }
  } catch (e) { /* 模块异常则放行，不阻断正常支付 */ }

  // 支付期间标记：app.onHide 检测到 keepUnlocked 时跳过「切后台立即锁定」，
  // 否则拉起微信支付再返回会把会话锁掉，打断支付结果确认（2026-10-24）
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.keepUnlocked = true;
    const clear = () => { try { if (app && app.globalData) app.globalData.keepUnlocked = false; } catch (e) {} };
    // 无论成功/失败/超时，10 分钟内必定清除，避免标记泄漏导致一直不锁屏
    setTimeout(clear, 10 * 60 * 1000);
  } catch (e) { /* 忽略 */ }
  return new Promise((resolve) => {
    const flow = createPayFlow(resolve);
    const unknownPayment = () => ({
      success: false,
      code: 'PAYMENT_STATUS_UNKNOWN',
      error: '支付请求未完成，订单状态可能仍在确认中，请稍后查询；请勿重复下单',
    });

    try {
      wx.login({
        success: (loginRes) => {
          if (!loginRes || !loginRes.code) {
            flow.settle(unknownPayment());
            return;
          }
          wx.cloud.callFunction({
            name: 'vpay',
            data: { product_id: productId, code: loginRes.code },
            success: (res) => {
              if (flow.isSettled()) return;
              const result = res && res.result;
              if (!result || !result.success) {
                if (result && result.out_trade_no
                    && ['ORDER_PENDING', 'PACK_ORDER_PENDING'].includes(result.code)) {
                  flow.setOrder(result.out_trade_no);
                  refreshAfterPay(result.out_trade_no, 0, flow);
                  return;
                }
                flow.settle({
                  success: false,
                  error: (result && result.error) || '下单失败',
                  code: result && result.code,
                });
                return;
              }
              if (typeof result.signData !== 'string' || typeof result.out_trade_no !== 'string') {
                flow.settle({ success: false, error: '支付参数不完整，请稍后重试' });
                return;
              }

              if (typeof wx.requestVirtualPayment !== 'function') {
                flow.settle({
                  success: false,
                  code: 'WX_VERSION_TOO_LOW',
                  out_trade_no: result.out_trade_no,
                  error: '当前微信版本过低（需基础库 2.19.2 及以上），请更新微信后重试',
                });
                return;
              }
              if (typeof wx.showLoading === 'function') wx.showLoading({ title: '正在拉起支付…', mask: true });
              rememberOrder(result.out_trade_no);
              flow.setOrder(result.out_trade_no);
              try {
                // 拉起小程序虚拟支付（道具直购）
                wx.requestVirtualPayment({
                  signData: result.signData,
                  paySig: result.paySig,
                  signature: result.signature,
                  mode: result.mode || 'short_series_goods',
                  success: () => {
                    if (typeof wx.hideLoading === 'function') wx.hideLoading();
                    // 支付提交瞬间就通知页面显示「等待确认」窗口（不等轮询结果）
                    if (hooks && typeof hooks.onPaymentSubmitted === 'function') {
                      try { hooks.onPaymentSubmitted(result.out_trade_no); } catch (e) { /* ignore */ }
                    }
                    if (flow.isSettled()) return;
                    refreshAfterPay(result.out_trade_no, 0, flow);
                  },
                  fail: (err) => {
                    if (typeof wx.hideLoading === 'function') wx.hideLoading();
                    if (flow.isSettled()) return;
                    const cancelled = !!err && (err.errCode === -2 || /cancel/i.test(err.errMsg || ''));
                    const reason = err && err.errMsg
                      ? err.errMsg + (err.errCode ? '（' + err.errCode + '）' : '')
                      : '未知原因';
                    console.error('[vpay] requestVirtualPayment fail:', err);
                    flow.settle({
                      success: false,
                      cancelled,
                      code: 'ORDER_PENDING',
                      out_trade_no: result.out_trade_no,
                      error: cancelled
                        ? '已取消本次支付；订单仍待平台确认，请勿重复下单'
                        : '支付未完成（' + reason + '）；订单状态仍待确认，请勿重复下单',
                    });
                  },
                });
              } catch (error) {
                if (typeof wx.hideLoading === 'function') wx.hideLoading();
                const message = error && error.message ? error.message : String(error);
                console.error('[vpay] requestVirtualPayment threw:', message);
                // API 不存在通常是微信版本过低（requestVirtualPayment 需基础库 2.19.2+）
                if (typeof wx.requestVirtualPayment !== 'function') {
                  flow.settle({
                    success: false,
                    code: 'WX_VERSION_TOO_LOW',
                    out_trade_no: result.out_trade_no,
                    error: '当前微信版本过低，无法拉起支付。请把微信更新到最新版后重试',
                  });
                  return;
                }
                // 其它异常：把真实原因暴露出来，便于定位（不再显示含糊的"确认中"）
                flow.settle({
                  success: false,
                  code: 'PAY_LAUNCH_FAILED',
                  out_trade_no: result.out_trade_no,
                  error: '拉起支付失败：' + message + '（订单已创建，可在下方查询）',
                });
              }
            },
            fail: (err) => {
              console.error('[vpay] 云函数调用失败:', err);
              flow.settle(unknownPayment());
            },
          });
        },
        fail: () => flow.settle(unknownPayment()),
      });
    } catch (error) {
      flow.settle(unknownPayment());
    }
  });
}

/** Only the server-confirmed state of this order can report payment success. */
function refreshAfterPay(outTradeNo, retry, flow) {
  if (flow.isSettled()) return;
  try {
    wx.cloud.callFunction({
      name: 'vpay',
      data: { action: 'order_status', out_trade_no: outTradeNo },
      success: (res) => {
        if (flow.isSettled()) return;
        const order = res && res.result;
        if (order && order.success && order.status === 'paid' && order.paid === true) {
          try {
            const app = getApp();
            if (!app || typeof app.refreshUserInfo !== 'function') {
              flow.settle(reconciliationResult(outTradeNo));
              return;
            }
            app.refreshUserInfo((refreshResult) => {
              if (flow.isSettled()) return;
              if (refreshResult && refreshResult.success) {
                forgetOrder();
                flow.settle({ success: true, error: null });
              } else {
                flow.settle(reconciliationResult(outTradeNo));
              }
            });
          } catch (error) {
            flow.settle(reconciliationResult(outTradeNo));
          }
          return;
        }

        if (order && order.success && [
          'closed',
          'refunded',
          'manual_review',
        ].includes(order.status)) {
          flow.settle({
            success: false,
            cancelled: false,
            code: order.code,
            status: order.status,
            out_trade_no: outTradeNo,
            error: orderStatusMessage(order),
          });
          return;
        }

        finishOrRetry(outTradeNo, retry, flow);
      },
      fail: () => finishOrRetry(outTradeNo, retry, flow),
    });
  } catch (error) {
    finishOrRetry(outTradeNo, retry, flow);
  }
}

function orderStatusMessage(order) {
  if (order.status === 'closed') return '订单已关闭';
  if (order.status === 'refunded') return '订单已退款';
  if (order.status === 'manual_review') return '退款情况待人工复核';
  return '订单状态仍在确认中，请稍后重试';
}

function rememberOrder(outTradeNo) {
  if (typeof outTradeNo !== 'string' || !outTradeNo) return;
  try {
    wx.setStorageSync(LAST_ORDER_STORAGE_KEY, outTradeNo);
  } catch (error) {
    // Order recovery still works through the server-side pending-order lookup.
  }
}

function forgetOrder() {
  try {
    wx.removeStorageSync(LAST_ORDER_STORAGE_KEY);
  } catch (error) {
    // A stale order number is harmless because the server verifies ownership.
  }
}

function getRememberedOrder() {
  try {
    const value = wx.getStorageSync(LAST_ORDER_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch (error) {
    return '';
  }
}

function callPayFunction(data) {
  return new Promise(resolve => {
    let settled = false;
    let timeoutId;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    timeoutId = setTimeout(() => finish(null), PAYMENT_FLOW_TIMEOUT_MS);

    try {
      wx.cloud.callFunction({
        name: 'vpay',
        data,
        success: response => finish(response && response.result),
        fail: () => finish(null),
      });
    } catch (error) {
      finish(null);
    }
  });
}

function refreshRecoveredEntitlement(outTradeNo) {
  return new Promise(resolve => {
    let settled = false;
    const timeoutId = setTimeout(() => finish(false), PAYMENT_FLOW_TIMEOUT_MS);
    const finish = success => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(success);
    };

    try {
      const app = getApp();
      if (!app || typeof app.refreshUserInfo !== 'function') {
        finish(false);
        return;
      }
      app.refreshUserInfo(result => finish(!!(result && result.success)));
    } catch (error) {
      finish(false);
    }
  }).then(success => {
    if (!success) return reconciliationResult(outTradeNo);
    forgetOrder();
    return { success: true, code: 'ORDER_PAID', status: 'paid', out_trade_no: outTradeNo };
  });
}

function recoverKnownOrder(order, outTradeNo) {
  if (!order || !order.success) {
    return {
      success: false,
      status: 'reconciliation_required',
      code: 'ORDER_RECONCILIATION_REQUIRED',
      out_trade_no: outTradeNo,
      error: '订单状态暂无法确认，请稍后重试',
    };
  }
  if (order.status === 'paid' && order.paid === true) {
    return refreshRecoveredEntitlement(outTradeNo);
  }
  if (['closed', 'refunded', 'manual_review'].includes(order.status)) {
    return {
      success: false,
      status: order.status,
      code: order.code,
      out_trade_no: outTradeNo,
      error: orderStatusMessage(order),
    };
  }
  return {
    success: false,
    status: order.status || 'reconciliation_required',
    code: order.code || 'ORDER_RECONCILIATION_REQUIRED',
    out_trade_no: outTradeNo,
    error: orderStatusMessage(order),
  };
}

async function recoverPendingOrder(outTradeNo) {
  const knownOrderNo = typeof outTradeNo === 'string' && outTradeNo
    ? outTradeNo
    : getRememberedOrder();

  if (knownOrderNo) {
    const knownOrder = await callPayFunction({
      action: 'order_status',
      out_trade_no: knownOrderNo,
    });
    if (knownOrder && knownOrder.code !== 'ORDER_NOT_FOUND') {
      return recoverKnownOrder(knownOrder, knownOrderNo);
    }
  }

  const pendingOrder = await callPayFunction({ action: 'order_status' });
  if (!pendingOrder || !pendingOrder.success) {
    return {
      success: false,
      status: 'reconciliation_required',
      code: 'ORDER_RECONCILIATION_REQUIRED',
      error: '待确认订单查询失败，请稍后重试',
    };
  }
  if (!pendingOrder.out_trade_no) {
    return { success: false, status: 'none', code: 'NO_PENDING_ORDER', error: '没有待确认订单' };
  }

  rememberOrder(pendingOrder.out_trade_no);
  const order = await callPayFunction({
    action: 'order_status',
    out_trade_no: pendingOrder.out_trade_no,
  });
  return recoverKnownOrder(order, pendingOrder.out_trade_no);
}

function finishOrRetry(outTradeNo, retry, flow) {
  if (flow.isSettled()) return;
  if (retry >= MAX_STATUS_RETRIES) {
    flow.settle(reconciliationResult(outTradeNo));
    return;
  }
  setTimeout(() => refreshAfterPay(outTradeNo, retry + 1, flow), STATUS_RETRY_DELAY_MS);
}

function reconciliationResult(outTradeNo) {
  return {
    success: false,
    code: 'ORDER_RECONCILIATION_REQUIRED',
    out_trade_no: outTradeNo,
    error: '支付结果仍在确认中，请稍后重试；请勿重复下单',
  };
}

function createPayFlow(resolve) {
  let settled = false;
  let outTradeNo = '';
  const timeoutId = setTimeout(() => {
    if (settled) return;
    resolveOnce(outTradeNo ? reconciliationResult(outTradeNo) : {
      success: false,
      code: 'PAYMENT_STATUS_UNKNOWN',
      error: '支付请求超时，订单状态无法确认，请稍后查询；请勿重复下单',
    });
  }, PAYMENT_FLOW_TIMEOUT_MS);

  function resolveOnce(result) {
    if (settled) return false;
    settled = true;
    clearTimeout(timeoutId);
    resolve(result);
    return true;
  }

  return {
    isSettled: () => settled,
    setOrder: (value) => {
      if (typeof value === 'string' && value) outTradeNo = value;
    },
    settle: resolveOnce,
  };
}

module.exports = {
  RULES,
  getUserEntitlement,
  checkVip,
  computePermanentCapacity,
  canAdd,
  canEdit,
  canCopy,
  getOverflowIds,
  requestPay,
  recoverPendingOrder,
};
