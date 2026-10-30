// 首次设置主密码：两个输入框同屏，点击一次即校验并提交（不再分步要求"再输一次"）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.js'), 'utf8');
const WXML = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');

test('first-time setup submits in one tap without an extra confirm step', () => {
  // 不应再有 "推进到确认步" 的中间步骤
  assert.equal(/setData\(\s*\{\s*step:\s*1/.test(JS), false, '不应再分步推进');
  assert.ok(JS.includes('两次输入的密码不一致'), '应直接校验两次输入是否一致');
  // 提交前必须同时满足两个输入长度（canSubmit 逻辑）
  assert.match(JS, /isFirstUse\)\s*\{\s*can = password\.length >= 6 && confirmPassword\.length >= 6;/);
});

test('pending invite code is prefilled into the first-time invite input', () => {
  // 分享卡片进入（index 转存 pending_invite_code）后，首次设置页面应回填邀请码
  assert.match(JS, /pending_invite_code/);
  assert.match(JS, /inviteCode,\s*\n\s*\}\);/);
});

test('confirm input stays visible together with the master password input', () => {
  assert.match(WXML, /class="confirm-area" wx:if="\{\{isFirstUse\}\}"/);
  assert.match(WXML, /placeholder="确认密码"/);
  // 副标题先讲清"微信已自动登录"（登录感知），两次一致性由提交校验兜底
  assert.ok(WXML.includes('微信已自动登录，此密码仅用于加密数据'), '副标题应说明微信已登录且密码仅用于加密');
  assert.equal(WXML.includes('请再次输入以确认'), false, '不应再出现"请再次输入以确认"的误导文案');
});

test('error message sits directly under the confirm input, with a fixed height', () => {
  const WXSS = fs.readFileSync(path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxss'), 'utf8');
  assert.match(WXSS, /\.error-area \{[\s\S]{0,160}min-height: \d+rpx;/, '错误区需固定高度，避免提示切换时顶动输入框');

  // 首次设置时，错误提示必须落在"确认密码"输入框之后、邀请码之前
  const idxConfirm = WXML.indexOf('placeholder="确认密码"');
  const idxErrorFirst = WXML.indexOf('class="error-area" wx:if="{{isFirstUse}}"');
  const idxInvite = WXML.indexOf('pwd-input-wrap invite-wrap');
  assert.ok(idxConfirm > 0 && idxErrorFirst > 0 && idxInvite > 0, '结构元素应齐全');
  assert.ok(idxErrorFirst > idxConfirm, '错误提示应在确认密码框下方');
  assert.ok(idxErrorFirst < idxInvite, '错误提示应在邀请码之前');

  // 解锁模式（无确认框）时提示在主密码框下方
  assert.match(WXML, /class="error-area" wx:if="\{\{!isFirstUse\}\}"/);
});
