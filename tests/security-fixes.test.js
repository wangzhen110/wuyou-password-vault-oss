// 安全修复回归（run-1 findings F1/F2/F3）：结构断言，防止被改回不安全实现
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CALLBACK = read('cloudfunctions/vpayCallback/index.js');
const SYNC = read('cloudfunctions/sync/index.js');
const OPENAPI = read('cloudfunctions/openapi/index.js');
const APIAUTH = read('cloudfunctions/apiAuth/index.js');

test('F1: deliveries require either a verified signature or an independent order query', () => {
  // 路线一：安全模式推送 → 验签解密通过，内容可信，跳过查单直接发货
  assert.match(CALLBACK, /function decryptRaw\(/);
  assert.match(CALLBACK, /function decryptMessage\(/);
  assert.match(CALLBACK, /SIGNATURE_MISMATCH/);
  assert.match(CALLBACK, /APPID_MISMATCH/);
  assert.match(CALLBACK, /const signatureVerified = !!\(ctx && ctx\.signatureVerified === true\);/);
  assert.match(CALLBACK, /signatureVerified = true; \/\/ 解密\+验签成功/);
  assert.match(CALLBACK, /result = await handleEvent\(payload, \{ signatureVerified \}\);/);
  assert.match(CALLBACK, /if \(!signatureVerified\) \{/);

  // 路线二：未验签（明文模式）→ 必须查单复核，且查单发生在发货事务之前
  assert.match(CALLBACK, /async function queryWechatOrder\(/);
  assert.match(CALLBACK, /\/xpay\/query_order&/);
  const queryIdx = CALLBACK.indexOf('await queryWechatOrder(outTradeNo');
  const deliverCall = CALLBACK.indexOf('await db.runTransaction(t => deliver(');
  assert.ok(queryIdx > 0 && deliverCall > queryIdx, '查单必须发生在发货事务之前');

  // 未支付 / 查单失败 / 缺交易号 都必须拒绝
  assert.match(CALLBACK, /fail\('ORDER_NOT_PAID'\)/);
  assert.match(CALLBACK, /ORDER_VERIFY_FAILED/);
  assert.match(CALLBACK, /MISSING_TRANSACTION_ID/);
  // 金额必须一致
  assert.match(CALLBACK, /AMOUNT_MISMATCH/);
  assert.match(CALLBACK, /AMOUNT_MISMATCH_SERVER/);
});

test('F1: iOS refund query answers from real delivery state', () => {
  assert.match(CALLBACK, /pay_order_id/);
  assert.match(CALLBACK, /entitlement_delivered_at/);
  assert.match(CALLBACK, /result_code: 0/, '未发货时应建议退款');
  assert.match(CALLBACK, /result_code: 1/, '已发货时应拒绝退款');
});

test('F2: sync enforces capacity on the server before writing', () => {
  assert.match(SYNC, /async function enforceCapacity\(/);
  assert.match(SYNC, /CAPACITY_EXCEEDED/);
  assert.match(SYNC, /vip_expire_at/);
  assert.match(SYNC, /VIP_CAPACITY = 500/);
  // 必须在处理上传之前校验
  const checkIdx = SYNC.indexOf('await enforceCapacity(openid, localUpdates)');
  const processIdx = SYNC.indexOf('await processUploads(openid, localUpdates)');
  assert.ok(checkIdx > 0 && processIdx > checkIdx, '容量校验必须在写入之前');
  // 已存在条目视为更新，不占新额度
  assert.match(SYNC, /uniqueIds\.length - existing/);
});

test('F3: token exchange is rate limited and uses 8-digit codes', () => {
  assert.match(OPENAPI, /CODE_ATTEMPT_GLOBAL_MAX/);
  assert.match(OPENAPI, /too_many_attempts/);
  assert.match(OPENAPI, /\^\\d\{8\}\$/, '授权码必须为 8 位');
  assert.match(OPENAPI, /code_locked/);
  assert.match(APIAUTH, /randomInt\(10000000, 100000000\)/, '授权码生成必须为 8 位');

  // 限流必须基于不可伪造维度：全局窗口函数不得接收 ip 参数
  assert.match(OPENAPI, /async function globalFailures\(\)/);
  assert.equal(/ipAttempts/.test(OPENAPI), false, '不得再按请求头推导的 ip 计数');
  const limitIdx = OPENAPI.indexOf('globalFailures()');
  const lookupIdx = OPENAPI.indexOf('where({ code })');
  assert.ok(limitIdx > 0 && lookupIdx > limitIdx, '全局限流必须先于码查询');
});

test('purge: cloud delete requires explicit confirm and only touches own data', () => {
  const sync = read('cloudfunctions/sync/index.js');
  // 必须要求显式确认串，防止误触/被脚本调用
  assert.match(sync, /confirm !== 'DELETE_MY_VAULT'/);
  assert.match(sync, /error: 'CONFIRM_REQUIRED'/);
  // 只删 passwords / vault_meta，订单与审计保留
  assert.match(sync, /for \(const collection of \['passwords', 'vault_meta'\]\)/);
  assert.match(sync, /where\(\{ _openid: openid \}\)/);
  assert.match(sync, /orders_and_audit_retained_for_compliance/);
});

test('purge: local cleanup exists and clears in-memory master key', () => {
  const storage = read('miniprogram/utils/storage.js');
  const settings = read('miniprogram/pages/settings/settings.js');
  const wxml = read('miniprogram/pages/settings/settings.wxml');

  assert.match(storage, /function clearAllLocalData\(\)/);
  assert.match(storage, /app\.globalData\.masterKey = null/);
  assert.match(storage, /wx\.removeStorageSync/);
  // 设置页必须能触发，并提示"删小程序不等于删云端"
  assert.match(settings, /onPurgeCloud\(\)/);
  assert.match(settings, /purge_vault/);
  assert.match(wxml, /清空云端数据/);
  assert.match(wxml, /删除小程序只会清空本机缓存/);
});
