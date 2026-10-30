const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const FUNCTION_PATH = path.join(__dirname, '..', 'cloudfunctions', 'invite', 'index.js');
const FIXED_NOW = new Date('2026-10-02T00:00:00.000Z');

async function withFrozenTime(now, callback) {
  const OriginalDate = global.Date;
  class FrozenDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(now.getTime());
      } else {
        super(...args);
      }
    }

    static now() {
      return now.getTime();
    }
  }

  global.Date = FrozenDate;
  try {
    return await callback();
  } finally {
    global.Date = OriginalDate;
  }
}

function cloneMap(records) {
  return new Map([...records].map(([id, record]) => [id, { ...record }]));
}

function createHarness({
  inviter = {},
  invitee = {},
  openid = 'invitee-openid',
  failInviteeUpdate = false,
} = {}) {
  const users = new Map([
    ['inviter-doc', {
      _id: 'inviter-doc',
      _openid: 'inviter-openid',
      invite_code: 'INVITER1',
      invited_by: null,
      invite_count: 0,
      free_capacity: 30,
      invite_capacity: 0,
      paid_capacity: 0,
      vip_expire_at: null,
      vip_type: 0,
      ...inviter,
    }],
    ['invitee-doc', {
      _id: 'invitee-doc',
      _openid: 'invitee-openid',
      created_at: FIXED_NOW,
      invite_code: 'INVITEE1',
      invited_by: null,
      invite_count: 0,
      free_capacity: 30,
      invite_capacity: 0,
      paid_capacity: 0,
      vip_expire_at: null,
      vip_type: 0,
      ...invitee,
    }],
  ]);
  const inviteRecords = new Map();
  let nextRecordId = 0;
  let transactionQueue = Promise.resolve();

  function makeCollection(name, userRecords = users, recordStore = inviteRecords, staged = false) {
    const records = name === 'users' ? userRecords : recordStore;
    return {
      where(query) {
        let resultLimit = 20;
        return {
          limit(value) {
            resultLimit = value;
            return this;
          },
          async get() {
            return {
              data: [...records.values()]
                .filter(record => Object.entries(query).every(([key, value]) => record[key] === value))
                .slice(0, resultLimit)
                .map(record => ({ ...record })),
            };
          },
        };
      },
      doc(id) {
        return {
          async get() {
            const data = records.get(id);
            return { data: data ? { ...data } : null };
          },
          async update({ data }) {
            if (staged && failInviteeUpdate && name === 'users' && id === 'invitee-doc') {
              throw new Error('simulated invitee update failure');
            }
            const current = records.get(id);
            if (!current) throw new Error('document not found');
            records.set(id, { ...current, ...data });
            return { updated: 1 };
          },
        };
      },
      async add({ data }) {
        const id = `invite-record-${++nextRecordId}`;
        records.set(id, { _id: id, ...data });
        return { _id: id };
      },
    };
  }

  const db = {
    collection(name) {
      // 建库事实改由服务端核验；默认视为已建库，个别用例可置 false
      if (name === 'vault_meta') {
        return {
          where() {
            return {
              limit() {
                return {
                  async get() {
                    return { data: global.__VAULT_META_EXISTS === false ? [] : [{ _openid: 'invitee-openid' }] };
                  },
                };
              },
            };
          },
        };
      }
      return makeCollection(name);
    },
    runTransaction(callback) {
      const pending = transactionQueue.then(async () => {
        const stagedUsers = cloneMap(users);
        const stagedRecords = cloneMap(inviteRecords);
        const transaction = {
          collection(name) {
            return makeCollection(name, stagedUsers, stagedRecords, true);
          },
        };
        const result = await callback(transaction);
        users.clear();
        for (const [id, record] of stagedUsers) users.set(id, record);
        inviteRecords.clear();
        for (const [id, record] of stagedRecords) inviteRecords.set(id, record);
        return result;
      });
      transactionQueue = pending.catch(() => {});
      return pending;
    },
  };

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: openid }),
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  let main;
  try {
    delete require.cache[FUNCTION_PATH];
    main = require(FUNCTION_PATH).main;
  } finally {
    Module._load = originalLoad;
  }

  return { main, users, inviteRecords };
}

