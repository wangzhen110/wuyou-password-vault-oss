# 技术方案：开发者密码中台 V2（MCP Server）

> 版本：v1.0 | 日期：2026-09-28
> 上游文档：`docs/prd-developer-access.md`（PRD v0.1）
> 前置依赖：无忧密码本 V1 正式上线（备案 + 提审通过）
> 本文回答 PRD TODO 中的前三项：云接入调研结论、MCP Server 技术选型、token/审计表结构设计
>
> **历史技术提案快照，不是当前架构、接口契约、调研结论或实施计划。** 本文方案未据此证明已实现；“M0”调研记录未经本轮复核，表结构、权限与安全假设均待重新评审。当前状态以[项目状态与路线图](项目状态与路线图.md)为准；当前加密格式见[加密说明](../miniprogram/utils/CRYPTO_README.md)，集合与部署边界见[云数据库说明](../CLOUD_DATABASE_SETUP.md)。

---

## 一、当时记录的云接入调研选项（未复核）

### 1.1 可选链路对比

| 链路 | 机制 | 适用 | 结论 |
|------|------|------|------|
| `wx.cloud.callHTTPFunction` | 当时记录为小程序内直接 HTTP 调用云函数的选项；基础库版本及能力需重新核对 | 小程序端 | 候选方案，未核验 |
| 云接入 HTTP 访问服务 | 当时记录为云函数 HTTP 访问选项；域名、CORS、鉴权与额度需重新核对 | 浏览器 / 第三方 / 本机程序 | 候选方案，未核验 |
| 第三方 access_token 鉴权 | 当时记录的 appid + appsecret 换 token 方案 | 微信官方生态调用 | 历史安全讨论；任何凭据分发方案都需单独威胁评估 |

### 1.2 关键安全结论：不能依赖微信 access_token 做用户级鉴权

微信 access_token 是**小程序全局凭据**（appid+appsecret 换取）。如果 MCP Server 用它调云接入端点：

- appsecret 必须存在用户本机 → 泄露 = 整个小程序后端沦陷
- 无法区分"哪个用户"在调用 → 做不到按 openid 隔离

**当时的提案倾向：自建令牌体系。** 这不是已确认或已实施的鉴权决策：

```
本地 MCP Server
   │  Authorization: Bearer <dev_token>     ← 用户在小程序里生成的开发者令牌
   ▼
云接入 HTTP 端点（devapi 云函数）
   │  校验 dev_token → 解析出 openid → 权限判定（提案）
   ▼
返回授权范围内的数据（密文、筛选元数据及解密边界尚未定案）
```

- 提案设想 dev_token 只能访问该 openid 的授权范围；权限模型、数据筛选方式和泄露影响面尚未验证。
- 不把 appsecret 下发至客户端是提案中的安全约束，不代表已有令牌体系。

### 1.3 小程序端与 MCP 端的分工

| 端 | 调用方式 | 职责 |
|----|---------|------|
| 小程序 | `wx.cloud.callFunction`（现有链路不变） | 授权管理 UI：生成/吊销 token、条目打标、模式设置、逐次确认审批、查审计日志 |
| 本地 MCP Server | 云接入 HTTP 端点 | 拉密文 → 本地解密 → 向 AI 工具提供 tools |

---

## 二、V2 总体架构

### 2.1 架构图（文字版）

```
┌─────────────────────────────────────────────────────┐
│ AI 工具（Cursor / Claude Code / WorkBuddy）          │
│    │ stdio (MCP 协议)                                │
│    ▼                                                 │
│ 本地 MCP Server（Node.js，用户本机常驻/按需启动）      │
│  ├─ tools: list_secrets / search_secrets / get_secret│
│  ├─ 本地密文缓存（复用现有离线模式的加密存储结构）        │
│  ├─ 主密钥：首次使用时用户输入主密码解锁一次，           │
│  │   派生密钥存 OS 凭据管理器（Windows DPAPI / macOS   │
│  │   Keychain），明文密钥不落盘                        │
│  └─ HTTP Client                                      │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS + Bearer dev_token
               ▼
┌─────────────────────────────────────────────────────┐
│ 云开发                                                │
│  ├─ devapi 云函数（云接入 HTTP 端点）                  │
│  │   · token 校验 / 限流 / 审计 / 权限判定             │
│  ├─ collections: dev_tokens / dev_pending_requests   │
│  │   / dev_audit_logs（见第四节）                     │
│  └─ 源码/说明涉及的集合（passwords / vault_meta / orders）│
│               ▲                                      │
│ 小程序端 ──────┘ callFunction                         │
│  · 授权管理页（M1）· 逐次确认审批（轮询 pending）       │
└─────────────────────────────────────────────────────┘
```

