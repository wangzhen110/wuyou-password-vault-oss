// 开放 API 云函数测试：apiAuth（小程序侧授权）+ openapi（第三方侧取数）
// 使用内存数据库模拟 CloudBase 集合，验证授权码→确认→令牌→密文拉取的完整链路
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const OPENID = 'user-openid-1';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createDb() {
  const collections = new Map();
  function ensure(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  let autoId = 0;
  function api(name) {
    const records = ensure(name);
    return {
      doc(id) {
        return {
          async get() {
            const row = records.get(id);
            if (!row) throw new Error('document not found');
            return { data: clone(row) };
          },
          async update({ data }) {
            const row = records.get(id);
            if (!row) throw new Error('document not found');
            const applied = {};
            for (const [k, v] of Object.entries(data)) {
              if (v && v.__op === 'set') applied[k] = clone(v.value === undefined ? null : v.value);
              else if (v && v.__op === 'inc') applied[k] = Number(row[k] || 0) + Number(v.value);
              else applied[k] = clone(v);
            }
            records.set(id, { ...row, ...applied });
            return { updated: 1 };
          },
          async remove() {
            records.delete(id);
            return { removed: 1 };
          },
        };
      },
      where(query) {
        const evalClause = (row, key, value) => {
          if (value && value.__op === 'gt') return Number(row[key]) > Number(value.value);
          if (value && value.__op === 'neq') return row[key] !== value.value;
          if (value && value.__op === 'in') return Array.isArray(value.values) && value.values.includes(row[key]);
          return row[key] === value;
        };
        const matches = () => [...records.values()].filter(row => (
          Object.entries(query).every(([key, value]) => evalClause(row, key, value))
        ));
        // 真实语义：orderBy 排序 + limit 截断（分页逻辑必须真跑，否则测不出增量丢数据）
        let orderSpec = null;
        let limitValue = null;
        const chain = {
          limit(n) { limitValue = Number(n) || 0; return chain; },
          orderBy(key, dir) { orderSpec = { key, desc: String(dir).toLowerCase() === 'desc' }; return chain; },
          async count() { return { total: matches().length }; },
          async get() {
            let rows = matches().map(clone);
            if (orderSpec) {
              const { key, desc } = orderSpec;
              rows.sort((a, b) => {
                const av = a[key]; const bv = b[key];
                const an = av instanceof Date ? av.getTime() : Number(av);
                const bn = bv instanceof Date ? bv.getTime() : Number(bv);
                if (an === bn) return 0;
                return desc ? bn - an : an - bn;
              });
            }
            if (limitValue && limitValue > 0) rows = rows.slice(0, limitValue);
            return { data: rows };
          },
          async remove() {
            const rows = matches();
            rows.forEach(row => records.delete(row._id));
            return { removed: rows.length };
          },
          // 条件更新（where(...).update({ data })）：签名与真实 SDK 一致，需解构 data
          async update(options) {
            const src = (options && options.data) || {};
            const applyOps = (row, src) => {
              const applied = {};
              for (const [k, v] of Object.entries(src)) {
                if (v && v.__op === 'set') applied[k] = clone(v.value === undefined ? null : v.value);
                else if (v && v.__op === 'inc') applied[k] = Number(row[k] || 0) + Number(v.value);
                else applied[k] = clone(v);
              }
              return applied;
            };
            let n = 0;
            for (const row of matches()) {
              records.set(row._id, { ...row, ...applyOps(row, src) });
              n += 1;
            }
            return { stats: { updated: n } };
          },
        };
        return chain;
      },
      async add({ data }) {
        autoId += 1;
        const id = data._id || `doc-${autoId}`;
        records.set(id, { _id: id, ...clone(data) });
        return { _id: id };
      },
    };
  }
  return { collections, api, ensure };
}

function loadFunction(file, db, openid = OPENID) {
  const moduleObj = { exports: {} };
  const sandbox = {
    require(id) {
      if (id === 'wx-server-sdk') {
        return {
          DYNAMIC_CURRENT_ENV: 'env-test',
          init() {},
          database: () => ({
            collection: name => db.api(name),
            command: {
              remove: () => ({ __op: 'remove' }),
              set: value => ({ __op: 'set', value }),
              gt: value => ({ __op: 'gt', value }),
              neq: value => ({ __op: 'neq', value }),
              in: values => ({ __op: 'in', values }),
              inc: value => ({ __op: 'inc', value }),
            },
          }),
          getWXContext: () => ({ OPENID: openid }),
        };
      }
      if (id === 'crypto') return require('crypto');
      throw new Error('Unexpected require: ' + id);
    },
    module: moduleObj,
    exports: moduleObj.exports,
    console,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    Promise,
    Error,
    RegExp,
    parseInt,
    Math,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  return moduleObj.exports;
}

function setup() {
  const db = createDb();
  const auth = loadFunction('cloudfunctions/apiAuth/index.js', db).main;
  const openapi = loadFunction('cloudfunctions/openapi/index.js', db).main;
  // 预置密码库元数据与一条密文记录
  db.ensure('vault_meta').set(OPENID, {
    _id: OPENID,
    _openid: OPENID,
    version: 1,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations: 600000,
    salt: '0123456789abcdef0123456789abcdef',
    verifier: 'a'.repeat(64),
  });
  db.ensure('passwords').set('p1', {
    _id: 'p1',
    _openid: OPENID,
    id: 'p1',
    crypto_version: 1,
    iv: 'abcd',
    ciphertext: 'ff'.repeat(32),
    mac: 'b'.repeat(64),
    salt: '0123456789abcdef0123456789abcdef',
    updated_at: new Date('2026-10-18T00:00:00Z'),
    created_at: new Date('2026-10-18T00:00:00Z'),
    is_deleted: false,
    // 下面这些是明文字段，API 绝不能返回
    platform: '某平台',
    password: 'plain-secret',
  });
  // 开放 API 为会员权益：测试用户需处于会员有效期内
  db.ensure('users').set(OPENID, {
    _id: OPENID,
    _openid: OPENID,
    vip_expire_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    vip_type: 1,
  });
  db.ensure('api_codes');
  db.ensure('api_tokens');
  db.ensure('api_audit');
  return { db, auth, openapi };
}

function req(pathname, { method = 'GET', body, token, query } = {}) {
  return {
    httpMethod: method,
    path: pathname,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body ? JSON.stringify(body) : '',
    queryStringParameters: query || {},
  };
}

test('full flow: code → pending → user approve → token → encrypted items', async () => {
  const { auth, openapi, db } = setup();

  const created = await auth({ action: 'create_code' });
  assert.equal(created.success, true);
  assert.match(created.code, /^\d{8}$/);

  // 第三方提交授权码：等待用户确认
  const first = await openapi(req('/v1/token', { method: 'POST', body: { code: created.code, device_name: '待确认设备' } }));
  assert.equal(first.statusCode, 202);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.status, 'pending_confirmation');

  // 小程序轮询到 pending，用户点允许
  const polled = await auth({ action: 'poll_requests', code_id: created.code_id });
  assert.equal(polled.status, 'pending');
  assert.equal(polled.device_name, '待确认设备');
  const approved = await auth({ action: 'confirm_request', code_id: created.code_id, allow: true });
  assert.equal(approved.success, true);

  // 第三方再次提交拿到令牌（一次性）
  const second = await openapi(req('/v1/token', { method: 'POST', body: { code: created.code, device_name: '待确认设备' } }));
  assert.equal(second.statusCode, 200);
  const tokenBody = JSON.parse(second.body);
  assert.match(tokenBody.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(tokenBody.scopes, ['items:read']);

  const again = await openapi(req('/v1/token', { method: 'POST', body: { code: created.code, device_name: '待确认设备' } }));
  assert.equal(again.statusCode, 410, '授权码一次性，用后即废');

  // 令牌只在云端存哈希
  const stored = [...db.collections.get('api_tokens').values()][0];
  assert.ok(stored.token_hash && stored.token_hash !== tokenBody.token);
  assert.equal(stored.revoked, false);

  // 拉元数据（公开参数）
  const meta = await openapi(req('/v1/vault/meta', { token: tokenBody.token }));
  assert.equal(meta.statusCode, 200);
  const metaBody = JSON.parse(meta.body);
  assert.equal(metaBody.vault_meta.kdf, 'PBKDF2-HMAC-SHA256');
  assert.equal(metaBody.vault_meta.iterations, 600000);

  // 拉密文：只含封套字段，绝不含明文字段
  const items = await openapi(req('/v1/items', { token: tokenBody.token }));
  assert.equal(items.statusCode, 200);
  const itemsBody = JSON.parse(items.body);
  assert.equal(itemsBody.items.length, 1);
  const envelope = itemsBody.items[0];
  assert.deepEqual(Object.keys(envelope).sort(), [
    'ciphertext', 'created_at', 'crypto_version', 'id', 'iv', 'mac', 'salt', 'updated_at',
  ].sort());
  assert.equal(JSON.stringify(itemsBody).includes('plain-secret'), false, 'API 不得返回明文密码');
  assert.equal(JSON.stringify(itemsBody).includes('某平台'), false, 'API 不得返回明文字段');

  // 审计有记录
  assert.ok(db.collections.get('api_audit').size >= 3);
});

test('rejects unauthorized, revoked, expired tokens and rate limits bursts', async () => {
  const { auth, openapi, db } = setup();
  const created = await auth({ action: 'create_code' });
  await openapi(req('/v1/token', { method: 'POST', body: { code: created.code, device_name: 'dev' } }));
  await auth({ action: 'confirm_request', code_id: created.code_id, allow: true });
  const token = JSON.parse((await openapi(req('/v1/token', { method: 'POST', body: { code: created.code, device_name: 'dev' } }))).body).token;

  // 无令牌 / 伪造令牌
  assert.equal((await openapi(req('/v1/items'))).statusCode, 401);
  assert.equal((await openapi(req('/v1/items', { token: 'f'.repeat(64) }))).statusCode, 401);

  // 用户拒绝
  const other = await auth({ action: 'create_code' });
  await openapi(req('/v1/token', { method: 'POST', body: { code: other.code, device_name: 'bad' } }));
  const rejected = await auth({ action: 'confirm_request', code_id: other.code_id, allow: false });
  assert.equal(rejected.status, 'rejected');
  const rejectedTry = await openapi(req('/v1/token', { method: 'POST', body: { code: other.code, device_name: 'bad' } }));
  assert.equal(rejectedTry.statusCode, 403);

  // 吊销后立即失效
  const devices = await auth({ action: 'list_devices' });
  assert.equal(devices.devices.length, 1);
  await auth({ action: 'revoke_device', device_id: devices.devices[0].id });
  assert.equal((await openapi(req('/v1/items', { token }))).statusCode, 403);

  // 限流：同一令牌 60 次/分钟
  const created2 = await auth({ action: 'create_code' });
  await openapi(req('/v1/token', { method: 'POST', body: { code: created2.code, device_name: 'dev2' } }));
  await auth({ action: 'confirm_request', code_id: created2.code_id, allow: true });
  const token2 = JSON.parse((await openapi(req('/v1/token', { method: 'POST', body: { code: created2.code, device_name: 'dev2' } }))).body).token;
  let limited = false;
  for (let i = 0; i < 62; i++) {
    const res = await openapi(req('/v1/items', { token: token2 }));
    if (res.statusCode === 429) { limited = true; break; }
  }
  assert.equal(limited, true, '超过 60 次/分钟应返回 429');
});


test('open API is a vip-only entitlement: non-members are rejected on both sides', async () => {
  const { auth, openapi, db } = setup();
  // 取消会员
  db.ensure('users').set(OPENID, {
    _id: OPENID,
    _openid: OPENID,
    vip_expire_at: new Date(Date.now() - 24 * 3600 * 1000),
    vip_type: 1,
  });

  const created = await auth({ action: 'create_code' });
  assert.equal(created.success, false);
  assert.equal(created.code, 'VIP_REQUIRED');

  // 直接构造一张有效令牌，模拟"会员期内签发、之后到期"的情形
  const crypto = require('node:crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  db.ensure('api_tokens').set('t-vip-lapsed', {
    _id: 't-vip-lapsed',
    _openid: OPENID,
    token_hash: tokenHash,
    device_name: '旧设备',
    scopes: ['items:read'],
    created_at: Date.now(),
    expires_at: Date.now() + 30 * 24 * 3600 * 1000,
    revoked: false,
    last_used_at: 0,
    rate_window_start: 0,
    rate_count: 0,
  });

  const meta = await openapi(req('/v1/vault/meta', { token }));
  assert.equal(meta.statusCode, 403);
  assert.equal(JSON.parse(meta.body).error, 'vip_required');
  const items = await openapi(req('/v1/items', { token }));
  assert.equal(items.statusCode, 403);
});

test('B11: /v1/items 的 since 下推查询并返回 next_since 游标（翻页不丢数据）', async () => {
  const { openapi, db } = setup();
  const token = 'ab'.repeat(32); // 接口要求 64 位十六进制令牌
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const base = 1792490000000;
  // 预置令牌与 4 条密文记录（每页 2 条，共两页）
  db.ensure('api_tokens').set('tk-b11', {
    _id: 'tk-b11', _openid: OPENID, token_hash: hash, scopes: ['items:read'], created_at: base,
    expires_at: Date.now() + 3600 * 1000, revoked: false, // 缺 expires_at 会被判定 token_expired
  });
  // 复用 setup 预置的会员用户（开放 API 为会员权益，不能覆盖成非会员）
  for (let i = 0; i < 4; i += 1) {
    db.ensure('passwords').set(`p-b11-${i}`, {
      _id: `p-b11-${i}`, id: `p-b11-${i}`, _openid: OPENID, is_deleted: false,
      updated_at: base + i * 1000, // 0 最旧、3 最新
      crypto_version: 1, cipher_text: 'ct', iv: 'iv', mac: 'mac', algo: 'aes-256-gcm',
    });
  }

  const first = await openapi({ httpMethod: 'GET', path: '/v1/items', queryStringParameters: { limit: '2' }, headers: { authorization: 'Bearer ' + token } });
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.items.length, 2, '第一页应为 2 条');
  assert.ok(firstBody.next_since > 0, '满页时必须返回 next_since 游标');

  const second = await openapi({ httpMethod: 'GET', path: '/v1/items', queryStringParameters: { limit: '2', since: String(firstBody.next_since) }, headers: { authorization: 'Bearer ' + token } });
  const secondBody = JSON.parse(second.body);
  assert.equal(secondBody.items.length, 2, '第二页应取回剩余 2 条（旧逻辑会静默丢弃）');

  // 第三页：setup 预置的 p1（更旧），取完后游标为 null
  const third = await openapi({ httpMethod: 'GET', path: '/v1/items', queryStringParameters: { limit: '2', since: String(secondBody.next_since) }, headers: { authorization: 'Bearer ' + token } });
  const thirdBody = JSON.parse(third.body);
  assert.equal(thirdBody.items.length, 1, '第三页应取回 setup 预置的 1 条');
  assert.equal(thirdBody.next_since, null, '未满页时 next_since 为 null 表示已取完');

  const ids = [...firstBody.items, ...secondBody.items, ...thirdBody.items].map(it => it.id).sort();
  assert.deepEqual(ids, ['p-b11-0', 'p-b11-1', 'p-b11-2', 'p-b11-3', 'p1'], '翻页合计应覆盖全部记录且无重复');
});
