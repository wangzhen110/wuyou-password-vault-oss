const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const SYNC_FUNCTION = path.join(__dirname, '..', 'cloudfunctions', 'sync', 'index.js');

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function createHarness({
  seed = {},
  failAddIds = [],
  failDownload = false,
  onDownloadPage = null,
  openid = 'authenticated-user',
} = {}) {
  const collections = new Map();
  // 配额校验需要 users 记录：测试默认给足容量，配额相关用例单独覆盖
  if (!seed.users) {
    seed = { ...seed, users: { [`user-${openid}`]: { _id: `user-${openid}`, _openid: openid, free_capacity: 1000 } } };
  }
  for (const [collection, records] of Object.entries(seed)) {
    collections.set(collection, new Map(Object.entries(records).map(([id, record]) => [id, clone(record)])));
  }

  const failures = new Set(failAddIds);
  const queries = [];
  const getCollection = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const matches = (record, query) => Object.entries(query).every(([field, expected]) => {
    const compare = (actual, boundary, operator) => {
      if (actual instanceof Date && boundary instanceof Date) {
        return operator === 'gt'
          ? actual.getTime() > boundary.getTime()
          : actual.getTime() <= boundary.getTime();
      }
      if (typeof actual === 'string' && typeof boundary === 'string') {
        return operator === 'gt' ? actual > boundary : actual <= boundary;
      }
      return false;
    };
    if (expected && expected.operator === 'and') {
      return expected.conditions.every(condition => (
        compare(record[field], condition.value, condition.operator)
      ));
    }
    if (expected && (expected.operator === 'gt' || expected.operator === 'lte')) {
      return compare(record[field], expected.value, expected.operator);
    }
    if (expected && expected.operator === 'neq') {
      return record[field] !== expected.value;
    }
    if (expected && expected.operator === 'in') {
      return expected.values.includes(record[field]);
    }
    return record[field] === expected;
  });

  const db = {
    command: {
      gt: value => ({ operator: 'gt', value }),
      lte: value => ({ operator: 'lte', value }),
      neq: value => ({ operator: 'neq', value }),
      in: values => ({ operator: 'in', values }),
      and: (...conditions) => ({ operator: 'and', conditions }),
    },
    serverDate: () => new Date('2026-09-30T00:00:00.000Z'),
    // 事务 mock：单线程顺序执行 get/update，行为与真实快照隔离一致（测试场景内足够）
    runTransaction(cb) {
      const t = {
        collection: (name) => ({
          doc: (id) => ({
            get: async () => ({ data: clone(getCollection(name).get(id) || null) }),
            update: async ({ data }) => {
              if (!getCollection(name).has(id)) throw new Error('document not found');
              getCollection(name).set(id, { ...getCollection(name).get(id), ...clone(data) });
              return { updated: 1 };
            },
          }),
        }),
      };
      return cb(t);
    },
    collection(name) {
      const records = getCollection(name);
      return {
        doc(id) {
          return {
            async get() {
              return { data: clone(records.get(id) || null) };
            },
            async set({ data }) {
              records.set(id, { ...clone(data), _id: id });
              return { _id: id };
            },
            async update({ data }) {
              if (!records.has(id)) throw new Error('document not found');
              records.set(id, { ...records.get(id), ...clone(data) });
              return { updated: 1 };
            },
          };
        },
        async add({ data }) {
          const id = data._id;
          if (failures.has(id)) throw new Error('simulated write failure');
          if (!id) throw new Error('expected server-selected document id');
          if (records.has(id)) throw new Error('duplicate document id');
          records.set(id, clone(data));
          return { _id: id };
        },
        where(query) {
          let offset = 0;
          let count = 20;
          const order = [];
          return {
            skip(value) {
              offset = value;
              return this;
            },
            limit(value) {
              count = value;
              return this;
            },
            orderBy(field, direction) {
              order.push({ field, direction });
              return this;
            },
            async count() {
              return { total: [...records.values()].filter(record => matches(record, query)).length };
            },
            async get() {
              queries.push({
                collection: name,
                query: clone(query),
                offset,
                limit: count,
                orderBy: clone(order),
              });
              if (failDownload && query.updated_at) {
                throw new Error('simulated download failure');
              }
              const compareValues = (left, right) => {
                if (left instanceof Date && right instanceof Date) {
                  return left.getTime() - right.getTime();
                }
                return left < right ? -1 : left > right ? 1 : 0;
              };
              const data = [...records.values()]
                .filter(record => matches(record, query))
                .sort((left, right) => {
                  for (const clause of order) {
                    const compared = compareValues(left[clause.field], right[clause.field]);
                    if (compared !== 0) {
                      return clause.direction === 'desc' ? -compared : compared;
                    }
                  }
                  return 0;
                })
                .slice(offset, offset + count)
                .map(clone);
              if (query.updated_at && typeof onDownloadPage === 'function') {
                await onDownloadPage({
                  collection: name,
                  query,
                  offset,
                  limit: count,
                  orderBy: clone(order),
                  records,
                });
              }
              return { data };
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
    getWXContext: () => ({ OPENID: openid }),
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[SYNC_FUNCTION];
  let main;
  try {
    main = require(SYNC_FUNCTION).main;
  } finally {
    Module._load = originalLoad;
  }

  return { main, collections, queries };
}

function envelope(id, updatedAt = '2026-09-29T12:00:00.000Z') {
  return {
    id,
    crypto_version: 1,
    updated_at: updatedAt,
    created_at: '2026-09-01T00:00:00.000Z',
    salt: 'a'.repeat(32),
    iv: 'b'.repeat(32),
    ciphertext: 'c'.repeat(32),
    mac: 'd'.repeat(64),
  };
}

async function clientEnvelope(id, updatedAt = '2026-09-29T12:00:00.000Z') {
  const originalWx = global.wx;
  global.wx = {
    getRandomValues({ length, success }) {
      const bytes = Uint8Array.from({ length }, (_, index) => index + 1);
      success({ randomValues: bytes.buffer });
    },
  };

  try {
    const crypto = require('../miniprogram/utils/crypto');
    const CryptoJS = require('../miniprogram/utils/crypto-js.min');
    const keys = {
      encryptionKey: CryptoJS.enc.Hex.parse('11'.repeat(32)),
      macKey: CryptoJS.enc.Hex.parse('22'.repeat(32)),
    };
    const meta = {
      crypto_version: 1,
      kdf: 'PBKDF2-HMAC-SHA256',
      iterations: 600000,
      salt: 'a'.repeat(32),
      verifier: 'b'.repeat(64),
    };
    return await crypto.encryptRecord({
      id,
      platform: 'client-format',
      password: 'encrypted-only',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: updatedAt,
    }, keys, meta);
  } finally {
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  }
}

function update(id, data = envelope(id), queueId = `queue-${id}`) {
  return {
    queue_id: queueId,
    id,
    collection: 'passwords',
    data,
  };
}

function validVaultMeta(overrides = {}) {
  return {
    version: 1,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations: 600000,
    salt: '0123456789abcdef0123456789abcdef',
    verifier: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ...overrides,
  };
}

const tests = [
  {
    name: 'accepts legacy envelopes without is_deleted (old clients must keep syncing)',
    async run() {
      const { main, collections } = createHarness();
      const legacy = envelope('legacy-1');
      delete legacy.is_deleted;
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('legacy-1', legacy)] });
      assert.equal(result.success, true);
      assert.equal(result.uploads_ok, 1);
      const saved = [...collections.get('passwords').values()][0];
      assert.equal(saved.id, 'legacy-1');
      assert.equal(saved.is_deleted, undefined);
    },
  },
  {
    name: 'persists the plaintext is_deleted flag so quota and open API can filter',
    async run() {
      const { main, collections } = createHarness();
      const tombstone = envelope('deleted-1');
      tombstone.is_deleted = true;
      const alive = envelope('alive-1');
      alive.is_deleted = false;
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update('deleted-1', tombstone, 'q-del'), update('alive-1', alive, 'q-alive')],
      });
      assert.equal(result.success, true);
      const docs = [...collections.get('passwords').values()];
      assert.equal(docs.find(doc => doc.id === 'deleted-1').is_deleted, true);
      assert.equal(docs.find(doc => doc.id === 'alive-1').is_deleted, false);
    },
  },
  {
    name: 'rejects a non-boolean is_deleted instead of trusting it',
    async run() {
      const { main } = createHarness();
      const bad = envelope('bad-flag');
      bad.is_deleted = 'true';
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('bad-flag', bad)] });
      assert.equal(result.success, false);
      assert.equal(result.upload_results[0].error, 'invalid_envelope');
    },
  },
  {
    name: 'caps a single batch to avoid blowing up the function',
    async run() {
      const { main } = createHarness();
      const many = [];
      for (let i = 0; i < 150; i++) many.push(update('bulk-' + i));
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: many });
      assert.equal(result.success, false);
      assert.equal(result.upload_results[0].error, 'BATCH_TOO_LARGE');
    },
  },

  {
    name: 'rotates metadata only with a matching old meta and preserves ciphertext',
    async run() {
      const oldMeta = validVaultMeta();
      const nextMeta = validVaultMeta({ salt: 'abcdef0123456789abcdef0123456789' });
      const { main, collections } = createHarness({
        seed: {
          vault_meta: { 'authenticated-user': { _id: 'authenticated-user', _openid: 'authenticated-user', ...oldMeta } },
          passwords: { 'keep-encrypted': { _id: 'keep-encrypted', _openid: 'authenticated-user', ...envelope('keep-encrypted') } },
        },
      });
      const before = JSON.stringify(Array.from(collections, ([name, values]) => [name, Array.from(values)]));

      // old meta 不匹配：拒绝且数据不动（防误操作/并发）
      const mismatch = await main({ action: 'rotate_vault_meta', old_vault_meta: validVaultMeta({ salt: 'ffffffffffffffffffffffffffffffff' }), vault_meta: nextMeta });
      assert.equal(mismatch.success, false);
      assert.equal(mismatch.error, 'vault_meta_mismatch');

      // old 匹配：允许换新，密文保持不变
      const rotated = await main({ action: 'rotate_vault_meta', old_vault_meta: oldMeta, vault_meta: nextMeta });
      assert.equal(rotated.success, true);
      assert.deepEqual(rotated.vault_meta, nextMeta);
      const fetched = await main({ action: 'get_vault_meta' });
      assert.deepEqual(fetched.vault_meta, nextMeta);
      assert.equal(collections.get('passwords').get('keep-encrypted').nonce, envelope('keep-encrypted').nonce,
        '轮换只换元数据，密文必须原样保留');
      const after = JSON.stringify(Array.from(collections, ([name, values]) => [name, Array.from(values)]));
      assert.notEqual(after, before);
    },
  },
  {
    name: 'rotation without an existing vault meta is rejected (use set_vault_meta first)',
    async run() {
      const { main } = createHarness();
      const rotated = await main({
        action: 'rotate_vault_meta',
        old_vault_meta: validVaultMeta(),
        vault_meta: validVaultMeta({ salt: 'abcdef0123456789abcdef0123456789' }),
      });
      assert.equal(rotated.success, false);
      assert.equal(rotated.error, 'vault_meta_not_found');
    },
  },
  {
    name: 'a repeated full sync keeps one document and one downloaded record',
    async run() {
      const { main, collections } = createHarness();
      for (let index = 0; index < 2; index++) {
        const result = await main({ client_version: '4.3.7', action: 'full_sync', local_updates: [update('saved-once')] });
        assert.equal(result.success, true, JSON.stringify(result).slice(0, 300));
        assert.equal(collections.get('passwords').size, 1);
        assert.equal(result.downloads.length, 1);
        assert.equal(result.downloads[0].data.id, 'saved-once');
      }
    },
  },
  {
    name: 'updates an owned business id in its original cloud document without creating a copy',
    async run() {
      const existing = {
        _id: 'legacy-document', _openid: 'authenticated-user', ...envelope('business-id'),
      };
      const { main, collections } = createHarness({ seed: { passwords: { 'legacy-document': existing } } });
      for (let index = 0; index < 2; index++) {
        const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('business-id')] });
        assert.equal(result.success, true);
        assert.equal(collections.get('passwords').size, 1);
        assert.equal(collections.get('passwords').get('legacy-document').id, 'business-id');
      }
    },
  },
  {
    name: 'ambiguous owned business ids retain all documents and leave the upload unconfirmed',
    async run() {
      const seed = {
        'business-id': { _id: 'business-id', _openid: 'authenticated-user', ...envelope('business-id') },
        'legacy-document': { _id: 'legacy-document', _openid: 'authenticated-user', ...envelope('business-id') },
      };
      const { main, collections } = createHarness({ seed: { passwords: seed } });
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('business-id')] });
      assert.equal(result.success, false);
      assert.equal(result.upload_results[0].error, 'record_id_conflict');
      assert.deepEqual(result.confirmed_queue_ids, []);
      assert.deepEqual(Object.fromEntries(collections.get('passwords')), seed);
    },
  },
  {
    name: 'an alias owned by another user cannot redirect an upload into their document',
    async run() {
      const foreign = { _id: 'foreign-document', _openid: 'another-user', ...envelope('business-id') };
      const { main, collections } = createHarness({ seed: { passwords: { 'foreign-document': foreign } } });
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('business-id')] });
      assert.equal(result.success, true);
      assert.deepEqual(collections.get('passwords').get('foreign-document'), foreign);
      assert.equal(collections.get('passwords').get('business-id')._openid, 'authenticated-user');
    },
  },
  {
    name: 'rejects categories and settings because the client sync contract only has passwords',
    async run() {
      const { main, collections, queries } = createHarness({
        seed: {
          categories: {
            'existing-category': {
              _id: 'existing-category',
              _openid: 'authenticated-user',
              updated_at: '2026-09-29T12:00:00.000Z',
            },
          },
          settings: {
            'existing-setting': {
              _id: 'existing-setting',
              _openid: 'authenticated-user',
              updated_at: '2026-09-29T12:00:00.000Z',
            },
          },
        },
      });
      const upload = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [
          { ...update('new-category'), collection: 'categories' },
          { ...update('new-setting'), collection: 'settings' },
        ],
      });

      assert.equal(upload.success, false);
      assert.deepEqual(
        upload.upload_results.map(item => [item.collection, item.error]),
        [
          ['categories', 'invalid_collection'],
          ['settings', 'invalid_collection'],
        ],
      );
      assert.equal(collections.get('categories').has('new-category'), false);
      assert.equal(collections.get('settings').has('new-setting'), false);

      const download = await main({
        client_version: '4.3.7', action: 'download',
        last_sync: '2026-09-29T00:00:00.000Z',
      });
      assert.deepEqual(download.downloads, []);
      assert.equal(
        queries.some(query => query.collection === 'categories' || query.collection === 'settings'),
        false,
      );

      const indexes = await main({ action: 'init_indexes' });
      assert.deepEqual(indexes.indexes_needed, [
        { collection: 'passwords', field: 'updated_at', order: 'desc' },
      ]);
      assert.match(indexes.note, /不会创建索引/);
    },
  },
  {
    name: 'accepts an encrypted envelope split between item and data',
    async run() {
      const { main, collections } = createHarness();
      const payload = envelope('split-envelope');
      const { id, ...insideData } = payload;
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update(id, insideData, 'queue-split-envelope')],
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.confirmed_queue_ids, ['queue-split-envelope']);
      const stored = collections.get('passwords').get('split-envelope');
      assert.equal(stored._openid, 'authenticated-user');
      assert.equal(stored.crypto_version, 1);
      assert.equal(stored.updated_at, '2026-09-29T12:00:00.000Z');
      assert.equal(stored.created_at, '2026-09-01T00:00:00.000Z');
      assert.equal(stored._synced_at instanceof Date, true);
      assert.equal(Object.hasOwn(stored, 'queue_id'), false);
    },
  },
  {
    name: 'accepts an envelope emitted by the client crypto implementation',
    async run() {
      const { main, collections } = createHarness();
      const payload = await clientEnvelope('client-generated-envelope');
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update(payload.id, payload)],
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.confirmed_queue_ids, ['queue-client-generated-envelope']);
      assert.deepEqual(
        Object.fromEntries(['salt', 'iv', 'ciphertext', 'mac'].map(field => [
          field,
          collections.get('passwords').get(payload.id)[field],
        ])),
        Object.fromEntries(['salt', 'iv', 'ciphertext', 'mac'].map(field => [
          field,
          payload[field],
        ])),
      );
    },
  },
  {
    name: 'rejects non-hex and incorrectly sized encrypted envelope fields',
    async run() {
      const invalidEnvelopes = [
        envelope('bad-salt-hex'),
        envelope('bad-salt-length'),
        envelope('bad-iv-hex'),
        envelope('bad-iv-length'),
        envelope('bad-ciphertext-hex'),
        envelope('bad-ciphertext-length'),
        envelope('bad-ciphertext-block-size'),
        envelope('bad-mac-hex'),
        envelope('bad-mac-length'),
      ];
      invalidEnvelopes[0].salt = 'g'.repeat(32);
      invalidEnvelopes[1].salt = 'a'.repeat(31);
      invalidEnvelopes[2].iv = 'g'.repeat(32);
      invalidEnvelopes[3].iv = 'b'.repeat(30);
      invalidEnvelopes[4].ciphertext = 'z'.repeat(32);
      invalidEnvelopes[5].ciphertext = 'c'.repeat(31);
      invalidEnvelopes[6].ciphertext = 'c'.repeat(16);
      invalidEnvelopes[7].mac = 'g'.repeat(64);
      invalidEnvelopes[8].mac = 'd'.repeat(63);

      for (const payload of invalidEnvelopes) {
        const { main, collections } = createHarness();
        const result = await main({
          client_version: '4.3.7', action: 'upload',
          local_updates: [update(payload.id, payload)],
        });

        assert.equal(result.success, false, payload.id);
        assert.equal(result.upload_results[0].error, 'invalid_envelope', payload.id);
        assert.equal((collections.get('passwords') || new Map()).has(payload.id), false);
      }
    },
  },
  {
    name: 'keeps mutation action outside the envelope and defaults the collection to passwords',
    async run() {
      const { main, collections } = createHarness();
      const mutation = update('action-envelope');
      mutation.action = 'update';
      delete mutation.collection;
      const result = await main({ client_version: '4.3.7', action: 'upload', local_updates: [mutation] });

      assert.equal(result.success, true);
      assert.equal(result.upload_results[0].collection, 'passwords');
      const stored = collections.get('passwords').get('action-envelope');
      assert.equal(Object.hasOwn(stored, 'action'), false);
      assert.equal(Object.hasOwn(stored, 'queue_id'), false);
    },
  },
  {
    name: 'rejects plaintext fields and leaves old cloud records untouched',
    async run() {
      const oldRecord = {
        _id: 'legacy',
        _openid: 'authenticated-user',
        account: 'legacy-account',
        password: 'legacy-password',
        notes: 'legacy-notes',
        updated_at: '2025-01-01T00:00:00.000Z',
      };
      const { main, collections } = createHarness({
        seed: { passwords: { legacy: oldRecord } },
      });
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: ['account', 'password', 'notes', 'fields', 'custom_fields'].map((key, index) => (
          update('legacy', { ...envelope('legacy'), [key]: 'plaintext' }, `legacy-queue-${index}`)
        )),
      });

      assert.equal(result.success, false);
      assert.equal(result.upload_results.length, 5);
      assert.equal(result.upload_results.every(item => item.success === false), true);
      assert.deepEqual(result.confirmed_queue_ids, []);
      assert.deepEqual(collections.get('passwords').get('legacy'), oldRecord);
    },
  },
  {
    name: 'rejects client-controlled ownership and document metadata',
    async run() {
      const { main, collections } = createHarness();
      const reservedKeys = ['_openid', '_id', '_synced_at'];
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: reservedKeys.map((key, index) => {
          const mutation = update(
            `reserved-${key}`,
            envelope(`reserved-${key}`),
            `reserved-queue-${index}`,
          );
          if (key === '_synced_at') {
            mutation.data[key] = 'forged-value';
          } else {
            mutation[key] = 'forged-value';
          }
          return mutation;
        }),
      });

      assert.equal(result.success, false);
      assert.equal(result.upload_results.length, reservedKeys.length);
      assert.equal((collections.get('passwords') || new Map()).size, 0);
    },
  },
  {
    name: 'never overwrites a document owned by another user',
    async run() {
      const existing = {
        _id: 'shared-id',
        _openid: 'another-user',
        crypto_version: 1,
        ciphertext: 'other-users-data',
      };
      const { main, collections } = createHarness({
        seed: { passwords: { 'shared-id': existing } },
      });
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update('shared-id')],
      });

      assert.equal(result.success, false);
      assert.deepEqual(result.confirmed_queue_ids, []);
      assert.deepEqual(collections.get('passwords').get('shared-id'), existing);
    },
  },
  {
    name: 'updates an existing record only when it already belongs to the caller',
    async run() {
      const existing = {
        _id: 'owned-id',
        _openid: 'authenticated-user',
        ...envelope('owned-id', '2026-09-20T00:00:00.000Z'),
      };
      const { main, collections } = createHarness({
        seed: { passwords: { 'owned-id': existing } },
      });
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update('owned-id')],
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.confirmed_queue_ids, ['queue-owned-id']);
      assert.equal(collections.get('passwords').get('owned-id')._openid, 'authenticated-user');
      assert.equal(
        collections.get('passwords').get('owned-id').ciphertext,
        envelope('owned-id').ciphertext,
      );
    },
  },
  {
    name: 'replaces legacy plaintext fields when updating an owned cloud record',
    async run() {
      const legacy = {
        _id: 'legacy-owned-id',
        _openid: 'authenticated-user',
        account: 'old-account',
        password: 'old-password',
        notes: 'old-notes',
        custom_fields: [{ label: 'legacy', value: 'plaintext' }],
        updated_at: '2025-01-01T00:00:00.000Z',
      };
      const { main, collections } = createHarness({
        seed: { passwords: { 'legacy-owned-id': legacy } },
      });
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update('legacy-owned-id')],
      });

      assert.equal(result.success, true);
      const stored = collections.get('passwords').get('legacy-owned-id');
      assert.equal(stored._openid, 'authenticated-user');
      assert.equal(stored.crypto_version, 1);
      for (const field of ['account', 'password', 'notes', 'custom_fields']) {
        assert.equal(Object.hasOwn(stored, field), false, `${field} must not survive replacement`);
      }
    },
  },
  {
    name: 'reports partial failure and confirms only successful record ids',
    async run() {
      const { main, collections } = createHarness({ failAddIds: ['write-fails'] });
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: ['saved', 'write-fails'].map(id => update(id)),
      });

      assert.equal(result.success, false);
      assert.equal(result.uploads_ok, 1);
      assert.deepEqual(result.confirmed_queue_ids, ['queue-saved']);
      assert.deepEqual(
        result.upload_results.map(item => [item.queue_id, item.id, item.success]),
        [['queue-saved', 'saved', true], ['queue-write-fails', 'write-fails', false]],
      );
      assert.equal(collections.get('passwords').has('saved'), true);
      assert.equal(collections.get('passwords').has('write-fails'), false);
    },
  },
  {
    name: 'normalizes Date updated_at to ISO and queries both legacy string and Date timestamps',
    async run() {
      const { main, collections, queries } = createHarness({
        seed: {
          passwords: {
            'legacy-string-time': {
              _id: 'legacy-string-time',
              _openid: 'authenticated-user',
              updated_at: '2026-09-29T13:00:00.000Z',
            },
            'legacy-date-time': {
              _id: 'legacy-date-time',
              _openid: 'authenticated-user',
              updated_at: new Date('2026-09-29T14:00:00.000Z'),
            },
            'old-time': {
              _id: 'old-time',
              _openid: 'authenticated-user',
              updated_at: '2026-09-28T00:00:00.000Z',
            },
          },
        },
      });
      const dateValue = new Date('2026-09-29T15:00:00.000Z');
      const upload = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [update('new-envelope', envelope('new-envelope', dateValue))],
      });

      assert.equal(upload.success, true);
      assert.equal(
        collections.get('passwords').get('new-envelope').updated_at,
        dateValue.toISOString(),
      );

      const download = await main({
        client_version: '4.3.7', action: 'download',
        last_sync: '2026-09-29T12:00:00.000Z',
      });
      const downloadedIds = download.downloads.map(item => item.id).sort();
      assert.deepEqual(downloadedIds, [
        'legacy-date-time',
        'legacy-string-time',
        'new-envelope',
      ]);
      const timestampComparisons = queries
        .filter(item => item.collection === 'passwords' && item.query.updated_at)
        .flatMap(item => item.query.updated_at.conditions
          ? item.query.updated_at.conditions.map(condition => condition.value)
          : [item.query.updated_at.value]);
      assert.equal(timestampComparisons.some(value => value instanceof Date), true);
      assert.equal(timestampComparisons.includes('2026-09-29T12:00:00.000Z'), true);
    },
  },
  {
    name: 'downloads only the explicit password envelope fields',
    async run() {
      const recordId = 'legacy-unknown-fields';
      const stored = {
        _id: recordId,
        _openid: 'authenticated-user',
        ...envelope(recordId),
        account: 'must-not-return',
        password: 'must-not-return',
        notes: 'must-not-return',
        legacy_secret: 'must-not-return',
        nested_unknown: { secret: 'must-not-return' },
        _synced_at: new Date('2026-09-29T12:00:00.000Z'),
      };
      const { main } = createHarness({
        seed: { passwords: { [recordId]: stored } },
      });

      const result = await main({
        client_version: '4.3.7', action: 'download',
        last_sync: '2026-09-29T00:00:00.000Z',
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.downloads, [{
        id: recordId,
        collection: 'passwords',
        data: envelope(recordId),
        seq: null,
      }]);
      assert.deepEqual(Object.keys(result.downloads[0].data).sort(), [
        'ciphertext',
        'created_at',
        'crypto_version',
        'id',
        'iv',
        'mac',
        'salt',
        'updated_at',
      ]);
    },
  },
  {
    name: 'captures a download high-water mark before pagination',
    async run() {
      const seed = {};
      for (let index = 0; index < 100; index++) {
        const id = `page-${String(index).padStart(3, '0')}`;
        seed[id] = {
          _id: id,
          _openid: 'authenticated-user',
          updated_at: '2026-09-29T12:00:00.000Z',
        };
      }
      let inserted = false;
      const { main, collections } = createHarness({
        seed: { passwords: seed },
        onDownloadPage({ offset, records }) {
          if (inserted || offset !== 0) return;
          inserted = true;
          records.set('future-write', {
            _id: 'future-write',
            _openid: 'authenticated-user',
            updated_at: '2999-01-01T00:00:00.000Z',
          });
        },
      });

      const result = await main({
        client_version: '4.3.7', action: 'download',
        last_sync: '2026-09-28T00:00:00.000Z',
      });

      assert.equal(result.success, true);
      assert.equal(result.downloads.length, 100);
      assert.equal(result.downloads.some(item => item.id === 'future-write'), false);
      assert.equal(collections.get('passwords').has('future-write'), true);
    },
  },
  {
    name: 'orders every page by timestamp and id for stable pagination boundaries',
    async run() {
      const seed = {};
      for (let index = 149; index >= 0; index--) {
        const id = `stable-${String(index).padStart(3, '0')}`;
        seed[id] = {
          _id: id,
          _openid: 'authenticated-user',
          updated_at: '2026-09-29T12:00:00.000Z',
        };
      }
      const { main, queries } = createHarness({
        seed: { passwords: seed },
      });

      const result = await main({
        client_version: '4.3.7', action: 'download',
        last_sync: '2026-09-28T00:00:00.000Z',
      });

      assert.equal(result.success, true);
      assert.deepEqual(
        result.downloads.map(item => item.id),
        Array.from({ length: 150 }, (_, index) => `stable-${String(index).padStart(3, '0')}`),
      );
      const pageQueries = queries.filter(item => item.collection === 'passwords'
        && item.query.updated_at);
      assert.equal(pageQueries.length >= 2, true);
      assert.equal(
        pageQueries.every(item => (
          JSON.stringify(item.orderBy) === JSON.stringify([
            { field: 'updated_at', direction: 'asc' },
            { field: '_id', direction: 'asc' },
          ])
        )),
        true,
      );
    },
  },
  {
    name: 'full_sync preserves per-record confirmations when one upload fails',
    async run() {
      const { main } = createHarness({ failAddIds: ['failed-in-full-sync'] });
      const result = await main({
        client_version: '4.3.7', action: 'full_sync',
        last_sync: '2026-09-28T00:00:00.000Z',
        local_updates: ['confirmed-in-full-sync', 'failed-in-full-sync'].map(id => update(id)),
      });

      assert.equal(result.success, false);
      assert.equal(result.download_success, true);
      assert.deepEqual(result.confirmed_queue_ids, ['queue-confirmed-in-full-sync']);
      assert.equal(Array.isArray(result.downloads), true);
      assert.equal(typeof result.server_time, 'string');
    },
  },
  {
    name: 'full_sync reports download failure separately from upload results',
    async run() {
      const { main } = createHarness({ failDownload: true });
      const result = await main({
        client_version: '4.3.7', action: 'full_sync',
        last_sync: '2026-09-28T00:00:00.000Z',
      });

      assert.equal(result.success, false);
      assert.equal(result.download_success, false);
      assert.deepEqual(result.downloads, []);
      assert.equal(result.error, 'download_failed');
      assert.equal(typeof result.server_time, 'string');
    },
  },
  {
    name: 'returns an individual failure for missing queue ids and malformed envelopes',
    async run() {
      const { main, collections } = createHarness();
      const missingQueueId = update('missing-queue-id');
      delete missingQueueId.queue_id;
      const missingMac = envelope('missing-mac');
      delete missingMac.mac;
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [missingQueueId, update('missing-mac', missingMac)],
      });

      assert.equal(result.success, false);
      assert.equal(result.upload_results.length, 2);
      assert.deepEqual(result.upload_results.map(item => item.success), [false, false]);
      assert.equal(result.upload_results[0].queue_id, null);
      assert.equal(result.upload_results[1].queue_id, 'queue-missing-mac');
      assert.deepEqual(result.confirmed_queue_ids, []);
      assert.equal((collections.get('passwords') || new Map()).size, 0);
    },
  },
  {
    name: 'fails every mutation that reuses a queue id',
    async run() {
      const { main, collections } = createHarness();
      const result = await main({
        client_version: '4.3.7', action: 'upload',
        local_updates: [
          update('same-record', envelope('same-record'), 'duplicate-queue'),
          update('same-record', envelope('same-record'), 'duplicate-queue'),
        ],
      });

      assert.equal(result.success, false);
      assert.deepEqual(result.upload_results.map(item => item.success), [false, false]);
      assert.deepEqual(result.confirmed_queue_ids, []);
      assert.equal((collections.get('passwords') || new Map()).size, 0);
    },
  },
  {
    name: 'creates vault metadata once and returns the existing metadata on conflict',
    async run() {
      const { main, collections } = createHarness();
      const first = validVaultMeta();
      const created = await main({ action: 'set_vault_meta', vault_meta: first });
      const fetched = await main({ action: 'get_vault_meta' });
      const attemptedReplacement = await main({
        action: 'set_vault_meta',
        vault_meta: validVaultMeta({
          salt: 'f'.repeat(32),
          verifier: 'e'.repeat(64),
        }),
      });

      assert.equal(created.success, true);
      assert.equal(created.created, true);
      assert.deepEqual(created.vault_meta, first);
      assert.equal(fetched.exists, true);
      assert.deepEqual(fetched.vault_meta, first);
      assert.equal(attemptedReplacement.success, true);
      assert.equal(attemptedReplacement.created, false);
      assert.deepEqual(attemptedReplacement.vault_meta, first);
      const stored = collections.get('vault_meta').get('authenticated-user');
      assert.deepEqual(
        Object.keys(stored).sort(),
        ['_id', '_openid', 'iterations', 'kdf', 'salt', 'verifier', 'version'],
      );
      assert.equal(stored._openid, 'authenticated-user');
    },
  },
  {
    name: 'vault metadata lookup is scoped to WXContext OPENID',
    async run() {
      const { main } = createHarness({
        openid: 'user-a',
        seed: {
          vault_meta: {
            'user-b': {
              _id: 'user-b',
              _openid: 'user-b',
              ...validVaultMeta({ verifier: 'other-user-verifier' }),
            },
          },
        },
      });
      const result = await main({
        action: 'get_vault_meta',
        openid: 'user-b',
        _openid: 'user-b',
      });

      assert.equal(result.success, true);
      assert.equal(result.exists, false);
      assert.equal(result.vault_meta, null);
    },
  },
  {
    name: 'rejects vault metadata containing secrets beyond the fixed metadata schema',
    async run() {
      const { main, collections } = createHarness();
      const result = await main({
        action: 'set_vault_meta',
        vault_meta: validVaultMeta({ master_password: 'must-not-be-stored' }),
      });

      assert.equal(result.success, false);
      assert.equal(collections.has('vault_meta'), false);
    },
  },
  {
    name: 'accepts only the supported v1 PBKDF2 metadata parameters',
    async run() {
      for (const iterations of [600000, 2000000]) {
        const { main, collections } = createHarness();
        const result = await main({
          action: 'set_vault_meta',
          vault_meta: validVaultMeta({ iterations }),
        });

        assert.equal(result.success, true, `iteration count ${iterations} is supported`);
        assert.equal(
          collections.get('vault_meta').get('authenticated-user').iterations,
          iterations,
        );
      }
    },
  },
  {
    name: 'rejects unsupported KDF versions, weak or excessive iteration counts, and malformed digests',
    async run() {
      const invalidMetadata = [
        validVaultMeta({ version: 2 }),
        validVaultMeta({ kdf: 'PBKDF2-HMAC-SHA1' }),
        validVaultMeta({ kdf: 'pbkdf2-sha256' }),
        validVaultMeta({ iterations: 599999 }),
        validVaultMeta({ iterations: 2000001 }),
        validVaultMeta({ iterations: 600000.5 }),
        validVaultMeta({ salt: 'not-32-byte-hex' }),
        validVaultMeta({ verifier: 'not-32-byte-hex' }),
      ];

      for (const vaultMeta of invalidMetadata) {
        const { main, collections } = createHarness();
        const result = await main({ action: 'set_vault_meta', vault_meta: vaultMeta });

        assert.equal(result.success, false, JSON.stringify(vaultMeta));
        assert.equal(result.error, 'invalid_vault_meta');
        assert.equal(collections.has('vault_meta'), false);
      }
    },
  },
  {
    name: 'upload assigns stable monotonically increasing seq to password entries (R0-verified)',
    async run() {
      const { main, collections } = createHarness();
      const r1 = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('seq-a')] });
      const r2 = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('seq-b')] });
      // 重传同一 id：沿用原编号（幂等，不重复取号）
      const r3 = await main({ client_version: '4.3.7', action: 'upload', local_updates: [update('seq-a')] });
      const a = r1.upload_results[0].seq;
      const b = r2.upload_results[0].seq;
      const aAgain = r3.upload_results[0].seq;
      assert.equal(a, 1, '首个条目编号为 1');
      assert.equal(b, 2, '第二个条目编号为 2');
      assert.equal(aAgain, a, '重复上传沿用原编号');
      const savedA = [...collections.get('passwords').values()].find((d) => d.id === 'seq-a');
      assert.equal(savedA.seq, a, '编号随条目持久化到云端文档');
    },
  },
  {
    name: 'full_sync backfills missing seq for legacy entries (R0-verified)',
    async run() {
      const recordId = 'legacy-no-seq';
      const stored = {
        _id: recordId,
        _openid: 'authenticated-user',
        ...envelope(recordId),
        _synced_at: new Date('2026-09-29T12:00:00.000Z'),
      };
      const { main, collections } = createHarness({
        seed: { passwords: { [recordId]: stored } },
      });

      const result = await main({
        client_version: '4.3.7', action: 'full_sync',
        last_sync: null,
        local_updates: [],
      });

      assert.equal(result.success, true, 'full_sync 应成功');
      const seq = result.backfilled_seq && result.backfilled_seq[recordId];
      assert.ok(Number(seq) > 0, '应为缺编号的存量条目分配编号');

      const saved = [...collections.get('passwords').values()].find(d => d.id === recordId);
      assert.equal(Number(saved.seq), Number(seq), '编号必须写回云端文档');

      const downloaded = (result.downloads || []).find(d => d.id === recordId);
      if (downloaded) {
        assert.equal(Number(downloaded.seq), Number(seq), '下载结果应携带编号');
      }

      // 幂等：再次 full_sync 不应重复分配
      const again = await main({ client_version: '4.3.7', action: 'full_sync', last_sync: null, local_updates: [] });
      const savedAgain = [...collections.get('passwords').values()].find(d => d.id === recordId);
      assert.equal(Number(savedAgain.seq), Number(seq), '重复同步不得改动已有编号');
      if (again.backfilled_seq && again.backfilled_seq[recordId]) {
        assert.fail('已有编号的条目不应再次出现在 backfilled_seq 中');
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
      console.error(error.stack || error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
