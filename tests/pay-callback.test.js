const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const CALLBACK_FUNCTION = path.join(__dirname, '..', 'cloudfunctions', 'payCallback', 'index.js');
const OUT_TRADE_NO = 'PWD202609300001';
const SUB_MCH_ID = '1746458484';

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function createHarness({
  order = {},
  existingOrders = [],
  user = {},
  existingUsers = [],
  payment = {},
  failCommit = false,
  failPaymentQuery = false,
  rejectTransactionQueries = false,
} = {}) {
  let shouldFailCommit = failCommit;
  const defaultOrder = {
    _id: 'order-doc',
    _openid: 'user-1',
    out_trade_no: OUT_TRADE_NO,
    product_id: 'permanent_pack',
    total_fee: 990,
    status: 'pending',
    ...clone(order),
  };
  const orders = new Map([['order-doc', defaultOrder]]);
  existingOrders.forEach((record, index) => {
    const id = record._id || `existing-order-${index}`;
    orders.set(id, {
      ...defaultOrder,
      ...clone(record),
      _id: id,
    });
  });

  const defaultUser = {
    _id: 'user-doc',
    _openid: 'user-1',
    free_capacity: 30,
    invite_capacity: 0,
    paid_capacity: 0,
    vip_expire_at: null,
    vip_type: 0,
    ...clone(user),
  };
  const users = new Map([['user-doc', defaultUser]]);
  existingUsers.forEach((record, index) => {
    const id = record._id || `existing-user-${index}`;
    users.set(id, {
      ...defaultUser,
      ...clone(record),
      _id: id,
    });
  });

  let collections = new Map([
    ['orders', orders],
    ['users', users],
  ]);
  const queryCalls = [];
  let transactionWhereCalls = 0;

  function collectionApi(name, target, isTransaction) {
    if (!target.has(name)) target.set(name, new Map());
    const records = target.get(name);
    return {
      doc(id) {
        return {
          async get() {
            return { data: clone(records.get(id) || null) };
          },
          async update({ data }) {
            const current = records.get(id);
            if (!current) throw new Error('document not found');
            if (Object.keys(data).length === 0) throw new Error('update data cannot be empty');
            const next = { ...current };
            for (const [key, value] of Object.entries(clone(data))) {
              if (value && value.__op === 'remove') delete next[key];
              else if (value && value.__op === 'set') next[key] = value.value;
              else next[key] = value;
            }
            records.set(id, next);
            return { updated: 1 };
          },
        };
      },
      where(query) {
        if (isTransaction) {
          transactionWhereCalls++;
          if (rejectTransactionQueries) {
            throw new Error('CloudBase transactions do not support where()');
          }
        }
        let limit = 20;
        return {
          limit(value) {
            limit = value;
            return this;
          },
          async get() {
            return {
              data: [...records.values()]
                .filter(record => Object.entries(query).every(([key, value]) => record[key] === value))
                .slice(0, limit)
                .map(clone),
            };
          },
        };
      },
      isTransaction,
    };
  }

  const db = {
    serverDate: () => new Date('2026-09-30T00:00:00.000Z'),
    command: {
      remove: () => ({ __op: 'remove' }),
      set: value => ({ __op: 'set', value }),
    },
    collection(name) {
      return collectionApi(name, collections, false);
    },
    async runTransaction(callback) {
      const staged = new Map(
        [...collections].map(([name, records]) => [
          name,
          new Map([...records].map(([id, record]) => [id, clone(record)])),
        ]),
      );
      const transaction = {
        collection(name) {
          return collectionApi(name, staged, true);
        },
      };
      const result = await callback(transaction);
      if (shouldFailCommit) throw new Error('simulated transaction commit failure');
      collections = staged;
      return result;
    },
  };

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    cloudPay: {
      async queryOrder(params) {
        queryCalls.push(clone(params));
        if (failPaymentQuery) throw new Error('simulated payment query failure');
        return clone(payment);
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[CALLBACK_FUNCTION];
  let main;
  try {
    main = require(CALLBACK_FUNCTION).main;
  } finally {
    Module._load = originalLoad;
  }

  return {
    main,
    queryCalls,
    getTransactionWhereCalls: () => transactionWhereCalls,
    setFailCommit(value) {
      shouldFailCommit = value;
    },
    getOrder: () => clone(collections.get('orders').get('order-doc')),
    getUser: (id = 'user-doc') => clone(collections.get('users').get(id)),
  };
}

function successfulPayment(overrides = {}) {
  return {
    returnCode: 'SUCCESS',
    resultCode: 'SUCCESS',
    tradeState: 'SUCCESS',
    outTradeNo: OUT_TRADE_NO,
    totalFee: 990,
    subMchId: SUB_MCH_ID,
    openid: 'user-1',
    transactionId: 'wx-transaction-1',
    ...overrides,
  };
}

const tests = [
  {
    name: 'yearly vip purchase by an invitee within 30 days grants the inviter 3 extra months',
    async run() {
      const harness = createHarness({
        order: { product_id: 'yearly_vip', total_fee: 3900 },
        user: {
          invited_by: 'INVITER1',
          invited_at: new Date('2026-10-01T00:00:00.000Z'),
          vip_expire_at: null,
          vip_type: 0,
        },
        existingUsers: [{
          _id: 'inviter-doc',
          _openid: 'inviter-1',
          invite_code: 'INVITER1',
          invited_by: null,
          vip_expire_at: null,
          vip_type: 0,
        }],
        payment: successfulPayment({ totalFee: 3900 }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 0, result.errmsg);
      const inviter = harness.getUser('inviter-doc');
      assert.ok(inviter.vip_expire_at, '邀请人应获得会员');
      assert.equal(inviter.vip_type, 1);
      const days = (new Date(inviter.vip_expire_at).getTime() - Date.now()) / 86400000;
      assert.ok(days > 88 && days < 92, '邀请人应获得约 3 个月（90 天）会员，实际 ' + days.toFixed(1));
      assert.equal(harness.getUser('user-doc').referral_vip_rewarded, true, '同一被邀请人只奖励一次');
      assert.equal(harness.getUser('user-doc').pending_payment_order, undefined);
      assert.equal(harness.getOrder().status, 'paid');
    },
  },
  {
    name: 'invitee purchase outside the 30-day window grants no inviter reward',
    async run() {
      const harness = createHarness({
        order: { product_id: 'yearly_vip', total_fee: 3900 },
        user: {
          invited_by: 'INVITER1',
          invited_at: new Date('2026-06-01T00:00:00.000Z'),
          vip_expire_at: null,
          vip_type: 0,
        },
        existingUsers: [{
          _id: 'inviter-doc',
          _openid: 'inviter-1',
          invite_code: 'INVITER1',
          invited_by: null,
          vip_expire_at: null,
          vip_type: 0,
        }],
        payment: successfulPayment({ totalFee: 3900 }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(result.errcode, 0, result.errmsg);
      assert.equal(harness.getUser('inviter-doc').vip_expire_at, null, '超出 30 天窗口不发奖励');
      assert.equal(harness.getUser('user-doc').referral_vip_rewarded, undefined);
    },
  },
  {
    name: 'keeps a delivered refund in manual review even if a later query reports success',
    async run() {
      const harness = createHarness({
        order: { status: 'paid', entitlement_delivered_at: new Date(), payment_state: 'REFUND', refund_review_status: 'manual_review_required', entitlement_status: 'frozen' },
        user: { paid_capacity: 30 },
        payment: successfulPayment(),
      });
      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(result.errcode, 1);
      assert.equal(result.errmsg, 'REFUND_REQUIRES_MANUAL_REVIEW');
      assert.equal(harness.getOrder().entitlement_status, 'frozen');
      assert.equal(harness.getUser().paid_capacity, 30);
    },
  },
  {
    name: 'does not deliver from client-supplied success fields when the queried trade is unpaid',
    async run() {
      const harness = createHarness({
        payment: successfulPayment({ resultCode: 'FAIL', tradeState: 'NOTPAY' }),
      });
      await harness.main({
        returnCode: 'SUCCESS',
        outTradeNo: OUT_TRADE_NO,
        return_code: 'SUCCESS',
        out_trade_no: OUT_TRADE_NO,
        result_code: 'SUCCESS',
      });
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
      assert.equal(harness.queryCalls.length, 1);
    },
  },
  {
    name: 'fails closed when the callback order number matches duplicate order records',
    async run() {
      const harness = createHarness({
        existingOrders: [{
          out_trade_no: OUT_TRADE_NO,
          status: 'pending',
        }],
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 1);
      assert.equal(result.errmsg, 'ORDER_NOT_FOUND_OR_AMBIGUOUS');
      assert.equal(harness.queryCalls.length, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'fails closed when the callback user lookup matches duplicate user records',
    async run() {
      const harness = createHarness({
        existingUsers: [{ _id: 'duplicate-user-doc', _openid: 'user-1' }],
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 1);
      assert.equal(result.errmsg, 'PROCESS_ERROR');
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'delivers a verified matching payment and marks fulfillment in the same transaction',
    async run() {
      const harness = createHarness({
        order: { out_trade_no: OUT_TRADE_NO },
        user: {
          pending_payment_order: { out_trade_no: OUT_TRADE_NO },
        },
        payment: successfulPayment(),
      });
      const result = await harness.main({
        return_code: 'SUCCESS',
        out_trade_no: OUT_TRADE_NO,
      });
      assert.equal(result.errcode, 0);
      assert.equal(harness.getUser().paid_capacity, 10);
      assert.equal(harness.getOrder().status, 'paid');
      assert.ok(harness.getOrder().entitlement_delivered_at);
      assert.equal(harness.getOrder().transaction_id, 'wx-transaction-1');
      assert.equal(harness.getUser().pending_payment_order, undefined); // 字段被删除而非置 null
      assert.equal(harness.queryCalls[0].outTradeNo, OUT_TRADE_NO);
      assert.equal(harness.queryCalls[0].subMchId, SUB_MCH_ID);
    },
  },
  {
    name: 'does not grant entitlement to an unmigrated user model',
    async run() {
      const harness = createHarness({
        user: {
          free_capacity: undefined,
          invite_capacity: undefined,
          paid_capacity: undefined,
          vip_expire_at: undefined,
          vip_type: undefined,
        },
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getOrder().entitlement_delivered_at, undefined);
      assert.equal(harness.getUser().paid_capacity, undefined);
      assert.equal(harness.queryCalls.length, 1);
    },
  },
  {
    name: 'does not clear a different pending order when delivering a legacy order',
    async run() {
      const pendingOrder = { out_trade_no: 'PWD202609300099' };
      const harness = createHarness({
        user: { pending_payment_order: pendingOrder },
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 0);
      assert.deepEqual(harness.getUser().pending_payment_order, pendingOrder);
    },
  },
  {
    name: 'uses only document operations to locate the user inside the transaction',
    async run() {
      const harness = createHarness({
        payment: successfulPayment(),
        rejectTransactionQueries: true,
      });
      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 0);
      assert.equal(harness.getTransactionWhereCalls(), 0);
      assert.equal(harness.getUser().paid_capacity, 10);
      assert.equal(harness.getOrder().status, 'paid');
    },
  },
  {
    name: 'rejects a queried amount that differs from the product price',
    async run() {
      const harness = createHarness({ payment: successfulPayment({ totalFee: 989 }) });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'keeps a callback retryable when the queried payment is still unpaid',
    async run() {
      const harness = createHarness({
        payment: successfulPayment({ tradeState: 'NOTPAY' }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'acknowledges terminal non-success payment states without granting entitlement',
    async run() {
      for (const tradeState of ['CLOSED', 'REVOKED', 'PAYERROR', 'REFUND']) {
        const harness = createHarness({
          user: {
            pending_payment_order: {
              out_trade_no: OUT_TRADE_NO,
              product_id: 'permanent_pack',
            },
          },
          payment: successfulPayment({ tradeState }),
        });

        const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

        assert.equal(result.errcode, 0, `${tradeState} is terminal`);
        assert.equal(
          harness.getOrder().status,
          tradeState === 'REFUND' ? 'refunded' : 'closed',
        );
        assert.equal(harness.getOrder().payment_state, tradeState);
        assert.equal(harness.getUser().pending_payment_order, undefined); // 字段被删除而非置 null
        assert.equal(harness.getUser().paid_capacity, 0);

        const duplicate = await harness.main({ out_trade_no: OUT_TRADE_NO });
        assert.equal(duplicate.errcode, 0, `${tradeState} duplicate is idempotent`);
        assert.equal(harness.queryCalls.length, 1);
      }
    },
  },
  {
    name: 'does not close an order from a mismatched terminal payment query',
    async run() {
      const pendingOrder = {
        out_trade_no: OUT_TRADE_NO,
        product_id: 'permanent_pack',
      };
      const harness = createHarness({
        user: { pending_payment_order: pendingOrder },
        payment: successfulPayment({
          outTradeNo: 'PWD202609300099',
          tradeState: 'CLOSED',
        }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.deepEqual(harness.getUser().pending_payment_order, pendingOrder);
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'terminal order reconciliation is atomic and retryable after transaction failure',
    async run() {
      const pendingOrder = {
        out_trade_no: OUT_TRADE_NO,
        product_id: 'permanent_pack',
      };
      const harness = createHarness({
        user: { pending_payment_order: pendingOrder },
        payment: successfulPayment({ tradeState: 'CLOSED' }),
        failCommit: true,
      });

      const first = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(first.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.deepEqual(harness.getUser().pending_payment_order, pendingOrder);

      harness.setFailCommit(false);
      const retried = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(retried.errcode, 0);
      assert.equal(harness.getOrder().status, 'closed');
      assert.equal(harness.getUser().pending_payment_order, undefined); // 字段被删除而非置 null
    },
  },
  {
    name: 'terminal reconciliation preserves a different pending user order',
    async run() {
      const pendingOrder = { out_trade_no: 'PWD202609300099' };
      const harness = createHarness({
        user: { pending_payment_order: pendingOrder },
        payment: successfulPayment({ tradeState: 'CLOSED' }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'closed');
      assert.deepEqual(harness.getUser().pending_payment_order, pendingOrder);
    },
  },
  {
    name: 'rejects an order whose stored price does not match its product',
    async run() {
      const harness = createHarness({
        order: { total_fee: 100 },
        payment: successfulPayment({ totalFee: 100 }),
      });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
      assert.equal(harness.queryCalls.length, 0);
    },
  },
  {
    name: 'rejects a verified payment bound to a different user',
    async run() {
      const harness = createHarness({ payment: successfulPayment({ openid: 'user-2' }) });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'rejects a different trade number or sub-merchant',
    async run() {
      for (const payment of [
        successfulPayment({ outTradeNo: 'PWD202609300002' }),
        successfulPayment({ subMchId: 'another-merchant' }),
      ]) {
        const harness = createHarness({ payment });
        await harness.main({ out_trade_no: OUT_TRADE_NO });
        assert.equal(harness.getOrder().status, 'pending');
        assert.equal(harness.getUser().paid_capacity, 0);
      }
    },
  },
  {
    name: 'does not deliver an unknown product',
    async run() {
      const harness = createHarness({
        order: { product_id: 'unknown_product' },
        payment: successfulPayment(),
      });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
      assert.equal(harness.queryCalls.length, 0);
    },
  },
  {
    name: 'does not mark a capacity pack delivered when the one-time allowance is already used',
    async run() {
      const harness = createHarness({
        user: { paid_capacity: 30 },
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getOrder().entitlement_delivered_at, undefined);
      assert.equal(harness.getUser().paid_capacity, 30);
    },
  },
  {
    name: 'does not partially grant a capacity pack beyond the three-purchase ceiling',
    async run() {
      // 新规则：每次 +10、上限 30；25 条属越界状态，再 +10 会超上限 → 整单拒绝且不部分发放
      const harness = createHarness({
        user: { paid_capacity: 25 },
        payment: successfulPayment(),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getOrder().entitlement_delivered_at, undefined);
      assert.equal(harness.getUser().paid_capacity, 25);
    },
  },
  {
    name: 'does not deliver when the trusted payment query is unavailable',
    async run() {
      const harness = createHarness({ failPaymentQuery: true });
      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);
    },
  },
  {
    name: 'duplicate successful callbacks deliver the entitlement only once',
    async run() {
      const harness = createHarness({ payment: successfulPayment() });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getUser().paid_capacity, 10);
      assert.equal(harness.getOrder().status, 'paid');
      assert.ok(harness.getOrder().entitlement_delivered_at);
    },
  },
  {
    name: 'marks a delivered refund for manual review without revoking entitlement',
    async run() {
      const harness = createHarness({
        order: {
          status: 'paid',
          entitlement_delivered_at: new Date('2026-09-30T00:00:00.000Z'),
          transaction_id: 'wx-transaction-1',
        },
        user: { paid_capacity: 30 },
        payment: successfulPayment({
          tradeState: 'REFUND',
        }),
      });

      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });

      assert.equal(result.errcode, 1);
      assert.equal(result.errmsg, 'REFUND_REQUIRES_MANUAL_REVIEW');
      assert.equal(harness.getOrder().status, 'paid');
      assert.equal(harness.getOrder().payment_state, 'REFUND');
      assert.equal(harness.getOrder().refund_review_status, 'manual_review_required');
      assert.equal(harness.getOrder().entitlement_status, 'frozen');
      assert.ok(harness.getOrder().refund_detected_at);
      assert.equal(harness.getUser().paid_capacity, 30);
    },
  },
  {
    name: 'duplicate yearly membership callbacks extend the expiry only once',
    async run() {
      const expiry = new Date('2027-01-01T00:00:00.000Z');
      const harness = createHarness({
        order: {
          product_id: 'yearly_vip',
          total_fee: 3900,
        },
        user: { vip_expire_at: expiry },
        payment: successfulPayment({ totalFee: 3900 }),
      });
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      const deliveredExpiry = harness.getUser().vip_expire_at;
      await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(harness.getUser().vip_expire_at.getTime(), deliveredExpiry.getTime());
    },
  },
  {
    name: 'does not replay a legacy paid order whose delivery status is ambiguous',
    async run() {
      const harness = createHarness({
        order: { status: 'paid' },
        payment: successfulPayment({ totalFee: 990 }),
      });
      const result = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.notEqual(result.errcode, 0);
      assert.equal(harness.getOrder().status, 'paid');
      assert.equal(harness.getUser().paid_capacity, 0);
      assert.equal(harness.queryCalls.length, 0);
    },
  },
  {
    name: 'a transaction failure leaves order and entitlement unchanged so callback retry can deliver',
    async run() {
      const harness = createHarness({
        payment: successfulPayment(),
        failCommit: true,
      });
      const first = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.notEqual(first.errcode, 0);
      assert.equal(harness.getOrder().status, 'pending');
      assert.equal(harness.getUser().paid_capacity, 0);

      harness.setFailCommit(false);
      const retried = await harness.main({ out_trade_no: OUT_TRADE_NO });
      assert.equal(retried.errcode, 0);
      assert.equal(harness.getOrder().status, 'paid');
      assert.equal(harness.getUser().paid_capacity, 10);
    },
  },
];

(async () => {
  let failed = 0;
  for (const test of tests) {
    try {
      await test.run();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${test.name}`);
      console.error(error);
    }
  }
  console.log(`\nResult: ${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
