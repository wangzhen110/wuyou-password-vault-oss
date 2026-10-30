# 无忧密码本 · 开放 API 接入文档（v1）

> 版本：v1（2026-10-18）· 权限：**只读 + 会员专属** · 安全模型：**云端只返回密文，解密在调用方本地完成**

> **在线文档（固定地址，可直接发给开发者或 AI）**：
> https://your-cloud-env-id-1448869858.tcloudbaseapp.com/api-doc.html
> 源码：`docs/api-doc.html`（改文档改这个文件，重新上传静态托管覆盖同名文件，URL 不变）

---

## 一、概览

开放 API 让第三方程序（脚本、插件、自建服务）读取用户在无忧密码本中保存的账号密码，免去手动输入。

**开通前提**：开放 API 是**年度会员专属权益**。非会员（或会员已到期）在小程序内无法生成授权码，已签发的令牌也会在会员到期后立即失效（返回 403 `vip_required`）。

三条硬约束，先读：

1. **接口只返回密文**：`ciphertext` / `iv` / `mac` / `salt`，没有任何明文密码字段。
2. **解密在调用方本地**：需要用户的主密码，通过 KDF 复现密钥后自行解密。服务端不掌握主密码。
3. **只读**：本版本不支持第三方写入、修改、删除。

**基础信息**

| 项 | 值 |
|---|---|
| Base URL | `https://your-cloud-env-id-1448869858.ap-shanghai.app.tcloudbase.com/v1` |
| 鉴权 | `Authorization: Bearer <token>` |
| 内容类型 | `application/json`（UTF-8） |
| 令牌有效期 | 7 天（2026-10-22 由 30 天缩短，一次性交付为主），可随时在小程序内吊销 |
| 一次性交付（协议 v2） | `POST /v1/request` 新增 `curve: "p256"` + `ai_pubkey`（130 hex 未压缩公钥）替代 `key_hex`——ECDH 密钥协商，云端零密钥（4.2.15） |
| 交付解密（v2） | 取件响应 `delivery.my_pubkey` + 自己私钥 → ECDH → SHA-256 → AES-256-CBC；先校验 `mac`（HMAC-SHA256(ivHex+ciphertextB64, aesKey)）；SDK 用 `decryptOtpDelivery()` |
| 限流 | 每令牌 60 次/分钟（超限返回 429） |
| 每账号设备上限 | 5 台 |

---

## 二、授权流程（三步）

```text
① 用户在小程序：设置 → 开发者 → 开放 API 授权 → 生成授权码（8 位，5 分钟有效）
② 第三方程序：POST /v1/token { code, device_name }        → 202 pending_confirmation
   用户在小程序内看到设备名 → 点「允许接入」
③ 第三方程序：再次 POST /v1/token { code, device_name }    → 200 { token }
```

要点：
- 授权码**一次性**，用后即废；5 分钟过期。
- 第三步必须重新提交，令牌只在这一次响应中出现，**服务端只保存其哈希**。
- 用户拒绝 → 403 `rejected_by_user`；已用过 → 410 `code_used`。

---

## 三、接口

### 3.1 换取令牌

`POST /v1/token`（`GET /v1/token` 等价，参数可用 query）

请求：

```json
{ "code": "123456", "device_name": "我的脚本" }
```

响应（等待用户确认）：

```json
// HTTP 202
{ "success": false, "status": "pending_confirmation", "message": "请在小程序内确认该设备接入" }
```

响应（成功签发）：

```json
// HTTP 200
{ "success": true, "token": "<64 位十六进制>", "expires_in": 604800, "scopes": ["items:read"] }
```

错误：

| HTTP | error | 说明 |
|---|---|---|
| 400 | `invalid_code` | 码格式不对（必须是 8 位数字） |
| 404 | `code_not_found` | 码不存在 |
| 410 | `code_expired` | 码已过期 |
| 410 | `code_used` | 码已被使用 |
| 403 | `rejected_by_user` | 用户拒绝 |
| 429 | `too_many_attempts` | 同一 IP 失败次数过多，稍后重试 |
| 410 | `code_locked` | 该码错误尝试过多已被锁定 |

### 3.2 读取密码库公开参数

`GET /v1/vault/meta`　`Authorization: Bearer <token>`

```json
{
  "success": true,
  "vault_meta": {
    "version": 1,
    "kdf": "PBKDF2-HMAC-SHA256",
    "iterations": 600000,
    "salt": "0123456789abcdef0123456789abcdef"
  }
}
```

> 这些参数是**公开的**（不含密钥），用于本地派生密钥。
> **不返回 verifier**（4.2.9 起）：verifier 是离线验证猜测主密码的凭据，服务端不对外暴露。校验主密码是否正确，以「解密后 MAC 校验是否通过」为准。

### 3.3 拉取密文条目

`GET /v1/items?since=<毫秒时间戳>&limit=100`

```json
{
  "success": true,
  "items": [
    {
      "id": "entry-1",
      "crypto_version": 1,
      "iv": "<32 位十六进制>",
      "ciphertext": "<偶数位十六进制>",
      "mac": "<64 位十六进制>",
      "salt": "<32 位十六进制>",
      "created_at": "2026-10-18T00:00:00.000Z",
      "updated_at": "2026-10-18T00:00:00.000Z"
    }
  ],
  "next_since": 1792290000000,
  "server_time": 1792290000000
}
```

