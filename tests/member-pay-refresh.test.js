const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const MEMBER_PATH = path.join(__dirname, '..', 'miniprogram', 'utils', 'member.js');

function loadMemberHarness({
  statusResults,
  user,
  throwOnStatusCall = false,
  noPayFunctionCallback = false,
  noPaymentCallback = false,
  noStatusCallback = false,
  noRefreshCallback = false,
  paymentCancelled = false,
  pendingOrderNo = 'PWD202610010001',
  noDiscoveryCallback = false,
}) {
  const calls = [];
  const stored = {};
  let refreshCalls = 0;
  const pendingTimeouts = [];

  global.getApp = () => ({
    refreshUserInfo(callback) {
      refreshCalls++;
      if (noRefreshCallback) return;
      callback({ success: true, user });
    },
  });
  global.wx = {
    setStorageSync(key, value) { stored[key] = value; },
    getStorageSync(key) { return stored[key] || ''; },
    removeStorageSync(key) { delete stored[key]; },
    cloud: {
      callFunction(options) {
        calls.push(options);
        if (noPayFunctionCallback && !options.data.action) return;
        if (noDiscoveryCallback && options.data.action === 'order_status' && !options.data.out_trade_no) return;
        if (throwOnStatusCall && options.data.action === 'order_status' && options.data.out_trade_no) {
          throw new Error('status call setup failed');
        }
        if (noStatusCallback && options.data.action === 'order_status' && options.data.out_trade_no) return;
        let result;
        if (options.data.action === 'order_status' && !options.data.out_trade_no) {
          result = { success: true, out_trade_no: pendingOrderNo };
        } else if (options.data.action === 'order_status' && options.data.out_trade_no) {
          result = statusResults.length
            ? statusResults.shift()
            : { success: true, paid: false };
        } else {
          result = {
            success: true,
            out_trade_no: 'PWD202610010001',
            signData: '{"offerId":"1450363281","outTradeNo":"PWD202610010001"}',
            paySig: 'paysig',
            signature: 'usersig',
            mode: 'short_series_goods',
          };
        }
        queueMicrotask(() => options.success({ result }));
      },
    },
    login(options) {
      queueMicrotask(() => options.success({ code: 'test-login-code' }));
    },
    requestVirtualPayment(options) {
      if (noPaymentCallback) return;
      if (paymentCancelled) {
        queueMicrotask(() => options.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' }));
        return;
      }
      queueMicrotask(() => options.success({}));
    },
  };
  global.setTimeout = (callback, delay) => {
    if (delay === 1500) {
      queueMicrotask(callback);
      return 0;
    }
    pendingTimeouts.push(callback);
    return pendingTimeouts.length;
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './storage' && parent.filename === MEMBER_PATH) return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  let member;
  try {
    delete require.cache[MEMBER_PATH];
    member = require(MEMBER_PATH);
  } finally {
    Module._load = originalLoad;
  }

  return {
    requestPay: productId => member.requestPay(productId),
    recoverPendingOrder: outTradeNo => member.recoverPendingOrder(outTradeNo),
    calls,
    getRefreshCalls: () => refreshCalls,
    triggerTimeouts: () => {
      const callbacks = pendingTimeouts.splice(0);
      callbacks.forEach(callback => callback());
    },
  };
}

async function withMember(options, run) {
  const originals = { getApp: global.getApp, wx: global.wx, setTimeout: global.setTimeout };
  try {
    await run(loadMemberHarness({ statusResults: [], user: {}, ...options }));
  } finally {
    Object.assign(global, originals);
  }
}

function loadPageHarness(memberOverrides = {}) {
  let definition;
  const calls = { paid: [], recovered: [], modals: [], toasts: [] };
  const app = { globalData: { masterKey: {} } };
  const dependencies = {
    '../../utils/storage': { getAllPasswords: async () => [] },
    '../../styles/theme': { getThemeClass: () => '' },
    '../../utils/member': {
      getUserEntitlement: () => ({ paidCapacity: 0, permanentCapacity: 30 }),
      async requestPay(id) {
        calls.paid.push(id);
        return { success: false, cancelled: true, code: 'ORDER_PENDING', out_trade_no: 'PWD-CANCEL' };
      },
      async recoverPendingOrder(outTradeNo) {
        calls.recovered.push(outTradeNo);
        return { success: true, status: 'paid', out_trade_no: outTradeNo };
      },
      ...memberOverrides,
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/member/member.js'), 'utf8'), {
    Page: value => { definition = value; },
    getApp: () => app,
    require: id => dependencies[id],
    wx: {
      showToast: value => calls.toasts.push(value),
      showModal: value => calls.modals.push(value), showLoading: () => {}, hideLoading: () => {}, },
  });
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch); } };
  // 这些用例验证支付逻辑本身，按上线后（购买入口开放）状态运行
  page.data.payEnabled = true;
  return { page, calls };
}

