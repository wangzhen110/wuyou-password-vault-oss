/**
 * Cryptographically secure password generator.
 */

const crypto = require('./crypto');

const CHARS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};

async function randomInt(max) {
  const range = 0x100000000;
  const limit = Math.floor(range / max) * max;
  while (true) {
    const bytes = await crypto.randomBytes(4);
    const value = bytes[0] * 0x1000000
      + bytes[1] * 0x10000
      + bytes[2] * 0x100
      + bytes[3];
    if (value < limit) return value % max;
  }
}

async function generate(options = {}) {
  const length = options.length === undefined ? 16 : options.length;
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new Error('密码长度必须为 8 到 64 的整数');
  }

  const digits = options.digits === undefined
    ? (options.numbers === undefined ? true : !!options.numbers)
    : !!options.digits;
  const enabled = [
    ['uppercase', options.uppercase === undefined ? true : !!options.uppercase],
    ['lowercase', options.lowercase === undefined ? true : !!options.lowercase],
    ['digits', digits],
    ['symbols', options.symbols === undefined ? true : !!options.symbols],
  ];
  let pools = enabled.filter(([, include]) => include).map(([name]) => CHARS[name]);
  if (pools.length === 0) pools = [CHARS.lowercase];
  if (length < pools.length) throw new Error('密码长度不足以覆盖所选字符类别');

  const charset = pools.join('');
  const chars = [];
  for (const pool of pools) {
    chars.push(pool[await randomInt(pool.length)]);
  }
  while (chars.length < length) {
    chars.push(charset[await randomInt(charset.length)]);
  }
  for (let index = chars.length - 1; index > 0; index--) {
    const other = await randomInt(index + 1);
    [chars[index], chars[other]] = [chars[other], chars[index]];
  }
  return chars.join('');
}

/**
 * 检测密码强度
 * @param {string} password - 密码
 * @returns {object} { score: 0-4, label: string, color: string }
 */
function checkStrength(password) {
  if (!password) return { score: 0, label: '无', color: '#64748b' };

  let score = 0;
  const len = password.length;
  if (len >= 8) score++;
  if (len >= 12) score++;
  if (len >= 16) score++;

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const types = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (types >= 3) score++;
  if (types >= 4) score++;
  score = Math.min(4, Math.max(0, Math.round(score * 4 / 5)));

  const levels = [
    { level: 'very-weak', label: '很弱', color: '#ef4444' },
    { level: 'weak', label: '弱', color: '#f97316' },
    { level: 'fair', label: '一般', color: '#f59e0b' },
    { level: 'strong', label: '强', color: '#22c55e' },
    { level: 'very-strong', label: '很强', color: '#10b981' },
  ];
  return { score, ...levels[score] };
}

module.exports = { generate, checkStrength };
