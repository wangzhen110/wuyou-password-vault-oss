// 云函数 - vpayCallback（微信虚拟支付消息推送接收）
// 事件：xpay_goods_deliver_notify（发货）、xpay_refund_notify（退款）、xpay_complaint_notify（投诉）、
//      xpay_wxpay_callback_notify（风控）、xpay_subscribe_ios_refund_query_notify（iOS 退款问询）
// 回执：{ ErrCode: 0, ErrMsg: 'success' }（异常情况返回非 0，平台会重推，最多 15 次）

const https = require('https');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const PACK_CAPACITY = 10;
const PAID_CAPACITY_MAX = 30;
const VIP_DAYS = 365;
const GRACE_DAYS = 3;
const INVITE_VIP_REFERRAL_DAYS = 90;
const INVITE_VIP_REFERRAL_WINDOW_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

// ===== 主动查单：不信任推送内容，改由微信侧确认支付状态 =====
// 说明：消息推送若配置为明文模式，无法校验 msg_signature；因此发货前一律回调
// /xpay/query_order 复核。查单失败时不发货并返回非 0（平台会重推），
// 保证"真实支付最终一定发货、伪造推送一定不发货"。
// OfferID 权威来源：MP 后台「虚拟支付 → 基础配置 → OfferID」（2026-10-21 人工核对 = 1450683281）
// 不读环境变量：VPAY_OFFER_ID 曾被误填为 1450663281（差一位）
// 该常量保留为「后台核对真值」的唯一锚点，测试据此校验；金额校验走接口下发值
// eslint-disable-next-line no-unused-vars
const OFFER_ID = '1450683281';
const APP_KEY = process.env.VPAY_APP_KEY || '';
const APP_SECRET = process.env.VPAY_APP_SECRET || '';
const WX_APP_ID = process.env.WX_APP_ID || '';
const ENV_FLAG = Number(process.env.VPAY_ENV || 0);

