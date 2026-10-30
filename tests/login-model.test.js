const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const LOGIN_FUNCTION = path.join(__dirname, '..', 'cloudfunctions', 'login', 'index.js');

function createHarness({
  existingUser,
  existingUsers = [],
  wxContext = { OPENID: 'user-1' },
  errors = {},
} = {}) {
  const users = new Map();
  const counters = new Map();
  const seededUsers = existingUser ? [existingUser, ...existingUsers] : existingUsers;
  seededUsers.forEach((user, index) => {
    const _id = user._id || `user-${index + 1}`;
    users.set(_id, { ...user, _id });
  });
  let queryCount = 0;

  // 模拟 db.command.inc：update 时用 { __inc: n } 标记原子自增
  const command = {
    inc: (value) => ({ __inc: value }),
  };

  function applyPatch(doc, patch) {
    const next = { ...doc };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && typeof value === 'object' && typeof value.__inc === 'number'
        ? (Number(next[key]) || 0) + value.__inc
        : value;
    }
    return next;
  }

  const db = {
    command,
    collection(name) {
      assert.ok(name === 'users' || name === 'counters', `unexpected collection: ${name}`);
      const store = name === 'users' ? users : counters;
      return {
        where(query) {
          let resultLimit = 20;
          return {
            limit(value) {
              resultLimit = value;
              return this;
            },
            async get() {
              queryCount++;
              if (errors.get) throw errors.get;
              return {
                data: [...store.values()]
                  .filter(user => Object.entries(query).every(([key, value]) => user[key] === value))
                  .slice(0, resultLimit)
                  .map(user => ({ ...user })),
              };
            },
          };
        },
        async add({ data }) {
          if (name === 'users' && errors.add) throw errors.add;
          if (name === 'counters' && errors.counterAdd) throw errors.counterAdd;
          const _id = data._id || `user-${store.size + 1}`;
          if (store.has(_id)) throw new Error('duplicate key');
          store.set(_id, { _id, ...data });
          return { _id };
        },
        doc(id) {
          return {
            async update({ data }) {
              if (name === 'users' && errors.update) throw errors.update;
              if (name === 'counters' && errors.counterUpdate) throw errors.counterUpdate;
              const current = store.get(id);
              if (!current) return { updated: 0 };
              store.set(id, applyPatch(current, data));
              return { updated: 1 };
            },
          };
        },
      };
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({ ...wxContext }),
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[LOGIN_FUNCTION];
  let main;
  try {
    main = require(LOGIN_FUNCTION).main;
  } finally {
    Module._load = originalLoad;
  }

  return { main, users, counters, getQueryCount: () => queryCount };
}

const validUser = {
  _id: 'user-doc',
  _openid: 'user-1',
  free_capacity: 30,
  invite_capacity: 7,
  paid_capacity: 12,
  vip_expire_at: new Date(Date.now() + 86_400_000),
  vip_type: 1,
  invite_code: 'USER0001',
  invited_by: null,
  invite_count: 0,
  biometric_enabled: false,
};

const tests = [
  {
    name: 'returns a stable code when the trusted OpenID is unavailable',
    async run() {
      const harness = createHarness({ wxContext: { OPENID: '  ' } });

      const result = await harness.main({ openid: 'attacker-openid' });

      assert.deepEqual(result, {
        success: false,
        code: 'USER_ID_UNAVAILABLE',
        error: '获取用户身份失败',
      });
      assert.equal(harness.getQueryCount(), 0);
      assert.equal(harness.users.size, 0);
    },
  },
  {
    name: 'uses the authenticated OpenID instead of an event-supplied identity',
    async run() {
      const harness = createHarness();

      const result = await harness.main({ openid: 'attacker-openid' });

      assert.equal(result.success, true);
      assert.equal(result.openid, 'user-1');
      assert.equal([...harness.users.values()][0]._openid, 'user-1');
      assert.equal([...harness.users.values()].some(user => user._openid === 'attacker-openid'), false);
    },
  },
  {
    name: 'reads legacy fields only to reject unsafe migration without changing the document',
    async run() {
      const harness = createHarness({
        existingUser: {
          _id: 'user-doc',
          _openid: 'user-1',
          member_level: 1,
          member_expire_at: new Date(Date.now() + 86_400_000),
          last_active_at: new Date(0),
        },
      });
      const before = { ...harness.users.get('user-doc') };

      const result = await harness.main();

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_MODEL_MIGRATION_REQUIRED');
      assert.equal(result.error, '用户权益数据尚未完成迁移，暂无法登录云端');
      assert.deepEqual(harness.users.get('user-doc'), before);
    },
  },
  {
    name: 'rejects invalid entitlement values instead of defaulting them',
    async run() {
      const harness = createHarness({
        existingUser: { ...validUser, paid_capacity: '12', updated_at: new Date(0) },
      });
      const before = { ...harness.users.get('user-doc') };

      const result = await harness.main();

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_MODEL_INVALID');
      assert.deepEqual(harness.users.get('user-doc'), before);
    },
  },
  {
    name: 'returns exact capacity and VIP state for a valid current user model',
    async run() {
      const harness = createHarness({ existingUser: validUser });

      const result = await harness.main();

      assert.equal(result.success, true);
      assert.equal(result.capacity, 49);
      assert.equal(result.is_vip, true);
      assert.equal(result.user.paid_capacity, 12);
      assert.equal(result.openid, 'user-1');
    },
  },
  {
    name: 'creates a new user with the current complete entitlement model',
    async run() {
      const harness = createHarness();

      const result = await harness.main();

      assert.equal(result.success, true);
      assert.equal(result.capacity, 10);
      assert.equal(result.is_vip, false);
      assert.equal(result.user.free_capacity, 10);
      assert.equal(harness.users.size, 1);
    },
  },
  {
    name: 'does not select one record when the authenticated OpenID is duplicated',
    async run() {
      const harness = createHarness({
        existingUsers: [
          { ...validUser, _id: 'user-doc-a' },
          { ...validUser, _id: 'user-doc-b' },
        ],
      });
      const before = [...harness.users.values()].map(user => ({ ...user }));

      const result = await harness.main();

      assert.deepEqual(result, {
        success: false,
        code: 'USER_NOT_UNIQUE',
        error: '用户数据异常',
      });
      assert.deepEqual([...harness.users.values()], before);
    },
  },
  {
    name: 'keeps concurrent first login calls to one user record',
    async run() {
      const harness = createHarness();

      const results = await Promise.all([
        harness.main(),
        harness.main(),
      ]);

      assert.equal(results.filter(result => result.success).length, 2);
      assert.equal(results.filter(result => result.is_new_user).length, 1);
      assert.equal(harness.users.size, 1);
      assert.equal([...harness.users.values()][0]._openid, 'user-1');
    },
  },
  {
    name: 'returns a stable business error without exposing a database message',
    async run() {
      const harness = createHarness({
        errors: { get: new Error('sensitive database failure') },
      });
      const originalConsoleError = console.error;
      console.error = () => {};

      let result;
      try {
        result = await harness.main();
      } finally {
        console.error = originalConsoleError;
      }

      assert.deepEqual(result, {
        success: false,
        code: 'LOGIN_FAILED',
        error: '登录失败，请稍后重试',
      });
      assert.equal(JSON.stringify(result).includes('sensitive database failure'), false);
    },
  },
  {
    name: 'records last_active_at and counts the user once per day',
    async run() {
      const harness = createHarness({
        existingUser: { ...validUser, last_active_at: new Date(Date.now() - 3 * 86_400_000) },
      });

      const first = await harness.main();
      const second = await harness.main();

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      assert.ok(harness.users.get('user-doc').last_active_at instanceof Date);
      assert.equal(harness.counters.size, 1);
      const [key] = [...harness.counters.keys()];
      assert.match(key, /^dau_\d{4}-\d{2}-\d{2}$/);
      assert.equal(harness.counters.get(key).value, 1);
      assert.equal(harness.counters.get(key).date, key.slice(4));
    },
  },
  {
    name: 'skips the daily counter when the user was already active today',
    async run() {
      const harness = createHarness({
        existingUser: { ...validUser, last_active_at: new Date() },
      });

      const result = await harness.main();

      assert.equal(result.success, true);
      assert.equal(harness.counters.size, 0);
    },
  },
  {
    name: 'counts a brand new user on the day of registration',
    async run() {
      const harness = createHarness();

      const result = await harness.main();

      assert.equal(result.success, true);
      assert.ok(harness.users.get('user-1').last_active_at instanceof Date);
      assert.equal(harness.counters.size, 1);
      const [key] = [...harness.counters.keys()];
      assert.equal(harness.counters.get(key).value, 1);
    },
  },
  {
    name: 'keeps login successful when the daily counter cannot be written',
    async run() {
      const harness = createHarness({
        existingUser: { ...validUser, last_active_at: new Date(Date.now() - 86_400_000) },
        errors: {
          counterUpdate: new Error('counter write failed'),
          counterAdd: new Error('counter write failed'),
        },
      });
      const originalConsoleError = console.error;
      console.error = () => {};

      let result;
      try {
        result = await harness.main();
      } finally {
        console.error = originalConsoleError;
      }

      assert.equal(result.success, true);
      assert.equal(harness.counters.size, 0);
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