- `since`：只返回 `updated_at` **晚于**该时间的条目（增量同步，服务端下推到查询条件，不受单页上限影响）。
- `limit`：1–100，默认 100。
- **排序**：按 `updated_at` **升序**（旧→新）返回，配合游标翻页保证不重不漏。
- `next_since`：**满页时**返回本页最新一条的 `updated_at`（毫秒时间戳），下次请求作为 `since` 继续拉取；**未满页时为 `null`**，表示已取完。
- 已软删除的条目**不会**出现在响应中。

**增量同步标准写法**：

```js
let since = 0;
for (;;) {
  const { items, next_since } = await vault.request(`/v1/items?since=${since}&limit=100`);
  process(items);
  if (next_since === null || next_since === undefined) break;
  since = next_since;
}
```

> 修复说明（4.0.97 后）：旧实现先在 `limit` 截断再按 `since` 过滤，单页之外的增量会被静默丢弃；现改为 `since` 下推查询 + `next_since` 游标，超过 100 条更新的账号可完整补齐。

### 3.4 通用错误

| HTTP | error | 处理建议 |
|---|---|---|
| 401 | `unauthorized` | 令牌缺失或无效，重新授权 |
| 403 | `token_revoked` | 用户已吊销，重新授权 |
| 403 | `token_expired` | 令牌过期（7 天），重新授权 |
| 429 | `rate_limited` | 超过 60 次/分钟，退避重试 |
| 403 | `vip_required` | 会员已到期，开放 API 不可用（续费后恢复） |
| 404 | `not_found` | 路径错误 |
| 500 | `internal_error` | 服务端异常，可退避重试 |

---

## 四、本地解密规范（必须严格一致）

密码库格式：**PBKDF2-HMAC-SHA256（60 万次）+ AES-256-CBC + Encrypt-then-MAC**。

### 4.1 派生密钥

```text
material = PBKDF2-HMAC-SHA256(masterPassword, salt, iterations=600000, dkLen=64)
encryptionKey = material[0..32)      // 32 字节，AES-256 密钥
macKey        = material[32..64)     // 32 字节，HMAC 密钥
```

### 4.2 校验主密码

```text
verifier = hex(HMAC-SHA256(key=macKey, msg="vault-verifier:v1"))
verifier === meta.verifier  → 主密码正确
```

### 4.3 验证并解密一条记录

**认证数据（AAD）必须是这个顺序的 JSON 数组**：

```js
const aad = JSON.stringify([
  envelope.crypto_version,
  envelope.salt,
  envelope.id,
  envelope.created_at,
  envelope.updated_at,
  envelope.iv,
  envelope.ciphertext,
]);
```

1. 计算 `expectedMac = hex(HMAC-SHA256(key=macKey, msg=aad))`；
2. 与 `envelope.mac` 常量时间比较，不一致 → **拒绝该条（密文被篡改）**；
3. `AES-256-CBC` 解密 `ciphertext`（`iv` 为十六进制，PKCS#7 填充）；
4. `JSON.parse` 得到条目对象（含 `platform`、`account`、`password`、`url`、`fields` 等）。

> 注意：`created_at` / `updated_at` 参与签名，**不能省略或改写**，否则验签失败。

---

## 五、SDK 用法（Node.js）

```js
const { VaultClient } = require('./sdk/wuyou-vault');

const vault = new VaultClient({
  baseUrl: 'https://your-cloud-env-id-1448869858.ap-shanghai.app.tcloudbase.com/v1',
  token: '<授权拿到的 token>',
});

await vault.unlock('<用户主密码>');      // 派生密钥 + verifier 校验
const items = await vault.list();        // 拉取并本地解密（自动跳过软删除）
const pwd = vault.getField(items[0], 'password');
```

手工实现也可，只需按第四节步骤即可，不依赖 SDK。

---

## 六、安全须知

1. **主密码只在本地使用**：任何要求你把主密码上传到服务器的服务都应视为危险。
2. 令牌只授予"读取密文"的权限；即使泄露，攻击者仍缺主密码。
3. SDK 不把密钥写入磁盘，进程退出即失效；请勿自行持久化 `encryptionKey` / `macKey`。
4. 用户在小程序内可随时吊销设备，吊销立即生效。
5. 全部访问写入审计日志（时间、设备、条目数量、IP），用户可在小程序内查看授权设备。

---

## 七、常见问题

| 问题 | 说明 |
|---|---|
| 令牌换到了但拉数据 401 | 确认 `Authorization: Bearer <token>` 格式；token 只出现一次，请立即保存 |
| 提交授权码一直 202 | 需要用户在小程序内点「允许接入」，然后**重新提交** |
| 解密报"认证失败" | AAD 字段顺序/数据被改动；确认 `created_at`/`updated_at` 原样传入 |
| 主密码正确但 verifier 不匹配 | 用户可能已修改主密码：meta 会变化，需重新 `GET /v1/vault/meta` 并重新 unlock |
| 能否写回密码 | 本版本只读，写入（`items:write`）在后续版本开放 |
| 支持哪些端 | 任意能发 HTTPS 的程序；浏览器插件将后续提供示例 |