### 2.2 数据流：三种操作

| 操作 | 链路 | 说明 |
|------|------|------|
| 首次同步 | MCP → devapi 拉全量密文 → 本地缓存 | 与小程序离线模式同源（密文本就存在小程序 storage），MCP 缓存独立存放 |
| 随时可取条目读取 | 本地缓存解密直接返回 | 不联网也可用（缓存有效期内） |
| 逐次确认条目读取 | MCP → devapi 写 pending_request → 小程序轮询发现 → 用户点允许 → devapi 标记 approved → MCP 收到放行 → 本地解密返回 | 60 秒 TTL，超时自动过期；详见 2.4 |

### 2.3 逐次确认的状态机

```
pending（MCP 发起，60s TTL）
  ├─ approved（用户点允许）→ MCP 拉取放行凭证 → 返回明文 → consumed
  ├─ denied（用户点拒绝）→ 终态，审计记录 denied
  └─ expired（60s 无响应）→ 终态，审计记录 expired
```

- 小程序端发现机制：`onShow` 触发拉取 + 授权管理页打开时 10s 轮询（PRD 已否决订阅消息，理由不变）
- 放行凭证：approved 时 devapi 生成一次性 `approval_code`（60s 有效、单次使用），MCP 凭它换取该条目密文——**确认状态判定完全在服务端**，MCP 本地无法伪造

### 2.4 MCP Server 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 协议 SDK | `@modelcontextprotocol/sdk`（官方） | stdio transport 开箱即用，Cursor/Claude Code/WorkBuddy 均兼容 |
| 运行时 | Node.js 18+ | 与云函数技术栈一致，一份加解密代码（AES-256-CBC + PBKDF2）可复用 |
| 分发 | npm 包 + 一键配置片段（各工具的 mcp 配置 JSON 直接给出） | 降低安装门槛；后续再考虑桌面安装包 |
| 本地缓存加密 | 密文原样落盘（本就是 AES 密文）+ 缓存元数据明文 | 与小程序端离线模式对齐 |
| 主密钥驻留 | OS 凭据管理器（DPAPI/Keychain），进程内存缓存 | 重启后需重新解锁一次；不做"记住明文密钥"选项 |

**MCP tools 规范（V2 只读三个）：**

| tool | 入参 | 出参 | 权限 |
|------|------|------|------|
| `list_secrets` | tag?（可选过滤） | 条目列表：id / 名称 / 用户名 / 标签 / api_mode（**不含密码**） | scopes 含 list |
| `search_secrets` | query（名称/用户名/标签模糊） | 同上 | scopes 含 search |
| `get_secret` | entry_id | 明文密码（结构化返回） | scopes 含 get；且条目已打标「API 可取」；逐次确认条目需 approval_code 链路放行 |

明文只经 `get_secret` 结构化返回；`list/search` 永不携带明文（防提示词注入的第一道闸，对应 PRD 铁律 5）。

---

## 三、token 表结构（dev_tokens）

```javascript
{
  _id: "auto",
  openid: "oXXXX",              // 归属用户，从校验链路得出，不信任请求体
  name: "我的 WorkBuddy",       // 用户起的名字
  token_hash: "sha256hex",      // 只存哈希；token 明文生成时展示一次即弃
  token_prefix: "wypwd_a1b2",   // 前 12 位明文，用于小程序内展示识别
  scopes: ["list", "search", "get"],   // 最小权限，生成时用户勾选
  entry_scope: {                // 作用域：条目 id 集合 或 标签集合（二选一或并集）
    mode: "tags",               // "ids" | "tags"
    tags: ["dev", "low-risk"],
    ids: []
  },
  expires_at: 1790000000000,    // 可选；null = 永不过期（生成时必须显式选择）
  revoked_at: null,             // 非空 = 已吊销，校验第一步即拒绝
  rate_limit: 60,               // 次/分钟，devapi 侧滑动窗口计数
  created_at: 1789000000000,
  last_used_at: 1789990000000
}
```

**校验顺序（devapi 每次请求）：**
`revoked_at 非空？→ expires_at 过期？→ rate_limit 超限？→ scopes 含所需权限？→ 目标条目在 entry_scope 内且已打标「API 可取」？`

任一不满足 → 拒绝 + 写审计日志（拒绝也要留痕）。

---

## 四、审计日志与 pending 表结构

### 4.1 dev_audit_logs

