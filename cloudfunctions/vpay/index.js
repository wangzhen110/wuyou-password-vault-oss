// 云函数 - vpay（小程序调用）
// 微信小程序虚拟支付：道具直购（short_series_goods）
// 签名规范（官方）：
//   paySig    = hex(HMAC-SHA256(AppKey, "requestVirtualPayment&" + signData))
//   signature = hex(HMAC-SHA256(session_key, signData))
// 密钥全部来自环境变量，不进入代码仓库。

const crypto = require('crypto');
const https = require('https');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// OfferID 为公开标识（非密钥）：直接写死，避免环境变量与后台不一致导致 -15001
// OfferID 权威来源：MP 后台「虚拟支付 → 基础配置 → OfferID」（2026-10-21 人工核对 = 1450683281）
// 不读环境变量：VPAY_OFFER_ID 曾被误填为 1450663281（差一位），导致 -15001 OFFER_ID_INVALID
const OFFER_ID = '1450683281';
const APP_KEY = process.env.VPAY_APP_KEY || '';
const APP_SECRET = process.env.VPAY_APP_SECRET || '';
const WX_APP_ID = process.env.WX_APP_ID || '';
const ENV_FLAG = Number(process.env.VPAY_ENV || 0); // 0 现网 / 1 沙箱

const PACK_CAPACITY_MAX = 30;

const PRODUCTS = {
  permanent_pack: { productId: 'permanent_pack', name: '永久容量补充包', price: 990 },
  yearly_vip: { productId: 'yearly_vip', name: '年度会员', price: 3900 },
};

function hmacHex(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function code2Session(code) {
  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(WX_APP_ID)}`
      + `&secret=${encodeURIComponent(APP_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errcode) reject(new Error('code2session: ' + parsed.errcode + ' ' + (parsed.errmsg || '')));
          else resolve(parsed);
        } catch (e) {
          reject(new Error('code2session 响应解析失败'));
        }
      });
    }).on('error', reject);
  });
}

