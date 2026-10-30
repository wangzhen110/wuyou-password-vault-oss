const assert = require('node:assert/strict');

let randomCounter = 17;
global.wx = {
  getRandomValues({ length, success }) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      bytes[index] = randomCounter++ & 0xff;
    }
    success({ randomValues: bytes.buffer });
  },
};

const generator = require('../miniprogram/utils/password-gen');

async function main() {
  const password = await generator.generate({ length: 24 });
  assert.equal(password.length, 24);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/);

  const digitsOnly = await generator.generate({
    length: 12,
    uppercase: false,
    lowercase: false,
    digits: true,
    symbols: false,
  });
  assert.match(digitsOnly, /^[0-9]{12}$/);

  const fallback = await generator.generate({
    length: 8,
    uppercase: false,
    lowercase: false,
    digits: false,
    symbols: false,
  });
  assert.match(fallback, /^[a-z]{8}$/);

  for (const length of [0, 7, 65, 1.5, '12']) {
    await assert.rejects(generator.generate({ length }));
  }

  global.wx = {};
  await assert.rejects(generator.generate({ length: 16 }), /安全随机源/);

  console.log('password-gen: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
