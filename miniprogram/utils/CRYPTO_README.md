# 加密格式与本地依赖

> 本文描述仓库当前源码，不代表独立密码学审计、真机性能测试或云端部署验收。项目当前状态以[项目状态与路线图](../../docs/项目状态与路线图.md)为准。

## 本地依赖

`crypto.js` 使用相邻文件 `crypto-js.min.js`（`require('./crypto-js.min')`）。该库文件已随仓库提供；小程序端不需要执行 `npm install crypto-js`，也不需要为它单独构建 npm。

不要从网络下载或裁剪替换此文件作为常规安装步骤。若依赖文件缺失或变更，应先核对 `crypto.js` 的导入和用到的 CryptoJS API，再通过项目既有验证流程确认兼容性。

## 当前密码记录封套

新格式由 `miniprogram/utils/crypto.js` 实现：

- `crypto_version: 1`
- PBKDF2-HMAC-SHA256，源码默认迭代 600,000 次，随机 salt 为 16 字节
- PBKDF2 使用专用 SHA-256 压缩路径减少每轮对象分配；这是实现优化，不改变 PBKDF2 结果或迭代参数
- 派生 64 字节材料，拆分为 AES 与 MAC 密钥
- 正文使用 AES-256-CBC；HMAC-SHA256 认证封套元数据和密文
- 解密前先验证 MAC；安全随机源不可用时失败关闭

这些是当前源码参数，不应表述为“已独立审计”或“已在真机验证”。兼容读取还包含旧主密码校验：SHA-256 初始计算后执行 500 次迭代哈希；它不是 PBKDF2，也不是新格式的密钥派生参数。迁移结果、旧云端记录和备份处置需分别核实。

## 云端密码库元数据

同步云函数提供 `get_vault_meta` / `set_vault_meta`，源码使用 `version`、`kdf`、`iterations`、`salt`、`verifier` 字段。元数据用于密码库格式与口令校验；它不含主密码。`ensureCollections` 仅尝试创建并验证 `orders` 与 `vault_meta` 集合。代码存在不等于云端集合已部署或可写，操作步骤见[云数据库集合说明](../../CLOUD_DATABASE_SETUP.md)和[部署指南](../../DEPLOY_GUIDE.md)。

## 相关源码

- [crypto.js](crypto.js)：封套、密钥派生、加解密与认证
- [storage.js](storage.js)：本地记录、旧格式验证与迁移、软删除
- [sync/index.js](../../cloudfunctions/sync/index.js)：云端封套及元数据校验
