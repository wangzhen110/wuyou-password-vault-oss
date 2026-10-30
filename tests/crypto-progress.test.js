const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// crypto.js 仅在需要随机源时触碰 wx；派生/校验路径不依赖它，这里给最小 stub 以防万一
global.wx = {
  getRandomValues: (opts) => {
    const buf = new Uint8Array(opts.length || 0);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 0xff;
    if (opts && typeof opts.success === 'function') opts.success({ randomValues: buf.buffer });
  },
};

const crypto = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'crypto.js'));

const META = {
  crypto_version: 1,
  kdf: 'PBKDF2-HMAC-SHA256',
  iterations: crypto.KDF_ITERATIONS,
  salt: '00112233445566778899aabbccddeeff',
  verifier: '0'.repeat(64), // 故意给假校验值：只验证进度回调行为，不验证密码正确性
};

test('KDF 进度回调按单调递增上报，且最终到达 1', async () => {
  const ratios = [];
  const result = await crypto.verifyVaultPassword('progress-test-pw', META, (ratio) => {
    ratios.push(ratio);
  });

  assert.equal(result.success, false, '假校验值应校验失败');
  assert.ok(ratios.length >= 5, '应上报多次进度，实际 ' + ratios.length);
  assert.equal(ratios[ratios.length - 1], 1, '最后一次进度应为 1');
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] >= ratios[i - 1], '进度必须单调不减');
  }
  assert.ok(ratios.every((r) => r > 0 && r <= 1), '进度应在 (0, 1] 区间');
});

test('进度回调抛异常时不得影响密钥派生', async () => {
  const result = await crypto.verifyVaultPassword('progress-test-pw', META, () => {
    throw new Error('界面回调炸了');
  });
  assert.equal(result.success, false, '仍应正常完成校验（失败是因为假校验值）');
  assert.ok(result.keys && result.keys.macKey, '密钥应正常派生出来');
});