function newOutTradeNo() {
  return 'WYV' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function getOrder(openid, outTradeNo) {
  const res = await db.collection('orders').where({ out_trade_no: outTradeNo, _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

// ===== 下单：生成 signData 与双签名 =====
async function prepay(openid, productId, code) {
  const product = PRODUCTS[productId];
  if (!product) return { success: false, error: '无效的商品' };
  if (!OFFER_ID || !APP_KEY || !APP_SECRET || !WX_APP_ID) {
    return { success: false, error: '支付参数未配置', code: 'VPAY_CONFIG_MISSING' };
  }
  if (typeof code !== 'string' || !code) return { success: false, error: '登录凭证缺失，请重试' };

  const userRes = await db.collection('users').where({ _openid: openid }).limit(2).get();
  if (userRes.data.length !== 1) return { success: false, error: '用户不存在，请重新进入小程序' };
  const user = userRes.data[0];

  // 待确认订单超过 5 分钟视为失效（拉起支付失败/用户中途退出会留下 pending，
  // 若不释放，用户将永远无法重新下单）
  const PENDING_TTL_MS = 5 * 60 * 1000;
  const pendingRes = await db.collection('orders')
    .where({ _openid: openid, status: 'pending' })
    .limit(2)
    .get();
  const activePending = (pendingRes.data || []).filter((order) => {
    const created = order.created_at ? new Date(order.created_at).getTime() : 0;
    return created && Date.now() - created < PENDING_TTL_MS;
  });
  // 过期订单标记为 closed，释放下单通道
  for (const order of pendingRes.data || []) {
    if (!activePending.includes(order)) {
      await db.collection('orders').doc(order._id)
        .update({ data: { status: 'closed', closed_at: db.serverDate(), close_reason: 'pending_timeout' } })
        .catch(() => {});
    }
  }

  if (activePending.length > 0) {
    return {
      success: false,
      code: 'ORDER_PENDING',
      error: '已有订单待确认，请稍后在会员页查询',
      out_trade_no: activePending[0].out_trade_no,
    };
  }
  if (productId === 'permanent_pack' && (user.paid_capacity || 0) >= PACK_CAPACITY_MAX) {
    return { success: false, code: 'PACK_LIMIT', error: '永久容量补充包最多购买 3 次，已达上限' };
  }

  const session = await code2Session(code);
  if (!session.session_key) return { success: false, error: '获取登录态失败，请重试' };

  const outTradeNo = newOutTradeNo();
  const signData = JSON.stringify({
    offerId: OFFER_ID,
    buyQuantity: 1,
    env: ENV_FLAG,
    currencyType: 'CNY',
    productId: product.productId,
    goodsPrice: product.price,
    outTradeNo,
    attach: openid,
  });

  const paySig = hmacHex(APP_KEY, 'requestVirtualPayment&' + signData);
  const signature = hmacHex(session.session_key, signData);

  await db.collection('orders').add({
    data: {
      _openid: openid,
      out_trade_no: outTradeNo,
      product_id: productId,
      product_name: product.name,
      total_fee: product.price,
      channel: 'virtual',
      status: 'pending',
      created_at: db.serverDate(),
      paid_at: null,
      transaction_id: null,
    },
  });
  await db.collection('users').doc(user._id).update({
    data: { pending_payment_order: _.set({ out_trade_no: outTradeNo, product_id: productId, created_at: new Date() }) },
  });

  return {
    success: true,
    out_trade_no: outTradeNo,
    signData,
    paySig,
    signature,
    mode: 'short_series_goods',
  };
}

// ===== access_token（stable_token，带内存缓存）=====
let tokenCache = { token: '', expireAt: 0 };

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (tokenCache.token && tokenCache.expireAt > Date.now() + 60000) return tokenCache.token;
  const payload = JSON.stringify({
    grant_type: 'client_credential',
    appid: WX_APP_ID,
    secret: APP_SECRET,
  });
  // 实测：stable_token(POST) 在云函数环境被微信 WAF 拦截返回 412；改用 GET /cgi-bin/token
  const qs = 'grant_type=client_credential&appid=' + encodeURIComponent(WX_APP_ID)
    + '&secret=' + encodeURIComponent(APP_SECRET);
  const res = await requestJson('https://api.weixin.qq.com/cgi-bin/token?' + qs, undefined);
  if (!res.access_token) throw new Error('获取 access_token 失败: ' + (res.errmsg || res.errcode));
  tokenCache = { token: res.access_token, expireAt: Date.now() + (res.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

// ===== 查单（发货兜底）：调用 /xpay/query_order =====
async function queryOrder(openid, outTradeNo) {
  if (!OFFER_ID || !APP_KEY) return { success: false, error: '支付参数未配置' };
  // 官方 /xpay/query_order 的业务单号参数名是 order_id（与 vpayCallback 保持一致）
  const body = JSON.stringify({ openid, env: ENV_FLAG, order_id: outTradeNo });
  const paySig = hmacHex(APP_KEY, '/xpay/query_order&' + body);
  const accessToken = await getAccessToken();
  const raw = await requestJson(
    `https://api.weixin.qq.com/xpay/query_order?access_token=${encodeURIComponent(accessToken)}&pay_sig=${paySig}`,
    body
  );
  return { success: true, raw };
}

// ===== 本地订单状态 =====
async function orderStatus(openid, outTradeNo) {
  let order = null;
  if (outTradeNo) {
    order = await getOrder(openid, outTradeNo);
  } else {
    // 未指定单号：查该用户最近的待确认订单（会员页“查询订单”入口）
    const pending = await db.collection('orders')
      .where({ _openid: openid, status: 'pending' })
      .limit(1)
      .get();
    order = pending.data[0] || null;
    if (!order) return { success: true, paid: false, status: 'none', delivered: false };
  }
  if (!order) return { success: false, error: '订单不存在' };
  return {
    success: true,
    paid: order.status === 'paid',
    status: order.status,
    out_trade_no: order.out_trade_no,
    product_id: order.product_id,
    delivered: !!order.entitlement_delivered_at,
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext() || {};
  const openid = wxContext.OPENID;
  if (!openid) return { success: false, error: '获取用户身份失败' };

  try {
    if (event.action === 'order_status') {
      return await orderStatus(openid, event.out_trade_no);
    }
    if (event.action === 'query_order') {
      return await queryOrder(openid, event.out_trade_no);
    }
    return await prepay(openid, event.product_id, event.code);
  } catch (error) {
    console.error('vpay 失败:', error && error.message ? error.message : error);
    return { success: false, error: error && error.message ? error.message : '下单失败，请重试' };
  }
};
