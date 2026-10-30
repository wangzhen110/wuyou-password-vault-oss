# 无忧密码本（开源版）

一个基于微信云开发的密码/账号管理小程序。**端到端加密，服务端只存密文。**

> 本仓库为开源存档版本，作者已暂停维护。代码完整可用，欢迎自建、学习或二次开发。
>
> 📜 **为什么停在这里** → [`docs/墓志铭.md`](docs/墓志铭.md)

---

## 这是什么

微信小程序 + 云开发的个人密码管理工具。所有敏感数据在主密码派生出的密钥下加密后才上传，云端永远拿不到明文。

**核心特性**

| 特性 | 实现 |
|---|---|
| 端到端加密 | PBKDF2-HMAC-SHA256（600,000 次迭代，16 字节盐）派生 64 字节材料，拆分为 AES-256 密钥 + HMAC-SHA256 密钥 |
| 加密模式 | AES-256-CBC + HMAC-SHA256，Encrypt-then-MAC，先加密后认证 |
| 完整性 | MAC 覆盖密文与关键字段，防篡改 |
| 密码库列表 | 按平台名自动分组、可折叠、抽屉式导航 |
| 录入 | 平台名自动补全（候选取自已有记录）、密码强度提示、随机生成 |
| 备份 | 加密导出 / 导入，取件链接一次性、10 分钟过期、5 次密码错误即失效 |
| 会员 | 免费 10 条 / 会员 500 条 + 邀请奖励叠加 |
| 其他 | 深色/浅色主题、离线模式、演示模式、邀请码、微信支付 |

---

## 技术栈

- **前端**：微信小程序原生（无框架）
- **后端**：微信云开发（云函数 14 个 + 云数据库 + 云存储）
- **测试**：Node.js 原生测试运行器，**193 个用例**
- **代码量**：约 24,000 行（不含依赖）

---

## 快速开始

### 1. 准备

- 微信开发者工具
- 一个云开发环境（[开通指引](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)）

### 2. 配置

替换以下占位符为你的真实值：

| 占位符 | 出现位置 | 替换为 |
|---|---|---|
| `wx0000000000000000` | `project.config.json`、`miniprogram/config.js` 等 | 你的小程序 AppID |
| `your-cloud-env-id` | 各云函数与前端配置 | 你的云开发环境 ID |

### 3. 部署云函数

```bash
# 每个云函数目录内先安装生产依赖
cd cloudfunctions/sync && npm install --production

# 用微信开发者工具右键上传，或使用 CLI
```

### 4. 配置环境变量（云函数级，不继承）

| 变量 | 用途 | 必需 |
|---|---|---|
| `VPAY_APP_KEY` / `VPAY_APP_SECRET` | 虚拟支付签名 | 仅付费功能 |
| `WX_APP_ID` | 小程序 AppID | 仅支付/开放接口 |
| `VPAY_ENV` | 支付环境（0 正式 / 1 沙箱） | 仅付费功能 |

> **密钥只走环境变量，绝不写进代码。** 开源版已移除所有真实凭据。

### 5. 初始化数据库集合

运行 `cloudfunctions/ensureCollections` 自动建集合，或参考 `docs/` 下的数据模型说明。

---

## 目录结构

```
miniprogram/          小程序前端
  pages/              页面（index 密码库 / add 录入 / lock 解锁 / settings / member …）
  components/         组件（comp-pwd-field 密码框 / comp-lock-screen 锁屏 / comp-nav-bar …）
  utils/              核心逻辑
    crypto.js         加解密（PBKDF2 / AES / HMAC）
    storage.js        本地存储 + 云端同步
    member.js         会员权益
    diagnostics.js    脱敏日志
cloudfunctions/       14 个云函数
  sync/               数据同步
  login/              登录与权益
  pay/ vpay/          支付
  backupDownload/     加密备份取件
  janitor/            过期数据清理
  openapi/            开放接口（Token 交换）
tests/                193 个测试
docs/                 设计文档与安全说明
```

---

## 安全说明

详细的安全设计与自查结论见：

- [`docs/安全说明-用户向.md`](docs/安全说明-用户向.md) — 面向普通用户的说明
- [`docs/安全自查报告-公开版.md`](docs/安全自查报告-公开版.md) — 面向开发者的技术细节

**已知限制**（诚实披露）

1. 小程序**无法实现系统级自动填充**（需要原生 App 的 Autofill 权限），每次取用需手动复制。
2. 主密码丢失后**无法找回**（这是端到端加密的必然结果，不是缺陷）。
3. 云函数 Node 版本为 16.13（已 EOL），升级需重建函数。
4. 部分云函数的圈复杂度偏高（最高 55），重构待办。

---

## 开发命令

```bash
npm test              # 跑测试
npm run test:coverage # 带覆盖率
npm run test:gate     # 完整门禁：lint + ui-lint + 安全扫描 + 守卫 + 覆盖率
npm run lint          # ESLint
npm run security:scan # 密钥泄露扫描
```

覆盖率门槛：行 66% / 分支 68% / 函数 54%。

---

## 许可

[MIT](LICENSE)

代码按「现状」提供，不附带任何担保。**如果你要部署到生产环境，请自行完成安全审计与合规评估。**

---

## 致谢

加密方案参考了 [Bitwarden](https://github.com/bitwarden) 与 [KeePassDX](https://github.com/Kunzisoft/KeePassDX) 的公开设计思路；UI 布局调研参考了 Ant Design、Flutter Material 的官方文档。
