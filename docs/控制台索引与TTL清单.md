# 控制台操作清单：索引与 TTL（B4 落地）

> **背景**：知识库已裁决——索引与 TTL **只能在控制台创建，代码无法创建**（`04-云数据库.md`：索引管理章节，依据官方 `reference/database`）。
> 代码侧已就位（4.2.10）：`api_audit` / `api_codes` / `api_tokens` / `otp_requests` 的每条新记录都带 **Date 类型 `expire_at` 字段**，供 TTL 索引使用。
> **执行位置**：云开发控制台 → 数据库 → 选集合 → 「索引管理」标签 → 新建索引。
> **TTL 字段类型说明**：官方文档确认数据库有 Date 类型且推荐时间用 Date 存（`guide/database/data-type`，抓取 2026-10-22）；TTL 索引的具体字段类型要求**官方原文未抓到，未核实**——`expire_at` 按 BSON Date 写入是最兼容写法。建索引时若控制台提示字段类型不适用，以控制台实际为准并回填本清单。

## ⛳ 操作步骤（2026-10-23 补，索引部分有官方原文依据）

**官方依据**：微信云开发「索引管理」文档（`developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/`，抓取 2026-10-23）——建立索引的入口在控制台，可分别对各个集合的字段添加索引；支持单字段（升/降序均可命中查询排序）、组合索引（前缀匹配）、唯一性限制；开发者工具 1.03.2006242+ 会自动检测无索引查询并给出告警。

**入口（二选一）**：
- 微信开发者工具 → 工具栏「云开发」→ 云开发控制台 → 「数据库」
- 或浏览器打开 `tcb.cloud.tencent.com/dev` → 数据库 → 文档型

**单条索引操作**：左侧选集合 → 顶部「索引管理」标签 → 「添加索引」→ 填字段名（组合索引点「添加字段」逐个加、顺序按清单）→ 排序方向 → 确认创建。**每个索引重复一次**。

**TTL（⚠️ 未核实项）**：微信官方索引文档**无 TTL 章节**（2026-10-23 抓取，未核实——官方原文未覆盖）。操作建议：在「索引管理」的添加索引界面查找 TTL / 过期删除选项；若界面不提供，把该集合标记为「TTL 不可用」并回填本清单——届时改为**季度手动清理**（控制台批量删过期记录或等云函数侧清理脚本）。

**建完后验证**：开发者工具里跑一遍列表/搜索/同步，控制台「数据库监控」看慢查询告警是否消失（官方：1.03.2006242+ 自动检测无索引查询并告警）。

## 一、TTL 自动清理（对 `expire_at` 字段开 TTL）

| 集合 | TTL 字段 | 保留时长 | 依据 |
|------|---------|---------|------|
| `api_audit` | `expire_at`（Date） | **90 天** | security-backlog B4 建议 30/90 天，审计留 90 天 |
| `api_codes` | `expire_at`（Date） | **1 天** | 授权码本身 5 分钟有效，垃圾码留 1 天足够 |
| `api_tokens` | `expire_at`（Date） | **随令牌到期**（签发时 = expires_at） | 过期令牌自动清理 |
| `otp_requests` | `expire_at`（Date） | **7 天** | 请求本身 10 分钟/60 秒生命周期，留 7 天备查 |

> ⚠️ 旧记录（4.2.10 之前写入的）**没有 `expire_at` 字段**，TTL 不会清它们——量很小（测试数据），可手动删或忽略。

## 二、索引（高频查询路径，全部来自代码检索）✅ 已全部建成（2026-10-23，经 `tcb UpdateTable` API 由 AI 执行，DescribeTable 验证）

> **实测修正知识库结论**：知识库 04 曾记载"代码无法创建索引"——**已过时**。官方 API `tcb UpdateTable`（CreateIndexes/DropIndexes）可完整管理索引；`DescribeTable/DescribeTables` 可查索引。索引命名沿用 Mongo 惯例（`字段_方向`，如 `_openid_1_updated_at_-1`）。
> **TTL 结论**：`UpdateTable` 参数定义中**无 TTL/expireAfterSeconds 字段**——API 层面不支持建 TTL 索引（2026-10-23 实测）；控制台如有 TTL 选项可手动，否则放弃 TTL、改用云函数侧定期清理。

| # | 集合 | 索引字段 | 服务查询 |
|---|------|---------|---------|
| 1 | `passwords` | `_openid` ↑ + `updated_at` ↑ | sync 增量下载（orderBy） |
| 2 | `passwords` | `_openid` ↑ + `id` ↑ | upload 查旧编号 |
| 2b | `passwords` | `id` ↑（单字段） | openapi `createOtpRequest` 按 `where({ id })` 定位条目（**不带 _openid**，复合索引服务不了）|
| 3 | `users` | `_openid` ↑ | login/invite/vpay 等所有用户查询 |
| 4 | `vault_meta` | `_openid` ↑ | get/set vault meta |
| 5 | `api_tokens` | `token_hash` ↑ | openapi 每次 Bearer 鉴权 |
| 6 | `api_tokens` | `_openid` ↑ | list_devices |
| 7 | `api_audit` | `_openid` ↑ + `created_at` ↓ | 审计查询 |
| 8 | `api_audit` | `action` ↑ + `created_at` ↓ | B4 指定 |
| 9 | `otp_requests` | `request_id` ↑ | 取件（每次 GET /v1/otp） |
| 10 | `otp_requests` | `_openid` ↑ + `status` ↑ + `approve_deadline` ↑ | 用户待批列表 |
| 11 | `otp_requests` | `create_ip` ↑ + `created_at` ↓ | 限流（同 IP 每分钟计数） |
| 12 | `orders` | `_openid` ↑ + `status` ↑ | vpay 查 pending 订单 |
| 13 | `invite_records` | `_openid` ↑ | 邀请关系查询 |
| 14 | `api_codes` | `code` ↑ | 授权码交换 |

**配额提醒**：单集合索引上限 **20 个**（微信 `reference/quota`，2026-10-22 已裁决进知识库），上表每集合最多 3 个，安全。

## 三、执行核对

- [ ] 4 个集合的 TTL 索引已建（第一节）
- [ ] 14 个索引已建（第二节）
- [ ] 控制台数据库监控无慢查询告警（建索引后观察一天）
- 完成后回填 `docs/security-backlog.md` B4 状态。

*生成：2026-10-22，依据：代码静态检索（scripts/extract_design_specs.py 模式）+ 知识库裁决*
