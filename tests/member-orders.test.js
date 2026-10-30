// 会员页历史订单入口：按钮语义改造 + 订单弹窗 + 自动恢复逻辑保留
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('member page button becomes order history with dialog wiring', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  // 按钮改为查询历史订单
  assert.match(wxml, /查询历史订单/);
  assert.doesNotMatch(wxml, /查询待确认订单/);
  assert.match(wxml, /bindtap="onListOrders"/);
  // 弹窗结构存在
  assert.match(wxml, /orders-mask/);
  assert.match(wxml, /ordersDialog\.visible/);
  // js：拉取 list_orders、状态映射、关闭弹窗
  assert.match(js, /onListOrders/);
  assert.match(js, /action:\s*'list_orders'/);
  assert.match(js, /closeOrdersDialog/);
  assert.match(js, /ordersDialog/);
});

test('order list shows full order number with copy action', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  // 完整订单号（不再只显示尾号）+ 点击复制
  assert.match(wxml, /\{\{item\.outTradeNo\}\}/);
  assert.doesNotMatch(wxml, /尾号 \{\{item\.tail\}\}/);
  assert.match(wxml, /bindtap="onCopyOrderNo" data-no="\{\{item\.outTradeNo\}\}"/);
  assert.match(js, /onCopyOrderNo/);
  assert.match(js, /setClipboardData/);
  assert.doesNotMatch(js, /slice\(-6\)/);
});

test('member page keeps silent pending-order recovery on show', () => {
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  // 自动恢复待确认订单走 onShow 静默路径，不因按钮改造丢失
  assert.match(js, /onRecoverOrder\(silent = false\)/);
  assert.match(js, /recoverPendingOrder/);
  assert.match(js, /onRecoverOrder\(true\)/);
});

test('member capacity row stays short with detail line always visible', () => {
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxml'), 'utf8');
  // 容量行不再拼接长括号说明（防止标签被挤竖排）
  assert.doesNotMatch(js, /含永久容量）/);
  // 容量明细行常显（会员态也显示分解）
  assert.match(wxml, /cap-detail/);
  assert.match(wxml, /isVip \? '会员 '/);
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/member/member.wxss'), 'utf8');
  // 标签防挤压
  assert.match(wxss, /\.status-label[^}]*flex-shrink:\s*0/);
  assert.match(wxss, /\.status-value[^}]*flex:\s*1/);
});

test('home page shows real total capacity instead of hardcoded 500 for vip', () => {
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  // 文案与取值：总容量 = effectiveCapacity（会员 500 + 邀请/付费叠加），不再写死
  assert.match(wxml, /\{\{capacity\}\}/, '首页容量文案必须来自真实变量 capacity');
  assert.doesNotMatch(wxml, /会员上限 500 条/);
  // 传给视图的容量必须来自 ent.effectiveCapacity（不写死 500）
  assert.match(js, /capacity: ent\.effectiveCapacity/);
});
