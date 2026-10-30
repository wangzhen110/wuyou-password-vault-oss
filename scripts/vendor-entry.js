// vendor 打包入口：把 @noble/curves 的 P-256 打成单文件 CJS 供小程序端使用
// （小程序无法直接用 ESM npm 包；产物经 esbuild 生成 miniprogram/utils/vendor/noble-p256.js）
const { p256 } = require('@noble/curves/p256');

module.exports = { p256 };
