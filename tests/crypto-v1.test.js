const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

let randomCounter = 1;
global.wx = {
  getRandomValues({ length, success }) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      bytes[index] = randomCounter++ & 0xff;
    }
    success({ randomValues: bytes.buffer });
  },
};

const crypto = require('../miniprogram/utils/crypto');
const CryptoJS = require('../miniprogram/utils/crypto-js.min');

async function main() {
  const random = await crypto.randomBytes(17);
  assert.ok(random instanceof Uint8Array);
  assert.equal(random.length, 17);

  const password = 'correct horse battery staple';
  const { meta, keys } = await crypto.createVaultMeta(password);
  assert.equal(meta.crypto_version, 1);
  assert.equal(meta.kdf, 'PBKDF2-HMAC-SHA256');
  assert.equal(meta.iterations, 600000);
  assert.match(meta.salt, /^[0-9a-f]{32}$/);
  assert.equal(meta.verifier, CryptoJS.HmacSHA256('vault-verifier:v1', keys.macKey).toString());

  const expectedMaterial = nodeCrypto.pbkdf2Sync(
    password,
    Buffer.from(meta.salt, 'hex'),
    meta.iterations,
    64,
    'sha256'
  );
  assert.equal(keys.encryptionKey.toString(), expectedMaterial.subarray(0, 32).toString('hex'));
  assert.equal(keys.macKey.toString(), expectedMaterial.subarray(32).toString('hex'));

  for (const vector of [
    { password: '中文密码🔐', salt: 'f0e1d2c3b4a5968778695a4b3c2d1e0f' },
    { password: 'x'.repeat(100), salt: '00112233445566778899aabbccddeeff' },
  ]) {
    const derived = await crypto.deriveVaultKeys(vector.password, {
      ...meta,
      salt: vector.salt,
    });
    const expected = nodeCrypto.pbkdf2Sync(
      vector.password,
      Buffer.from(vector.salt, 'hex'),
      meta.iterations,
      64,
      'sha256'
    );
    assert.equal(
      derived.encryptionKey.toString() + derived.macKey.toString(),
      expected.toString('hex')
    );
  }

  const entry = {
    id: 'record-42',
    platform: '邮箱',
    account: 'user@example.com',
    password: 'correct horse',
    securityAnswer: 'first pet',
    fields: [{ key: 'private-key', value: 'secret', concealed: true }],
    custom_fields: [{ label: 'recovery', value: 'also secret', concealed: true }],
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:01:00.000Z',
  };

  const envelope = await crypto.encryptRecord(entry, keys, meta);
  assert.equal(envelope.crypto_version, 1);
  assert.equal(envelope.id, entry.id);
  assert.equal(envelope.salt, meta.salt);
  assert.equal(JSON.stringify(envelope).includes(entry.password), false);
  assert.equal(JSON.stringify(envelope).includes(entry.securityAnswer), false);
  assert.deepEqual(await crypto.decryptRecord(envelope, keys, entry.id), entry);

  const wrongKeys = {
    ...keys,
    encryptionKey: CryptoJS.enc.Hex.parse('01' + keys.encryptionKey.toString().slice(2)),
  };
  await assert.rejects(crypto.decryptRecord(envelope, wrongKeys, entry.id));

  for (const mutate of [
    (copy) => { copy.ciphertext = copy.ciphertext.slice(0, -2) + '00'; },
    (copy) => { copy.mac = '00'.repeat(32); },
    (copy) => { copy.iv = '00'.repeat(16); },
    (copy) => { copy.salt = '00'.repeat(16); },
    (copy) => { copy.updated_at = '2026-09-30T10:02:00.000Z'; },
    (copy) => { copy.crypto_version = 2; },
  ]) {
    const tampered = { ...envelope };
    mutate(tampered);
    await assert.rejects(crypto.decryptRecord(tampered, keys, entry.id));
  }
  await assert.rejects(crypto.decryptRecord(envelope, keys, 'another-record'));

  await assert.rejects(
    crypto.deriveVaultKeys(password, { ...meta, iterations: 599999 }),
    /迭代/
  );

  const originalWx = global.wx;
  global.wx = {};
  await assert.rejects(crypto.randomBytes(16), /安全随机源/);
  global.wx = {
    getRandomValues({ fail }) {
      fail(new Error('random provider failed'));
    },
  };
  await assert.rejects(crypto.randomBytes(16), /random provider failed/);
  global.wx = originalWx;

  console.log('crypto-v1: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
