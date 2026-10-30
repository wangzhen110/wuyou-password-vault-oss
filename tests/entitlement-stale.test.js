// 权益 stale 提示修复：refreshUserInfo 补同步时间戳 + member 页过期自愈
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('refreshUserInfo stamps _synced_at so fresh server data is not marked stale', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8');
  // 主 login 路径已有时间戳；refreshUserInfo（支付到账/邀请/设置页共用）必须同样补齐
  const refreshFn = appJs.match(/refreshUserInfo\(callback\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(refreshFn, 'refreshUserInfo found');
  assert.match(refreshFn[0], /_synced_at\s*=\s*Date\.now\(\)/);
});

test('member page self-heals expired entitlement via refreshUserInfo with throttle', () => {
  const memberJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  // 仅"过期但在线"自愈，离线提示保持不变
  assert.match(memberJs, /staleReason\s*===\s*'expired'/);
  assert.match(memberJs, /app\.refreshUserInfo/);
  // 10 秒节流防失败时接口风暴
  assert.match(memberJs, /_lastEntitlementFetchAt/);
  assert.match(memberJs, /10 \* 1000/);
});

test('member page keeps offline stale text intact', () => {
  const memberJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  assert.match(memberJs, /离线状态，权益显示为上次同步结果/);
  assert.match(memberJs, /权益信息已超过 10 分钟未同步/);
});