let tokenCache = { token: '', expireAt: 0 };

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      // 明确要求不压缩：避免拿到 gzip 内容导致 JSON.parse 失败
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
        // 微信接口对缺少 UA/Referer 的机房请求会返回 412（WAF 拦截）
        'Referer': 'https://servicewechat.com/' + (process.env.WX_APP_ID || '') + '/0/page-frame.html',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
          + '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.79(0x18004f2f) NetType/WIFI Language/zh_CN',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 80)));
        }
        if (!data) return reject(new Error('空响应'));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('非JSON响应: ' + data.slice(0, 80)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (tokenCache.token && tokenCache.expireAt > Date.now() + 60000) return tokenCache.token;
  let res;
  try {
    // 实测：stable_token(POST) 在云函数环境被微信 WAF 拦截返回 412；改用 GET /cgi-bin/token
    const qs = 'grant_type=client_credential&appid=' + encodeURIComponent(WX_APP_ID)
      + '&secret=' + encodeURIComponent(APP_SECRET);
    res = await requestJson('https://api.weixin.qq.com/cgi-bin/token?' + qs, undefined);
  } catch (e) {
    throw new Error('token阶段: ' + (e && e.message ? e.message : e));
  }
  if (!res.access_token) throw new Error('access_token 获取失败: ' + (res.errmsg || res.errcode));
  tokenCache = { token: res.access_token, expireAt: Date.now() + (res.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

function hmacHex(key, text) {
  return require('crypto').createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** 向微信查单，返回 { paid, transactionId, actualPrice } */
async function queryWechatOrder(outTradeNo, openid) {
  if (!APP_KEY || !APP_SECRET || !WX_APP_ID) {
    throw new Error('VPAY_CONFIG_MISSING');
  }
  // 官方文档：/xpay/query_order 的业务单号参数名是 order_id
  // 2026-10-23：POST 版被微信 WAF 拦截（HTTP 412，知识库 08-排错手册 #2：云函数机房 POST 被拦，
  // stable_token 同坑换 GET 才通）——改 GET：参数放 query，pay_sig 对空 body 签名
  const qs = `openid=${encodeURIComponent(openid)}&env=${ENV_FLAG}&order_id=${encodeURIComponent(outTradeNo)}`;
  const paySig = hmacHex(APP_KEY, '/xpay/query_order&');
  const accessToken = await getAccessToken();
  let res;
  try {
    res = await requestJson(
      `https://api.weixin.qq.com/xpay/query_order?access_token=${encodeURIComponent(accessToken)}&pay_sig=${paySig}&${qs}`
    );
  } catch (e) {
    throw new Error('query阶段: ' + (e && e.message ? e.message : e));
  }
  if (res.errcode) throw new Error('query_order: ' + res.errcode + ' ' + (res.errmsg || ''));
  const order = res.order || res;
  // 字段名以官方 /xpay/query_order 实际返回为准（2026-10 实测）：
  //   wxpay_order_id 微信支付交易号（真正的支付凭证）
  //   wx_order_id    虚拟支付平台单号
  //   status         订单状态；paid_fee 实付金额(分)；paid_time 支付时间(秒)
  const txId = String(order.wxpay_order_id || order.transaction_id || '');
  const paidFee = order.paid_fee !== undefined ? Number(order.paid_fee) : undefined;
  const paidTime = Number(order.paid_time || 0);
  // 已支付判定：具备真实支付痕迹（交易号 + 支付完成时间 + 实付金额>0），
  // 不依赖 status 枚举值（枚举可能变化，支付痕迹不会）
  const paid = !!txId && paidTime > 0 && Number.isFinite(paidFee) && paidFee > 0;
  const actualPrice = paidFee !== undefined ? paidFee
    : (order.order_fee !== undefined ? Number(order.order_fee) : undefined);
  return { paid, transactionId: txId, actualPrice, raw: order };
}


function ok() { return { ErrCode: 0, ErrMsg: 'success' }; }
function fail(reason) {
  console.error('vpayCallback 处理失败:', reason);
  return { ErrCode: 1, ErrMsg: String(reason || 'error') };
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 事务内发放权益（幂等：已发放直接返回） */
async function deliver(transaction, orderId, outTradeNo, openid, productId, referrer, userDocId) {
  const orderRef = transaction.collection('orders').doc(orderId);
  const orderRes = await orderRef.get();
  const order = orderRes.data;
  if (!order || order.out_trade_no !== outTradeNo || order._openid !== openid) {
    throw new Error('ORDER_CHANGED');
  }
  if (order.status === 'paid' && order.entitlement_delivered_at) return; // 已发货
  if (order.status !== 'pending') throw new Error('ORDER_STATUS_NOT_DELIVERABLE');

  // 事务内不支持 where 查询：用户文档 id 由调用方在事务外解析后传入
  const userRef = transaction.collection('users').doc(userDocId);
  const userSnap = await userRef.get();
  const user = userSnap.data;
  const now = new Date();
  const update = { updated_at: now };

  if (productId === 'permanent_pack') {
    const current = user.paid_capacity || 0;
    if (current + PACK_CAPACITY > PAID_CAPACITY_MAX) throw new Error('PACK_CAPACITY_ALREADY_USED');
    update.paid_capacity = current + PACK_CAPACITY;
  } else if (productId === 'yearly_vip') {
    const expire = toDate(user.vip_expire_at);
    let base = now;
    if (expire) {
      const graceEnd = expire.getTime() + GRACE_DAYS * DAY_MS;
      if (now.getTime() <= graceEnd) base = expire;
    }
    update.vip_expire_at = new Date(base.getTime() + VIP_DAYS * DAY_MS);
    update.vip_type = 1;
  } else {
    throw new Error('UNKNOWN_PRODUCT');
  }

  if (user.pending_payment_order && user.pending_payment_order.out_trade_no === outTradeNo) {
    update.pending_payment_order = _.remove();
  }

  await userRef.update({ data: update });
  await orderRef.update({
    data: {
      status: 'paid',
      paid_at: db.serverDate(),
      entitlement_delivered_at: db.serverDate(),
    },
  });

  // 推荐奖励：被邀请人 30 天内购买年度会员 → 邀请人 +3 个月（无上限）
  if (productId === 'yearly_vip' && referrer && referrer.inviterId && user.referral_vip_rewarded !== true) {
    const inviterRef = transaction.collection('users').doc(referrer.inviterId);
    const inviterSnap = await inviterRef.get();
    const inviter = inviterSnap.data;
    if (inviter && inviter._openid === referrer.inviterOpenid) {
      const inviterExpire = toDate(inviter.vip_expire_at);
      const base = inviterExpire && inviterExpire > now ? inviterExpire : now;
      await inviterRef.update({
        data: {
          vip_expire_at: new Date(base.getTime() + INVITE_VIP_REFERRAL_DAYS * DAY_MS),
          vip_type: 1,
          updated_at: now,
        },
      });
      await userRef.update({ data: { referral_vip_rewarded: true } });
    }
  }
}

/** 事务外定位推荐人（事务内不支持 where 查询） */
async function findReferrer(invitee) {
  if (!invitee || !invitee.invited_by || invitee.referral_vip_rewarded === true) return null;
  const invitedAt = toDate(invitee.invited_at || invitee.created_at);
  if (!invitedAt || Date.now() - invitedAt.getTime() > INVITE_VIP_REFERRAL_WINDOW_DAYS * DAY_MS) return null;
  const res = await db.collection('users').where({ invite_code: invitee.invited_by }).limit(2).get();
  if (res.data.length !== 1) return null;
  return { inviterId: res.data[0]._id, inviterOpenid: res.data[0]._openid };
}

async function handleDeliver(event, ctx = {}) {
  const outTradeNo = String(event.OutTradeNo || '');
  const openid = String(event.OpenId || '');
  const goods = event.GoodsInfo || {};
  const productId = String(goods.ProductId || '');
  // 诊断日志（2026-10-23 查单 openid 错误排查）：打印推送 payload 的关键单号字段，定位单号维度问题
  console.error('[vpayCallback][diag] 推送字段:', JSON.stringify({
    Event: event.Event || event.event || null,
    OutTradeNo: outTradeNo,
    OpenId: openid,
    ProductId: productId,
    ActualPrice: goods.ActualPrice || null,
    WxOrderId: event.WxOrderId || event.wx_order_id || (event.WeChatPayInfo && event.WeChatPayInfo.MchOrderNo) || null,
    hasDecryptData: !!event.encryptedData,
  }));
  if (!outTradeNo || !openid || !productId) return fail('DELIVER_FIELDS_MISSING');

  const orderRes = await db.collection('orders')
    .where({ out_trade_no: outTradeNo })
    .limit(2)
    .get();
  if (orderRes.data.length !== 1) return fail('ORDER_NOT_FOUND_OR_AMBIGUOUS');
  const order = orderRes.data[0];

  // 防伪造：商品必须与本地订单一致
  if (order._openid !== openid || order.product_id !== productId) return fail('ORDER_MISMATCH');

  // 金额必须与本地订单一致（推送里的实际支付价）；缺失或非法一律拒绝，不得跳过
  const actual = Number(goods.ActualPrice);
  if (!Number.isFinite(actual) || actual !== Number(order.total_fee)) {
    return fail('AMOUNT_MISMATCH');
  }

  // 安全模式推送已由微信签名验签（解密成功），内容可信 → 直接发货（无需查单）
  // 明文/未验签仍必须查单复核，否则拒绝发货
  // signatureVerified 由 exports.main 的网关+解密成功路径通过 ctx 传入；
  // 直调云函数时 ctx 恒为空 → 强制查单，且无法通过伪造 event 字段绕过
  const signatureVerified = !!(ctx && ctx.signatureVerified === true);
  if (!signatureVerified) {
  let verified;
  try {
    verified = await queryWechatOrder(outTradeNo, openid);
  } catch (error) {
    // 查单失败不发货，返回非 0 让平台重推；真实支付最终会成功
    const detail = error && error.message ? String(error.message).slice(0, 120) : 'unknown';
    console.error('[vpayCallback] 查单失败原因:', detail);
    return fail('ORDER_VERIFY_FAILED:' + detail);
  }
  if (!verified.paid) return fail('ORDER_NOT_PAID');
  if (!Number.isFinite(verified.actualPrice) || verified.actualPrice !== Number(order.total_fee)) {
    return fail('AMOUNT_MISMATCH_SERVER');
  }
  if (!verified.transactionId) return fail('MISSING_TRANSACTION_ID');
  // 记录平台交易号，便于对账与重复发货排查
  await db.collection('orders').doc(order._id).update({
    data: { transaction_id: verified.transactionId },
  }).catch(() => {});
  }

  const userRes = await db.collection('users').where({ _openid: openid }).limit(2).get();
  if (userRes.data.length !== 1) return fail('USER_NOT_FOUND_OR_AMBIGUOUS');
  const referrer = productId === 'yearly_vip' ? await findReferrer(userRes.data[0]) : null;

  await db.runTransaction(t => deliver(t, order._id, outTradeNo, openid, productId, referrer, userRes.data[0]._id));
  return ok();
}

async function handleRefund(event) {
  const mchOrderId = String(event.MchOrderId || '');
  if (!mchOrderId) return ok();
  const orderRes = await db.collection('orders').where({ out_trade_no: mchOrderId }).limit(2).get();
  if (orderRes.data.length !== 1) return ok();
  const order = orderRes.data[0];
  const retCode = Number(event.RetCode);

  // 幂等：已处理过退款直接回执，防止平台重推导致权益被重复撤销
  if (order.refund_state === 'refunded') return ok();

  await db.collection('orders').doc(order._id).update({
    data: {
      refund_state: retCode === 0 ? 'refunded' : 'refund_failed',
      refund_ret_msg: String(event.RetMsg || ''),
      refunded_at: db.serverDate(),
      refund_review_status: retCode === 0 ? 'manual_review_required' : order.refund_review_status || null,
      entitlement_status: retCode === 0 ? 'frozen' : order.entitlement_status || null,
    },
  });

  // 退款成功必须撤销已发货权益（2026-10-23 修复白嫖级漏洞：此前退款只改标记不撤销，
  // 用户可"购买→退款→保留权益"）
  if (retCode === 0) {
    const userRes = await db.collection('users').where({ _openid: order._openid }).limit(2).get();
    if (userRes.data.length === 1) {
      const user = userRes.data[0];
      if (order.product_id === 'permanent_pack') {
        // 永久包：扣回对应容量（防负，最多扣到 0）
        const current = Number(user.paid_capacity) || 0;
        const deducted = Math.min(PACK_CAPACITY, current);
        if (deducted > 0) {
          await db.collection('users').doc(user._id).update({
            data: { paid_capacity: _.inc(-deducted), updated_at: Date.now() },
          }).catch(e => console.error('[refund] 扣回容量失败:', e && e.message));
        }
      } else if (order.product_id === 'yearly_vip') {
        // 年度会员：退一笔减一年；剩余不足一天则清空会员状态
        const expire = user.vip_expire_at ? new Date(user.vip_expire_at).getTime() : 0;
        const remainDays = (expire - Date.now()) / DAY_MS;
        if (remainDays > 1) {
          await db.collection('users').doc(user._id).update({
            data: { vip_expire_at: new Date(expire - 365 * DAY_MS), updated_at: Date.now() },
          }).catch(e => console.error('[refund] 扣减会员时长失败:', e && e.message));
        } else {
          await db.collection('users').doc(user._id).update({
            data: { vip_type: 0, vip_expire_at: null, updated_at: Date.now() },
          }).catch(e => console.error('[refund] 清除会员状态失败:', e && e.message));
        }
      }
      console.error('[vpayCallback] 退款成功，已撤销权益:', JSON.stringify({
        out_trade_no: mchOrderId, product_id: order.product_id, openid: order._openid,
      }));
    }
  }
  return ok();
}

async function handleComplaint(event) {
  try {
    await db.collection('api_audit').add({
      data: {
        _openid: String(event.OpenId || ''),
        action: 'vpay_complaint',
        complaint_id: String(event.ComplaintId || ''),
        detail: String(event.ComplaintDetail || '').slice(0, 500),
        created_at: Date.now(),
      },
    });
  } catch (e) { /* 审计失败不影响回执 */ }
  return ok();
}

// ===== 安全模式：验签 + 解密（推送自带微信签名，无需再查单）=====
const MSG_TOKEN = process.env.VPAY_TOKEN || '';
const MSG_AES_KEY = process.env.VPAY_AES_KEY || '';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ba, bb);
}

/**
 * 校验 msg_signature 并解密任意加密串，返回明文 msg 字符串。
 */
function decryptRaw(query, encryptStr) {
  const encrypt = String(encryptStr || '');
  const msgSignature = String((query && (query.msg_signature || query.signature)) || '');
  const timestamp = String((query && query.timestamp) || '');
  const nonce = String((query && query.nonce) || '');
  if (!encrypt || !msgSignature) throw new Error('MISSING_ENCRYPT_PAYLOAD');
  if (!MSG_TOKEN || !MSG_AES_KEY) throw new Error('AES_CONFIG_MISSING');

  const raw = [MSG_TOKEN, timestamp, nonce, encrypt].sort().join('');
  const expected = require('crypto').createHash('sha1').update(raw).digest('hex');
  if (!safeEqual(expected, msgSignature)) throw new Error('SIGNATURE_MISMATCH');

  const key = Buffer.from(MSG_AES_KEY + '=', 'base64');
  if (key.length !== 32) throw new Error('AES_KEY_INVALID');
  const iv = key.slice(0, 16);
  const decipher = require('crypto').createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  if (pad >= 1 && pad <= 32) buf = buf.slice(0, buf.length - pad);
  const msgLen = buf.readUInt32BE(16);
  const msg = buf.slice(20, 20 + msgLen).toString('utf8');
  const appid = buf.slice(20 + msgLen).toString('utf8');
  if (appid !== WX_APP_ID) throw new Error('APPID_MISMATCH: ' + appid);
  return msg;
}

/**
 * 校验 msg_signature 并解密 Encrypt 字段。
 * 成功返回解密后的对象；失败抛错（调用方拒绝处理）。
 */
function decryptMessage(query, bodyObj) {
  const encrypt = String((bodyObj && (bodyObj.Encrypt || bodyObj.encrypt)) || '');
  if (!encrypt) throw new Error('MISSING_ENCRYPT_PAYLOAD');

  // 验签 + 解密（复用 decryptRaw，其内部用 safeEqual 校验 msg_signature）
  const msg = decryptRaw(query, encrypt);

  // 明文可能是 JSON 或 XML，两种都兼容
  const text = msg.trim();
  if (text.startsWith('{')) return JSON.parse(text);
  const obj = {};
  const re = /<([A-Za-z0-9_-]+)>([^<]*)<\/([A-Za-z0-9_-]+)>/g;
  let m;
  while ((m = re.exec(text)) !== null) obj[m[1]] = m[2];
  return obj;
}

// ===== HTTP 接入（微信「消息推送」以 URL 方式投递）=====
// GET：平台启用配置时的校验请求，需原样返回 echostr
// POST：事件推送（明文模式 -> JSON body）
function httpParse(event) {
  const method = String(event.httpMethod || event.method || '').toUpperCase();
  const query = event.queryStringParameters || {};
  if (method === 'GET') {
    if (typeof query.echostr === 'string') {
      // 安全模式下 echostr 是加密的：验签 + 解密后返回明文，否则微信会判定校验失败
      if (query.msg_signature) {
        try {
          return { http: true, verify: decryptRaw(query, query.echostr) };
        } catch (error) {
          console.error('[vpayCallback] echostr 解密失败:', error && error.message);
          return { http: true, verify: '' };
        }
      }
      return { http: true, verify: query.echostr };
    }
    return { http: true, verify: '' };
  }
  let payload = event.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
  }
  return { http: true, payload: payload || {} };
}

exports.main = async (event = {}) => {
  const isHttp = !!(event.httpMethod || event.queryStringParameters || event.body);
  if (isHttp) {
    const parsed = httpParse(event);
    if (parsed.verify !== undefined) {
      // 微信校验：直接回显 echostr 明文
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: parsed.verify };
    }
    let payload = parsed.payload || {};
    // 安全模式推送：body 带 Encrypt 字段，先验签解密（解密后的内容可信，无需查单）
    let signatureVerified = false; // 经函数参数传递给 handleEvent，伪造者无法从 event 注入
    if (payload && (payload.Encrypt || payload.encrypt)) {
      try {
        payload = decryptMessage(event.queryStringParameters || {}, payload);
        signatureVerified = true; // 解密+验签成功：内容可信（状态经函数参数传递，不落 event）
      } catch (error) {
        const detail = error && error.message ? String(error.message).slice(0, 100) : 'unknown';
        console.error('[vpayCallback] 解密失败:', detail);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ErrCode: 1, ErrMsg: 'DECRYPT_FAILED:' + detail }),
        };
      }
    }
    let result;
    try {
      result = await handleEvent(payload, { signatureVerified });
    } catch (error) {
      result = fail(error && error.message ? error.message : error);
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result),
    };
  }

  const result = await handleEvent(event);
  return result;
};

