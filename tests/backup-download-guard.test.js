const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const TARGET = path.join(__dirname, '..', 'cloudfunctions', 'backupDownload', 'index.js');
const originalLoad = Module._load;

/**
 * 最小 wx-server-sdk mock：支持 where(精确/lt/in)、limit、get、remove、doc.update、
 * command.inc、serverDate、deleteFile。仅覆盖 backupDownload 用到的子集。
 */
function createCloud(seedRecords) {
  const store = new Map();
  for (const r of seedRecords) store.set(r._id, { ...r });
  const deletedFiles = [];

  const match = (rec, query) => Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '__lt' in expected) {
      return new Date(rec[key]).getTime() < new Date(expected.__lt).getTime();
    }
    if (expected && typeof expected === 'object' && '__in' in expected) {
      return expected.__in.includes(rec[key]);
    }
    return rec[key] === expected;
  });

  const makeQuery = (query) => ({
    limit: (n) => ({
      get: async () => ({ data: [...store.values()].filter((r) => match(r, query)).slice(0, n) }),
    }),
    get: async () => ({ data: [...store.values()].filter((r) => match(r, query)) }),
    remove: async () => {
      const victims = [...store.values()].filter((r) => match(r, query));
      for (const v of victims) store.delete(v._id);
      return { stats: { removed: victims.length } };
    },
  });

  const db = {
    command: {
      inc: (n) => ({ __inc: n }),
      lt: (v) => ({ __lt: v }),
      in: (arr) => ({ __in: arr }),
    },
    serverDate: () => new Date(),
    collection: () => ({
      where: (query) => makeQuery(query),
      doc: (id) => ({
        update: async ({ data }) => {
          const rec = store.get(id) || {};
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && '__inc' in value) {
              rec[key] = Number(rec[key] || 0) + value.__inc;
            } else {
              rec[key] = value;
            }
          }
          store.set(id, rec);
          return { stats: { updated: 1 } };
        },
      }),
    }),
  };

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init: () => {},
    database: () => db,
    getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://example.com/tmp' }] }),
    deleteFile: async ({ fileList }) => {
      deletedFiles.push(...fileList);
      return { fileList: fileList.map((f) => ({ fileID: f, status: 0 })) };
    },
  };

  return { cloud, store, deletedFiles };
}

function loadWith(cloud) {
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[require.resolve(TARGET)];
  const mod = require(TARGET);
  Module._load = originalLoad;
  return mod;
}

const SALT = '00'.repeat(16);
const ITERATIONS = 10; // 测试用小迭代；真实记录是 600000
const LINK_ID = 'a'.repeat(24);

function computeVerifier(password) {
  const material = crypto.pbkdf2Sync(password, Buffer.from(SALT, 'hex'), ITERATIONS, 64, 'sha256');
  return crypto.createHmac('sha256', material.slice(32, 64)).update('vault-verifier:v1').digest('hex');
}

function baseRecord(overrides = {}) {
  return {
    _id: 'rec-1',
    link_id: LINK_ID,
    status: 'active',
    downloads: 0,
    salt: SALT,
    iterations: ITERATIONS,
    verifier: computeVerifier('right-password'),
    file_id: 'cloud://env/backups/temp/x.pwma',
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

async function post(cloud, password) {
  const { main } = loadWith(cloud);
  return main({ httpMethod: 'POST', body: JSON.stringify({ id: LINK_ID, password }) });
}

async function get(cloud) {
  const { main } = loadWith(cloud);
  return main({ httpMethod: 'GET', queryStringParameters: { id: LINK_ID } });
}

async function run() {
  // 1) 单次错误：403，计数 +1，链接仍可用，文件未删
  {
    const { cloud, store, deletedFiles } = createCloud([baseRecord()]);
    const res = await post(cloud, 'wrong');
    assert.equal(res.statusCode, 403);
    assert.equal(store.get('rec-1').failed_attempts, 1);
    assert.equal(store.get('rec-1').status, 'active');
    assert.equal(deletedFiles.length, 0, '未达上限不应删除文件');
  }

  // 2) 第 5 次错误：410 + 链接失效 + 立即删除云存储文件 + 记录到期待回收
  {
    const { cloud, store, deletedFiles } = createCloud([baseRecord({ failed_attempts: 4 })]);
    const res = await post(cloud, 'wrong');
    assert.equal(res.statusCode, 410);
    const rec = store.get('rec-1');
    assert.equal(rec.failed_attempts, 5);
    assert.equal(rec.status, 'disabled');
    assert.equal(rec.file_id, null, '文件已删除，应清空 file_id');
    assert.ok(new Date(rec.expires_at).getTime() <= Date.now() + 1000, '记录应置为已到期');
    assert.deepEqual(deletedFiles, ['cloud://env/backups/temp/x.pwma'], '应删除云存储文件');
  }

  // 3) 失效后即使密码正确也不可用
  {
    const { cloud, store } = createCloud([baseRecord({ failed_attempts: 5, status: 'disabled' })]);
    const res = await post(cloud, 'right-password');
    assert.equal(res.statusCode, 410);
    assert.equal(store.get('rec-1').downloads, 0);
  }

  // 4) 失效后 GET 页面提示失效
  {
    const { cloud } = createCloud([baseRecord({ failed_attempts: 5, status: 'disabled' })]);
    const res = await get(cloud);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /已失效/);
  }

  // 5) 未达上限时密码正确：放行、下载次数 +1、成功后链接置失效且保留文件到直链过期
  {
    const { cloud, store, deletedFiles } = createCloud([baseRecord({ failed_attempts: 2 })]);
    const res = await post(cloud, 'right-password');
    assert.equal(res.statusCode, 200);
    const rec = store.get('rec-1');
    assert.equal(rec.downloads, 1);
    assert.equal(rec.status, 'disabled', '一次性：下载成功即失效');
    assert.ok(new Date(rec.expires_at).getTime() > Date.now() + 4 * 60 * 1000, '文件需活过 5 分钟直链');
    assert.equal(deletedFiles.length, 0, '下载后不能立刻删文件，否则直链失效');
  }

  // 6) 同一链接第二次请求被拒
  {
    const { cloud } = createCloud([baseRecord({ downloads: 1, status: 'disabled' })]);
    const res = await post(cloud, 'right-password');
    assert.equal(res.statusCode, 410);
  }

  // 7) 请求时扫尾：过期记录连同文件一起被清理
  {
    const expired = baseRecord({
      _id: 'rec-old',
      link_id: 'b'.repeat(24),
      status: 'disabled',
      expires_at: new Date(Date.now() - 60 * 1000),
      file_id: 'cloud://env/backups/temp/old.pwma',
    });
    const { cloud, store, deletedFiles } = createCloud([baseRecord(), expired]);
    await get(cloud);
    assert.equal(store.has('rec-old'), false, '过期记录应被删除');
    assert.ok(deletedFiles.includes('cloud://env/backups/temp/old.pwma'), '过期文件应被删除');
    assert.equal(store.has('rec-1'), true, '未过期记录不应被误删');
  }

  console.log('backupDownload：5 次失效 / 一次性 / 及时清理，7/7 用例通过');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
