const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const FUNCTION_PATH = path.join(__dirname, '..', 'cloudfunctions', 'pay', 'index.js');
const FIXED_NOW = 1_798_761_600_000;

function createHarness({
  existingOrders = [],
  existingUsers = [],
  user = {},
  wxContext = { OPENID: 'user-1', ENV: 'wx-context-env' },
  unifiedOrderError,
  unifiedOrderGate,
  randomBytesImpl,
  transactionUser,
  callbackResult = { errcode: 0 },
  callbackError,
  onCallback,
  payment,
} = {}) {
  const orders = new Map(existingOrders.map((order, index) => [`existing-${index}`, { _id: `existing-${index}`, ...order }]));
  const defaultUser = {
    _id: 'user-doc',
    _openid: 'user-1',
    free_capacity: 30,
    invite_capacity: 0,
    paid_capacity: 0,
    vip_expire_at: null,
    vip_type: 0,
    ...user,
  };
  const users = new Map([['user-doc', defaultUser]]);
  existingUsers.forEach((record, index) => {
    const id = record._id || `existing-user-${index}`;
    users.set(id, { ...defaultUser, ...record, _id: id });
  });
  const unifiedOrderCalls = [];
  const callbackCalls = [];
  const queryCalls = [];
  let nextOrderId = 0;
  let transactionQueue = Promise.resolve();
  let signalUnifiedOrderStarted;
  const unifiedOrderStarted = new Promise(resolve => {
    signalUnifiedOrderStarted = resolve;
  });

  function collection(name) {
    const records = name === 'orders' ? orders : users;
    return {
      where(query) {
        let resultLimit = 20;
        let sortField = null;
        let sortOrder = 'asc';
        return {
          limit(value) {
            resultLimit = value;
            return this;
          },
          orderBy(field, order) {
            sortField = field;
            sortOrder = order === 'desc' ? 'desc' : 'asc';
            return this;
          },
          async get() {
            let data = [...records.values()]
              .filter(record => Object.entries(query).every(([key, value]) => record[key] === value))
              .map(record => ({ ...record }));
            if (sortField) {
              // 缺失排序字段的记录排在末尾（与真实数据库行为对齐）
              const present = data.filter(record => record[sortField] != null);
              const missing = data.filter(record => !(record[sortField] != null));
              present.sort((a, b) => {
                const av = a[sortField];
                const bv = b[sortField];
                const cmp = av < bv ? -1 : (av > bv ? 1 : 0);
                return sortOrder === 'desc' ? -cmp : cmp;
              });
              data = [...present, ...missing];
            }
            return {
              data: data.slice(0, resultLimit),
            };
          },
        };
      },
      async add({ data }) {
        const _id = `order-${++nextOrderId}`;
        orders.set(_id, { _id, ...data });
        return { _id };
      },
      doc(id) {
        return {
          async get() {
            return { data: records.get(id) ? { ...records.get(id) } : null };
          },
        };
      },
    };
  }

  const db = {
    collection,
    // db.command 的最小实现（pay 云函数用 command.set 整体替换字段）
    command: {
      set: value => value,
      inc: value => ({ __inc: value }),
      remove: () => null,
    },
    serverDate: () => new Date(FIXED_NOW),
    runTransaction(callback) {
      const transaction = transactionQueue.then(async () => {
        if (transactionUser) Object.assign(users.get('user-doc'), transactionUser);
        const stagedUsers = new Map([...users].map(([id, record]) => [id, { ...record }]));
        const stagedOrders = new Map([...orders].map(([id, record]) => [id, { ...record }]));
        const staged = {
          collection(name) {
            const records = name === 'orders' ? stagedOrders : stagedUsers;
            return {
              doc(id) {
                return {
                  async get() {
                    return { data: records.get(id) ? { ...records.get(id) } : null };
                  },
                  async set({ data }) {
                    records.set(id, { _id: id, ...data });
                    return { created: 1 };
                  },
                  async update({ data }) {
                    const current = records.get(id);
                    if (!current) throw new Error('document not found');
                    records.set(id, { ...current, ...data });
                    return { updated: 1 };
                  },
                };
              },
              async add({ data }) {
                const _id = `order-${++nextOrderId}`;
                stagedOrders.set(_id, { _id, ...data });
                return { _id };
              },
            };
          },
        };
        const result = await callback(staged);
        users.clear();
        for (const [id, record] of stagedUsers) users.set(id, record);
        orders.clear();
        for (const [id, record] of stagedOrders) orders.set(id, record);
        return result;
      });
      transactionQueue = transaction.catch(() => {});
      return transaction;
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
    init() {},
    database: () => db,
    getWXContext: () => ({ ...wxContext }),
    async callFunction(params) {
      callbackCalls.push(params);
      if (callbackError) throw callbackError;
      if (onCallback) await onCallback({ orders, users });
      return { result: payment ? await callbackMain(params.data) : callbackResult };
    },
    cloudPay: {
      async queryOrder(params) {
        queryCalls.push(params);
        return { ...payment };
      },
      async unifiedOrder(params) {
        unifiedOrderCalls.push({ ...params });
        signalUnifiedOrderStarted();
        if (unifiedOrderGate) await unifiedOrderGate;
        if (unifiedOrderError) throw unifiedOrderError;
        return { payment: { package: 'prepay_id=test' } };
      },
    },
  };

  const originalLoad = Module._load;
  const originalRandomBytes = crypto.randomBytes;
  if (randomBytesImpl) crypto.randomBytes = randomBytesImpl;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  let main;
  let callbackMain;
  try {
    delete require.cache[FUNCTION_PATH];
    main = require(FUNCTION_PATH).main;
    const callbackPath = path.join(__dirname, '..', 'cloudfunctions', 'payCallback', 'index.js');
    delete require.cache[callbackPath];
    callbackMain = require(callbackPath).main;
  } finally {
    Module._load = originalLoad;
    crypto.randomBytes = originalRandomBytes;
  }

  return {
    main,
    orders,
    users,
    unifiedOrderCalls,
    unifiedOrderStarted,
    callbackCalls,
    queryCalls,
  };
}

const tests = [
  {
    name: 'rejects paid capacity at or above the 3-pack cap before reserving',
    async run() {
      for (const paid_capacity of [30, 40, 50, 100]) {
        const harness = createHarness({ user: { paid_capacity } });
        const result = await harness.main({ product_id: 'permanent_pack' });
        assert.equal(result.code, 'PACK_LIMIT');
        assert.equal(harness.orders.size, 0);
        assert.equal(harness.users.get('user-doc').pending_payment_order, undefined);
        assert.equal(harness.unifiedOrderCalls.length, 0);
      }
    },
  },
  {
    name: 'rechecks paid capacity cap inside the reservation transaction',
    async run() {
      const harness = createHarness({ transactionUser: { paid_capacity: 30 } });
      const result = await harness.main({ product_id: 'permanent_pack' });
      assert.equal(result.code, 'PACK_LIMIT');
      assert.equal(harness.orders.size, 0);
      assert.equal(harness.users.get('user-doc').paid_capacity, 30);
      assert.equal(harness.users.get('user-doc').pending_payment_order, undefined);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'owned status queries reuse the real callback query and transaction to deliver only once',
    async run() {
      const outTradeNo = 'PWD202610170001';
      const harness = createHarness({
        existingOrders: [{ _openid: 'user-1', out_trade_no: outTradeNo, product_id: 'permanent_pack', total_fee: 990, status: 'pending' }],
        user: { pending_payment_order: { out_trade_no: outTradeNo } },
        payment: { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', outTradeNo, totalFee: 990, subMchId: '1746458484', openid: 'user-1', transactionId: 'wx-mock-transaction' },
      });
      for (let i = 0; i < 2; i++) {
        const result = await harness.main({ action: 'get_order_status', out_trade_no: outTradeNo, paid: true, total_fee: 1 });
        assert.equal(result.paid, true);
        assert.equal(result.status, 'paid');
        assert.equal(result.out_trade_no, outTradeNo);
      }
      assert.equal(harness.callbackCalls.length, 2);
      assert.deepEqual(harness.callbackCalls[0], { name: 'payCallback', data: { out_trade_no: outTradeNo } });
      assert.equal(harness.queryCalls.length, 2);
      assert.equal(harness.users.get('user-doc').paid_capacity, 10);
      assert.equal(harness.users.get('user-doc').pending_payment_order, null);
      assert.ok(harness.orders.get('existing-0').entitlement_delivered_at);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'rejects unowned invalid and ambiguous status queries before invoking the callback',
    async run() {
      for (const existingOrders of [
        [{ _openid: 'user-2', out_trade_no: 'PWD1' }],
        [{ _openid: 'user-1', out_trade_no: 'PWD1' }, { _openid: 'user-1', out_trade_no: 'PWD1' }],
      ]) {
        const harness = createHarness({ existingOrders });
        const result = await harness.main({ action: 'get_order_status', out_trade_no: 'PWD1' });
        assert.equal(result.success, false);
        assert.equal(harness.callbackCalls.length, 0);
      }
      const harness = createHarness();
      assert.equal((await harness.main({ action: 'get_order_status', out_trade_no: '../bad' })).success, false);
      assert.equal(harness.callbackCalls.length, 0);
    },
  },
  {
    name: 'rereads terminal and refund review states after callback reconciliation without reporting paid',
    async run() {
      for (const [patch, status, code] of [
        [{ status: 'closed', payment_state: 'CLOSED' }, 'closed', 'ORDER_CLOSED'],
        [{ status: 'refunded', payment_state: 'REFUND' }, 'refunded', 'ORDER_REFUNDED'],
        [{ status: 'paid', entitlement_delivered_at: new Date(), payment_state: 'REFUND', refund_review_status: 'manual_review_required', entitlement_status: 'frozen' }, 'manual_review', 'REFUND_REQUIRES_MANUAL_REVIEW'],
      ]) {
        const harness = createHarness({
          existingOrders: [{ _openid: 'user-1', out_trade_no: 'PWD1', status: 'pending' }],
          onCallback({ orders }) { Object.assign(orders.get('existing-0'), patch); },
          callbackResult: { errcode: code === 'REFUND_REQUIRES_MANUAL_REVIEW' ? 1 : 0 },
        });
        const result = await harness.main({ action: 'get_order_status', out_trade_no: 'PWD1' });
        assert.equal(result.paid, false);
        assert.equal(result.status, status);
        assert.equal(result.code, code);
      }
    },
  },
  {
    name: 'does not hide refund or frozen markers behind a paid delivery marker',
    async run() {
      for (const patch of [{ payment_state: 'REFUND' }, { refund_review_status: 'manual_review_required' }, { entitlement_status: 'frozen' }]) {
        const harness = createHarness({ existingOrders: [{ _openid: 'user-1', out_trade_no: 'PWD1', status: 'paid', entitlement_delivered_at: new Date(), ...patch }] });
        const result = await harness.main({ action: 'get_order_status', out_trade_no: 'PWD1' });
        assert.equal(result.paid, false);
        assert.equal(result.status, 'manual_review');
      }
    },
  },
  {
    name: 'returns a finite retryable status when callback invocation fails',
    async run() {
      const harness = createHarness({ callbackError: new Error('mock callback unavailable'), existingOrders: [{ _openid: 'user-1', out_trade_no: 'PWD1', status: 'pending' }] });
      const result = await harness.main({ action: 'get_order_status', out_trade_no: 'PWD1', paid: true });
      assert.equal(result.paid, false);
      assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
      assert.equal(harness.orders.get('existing-0').status, 'pending');
    },
  },
  {
    name: 'discovers only the current users pending order for recovery without creating a payment',
    async run() {
      const harness = createHarness({ existingOrders: [
        { _openid: 'user-2', out_trade_no: 'OTHER', status: 'pending' },
        { _openid: 'user-1', out_trade_no: 'MINE', status: 'pending' },
      ] });
      const result = await harness.main({ action: 'get_pending_order' });
      assert.equal(result.success, true);
      assert.equal(result.out_trade_no, 'MINE');
      assert.equal(harness.unifiedOrderCalls.length, 0);
      assert.equal(harness.orders.size, 2);
      const empty = await createHarness().main({ action: 'get_pending_order' });
      assert.equal(empty.success, true);
      assert.equal(empty.out_trade_no, null);
    },
  },
  {
    name: 'uses secure random values for a valid trade number and nonce without Math.random',
    async run() {
      const harness = createHarness();
      const originalRandom = Math.random;
      const originalNow = Date.now;
      Math.random = () => {
        throw new Error('Math.random must not be used for payment identifiers');
      };
      Date.now = () => Number.MAX_SAFE_INTEGER;

      let result;
      try {
        result = await harness.main({ product_id: 'permanent_pack' });
      } finally {
        Math.random = originalRandom;
        Date.now = originalNow;
      }

      assert.equal(result.success, true);
      assert.match(result.out_trade_no, /^[A-Za-z0-9_-]+$/);
      assert.ok(result.out_trade_no.length <= 32);
      assert.match(harness.unifiedOrderCalls[0].nonceStr, /^[A-Fa-f0-9]{32}$/);
      assert.equal(harness.unifiedOrderCalls[0].envId, 'wx-context-env');
      assert.equal(harness.orders.size, 1);
    },
  },
  {
    name: 'fails closed without a valid context environment before creating an order',
    async run() {
      const invalidContexts = [
        { OPENID: 'user-1' },
        { OPENID: 'user-1', ENV: undefined },
        { OPENID: 'user-1', ENV: '' },
        { OPENID: 'user-1', ENV: '   ' },
        { OPENID: 'user-1', ENV: 123 },
        { OPENID: 'user-1', ENV: null },
      ];

      for (const wxContext of invalidContexts) {
        const harness = createHarness({ wxContext });
        const userBefore = { ...harness.users.get('user-doc') };
        const result = await harness.main({ product_id: 'permanent_pack' });

        assert.equal(result.success, false);
        assert.equal(result.code, 'ENV_ID_UNAVAILABLE');
        assert.deepEqual([...harness.orders.values()], []);
        assert.deepEqual(harness.users.get('user-doc'), userBefore);
        assert.equal(harness.unifiedOrderCalls.length, 0);
      }

      const pendingOrder = {
        out_trade_no: 'PWD202609300005',
        product_id: 'permanent_pack',
      };
      const harness = createHarness({
        wxContext: { OPENID: 'user-1', ENV: '' },
        user: { pending_payment_order: pendingOrder },
        existingOrders: [{
          _openid: 'user-1',
          out_trade_no: pendingOrder.out_trade_no,
          product_id: pendingOrder.product_id,
          status: 'pending',
        }],
      });
      const ordersBefore = [...harness.orders.values()].map(order => ({ ...order }));
      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.code, 'ENV_ID_UNAVAILABLE');
      assert.deepEqual([...harness.orders.values()], ordersBefore);
      assert.deepEqual(harness.users.get('user-doc').pending_payment_order, pendingOrder);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'refuses to create a payment order for an unmigrated user model',
    async run() {
      const harness = createHarness({ user: { free_capacity: undefined } });
      const userBefore = { ...harness.users.get('user-doc') };

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_MODEL_MIGRATION_REQUIRED');
      assert.deepEqual([...harness.orders.values()], []);
      assert.deepEqual(harness.users.get('user-doc'), userBefore);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'fails closed when more than one user record matches the caller',
    async run() {
      const harness = createHarness({
        existingUsers: [{ _id: 'duplicate-user-doc', _openid: 'user-1' }],
      });

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_NOT_FOUND_OR_AMBIGUOUS');
      assert.equal(harness.orders.size, 0);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'fails closed when more than one pending order matches the caller',
    async run() {
      const harness = createHarness({
        existingOrders: [
          {
            _openid: 'user-1',
            out_trade_no: 'PWD202609300010',
            product_id: 'permanent_pack',
            status: 'pending',
          },
          {
            _openid: 'user-1',
            out_trade_no: 'PWD202609300011',
            product_id: 'permanent_pack',
            status: 'pending',
          },
        ],
      });

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'ORDER_NOT_FOUND_OR_AMBIGUOUS');
      assert.equal(result.out_trade_no, undefined);
      assert.equal(harness.unifiedOrderCalls.length, 0);
      assert.equal(harness.orders.size, 2);
    },
  },
  {
    name: 'retries an order number already present in the orders collection',
    async run() {
      const firstRandom = '01'.repeat(8);
      const secondRandom = '02'.repeat(8);
      const timestamp = FIXED_NOW.toString(36).toUpperCase();
      const existingTradeNo = `PWD${timestamp}${firstRandom}`;
      let orderRandomCalls = 0;
      const harness = createHarness({
        existingOrders: [{ out_trade_no: existingTradeNo, status: 'pending' }],
        randomBytesImpl(size) {
          if (size === 8) {
            orderRandomCalls++;
            return Buffer.from(orderRandomCalls === 1 ? firstRandom : secondRandom, 'hex');
          }
          return Buffer.alloc(size, 0xab);
        },
      });

      const originalNow = Date.now;
      Date.now = () => FIXED_NOW;
      let result;
      try {
        result = await harness.main({ product_id: 'permanent_pack' });
      } finally {
        Date.now = originalNow;
      }

      assert.equal(result.success, true);
      assert.notEqual(result.out_trade_no, existingTradeNo);
      assert.equal(result.out_trade_no, `PWD${timestamp}${secondRandom}`);
      assert.equal(orderRandomCalls, 2);
      assert.equal(harness.orders.size, 2);
    },
  },
  {
    name: 'stops after the bounded order-number collision retries',
    async run() {
      const collidingRandom = '03'.repeat(8);
      const timestamp = FIXED_NOW.toString(36).toUpperCase();
      let orderRandomCalls = 0;
      const harness = createHarness({
        existingOrders: [{
          out_trade_no: `PWD${timestamp}${collidingRandom}`,
          status: 'pending',
        }],
        randomBytesImpl(size) {
          if (size === 8) {
            orderRandomCalls++;
            return Buffer.from(collidingRandom, 'hex');
          }
          return Buffer.alloc(size, 0xab);
        },
      });

      const originalNow = Date.now;
      Date.now = () => FIXED_NOW;
      let result;
      try {
        result = await harness.main({ product_id: 'permanent_pack' });
      } finally {
        Date.now = originalNow;
      }

      assert.equal(result.success, false);
      assert.equal(orderRandomCalls, 5);
      assert.equal(harness.orders.size, 1);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'does not create an order when the secure random source fails',
    async run() {
      let randomCalls = 0;
      const harness = createHarness({
        randomBytesImpl(size) {
          randomCalls++;
          if (randomCalls === 1) return Buffer.alloc(size, 0xcd);
          throw new Error('secure random source unavailable');
        },
      });

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(randomCalls, 2);
      assert.equal(harness.orders.size, 0);
      assert.equal(harness.unifiedOrderCalls.length, 0);
    },
  },
  {
    name: 'keeps an ambiguous CloudPay failure reserved for reconciliation',
    async run() {
      const harness = createHarness({ unifiedOrderError: new Error('network timeout') });

      const result = await harness.main({ product_id: 'permanent_pack' });
      const retry = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'ORDER_RECONCILIATION_REQUIRED');
      assert.ok(result.out_trade_no);
      assert.equal(harness.orders.size, 1);
      assert.ok(harness.users.get('user-doc').pending_payment_order);
      assert.equal(retry.code, 'PACK_ORDER_PENDING');
      assert.equal(harness.unifiedOrderCalls.length, 1);
    },
  },
  {
    name: 'does not create a second permanent-pack order while one is pending',
    async run() {
      const harness = createHarness({
        existingOrders: [{
          _openid: 'user-1',
          out_trade_no: 'PWD202609300002',
          product_id: 'permanent_pack',
          status: 'pending',
        }],
      });

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'PACK_ORDER_PENDING');
      assert.equal(result.out_trade_no, 'PWD202609300002');
      assert.equal(harness.unifiedOrderCalls.length, 0);
      assert.equal(harness.orders.size, 1);
    },
  },
  {
    name: 'returns the reserved trade number when the user order slot is pending',
    async run() {
      const harness = createHarness({
        user: {
          pending_payment_order: {
            out_trade_no: 'PWD202609300004',
            product_id: 'yearly_vip',
          },
        },
      });

      const result = await harness.main({ product_id: 'permanent_pack' });

      assert.equal(result.success, false);
      assert.equal(result.code, 'PACK_ORDER_PENDING');
      assert.equal(result.out_trade_no, 'PWD202609300004');
      assert.equal(harness.unifiedOrderCalls.length, 0);
      assert.equal(harness.orders.size, 0);
    },
  },
  {
    name: 'serializes concurrent permanent-pack order creation per user',
    async run() {
      let releaseUnifiedOrder;
      const unifiedOrderGate = new Promise(resolve => {
        releaseUnifiedOrder = resolve;
      });
      const harness = createHarness({ unifiedOrderGate });

      const firstPromise = harness.main({ product_id: 'permanent_pack' });
      await harness.unifiedOrderStarted;
      const second = await harness.main({ product_id: 'permanent_pack' });
      releaseUnifiedOrder();
      const first = await firstPromise;

      assert.equal(first.success, true);
      assert.equal(second.success, false);
      assert.equal(second.code, 'PACK_ORDER_PENDING');
      assert.equal(harness.unifiedOrderCalls.length, 1);
      assert.equal(harness.orders.size, 1);
    },
  },
  {
    name: 'reserves the order and user slot before calling CloudPay',
    async run() {
      let releaseUnifiedOrder;
      const unifiedOrderGate = new Promise(resolve => {
        releaseUnifiedOrder = resolve;
      });
      const harness = createHarness({ unifiedOrderGate });

      const firstPromise = harness.main({ product_id: 'permanent_pack' });
      await harness.unifiedOrderStarted;

      assert.equal(harness.orders.size, 1);
      assert.ok(harness.users.get('user-doc').pending_payment_order);
      releaseUnifiedOrder();

      const result = await firstPromise;
      assert.equal(result.success, true);
      assert.equal(
        result.out_trade_no,
        harness.users.get('user-doc').pending_payment_order.out_trade_no,
      );
    },
  },
  {
    name: 'reports only an owned order with confirmed entitlement delivery as paid',
    async run() {
      const harness = createHarness({
        existingOrders: [{
          _openid: 'user-1',
          out_trade_no: 'PWD202609300003',
          status: 'pending',
        }],
      });

      const pending = await harness.main({
        action: 'get_order_status',
        out_trade_no: 'PWD202609300003',
      });
      assert.equal(pending.success, true);
      assert.equal(pending.paid, false);

      const [orderId] = harness.orders.keys();
      harness.orders.set(orderId, { ...harness.orders.get(orderId), status: 'paid' });
      const ambiguousPaid = await harness.main({
        action: 'get_order_status',
        out_trade_no: 'PWD202609300003',
      });
      assert.equal(ambiguousPaid.paid, false);

      harness.orders.set(orderId, {
        ...harness.orders.get(orderId),
        entitlement_delivered_at: new Date(FIXED_NOW),
      });
      const paid = await harness.main({
        action: 'get_order_status',
        out_trade_no: 'PWD202609300003',
      });
      assert.equal(paid.paid, true);

      const wrongOwnerHarness = createHarness({
        existingOrders: [{
          _openid: 'user-2',
          out_trade_no: 'PWD202609300003',
          status: 'paid',
          entitlement_delivered_at: new Date(FIXED_NOW),
        }],
      });
      const wrongOwner = await wrongOwnerHarness.main({
        action: 'get_order_status',
        out_trade_no: 'PWD202609300003',
      });
      assert.equal(wrongOwner.success, false);
      assert.equal(wrongOwner.paid, undefined);
    },
  },
  {
    name: 'does not silently select one of duplicate owned orders when reading status',
    async run() {
      const harness = createHarness({
        existingOrders: [
          {
            _openid: 'user-1',
            out_trade_no: 'PWD202609300012',
            status: 'paid',
            entitlement_delivered_at: new Date(FIXED_NOW),
          },
          {
            _openid: 'user-1',
            out_trade_no: 'PWD202609300012',
            status: 'pending',
          },
        ],
      });

      const result = await harness.main({
        action: 'get_order_status',
        out_trade_no: 'PWD202609300012',
      });

      assert.equal(result.success, false);
      assert.equal(result.code, 'ORDER_NOT_FOUND_OR_AMBIGUOUS');
      assert.equal(result.paid, undefined);
    },
  },
  {
    name: 'lists only the caller orders newest first without leaking identity or internals',
    async run() {
      const harness = createHarness({
        existingOrders: [
          { _openid: 'user-1', out_trade_no: 'PWDOLDA', product_id: 'permanent_pack', product_name: '永久容量补充包', total_fee: 990, status: 'paid', created_at: new Date(FIXED_NOW - 60000), paid_at: new Date(FIXED_NOW - 30000) },
          { _openid: 'user-1', out_trade_no: 'PWDNEWB', product_id: 'yearly_vip', product_name: '年度会员', total_fee: 3900, status: 'pending', created_at: new Date(FIXED_NOW) },
          { _openid: 'user-2', out_trade_no: 'OTHERX', product_id: 'permanent_pack', product_name: '永久容量补充包', total_fee: 990, status: 'paid', created_at: new Date(FIXED_NOW) },
        ],
      });
      const result = await harness.main({ action: 'list_orders' });
      assert.equal(result.success, true);
      // 仅本人订单，最新在前
      assert.deepEqual(result.orders.map(order => order.out_trade_no), ['PWDNEWB', 'PWDOLDA']);
      assert.equal(result.orders[0].status, 'pending');
      assert.equal(result.orders[1].status, 'paid');
      // 不泄露 openid / 事务号等内部字段
      const serialized = JSON.stringify(result.orders);
      assert.ok(!serialized.includes('_openid'));
      assert.ok(!serialized.includes('transaction_id'));
      // 空订单与未登录
      const empty = await createHarness().main({ action: 'list_orders' });
      assert.equal(empty.success, true);
      assert.deepEqual(empty.orders, []);
      const anon = await createHarness({ wxContext: {} }).main({ action: 'list_orders' });
      assert.equal(anon.success, false);
      assert.equal(anon.code, 'USER_NOT_AUTHENTICATED');
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