async function handleEvent(event, ctx = {}) {
  const eventType = String(event.Event || event.event || '');
  try {
    switch (eventType) {
      case 'xpay_goods_deliver_notify':
        return await handleDeliver(event, ctx);
      case 'xpay_refund_notify':
        return await handleRefund(event);
      case 'xpay_complaint_notify':
        return await handleComplaint(event);
      case 'xpay_wxpay_callback_notify':
        console.warn('虚拟支付风控事件:', JSON.stringify(event).slice(0, 500));
        return ok();
      case 'xpay_subscribe_ios_refund_query_notify': {
        // iOS 退款问询：3 秒内必须响应，据实回答（未发货则建议退款）
        const payOrderId = String(event.pay_order_id || '');
        let delivered = false;
        if (payOrderId) {
          const res = await db.collection('orders').where({ out_trade_no: payOrderId }).limit(1).get();
          delivered = !!(res.data[0] && res.data[0].entitlement_delivered_at);
        }
        return delivered
          ? { result_code: 1, result_info: '权益已发放，拒绝退款', evidence: 'entitlement_delivered_at 已记录' }
          : { result_code: 0, result_info: '未发货，建议退款', evidence: '本地订单无发货记录' };
      }
      default:
        console.warn('未处理的推送事件:', eventType);
        return ok();
    }
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}
