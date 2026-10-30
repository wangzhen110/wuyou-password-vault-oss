const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('../miniprogram/utils/crypto');

function foreignBuffer(length = 16) {
  return vm.runInNewContext(
    'Uint8Array.from({ length }, (_, index) => index + 1).buffer',
    { length },
  );
}

test('accepts callback ArrayBuffers from the WeChat native bridge realm', async () => {
  const buffer = foreignBuffer();
  assert.equal(buffer instanceof ArrayBuffer, false);
  global.wx = {
    getRandomValues({ success }) {
      success({ randomValues: buffer });
    },
  };

  const result = await crypto.randomBytes(16);
  assert.deepEqual(Array.from(result), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.ok(result instanceof Uint8Array);
});

test('accepts promise ArrayBuffers from another realm', async () => {
  global.wx = { getRandomValues: () => Promise.resolve({ randomValues: foreignBuffer() }) };
  assert.equal((await crypto.randomBytes(16)).length, 16);
});

test('uses the exact byte range of a foreign typed-array view', async () => {
  const view = vm.runInNewContext('Uint8Array.from([99, 1, 2, 3, 88]).subarray(1, 4)');
  global.wx = { getRandomValues: () => view };
  assert.deepEqual(Array.from(await crypto.randomBytes(3)), [1, 2, 3]);
});

test('rejects spoofed ArrayBuffers without throwing outside the promise', async () => {
  global.wx = {
    getRandomValues({ success }) {
      success({ randomValues: { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 16 } });
    },
  };
  await assert.rejects(crypto.randomBytes(16), /安全随机源返回长度错误/);
});

test('rejects wrong-sized native buffers', async () => {
  global.wx = { getRandomValues: () => foreignBuffer(15) };
  await assert.rejects(crypto.randomBytes(16), /安全随机源返回长度错误/);
});
