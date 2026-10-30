const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'utils', 'crypto-js.min.js'),
  'utf8',
);
let mathRandomCalls = 0;
const sandbox = {
  module: { exports: {} },
  exports: {},
  Math: Object.create(Math),
  Uint8Array,
};
sandbox.Math.random = () => {
  mathRandomCalls++;
  return 0.5;
};

vm.runInNewContext(source, sandbox, { filename: 'crypto-js.min.js' });
const CryptoJS = sandbox.module.exports;

assert.throws(
  () => CryptoJS.lib.WordArray.random(16),
  /secure random|crypto|random/i,
  'CryptoJS random must fail without a secure random provider',
);
assert.equal(mathRandomCalls, 0, 'CryptoJS must never fall back to Math.random');
console.log('crypto-random-fail-closed: all checks passed');
