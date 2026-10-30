/**
 * 容量规则测试：会员容量必须与"永久容量"叠加，不能覆盖。
 * 规则（2026-10-20 起）：
 *   非会员：free_capacity + invite_capacity + paid_capacity
 *   会员：  VIP_CAPACITY(500) + invite_capacity + paid_capacity
 * 关联：cloudfunctions/sync 的 resolveCapacity 采用同一口径（服务端权威）。
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const MEMBER_PATH = path.join(__dirname, '..', 'miniprogram', 'utils', 'member.js');

function loadMember(userInfo) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === '../../utils/storage' || request === '../utils/storage' || request.endsWith('utils/storage')) {
      return {
        get: () => null,
        set: () => true,
        remove: () => true,
        getAllPasswords: async () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  global.wx = {
    getStorageSync: () => null,
    setStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    cloud: { callFunction: () => {} },
  };
  global.getApp = () => ({ globalData: { userInfo, offlineMode: false } });

  delete require.cache[require.resolve(MEMBER_PATH)];
  const member = require(MEMBER_PATH);
  Module._load = originalLoad;
  return member;
}

test('非会员容量 = 免费 + 邀请 + 已购', () => {
  const member = loadMember({
    free_capacity: 30,
    invite_capacity: 10,
    paid_capacity: 20,
    vip_expire_at: null,
    vip_type: 0,
  });
  const ent = member.getUserEntitlement();
  assert.equal(ent.isVip, false);
  assert.equal(ent.permanentCapacity, 60);
  assert.equal(ent.effectiveCapacity, 60);
});

test('会员容量 = 500 + 邀请 + 已购（永久容量不被覆盖）', () => {
  const member = loadMember({
    free_capacity: 30,
    invite_capacity: 10,
    paid_capacity: 20,
    vip_expire_at: new Date(Date.now() + 86400000).toISOString(),
    vip_type: 1,
  });
  const ent = member.getUserEntitlement();
  assert.equal(ent.isVip, true);
  assert.equal(ent.memberCapacity, 530, '会员 500 + 邀请 10 + 已购 20');
  assert.equal(ent.effectiveCapacity, 530);
});

test('会员且无永久容量时仍为 500', () => {
  const member = loadMember({
    free_capacity: 30,
    invite_capacity: 0,
    paid_capacity: 0,
    vip_expire_at: new Date(Date.now() + 86400000).toISOString(),
    vip_type: 1,
  });
  const ent = member.getUserEntitlement();
  assert.equal(ent.effectiveCapacity, 500);
});