```javascript
{
  _id: "auto",
  openid: "oXXXX",
  token_id: "dev_tokens._id",   // 小程序端操作记 "console"
  action: "get_secret",         // list_secrets / search_secrets / get_secret
                                // / approve / deny / token_created / token_revoked
  entry_id: "vault条目id",       // 无关操作记 null
  result: "ok",                 // ok / denied_scope / denied_mode / rate_limited
                                // / expired / not_found
  channel: "mcp",               // mcp / console
  client: "WorkBuddy/1.0",      // MCP 上报的 User-Agent，仅供参考不作为凭据
  ts: 1789990000000
}
```

保留策略：免费 7 天（定时清理云函数，可挂到现有 `payCallback` 同款定时触发器体系），会员 180 天 + 导出（导出走小程序端拉取，生成文件放云存储）。

### 4.2 dev_pending_requests

```javascript
{
  _id: "auto",
  openid: "oXXXX",
  token_id: "dev_tokens._id",
  entry_id: "vault条目id",
  status: "pending",            // pending / approved / denied / expired / consumed
  approval_code_hash: "sha256", // approved 时生成；MCP 凭 code 换密文时校验后立即置 consumed
  expire_at: 1789990060000,     // 创建时间 + 60s，定时器/惰性双保险清理
  created_at: 1789990000000,
  decided_at: null
}
```

---

## 五、与现有代码的对接点

| 现有模块 | 对接方式 |
|---------|---------|
| `cloudfunctions/ensureCollections` | 扩展创建 dev_tokens / dev_pending_requests / dev_audit_logs 三个集合（沿用幂等模式） |
| 会员拦截（member 相关逻辑） | devapi 内嵌权益判定：免费用户 token 数 ≤1、entry_scope 条目 ≤3、审计 7 天；M1 的授权 UI 同步展示权益墙 |
| 离线模式加密存储 | MCP 本地缓存沿用同一密文格式与 PBKDF2 参数，解密代码可从小程序端 utils 平移（纯 JS，无平台依赖） |
| 现有锁屏/主密钥体系 | MCP 端解锁是**独立输入主密码**，不复用小程序缓存——主密钥从不出小程序进程，也不进 MCP 进程（各自派生，互不共享明文） |

---

## 六、实施排期（对齐 PRD M1–M4）

| 里程碑 | 交付物 | 预估 |
|--------|--------|------|
| M1 | 小程序「开发者授权」页：token 生成（scopes/entry_scope/有效期勾选）+ 吊销 + 条目打标开关（add/detail 页加「API 可取」+ 模式选择） | 2 周 |
| M2 | devapi 云函数（云接入端点 + token 校验 + 限流）+ MCP Server 包（3 个 tools + 逐次确认轮询） | 2 周 |
| M3 | 审计日志查询 UI + 7 天清理定时器 + 会员权益硬拦截 | 1 周 |
| M4 | 10 人内测：覆盖 Cursor / Claude Code / WorkBuddy 三端，重点测 approval_code 链路与吊销即时性 | 2 周 |

以上排期是历史估算，前置条件、技术选型、工作量与上线顺序均未重新确认；不能据此推断任何里程碑已经开始或完成。

---

## 七、风险与未决项（TBD）

| 项 | 状态 | 说明 |
|----|------|------|
| 云接入 HTTP 端点的免费额度限流细则 | TBD | M2 前在控制台实测配额，必要时升配或对 devapi 做本地缓存降频 |
| 微信类目是否需新增「开发者服务」 | TBD | 授权功能属工具类目延伸，预计无需变更；提审前核对 |
| approval_code 链路的端到端延迟 | 待内测 | 目标 < 5s（轮询间隔 2s）；超 10s 体验不可接受需改长连接 |
| MCP 包分发渠道 | TBD | npm public 或私包 + 文档站，M4 内测前定 |
| Windows DPAPI 封装库选型 | TBD | 候选：`keytar`（维护状态需确认）或自调 `wincred`；macOS 用 Keychain 原生 |
| 加密封套与授权范围过滤 | 未解决 | 若条目标签及 API 标记位于加密正文中，云端如何按标签/标记过滤且不解密正文尚无设计；若增加明文索引字段，需明确隐私泄露面、认证方式及篡改防护 |

---

## 八、已否决方案（继承 PRD 并补充）

| 方案 | 否决原因 |
|------|---------|
| 本机 MCP Server 直接持有 appsecret 调微信 access_token | appsecret 落地用户本机 = 全局凭据泄露；且无法定位到用户 |
| 逐次确认用微信订阅消息通知 | 一次性授权、到达率不稳定（PRD 已否决） |
| MCP Server 直连云数据库（SDK + 自定义登录态） | 需要自定义登录态私钥出云环境，同 appsecret 问题 |
| 密文全量常驻 MCP 内存 | 进程内存可被同机进程读取；改为按需解密 + 用完即清 |
