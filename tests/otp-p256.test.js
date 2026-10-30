// 一次性交付协议 v2（ECDH P-256）跨实现端到端测试
// 端侧模拟：noble（与 miniprogram/utils/vendor/noble-p256.js 同源，IV 用 node randomBytes
// 替代 wx.getRandomValues——算法核心一致，仅随机源宿主不同）
// AI 侧：sdk/wuyou-vault（Node 原生 crypto，与真实第三方用法一致）
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { p256 } = require(path.join(ROOT, 'miniprogram/utils/vendor/noble-p256.js'));
const sdk = require(path.join(ROOT, 'sdk/wuyou-vault/index.js'));

// 端侧等价实现：与 miniprogram crypto.js otpEcdhEncrypt 逻辑一致（IV 来源除外）
function encryptOnDeviceSide(plaintextJson, aiPubHex) {
  const pub = aiPubHex.toLowerCase().startsWith('04') ? aiPubHex.toLowerCase() : '04' + aiPubHex.toLowerCase();
  const myPriv = p256.utils.randomPrivateKey();
  const myPub = Buffer.from(p256.getPublicKey(myPriv)).toString('hex');
  const shared = p256.getSharedSecret(myPriv, pub);
  const sharedX = shared.slice(-32); // noble 返回 33 字节压缩点，取后 32 字节 x
  const aesKey = crypto.createHash('sha256').update(Buffer.from(sharedX)).digest(); // Buffer(32)
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ciphertextB64 = Buffer.concat([cipher.update(Buffer.from(plaintextJson, 'utf8')), cipher.final()]).toString('base64');
  const ivHex = iv.toString('hex');
  const mac = crypto.createHmac('sha256', aesKey).update(ivHex + ciphertextB64).digest('hex');
  return { alg: 'AES-256-CBC-P256', my_pubkey: myPub, iv: ivHex, ciphertext: ciphertextB64, mac };
}

test('协议 v2：端侧加密 → AI 侧解密，内容一致', () => {
  const kp = sdk.generateOtpKeypair();
  assert.equal(kp.curve, 'p256');
  assert.match(kp.public_key, /^04[0-9a-f]{128}$/);

  const entry = { id: 'entry-1', platform: '微信', account: 'user@example.com', password: 'p@ss 密码测试' };
  const delivery = encryptOnDeviceSide(JSON.stringify(entry), kp.public_key);

  const decrypted = sdk.decryptOtpDelivery(delivery, kp.private_key);
  assert.deepEqual(decrypted, entry);
});

test('协议 v2：密文被篡改时 MAC 校验必须失败', () => {
  const kp = sdk.generateOtpKeypair();
  const entry = { id: 'e2', platform: 'GitHub', password: 'secret' };
  const delivery = encryptOnDeviceSide(JSON.stringify(entry), kp.public_key);

  // 篡改密文（翻转 base64 尾部字符）
  const tampered = { ...delivery, ciphertext: delivery.ciphertext.slice(0, -2) + (delivery.ciphertext.endsWith('A') ? 'B' : 'A') };
  assert.throws(() => sdk.decryptOtpDelivery(tampered, kp.private_key), /MAC 校验失败/);

  // 换用错误的私钥也必须失败
  const wrongKp = sdk.generateOtpKeypair();
  assert.throws(() => sdk.decryptOtpDelivery(delivery, wrongKp.private_key), /MAC 校验失败/);
});

test('协议 v2：旧对称协议的交付（无 my_pubkey）必须被 SDK 拒绝', () => {
  const legacy = { alg: 'AES-256-CBC', iv: 'ab'.repeat(16), ciphertext: 'AAECAwQFBgcICQ==' };
  assert.throws(() => sdk.decryptOtpDelivery(legacy, 'ab'.repeat(32)), /未知交付算法|my_pubkey/);
});
