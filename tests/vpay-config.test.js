// vpay 配置测试：OfferID 必须等于 MP 后台真值，且不读环境变量
// 背景（2026-10-21）：云函数环境变量 VPAY_OFFER_ID 被误填为 1450663281，而 MP 后台
// 「虚拟支付 → 基础配置 → OfferID」真值为 1450683281（差一位），导致 -15001 OFFER_ID_INVALID。
// 因此以代码常量为准（后台核对值），并禁止再用环境变量覆盖。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKEND_OFFER_ID = '1450683281'; // 2026-10-21 从 MP 后台核对

test('vpay functions use the backend-confirmed OFFER_ID', () => {
  for (const file of ['cloudfunctions/vpay/index.js', 'cloudfunctions/vpayCallback/index.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(
      src,
      new RegExp("const OFFER_ID = '" + BACKEND_OFFER_ID + "';"),
      file + ' 的 OFFER_ID 必须等于 MP 后台真值'
    );
    assert.doesNotMatch(
      src,
      /process\.env\.VPAY_OFFER_ID/,
      file + ' 不得再读 VPAY_OFFER_ID（历史上被误填导致 -15001）'
    );
  }
});

test('vpay query_order uses official order_id field', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/vpay/index.js'), 'utf8');
  assert.match(src, /order_id: outTradeNo/, 'query_order 的业务单号参数名必须是 order_id');
});

test('vpay no longer carries the stale offerId value', () => {
  const stale = "'1450663281'";
  for (const file of ['cloudfunctions/vpay/index.js', 'cloudfunctions/vpayCallback/index.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!src.includes(stale), file + ' 不得出现错误值 1450663281');
  }
});
