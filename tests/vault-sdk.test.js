// SDK 解密单测：用与小程序一致的算法生成封套，验证 SDK 能正确解密/验签/拒绝篡改
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { VaultClient } = require('../sdk/wuyou-vault/index.js');

const PASSWORD = 'my-master-password';
const SALT_HEX = '0123456789abcdef0123456789abcdef';
const ITERATIONS = 600000;

function deriveKeys(password) {
  const material = crypto.pbkdf2Sync(password, Buffer.from(SALT_HEX, 'hex'), ITERATIONS, 64, 'sha256');
  return { encryptionKey: material.subarray(0, 32), macKey: material.subarray(32, 64) };
}

function buildMeta(password) {
  const { macKey } = deriveKeys(password);
  const verifier = crypto.createHmac('sha256', macKey).update('vault-verifier:v1').digest('hex');
  return { version: 1, kdf: 'PBKDF2-HMAC-SHA256', iterations: ITERATIONS, salt: SALT_HEX, verifier };
}

/** 按 crypto.js 的格式生成封套 */
function encryptEntry(entry, keys) {
  const iv = crypto.randomBytes(16);
  const envelope = {
    crypto_version: 1,
    salt: SALT_HEX,
    id: entry.id,
    created_at: entry.created_at || '',
    updated_at: entry.updated_at || '',
    iv: iv.toString('hex'),
  };
  const cipher = crypto.createCipheriv('aes-256-cbc', keys.encryptionKey, iv);
  envelope.ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(entry), 'utf8'),
    cipher.final(),
  ]).toString('hex');
  envelope.mac = crypto
    .createHmac('sha256', keys.macKey)
    .update(JSON.stringify([
      envelope.crypto_version, envelope.salt, envelope.id,
      envelope.created_at, envelope.updated_at, envelope.iv, envelope.ciphertext,
    ]))
    .digest('hex');
  return envelope;
}

const ENTRY = {
  id: 'entry-1',
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z',
  platform: '测试平台',
  account: 'user@example.com',
  password: 'plain-secret',
  url: 'https://example.com',
};

function makeClient(entries) {
  const meta = buildMeta(PASSWORD);
  const client = new VaultClient({ baseUrl: 'http://local', token: 'f'.repeat(64) });
  client.request = async p => {
    if (p.startsWith('/v1/vault/meta')) return { success: true, vault_meta: meta };
    if (p.startsWith('/v1/items')) return { success: true, items: entries };
    throw new Error('unexpected ' + p);
  };
  return client;
}

test('unlocks with the right password and decrypts entries locally', async () => {
  const keys = deriveKeys(PASSWORD);
  const envelope = encryptEntry(ENTRY, keys);
  const client = makeClient([envelope]);

  await client.unlock(PASSWORD);
  const items = await client.list();
  assert.equal(items.length, 1);
  assert.equal(client.getField(items[0], 'password'), 'plain-secret');
  assert.equal(client.getField(items[0], 'account'), 'user@example.com');
  assert.equal(items[0]._id, 'entry-1');
});

test('rejects a wrong master password at unlock time', async () => {
  const client = makeClient([]);
  await assert.rejects(() => client.unlock('wrong-password'), /主密码不正确/);
});

test('rejects tampered ciphertext or envelope metadata', async () => {
  const keys = deriveKeys(PASSWORD);
  const tampered = encryptEntry(ENTRY, keys);
  tampered.ciphertext = tampered.ciphertext.replace(/^../, 'ff');

  const client = makeClient([tampered]);
  await client.unlock(PASSWORD);
  // list() 会跳过解密失败的条目并记录失败
  const items = await client.list();
  assert.equal(items.length, 0);

  const modified = encryptEntry(ENTRY, keys);
  modified.updated_at = '2027-01-01T00:00:00.000Z'; // 改元数据也会被认证拒绝
  const client2 = makeClient([modified]);
  await client2.unlock(PASSWORD);
  assert.equal((await client2.list()).length, 0);
});

test('skips soft-deleted entries', async () => {
  const keys = deriveKeys(PASSWORD);
  const alive = encryptEntry(ENTRY, keys);
  const deleted = { ...encryptEntry({ ...ENTRY, id: 'entry-2' }, keys), is_deleted: true };
  const client = makeClient([alive, deleted]);
  await client.unlock(PASSWORD);
  const items = await client.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]._id, 'entry-1');
});