const tests = [
  {
    name: 'refuses invite when the invitee has not created a vault yet',
    async run() {
      // 建库事实由服务端核验：本用例模拟"未创建密码库"
      global.__VAULT_META_EXISTS = false;
      try {
        await withFrozenTime(FIXED_NOW, async () => {
          const harness = createHarness();
          const result = await harness.main({ action: 'verify_invite', invite_code: 'INVITER1' });
          assert.equal(result.success, false);
          assert.equal(result.code, 'VAULT_NOT_READY');
          assert.equal(harness.users.get('invitee-doc').invite_capacity, 0);
          assert.equal(harness.users.get('inviter-doc').invite_count, 0);
          assert.equal(harness.inviteRecords.size, 0);
        });
      } finally {
        global.__VAULT_META_EXISTS = true;
      }
    },
  },
  {
    name: 'rejects an inviter with an unmigrated entitlement model without changing either user',
    async run() {
      const harness = createHarness({ inviter: { free_capacity: undefined } });
      const before = [...harness.users.values()].map(user => ({ ...user }));

      const result = await harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true });

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_MODEL_MIGRATION_REQUIRED');
      assert.deepEqual([...harness.users.values()], before);
      assert.equal(harness.inviteRecords.size, 0);
    },
  },
  {
    name: 'rejects an invitee with invalid entitlement values without granting a reward',
    async run() {
      const harness = createHarness({ invitee: { invite_capacity: -1 } });
      const before = [...harness.users.values()].map(user => ({ ...user }));

      const result = await harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true });

      assert.equal(result.success, false);
      assert.equal(result.code, 'USER_MODEL_INVALID');
      assert.deepEqual([...harness.users.values()], before);
      assert.equal(harness.inviteRecords.size, 0);
    },
  },
  {
    name: 'does not fabricate invite counts or capacity for an invalid user model',
    async run() {
      const harness = createHarness({ invitee: { invite_count: undefined } });

      const codeResult = await harness.main({ action: 'get_my_code' });
      const infoResult = await harness.main({ action: 'get_invite_info' });

      assert.equal(codeResult.success, false);
      assert.equal(codeResult.code, 'USER_MODEL_MIGRATION_REQUIRED');
      assert.equal(infoResult.success, false);
      assert.equal(infoResult.code, 'USER_MODEL_MIGRATION_REQUIRED');
    },
  },
  {
    name: 'atomically grants capacity to both users and records one successful invitation',
    async run() {
      const harness = createHarness();

      const result = await harness.main({ action: 'verify_invite', invite_code: 'inviter1', vault_ready: true });

      assert.equal(result.success, true);
      assert.equal(harness.users.get('inviter-doc').invite_count, 1);
      assert.equal(harness.users.get('inviter-doc').invite_capacity, 5);
      assert.equal(harness.users.get('invitee-doc').invited_by, 'INVITER1');
      assert.equal(harness.users.get('invitee-doc').invite_capacity, 5);
      assert.equal(harness.inviteRecords.size, 1);
      assert.equal([...harness.inviteRecords.values()][0].reward_value, 5);
    },
  },
  {
    name: 'grants 30-day vip instead of capacity once the inviter reaches three invites',
    async run() {
      await withFrozenTime(FIXED_NOW, async () => {
        // 2026-10-20 新规则：满 3 人后不再拒绝，继续有效邀请 → 邀请人每次获 30 天会员（被邀请人仍 +5）
        const harness = createHarness({
          inviter: {
            free_capacity: 10,
            invite_capacity: 15,
            invite_count: 3,
            vip_expire_at: null,
            vip_type: 0,
          },
        });

        const result = await harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true });

        assert.equal(result.success, true);
        assert.equal(harness.users.get('inviter-doc').invite_count, 4);
        assert.equal(harness.users.get('inviter-doc').invite_capacity, 15, '满 3 人后不再加容量');
        assert.equal(harness.users.get('inviter-doc').vip_type, 1);
        const vipStart = new Date('2026-10-02T00:00:00.000Z').getTime();
        const vipEnd = new Date(harness.users.get('inviter-doc').vip_expire_at).getTime();
        assert.equal(Math.round((vipEnd - vipStart) / 86400000), 30, '会员 30 天');
        assert.equal(harness.users.get('invitee-doc').invite_capacity, 5, '被邀请人仍 +5');
        assert.equal(harness.inviteRecords.size, 1);
      });
    },
  },
  {
    name: 'serializes concurrent attempts so the invitee receives one reward only',
    async run() {
      const harness = createHarness();

      const results = await Promise.all([
        harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true }),
        harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true }),
      ]);

      assert.equal(results.filter(result => result.success).length, 1);
      assert.equal(harness.users.get('inviter-doc').invite_count, 1);
      assert.equal(harness.users.get('inviter-doc').invite_capacity, 5);
      assert.equal(harness.users.get('invitee-doc').invite_capacity, 5);
      assert.equal(harness.inviteRecords.size, 1);
    },
  },
  {
    name: 'rolls back inviter reward if updating the invitee fails',
    async run() {
      const harness = createHarness({ failInviteeUpdate: true });
      const before = [...harness.users.values()].map(user => ({ ...user }));

      const result = await harness.main({ action: 'verify_invite', invite_code: 'INVITER1', vault_ready: true });

      assert.equal(result.success, false);
      assert.deepEqual([...harness.users.values()], before);
      assert.equal(harness.inviteRecords.size, 0);
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