const tests = [
  {
    name: 'recovers a cancelled payment using its original order without creating another payment',
    async run() {
      await withMember({ paymentCancelled: true, statusResults: [{ success: true, paid: true, status: 'paid' }] }, async harness => {
        const cancelled = await harness.requestPay('yearly_vip');
        assert.equal(cancelled.cancelled, true);
        const recovered = await harness.recoverPendingOrder(cancelled.out_trade_no);
        assert.equal(recovered.success, true);
        assert.equal(harness.calls.filter(call => !call.data.action).length, 1);
        assert.equal(harness.calls.at(-1).data.out_trade_no, cancelled.out_trade_no);
        assert.equal(harness.getRefreshCalls(), 1);
      });
    },
  },
  {
    name: 'discovers and recovers the server pending order after reopening the page',
    async run() {
      await withMember({ statusResults: [{ success: true, paid: true, status: 'paid' }] }, async harness => {
        const result = await harness.recoverPendingOrder();
        assert.equal(result.success, true);
        assert.deepEqual(harness.calls.map(call => call.data.action), ['order_status', 'order_status']);
        assert.equal(harness.calls[1].data.out_trade_no, 'PWD202610010001');
      });
    },
  },
  {
    name: 'reports no pending order without creating or querying a payment',
    async run() {
      await withMember({ pendingOrderNo: null }, async harness => {
        const result = await harness.recoverPendingOrder();
        assert.equal(result.code, 'NO_PENDING_ORDER');
        assert.equal(harness.calls.length, 1);
        assert.equal(harness.getRefreshCalls(), 0);
      });
    },
  },
  {
    name: 'stops polling and returns closed refunded and manual review states before any paid flag',
    async run() {
      for (const [status, code] of [['closed', 'ORDER_CLOSED'], ['refunded', 'ORDER_REFUNDED'], ['manual_review', 'REFUND_REQUIRES_MANUAL_REVIEW']]) {
        await withMember({ statusResults: [{ success: true, paid: true, status, code }] }, async harness => {
          const result = await harness.recoverPendingOrder('PWD1');
          assert.equal(result.success, false);
          assert.equal(result.status, status);
          assert.equal(result.code, code);
          assert.equal(result.out_trade_no, 'PWD1');
          assert.equal(harness.calls.length, 1);
          assert.equal(harness.getRefreshCalls(), 0);
        });
      }
    },
  },
  {
    name: 'does not hang when pending-order discovery never calls back',
    async run() {
      const nativeSetTimeout = global.setTimeout;
      await withMember({ noDiscoveryCallback: true }, async harness => {
        const pending = harness.recoverPendingOrder();
        harness.triggerTimeouts();
        const result = await Promise.race([pending, new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50))]);
        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(harness.calls.length, 1);
      });
    },
  },
  {
    name: 'member page retains the cancelled order and exposes a separate recovery action',
    async run() {
      const { page, calls } = loadPageHarness();
      await page.onPay();
      assert.equal(page.data.pendingOrderNo, 'PWD-CANCEL');
      assert.equal(page.data.paying, false);
      assert.match(page.data.orderStatusText, /待确认/);
      await page.onRecoverOrder();
      assert.deepEqual(calls.recovered, ['PWD-CANCEL']);
      assert.equal(calls.paid.length, 1);
      assert.equal(page.data.pendingOrderNo, '');
      assert.equal(page.data.recovering, false);
      assert.equal(calls.toasts.at(-1).title, '权益已到账');
    },
  },
  {
    name: 'member page recovery discovers an order on reentry and resets busy state after errors',
    async run() {
      const { page } = loadPageHarness({ recoverPendingOrder: async () => ({
        success: false,
        status: 'reconciliation_required',
        error: '订单状态仍在确认，请稍后重试',
      }) });
      await page.onRecoverOrder();
      assert.equal(page.data.recovering, false);
      assert.match(page.data.orderStatusText, /确认/);
    },
  },
  {
    name: 'member page shows terminal recovery states and prevents duplicate recovery calls',
    async run() {
      for (const [status, code, text] of [['closed', 'ORDER_CLOSED', /关闭/], ['refunded', 'ORDER_REFUNDED', /退款/], ['manual_review', 'REFUND_REQUIRES_MANUAL_REVIEW', /人工复核/]]) {
        let calls = 0;
        let finish;
        const { page } = loadPageHarness({ recoverPendingOrder: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
        const pending = page.onRecoverOrder();
        await page.onRecoverOrder();
        await page.onPay();
        assert.equal(calls, 1);
        finish({ success: false, status, code, out_trade_no: 'PWD1' });
        await pending;
        assert.match(page.data.orderStatusText, text);
        assert.equal(page.data.recovering, false);
      }
    },
  },
  {
    name: 'does not treat pre-existing capacity or membership as this order being paid',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      try {
        const harness = loadMemberHarness({
          statusResults: [],
          user: {
            paid_capacity: 50,
            vip_expire_at: new Date(Date.now() + 365 * 24 * 3600 * 1000),
          },
        });

        const result = await harness.requestPay('permanent_pack');

        assert.equal(result.success, false);
        assert.match(result.error, /确认中/);
        assert.equal(
          harness.calls.filter(call => call.data.action === 'order_status').length,
          6,
        );
        assert.equal(harness.getRefreshCalls(), 0);
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'reports success only when this order is paid and its entitlement was delivered',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      try {
        const harness = loadMemberHarness({
          statusResults: [
            { success: true, paid: false },
            { success: true, paid: true, status: 'paid' },
          ],
          user: { paid_capacity: 50 },
        });

        const result = await harness.requestPay('permanent_pack');

        assert.equal(result.success, true);
        assert.equal(harness.getRefreshCalls(), 1);
        assert.deepEqual(
          harness.calls
            .filter(call => call.data.action === 'order_status')
            .map(call => call.data.out_trade_no),
          ['PWD202610010001', 'PWD202610010001'],
        );
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'converts a synchronous order-status setup failure into a finite reconciliation result',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      const nativeSetTimeout = globalThis.setTimeout;
      const uncaught = [];
      const onUncaughtException = error => {
        uncaught.push(error);
      };
      process.on('uncaughtException', onUncaughtException);
      try {
        const harness = loadMemberHarness({
          statusResults: [],
          throwOnStatusCall: true,
          user: {},
        });

        const result = await Promise.race([
          harness.requestPay('permanent_pack'),
          new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50)),
        ]);

        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
        assert.equal(uncaught.length, 0);
      } finally {
        process.removeListener('uncaughtException', onUncaughtException);
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'does not leave the payment flow pending when requestPayment never calls back',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      const nativeSetTimeout = globalThis.setTimeout;
      try {
        const harness = loadMemberHarness({
          statusResults: [],
          noPaymentCallback: true,
          user: {},
        });
        const pending = harness.requestPay('permanent_pack');
        await new Promise(resolve => nativeSetTimeout(resolve, 0));
        harness.triggerTimeouts();

        const result = await Promise.race([
          pending,
          new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50)),
        ]);

        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
        assert.equal(result.out_trade_no, 'PWD202610010001');
        assert.equal(harness.getRefreshCalls(), 0);
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'does not leave the order query pending when the status callback never arrives',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      const nativeSetTimeout = globalThis.setTimeout;
      try {
        const harness = loadMemberHarness({
          statusResults: [],
          noStatusCallback: true,
          user: {},
        });
        const pending = harness.requestPay('permanent_pack');
        await new Promise(resolve => nativeSetTimeout(resolve, 0));
        harness.triggerTimeouts();

        const result = await Promise.race([
          pending,
          new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50)),
        ]);

        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
        assert.equal(result.out_trade_no, 'PWD202610010001');
        assert.equal(
          harness.calls.filter(call => call.data.action === 'order_status').length,
          1,
        );
        assert.equal(harness.getRefreshCalls(), 0);
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'does not report success when entitlement refresh never calls back',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      const nativeSetTimeout = globalThis.setTimeout;
      try {
        const harness = loadMemberHarness({
          statusResults: [{ success: true, paid: true, status: 'paid' }],
          noRefreshCallback: true,
          user: {},
        });
        const pending = harness.requestPay('permanent_pack');
        await new Promise(resolve => nativeSetTimeout(resolve, 0));
        harness.triggerTimeouts();

        const result = await Promise.race([
          pending,
          new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50)),
        ]);

        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
        assert.equal(result.out_trade_no, 'PWD202610010001');
        assert.equal(harness.getRefreshCalls(), 1);
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
    },
  },
  {
    name: 'does not leave the initial pay request pending when the cloud callback never arrives',
    async run() {
      const originals = {
        getApp: global.getApp,
        wx: global.wx,
        setTimeout: global.setTimeout,
      };
      const nativeSetTimeout = globalThis.setTimeout;
      try {
        const harness = loadMemberHarness({
          statusResults: [],
          noPayFunctionCallback: true,
          user: {},
        });
        const pending = harness.requestPay('permanent_pack');
        await new Promise(resolve => nativeSetTimeout(resolve, 0));
        harness.triggerTimeouts();

        const result = await Promise.race([
          pending,
          new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 50)),
        ]);

        assert.notEqual(result, 'timed out');
        assert.equal(result.success, false);
        assert.equal(result.code, 'PAYMENT_STATUS_UNKNOWN');
        assert.equal(harness.calls.length, 1);
      } finally {
        global.getApp = originals.getApp;
        global.wx = originals.wx;
        global.setTimeout = originals.setTimeout;
      }
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
