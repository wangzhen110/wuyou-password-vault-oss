const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const FUNCTION_PATH = path.join(__dirname, '..', 'cloudfunctions', 'ensureCollections', 'index.js');
const created = [];
let nextId = 0;
const db = {
  async createCollection(name) {
    created.push(name);
  },
  collection(name) {
    return {
      async add() {
        return { _id: `${name}-probe-${++nextId}` };
      },
      doc() {
        return {
          async remove() {},
        };
      },
    };
  },
};
const cloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database: () => db,
  // 维护函数已加管理员白名单，测试中显式提供管理员身份
  getWXContext: () => ({ OPENID: 'test-admin-openid' }),
};
process.env.ADMIN_OPENIDS = 'test-admin-openid';

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

main({}).then(result => {
  assert.deepEqual(created.sort(), ['orders', 'vault_meta']);
  assert.deepEqual(Object.keys(result.results).sort(), ['orders', 'vault_meta']);
  assert.equal(result.verify, 'WRITABLE_OK');
  console.log('ensure-collections: all checks passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
