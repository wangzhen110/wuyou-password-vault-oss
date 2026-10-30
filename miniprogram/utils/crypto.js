/**
 * Versioned password-vault cryptography.
 *
 * Record payloads use AES-256-CBC with Encrypt-then-MAC. The MAC is checked
 * before decryption because CryptoJS does not provide an authenticated mode.
 */

const CryptoJS = require('./crypto-js.min');

const CRYPTO_VERSION = 1;
const KDF = 'PBKDF2-HMAC-SHA256';
const KDF_ITERATIONS = 600000;
const MAX_KDF_ITERATIONS = 2000000;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const IV_BYTES = 16;
const PBKDF2_YIELD_INTERVAL = 10000;

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function getRandomValues(length) {
  if (!Number.isInteger(length) || length <= 0) {
    return Promise.reject(new Error('随机数长度无效'));
  }
  if (typeof wx === 'undefined' || typeof wx.getRandomValues !== 'function') {
    return Promise.reject(new Error('当前微信基础库不支持安全随机源'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error instanceof Error ? error : new Error('安全随机源调用失败'));
        return;
      }

      const value = result && result.randomValues !== undefined
        ? result.randomValues
        : result;
      let bytes;
      try {
        if (ArrayBuffer.isView(value)) {
          bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        } else {
          // Native bridge buffers may belong to a different JavaScript realm.
          bytes = new Uint8Array(ArrayBuffer.prototype.slice.call(value, 0));
        }
      } catch (error) {
        bytes = null;
      }
      if (!bytes || bytes.length !== length) {
        reject(new Error('安全随机源返回长度错误'));
        return;
      }
      resolve(bytes);
    };

    try {
      const result = wx.getRandomValues({
        length,
        success: (value) => finish(null, value),
        fail: (error) => finish(error || new Error('安全随机源调用失败')),
      });
      if (result && typeof result.then === 'function') {
        result.then((value) => finish(null, value), (error) => finish(error));
      } else if (result !== undefined) {
        finish(null, result);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function bytesToWordArray(bytes) {
  const words = [];
  for (let index = 0; index < bytes.length; index++) {
    words[index >>> 2] = (words[index >>> 2] || 0)
      | (bytes[index] << (24 - (index % 4) * 8));
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function compressSha256(baseState, block, output, schedule) {
  for (let index = 0; index < 16; index++) schedule[index] = block[index];
  for (let index = 16; index < 64; index++) {
    const word15 = schedule[index - 15];
    const word2 = schedule[index - 2];
    const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
    const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
    schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
  }

  let a = baseState[0];
  let b = baseState[1];
  let c = baseState[2];
  let d = baseState[3];
  let e = baseState[4];
  let f = baseState[5];
  let g = baseState[6];
  let h = baseState[7];

  for (let index = 0; index < 64; index++) {
    const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + sigma1 + choose + SHA256_ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
    const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (sigma0 + majority) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  output[0] = (baseState[0] + a) >>> 0;
  output[1] = (baseState[1] + b) >>> 0;
  output[2] = (baseState[2] + c) >>> 0;
  output[3] = (baseState[3] + d) >>> 0;
  output[4] = (baseState[4] + e) >>> 0;
  output[5] = (baseState[5] + f) >>> 0;
  output[6] = (baseState[6] + g) >>> 0;
  output[7] = (baseState[7] + h) >>> 0;
}

function createHmacBaseState(passwordBytes, padByte) {
  const block = new Uint32Array(16);
  block.fill(padByte * 0x01010101);
  for (let index = 0; index < passwordBytes.length; index++) {
    block[index >>> 2] ^= passwordBytes[index] << (24 - (index % 4) * 8);
  }
  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const output = new Uint32Array(8);
  compressSha256(state, block, output, new Uint32Array(64));
  return output;
}

function passwordBytes(password) {
  let bytes = wordArrayToBytes(CryptoJS.enc.Utf8.parse(password));
  if (bytes.length > 64) bytes = wordArrayToBytes(CryptoJS.SHA256(bytesToWordArray(bytes)));
  return bytes;
}

function wordArrayToBytes(wordArray) {
  const bytes = new Uint8Array(wordArray.sigBytes);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
  }
  return bytes;
}

function setWordArrayPadding(block, messageBytes) {
  block.fill(0);
  for (let index = 0; index < messageBytes.length; index++) {
    block[index >>> 2] |= messageBytes[index] << (24 - (index % 4) * 8);
  }
  block[messageBytes.length >>> 2] |= 0x80 << (24 - (messageBytes.length % 4) * 8);
  block[15] = (64 + messageBytes.length) * 8;
}

function setDigestPadding(block, digest) {
  for (let index = 0; index < 8; index++) block[index] = digest[index];
  block[8] = 0x80000000;
  for (let index = 9; index < 15; index++) block[index] = 0;
  block[15] = 768;
}

async function derivePbkdf2(password, saltBytes, iterations, onProgress) {
  const keyBytes = passwordBytes(password);
  const innerBase = createHmacBaseState(keyBytes, 0x36);
  const outerBase = createHmacBaseState(keyBytes, 0x5c);
  const schedule = new Uint32Array(64);
  const innerDigest = new Uint32Array(8);
  const current = new Uint32Array(8);
  const accumulated = new Uint32Array(8);
  const innerBlock = new Uint32Array(16);
  const outerBlock = new Uint32Array(16);
  const outputWords = [];
  const blockCount = Math.ceil(KEY_BYTES / 32);
  const totalWork = blockCount * iterations;
  let doneWork = 0;

  for (let block = 1; block <= blockCount; block++) {
    const firstMessage = new Uint8Array(saltBytes.length + 4);
    firstMessage.set(saltBytes);
    firstMessage[saltBytes.length] = (block >>> 24) & 0xff;
    firstMessage[saltBytes.length + 1] = (block >>> 16) & 0xff;
    firstMessage[saltBytes.length + 2] = (block >>> 8) & 0xff;
    firstMessage[saltBytes.length + 3] = block & 0xff;

    setWordArrayPadding(innerBlock, firstMessage);
    compressSha256(innerBase, innerBlock, innerDigest, schedule);
    setDigestPadding(outerBlock, innerDigest);
    compressSha256(outerBase, outerBlock, current, schedule);
    accumulated.set(current);

    for (let iteration = 2; iteration <= iterations; iteration++) {
      setDigestPadding(innerBlock, current);
      compressSha256(innerBase, innerBlock, innerDigest, schedule);
      setDigestPadding(outerBlock, innerDigest);
      compressSha256(outerBase, outerBlock, current, schedule);
      for (let index = 0; index < 8; index++) accumulated[index] ^= current[index];
      if (iteration % PBKDF2_YIELD_INTERVAL === 0) {
        doneWork = (block - 1) * iterations + iteration;
        if (typeof onProgress === 'function') {
          // 进度回调只用于界面反馈，任何异常都不得中断密钥派生
          try { onProgress(Math.min(1, doneWork / totalWork)); } catch (progressError) { /* 忽略 */ }
        }
        await yieldToEventLoop();
      }
    }
    for (let index = 0; index < 8; index++) outputWords.push(accumulated[index]);
  }

  return CryptoJS.lib.WordArray.create(outputWords, KEY_BYTES);
}

function validateRecordMeta(meta) {
  if (!meta || meta.crypto_version !== CRYPTO_VERSION || meta.kdf !== KDF) {
    throw new Error('密码库加密格式不受支持');
  }
  if (!Number.isInteger(meta.iterations)
      || meta.iterations < KDF_ITERATIONS
      || meta.iterations > MAX_KDF_ITERATIONS) {
    throw new Error('密码库 KDF 迭代参数无效');
  }
  if (typeof meta.salt !== 'string' || !/^[0-9a-f]{32}$/i.test(meta.salt)) {
    throw new Error('密码库盐值无效');
  }
}

function validateVaultMeta(meta) {
  validateRecordMeta(meta);
  if (typeof meta.verifier !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.verifier)) {
    throw new Error('密码库校验值无效');
  }
}

function splitKeys(material) {
  const hex = material.toString(CryptoJS.enc.Hex);
  return {
    encryptionKey: CryptoJS.enc.Hex.parse(hex.slice(0, 64)),
    macKey: CryptoJS.enc.Hex.parse(hex.slice(64, 128)),
  };
}

async function createVaultMeta(password) {
  // 强度策略：长度是第一位的；短密码必须混合字符，长密码（≥12）允许纯短语
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('主密码至少需要 8 个字符');
  }
  if (password.length < 12 && (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))) {
    throw new Error('12 位以下的主密码需同时包含字母和数字');
  }
  const salt = await getRandomValues(SALT_BYTES);
  const material = await derivePbkdf2(password, salt, KDF_ITERATIONS);
  const keys = splitKeys(material);
  const meta = {
    crypto_version: CRYPTO_VERSION,
    kdf: KDF,
    iterations: KDF_ITERATIONS,
    salt: Array.from(salt, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    verifier: CryptoJS.HmacSHA256('vault-verifier:v1', keys.macKey).toString(),
  };
  return { meta, keys };
}

async function deriveVaultKeys(password, meta, onProgress) {
  validateVaultMeta(meta);
  if (typeof password !== 'string') throw new Error('主密码无效');
  const material = await derivePbkdf2(
    password,
    Uint8Array.from(meta.salt.match(/.{2}/g), (part) => parseInt(part, 16)),
    meta.iterations,
    onProgress
  );
  return splitKeys(material);
}

function equalHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyVaultPassword(password, meta, onProgress) {
  const keys = await deriveVaultKeys(password, meta, onProgress);
  const verifier = CryptoJS.HmacSHA256('vault-verifier:v1', keys.macKey).toString();
  return { success: equalHex(verifier, meta.verifier), keys };
}

function requireKeys(keys) {
  if (!keys || !keys.encryptionKey || !keys.macKey) {
    throw new Error('当前密码库密钥无效');
  }
}

function getAuthenticatedData(envelope) {
  return JSON.stringify([
    envelope.crypto_version,
    envelope.salt,
    envelope.id,
    envelope.created_at,
    envelope.updated_at,
    envelope.iv,
    envelope.ciphertext,
  ]);
}

async function encryptRecord(entry, keys, meta) {
  requireKeys(keys);
  validateRecordMeta(meta);
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
    throw new Error('密码条目缺少有效 ID');
  }
  const iv = await getRandomValues(IV_BYTES);
  const envelope = {
    crypto_version: CRYPTO_VERSION,
    salt: meta.salt,
    id: entry.id,
    created_at: entry.created_at || '',
    updated_at: entry.updated_at || '',
    iv: Array.from(iv, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
  const serialized = JSON.stringify(entry);
  if (typeof serialized !== 'string') throw new Error('密码条目无法序列化');
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(serialized),
    keys.encryptionKey,
    {
      iv: bytesToWordArray(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }
  );
  envelope.ciphertext = encrypted.ciphertext.toString(CryptoJS.enc.Hex);
  envelope.mac = CryptoJS.HmacSHA256(getAuthenticatedData(envelope), keys.macKey)
    .toString(CryptoJS.enc.Hex);
  // 明文删除标记（不参与 MAC）：让云端能做配额统计与开放 API 过滤。
  // 内容仍受 ciphertext + mac 保护，篡改此字段只能影响可见性。
  envelope.is_deleted = entry.is_deleted === true;
  return envelope;
}

async function decryptRecord(envelope, keys, expectedId) {
  requireKeys(keys);
  if (!envelope
      || envelope.crypto_version !== CRYPTO_VERSION
      || typeof envelope.id !== 'string'
      || (expectedId && envelope.id !== expectedId)
      || typeof envelope.salt !== 'string'
      || !/^[0-9a-f]{32}$/i.test(envelope.salt)
      || typeof envelope.created_at !== 'string'
      || typeof envelope.updated_at !== 'string'
      || typeof envelope.iv !== 'string'
      || !/^[0-9a-f]{32}$/i.test(envelope.iv)
      || typeof envelope.ciphertext !== 'string'
      || !/^(?:[0-9a-f]{2})+$/i.test(envelope.ciphertext)
      || typeof envelope.mac !== 'string'
      || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    throw new Error('密码条目封套无效');
  }

  const expectedMac = CryptoJS.HmacSHA256(getAuthenticatedData(envelope), keys.macKey)
    .toString(CryptoJS.enc.Hex);
  if (!equalHex(expectedMac, envelope.mac.toLowerCase())) {
    throw new Error('密码条目认证失败');
  }

  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Hex.parse(envelope.ciphertext),
    }),
    keys.encryptionKey,
    {
      iv: CryptoJS.enc.Hex.parse(envelope.iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }
  );
  const plaintext = decrypted.toString(CryptoJS.enc.Utf8);
  if (!plaintext) throw new Error('密码条目解密失败');
  const entry = JSON.parse(plaintext);
  if (entry.id !== envelope.id
      || (entry.created_at || '') !== envelope.created_at
      || (entry.updated_at || '') !== envelope.updated_at) {
    throw new Error('密码条目认证失败');
  }
  return entry;
}

/** bytes -> hex 小写。必须用 for 循环：Uint8Array.map 的回调返回值会被强制转回数字，
 *  字符串 "05" 会变回数字 5，导致 join 后丢失前导零（真机已踩坑）。 */
function bytesToHex(bytes) {
  let out = '';
  const list = bytes || [];
  for (let i = 0; i < list.length; i++) {
    out += list[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 用调用方提供的 32 字节 hex key 做 AES-256-CBC 加密（一次性交付场景专用）。
 * 返回 { alg, iv(32hex), ciphertext(base64) }；与 AI 侧约定的格式一致。
 */
async function encryptWithKey(plaintext, keyHex) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('一次性密钥格式无效');
  }
  const key = CryptoJS.enc.Hex.parse(keyHex.toLowerCase());
  // getRandomValues 返回 Promise（wx 安全随机源是异步 API），必须 await
  const ivBytes = await getRandomValues(16);
  const iv = bytesToWordArray(ivBytes);
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(String(plaintext)),
    key,
    { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );
  const ciphertextB64 = CryptoJS.enc.Base64.stringify(encrypted.ciphertext);
  // EtM：与 encryptRecord 一致的完整性思路——HMAC 覆盖 iv 与密文，
  // 防CBC位翻转盲篡改（key 为一次性交付专用，同 key 做 MAC 属可接受实用方案）
  const mac = CryptoJS.HmacSHA256(bytesToHex(ivBytes) + ciphertextB64, key).toString();
  return {
    alg: 'AES-256-CBC',
    iv: bytesToHex(ivBytes),
    ciphertext: ciphertextB64,
    mac,
  };
}

/**
 * 一次性交付 · 协议 v2：ECDH(P-256) 密钥协商 + AES-256-CBC 加密。
 * 端侧生成临时密钥对，用 AI 公钥协商出共享密钥加密交付内容——
 * 云端全程只见双方公钥与密文，不持有任何可解密的密钥。
 * 返回 { alg: 'AES-256-CBC-P256', my_pubkey(66hex 压缩公钥), iv(32hex), ciphertext(base64), mac(64hex) }
 * mac = HMAC-SHA256(ivHex + ciphertextB64, aesKey)，AI 侧以相同方式校验。
 */
// 懒加载 noble（BigInt 强依赖）：只在调用一次性交付时才加载，
// 加载失败/环境不支持时优雅降级——绝不阻塞启动链（4.3.7 白屏事故根因）
let nobleModule; // undefined=未加载, null=不可用, object=已加载
function loadNobleP256() {
  if (nobleModule !== undefined) return nobleModule || null;
  try {
    if (typeof BigInt !== 'function') {
      console.warn('[crypto] 当前环境不支持 BigInt，一次性交付功能不可用');
      nobleModule = null;
      return null;
    }
    nobleModule = require('./vendor/noble-p256');
    return nobleModule;
  } catch (e) {
    console.warn('[crypto] noble-p256 加载失败:', e && e.message);
    nobleModule = null;
    return null;
  }
}

async function otpEcdhEncrypt(plaintext, aiPubHex) {
  if (typeof aiPubHex !== 'string' || !/^(04)?[0-9a-f]{128}$/i.test(aiPubHex)) {
    throw new Error('AI 公钥格式无效（应为 P-256 未压缩公钥）');
  }
  const pub = aiPubHex.toLowerCase().startsWith('04') ? aiPubHex.toLowerCase() : '04' + aiPubHex.toLowerCase();
  const noble = loadNobleP256();
  if (!noble) throw new Error('当前设备不支持一次性交付功能（缺少 BigInt 支持）');
  const myPriv = noble.p256.utils.randomPrivateKey();
  const myPub = noble.p256.getPublicKey(myPriv);
  // noble getSharedSecret 返回 33 字节压缩点，取后 32 字节 x 坐标（与 Node OpenSSL 一致）
  const shared = noble.p256.getSharedSecret(myPriv, pub);
  const sharedX = shared.slice(-32);
  const aesKey = CryptoJS.SHA256(bytesToWordArray(sharedX));
  const ivBytes = await getRandomValues(16);
  const iv = bytesToWordArray(ivBytes);
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(String(plaintext)),
    aesKey,
    { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );
  const ivHex = bytesToHex(ivBytes);
  const ciphertextB64 = CryptoJS.enc.Base64.stringify(encrypted.ciphertext);
  const mac = CryptoJS.HmacSHA256(ivHex + ciphertextB64, aesKey).toString();
  return {
    alg: 'AES-256-CBC-P256',
    my_pubkey: bytesToHex(myPub),
    iv: ivHex,
    ciphertext: ciphertextB64,
    mac,
  };
}

module.exports = {
  CRYPTO_VERSION,
  KDF,
  KDF_ITERATIONS,
  randomBytes: getRandomValues,
  createVaultMeta,
  deriveVaultKeys,
  verifyVaultPassword,
  encryptRecord,
  decryptRecord,
  encryptWithKey,
  otpEcdhEncrypt,
};
