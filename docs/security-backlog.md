# 安全遗留问题清单（Security Backlog）

> 来源：`security-audit-skill` 审计 run-1（4.0.20）、run-2（4.0.21/4.0.22）
> 产物位置：`~/security-audit-skill/cloud-password-vault/run-{1,2}/`
> 更新：2026-10-18

本文件只记录**已知但未解决**的问题，已修项见 run 元数据的 `remediation_status`。

---

## 一、待修（有明确方案，等排期）

### B15 · 缺少「删除云端数据」入口（**已实现，待 4.0.24 发版**）
- **背景**：用户在微信里删除小程序只清本机缓存，云端备份仍在（2026-10-18 亲身遇到并困惑）。
- **合规风险**：《个人信息保护法》要求提供删除权；密码类目审核也可能询问。
- **实现（4.0.24）**：
  - 云函数 `sync` 新增 `action: 'purge_vault'`：必须传 `confirm: 'DELETE_MY_VAULT'`；仅删 `getWXContext().OPENID` 名下的 `passwords` 与 `vault_meta`（循环分批删除）；订单与审计**保留**用于对账/合规（返回 `orders_and_audit_retained_for_compliance`）。
  - 前端：设置 → **数据与隐私** → 「清空云端数据」→ **两次确认**（第二次明确"不可恢复"）→ 调云函数 → `storage.clearAllLocalData()` 清本机（按 `pwd_` 前缀精确删除 + 清内存 masterKey + 重锁）→ 回锁屏。
  - 设置页新增说明文案："在微信里删除小程序只会清空本机缓存，不会删除云端备份"。
  - 测试：2 条结构断言（确认串必需、仅删本人数据、订单保留、本地清理存在且清主密钥）。
- **待办**：4.0.24 需在 4.0.23 审核通过后发布；上线后验证一次完整删除流程（云端 0 + 本机回锁屏）。

### B1 · `is_deleted` 未纳入 MAC 完整性保护
- **现状**：4.0.22 把 `is_deleted` 放到了封套**外层明文**（不参与 MAC），解决了"删除不释放额度、API 返回已删除条目"的功能问题，但**完整性仍未覆盖**。
- **残留风险**：有云端写权限的一方（运维、越权云函数、数据库直连）可翻转该字段静默隐藏或"复活"条目；读不出内容，属可用性/完整性降级。
- **方案**：`crypto_version=2` —— 把 `is_deleted`（以及未来的条目类型）加入 AAD，并对 v1 记录做兼容读取 + 增量迁移。
- **影响面**：`miniprogram/utils/crypto.js`、`sdk/wuyou-vault/index.js`、`cloudfunctions/sync/index.js`、开放 API 文档。
- **风险**：加密格式升级涉及历史数据，需单独窗口 + 回滚预案。

### B2 · 容量校验存在"先查后写"窗口（TOCTOU）
- **现状**：4.0.22 已做到"只拦新增、更新/删除放行"，且校验失败即整体拒绝；但 `count` 与写入之间仍有毫秒级窗口。
- **残留风险**：并发 N 个 `upload` 可能各自通过校验，写入超过配额（需并发环境验证）。
- **方案**：在 `users` 上加额度占位字段，用事务/条件更新做原子预留；或写入后复检并回滚本批新增。
- **备注**：影响收入与存储成本，不影响数据安全。

### B3 · 试码限流仍可被分布式压测
- **现状**：4.0.22 改为全局滑动窗口（120 次/分钟）+ 单码 5 次锁定，不再依赖可伪造的 IP 头。
- **残留风险**：全局阈值是"总量限制"，攻击者可用分布式来源在阈值内持续低速枚举（8 位码 + 5 分钟 TTL 已大幅提高成本）。
- **方案**：改为 `api_code_attempts` 独立集合 + TTL 索引 + 按码/按来源多维计数；或引入图形/滑块验证。

### B4 · `api_audit` 无 TTL、无索引 ✅ 代码侧完成（2026-10-23），控制台执行待用户
- **已完成**：4.2.10 起 `api_audit`/`api_codes`/`api_tokens`/`otp_requests` 新记录均带 Date 类型 `expire_at`（90 天/1 天/随令牌/7 天）；索引与 TTL 的控制台操作清单见 `docs/控制台索引与TTL清单.md`（4 TTL + 15 索引）。
- **剩余**：索引已全部由 AI 经 `tcb UpdateTable` API 建成（14 条，2026-10-23 实测）；TTL 经 API 不支持（UpdateTable 无 TTL 参数，实测）→ **已改用云函数 janitor 定时清理**（4.2.16，每日 03:00，按 expire_at 删 4 集合过期记录），B4 关闭。

---

## 一·五、B16 · 云函数运行时停留在 Nodejs16.13（**搁置 · 用户 2026-10-25 决定**）

- **现状（2026-10-25 实测，MCP 查询）**：17 个云函数中 **13 个仍是 `Nodejs16.13`**——`pay`、`sync`、`login`、`invite`、`openapi`、`apiAuth`、`ensureCollections`、`payCallback`、`purgeAll`、`vpay`、`initDB`、`leaderboard`、`globalStats`；其余 **4 个已是 `Nodejs18.15`**（`backupDownload`、`janitor`、`vpayCallback`、`inviteQrcode`）。13 + 4 = 17，与函数总数一致。
- **为什么不能"改个配置"**：平台**禁止原地修改运行时**。官方报错原文（2026-10-25，`UPDATE` 调用 `scf UpdateFunctionConfiguration`）：
  > `[UpdateFunctionConfiguration] 函数Runtime不支持修改（Nodejs16.13），请修正后再试。`
- **唯一可行路径 = 删除后重建**，代价清单：
  | 会丢失 | 涉及函数 |
  |---|---|
  | 环境变量 | `vpayCallback`（8 个，含 `VPAY_APP_SECRET` / `VPAY_AES_KEY`）、`purgeAll`（`PURGE_TOKEN`）、`ensureCollections`（`ADMIN_OPENIDS`） |
  | 触发器绑定 | `payCallback` / `vpayCallback` 是微信消息推送目标 |
  | 网关路由 | `apiAuth` / `openapi` 走 HTTP 网关 |
  | 线上中断窗口 | 删除到重建之间该函数不可用 |
- **风险分级建议（若将来要做）**：
  - A 低风险：`ensureCollections`、`invite`、`leaderboard`、`globalStats`、`initDB` → 先做重建演练
  - B 中风险：`apiAuth`、`openapi`、`purgeAll` → 需先记录网关路由，重建后重挂验证
  - C 高风险：`pay`、`payCallback`、`vpay`、`sync` → 单排期 + 真机验证，且需密钥由用户在控制台重填（不得读入对话，K-04）
- **未核实项（不得当作已确认依据）**：官方是否有 `Nodejs16.13` 强制下线时间表 —— **未核实**（原因：`docs.cloudbase.net/cloud-function/runtime` 返回 404；知识库检索接口当日报错 `ERR_STREAM_PREMATURE_CLOSE`）。因此"必须立即升级"目前**没有官方依据**。
- **当前影响**：12 个函数运行正常（2026-10-25 实测 `ensureCollections` 正常返回、耗时 5ms），功能未受影响。
- **搁置结论（用户 2026-10-25 决定）**：暂不升级，先回到产品功能；需要重启此议题时，按上表 A→B→C 顺序推进。

---

## 二、外部阻塞（不是代码问题）

### B5 · 虚拟支付 `-15001`（OFFER_ID_INVALID）
- **现状**：商户号 `1001750291` 已与 AppID 关联、道具已发布、推送已配置、复核已加固；拉起支付仍报 -15001。
- **判断**：小程序**尚无线上版本**（4.x 一直在审核/驳回流程中），虚拟支付很可能要求已发布版本。
- **下一步**：先让审核通过并全量发布，再复测；若仍失败，带 `AppID wx0000000000000000 / 商户号 1001750291 / OfferID 1450363281` 找微信支付客服核对绑定。

### B6 · 小程序审核（首页锁屏无法体验）
- **现状**：4.0.19 起已加"演示模式"（锁屏底部入口，只读示例数据、不碰真实库、重启即退出），4.0.21/4.0.22 继续带着。
- **下一步**：用 4.0.22 重新提审，版本描述写明"点锁屏底部『进入演示模式』即可完整体验，无需账号密码"。

---

## 二·五、run-3 新增（4.0.23 已知未解决）

| 编号 | 问题 | 影响 | 方案 |
|---|---|---|---|
| ~~B11~~ | ~~`/v1/items` 的 `since` 过滤在 `limit(100)` 之后执行~~ | **已修复并部署（2026-10-21）**：since 下推到查询条件 + 改升序 + 返回 `next_since` 游标；`openapi.test.js` 增加三页翻页覆盖断言；文档同步；openapi 云函数已部署（CLI 挂死改用 CloudBase MCP updateFunctionCode），线上调用返回 401 验证加载正常 | 已完成 |
| B12 | 试码全局桶仍是"共享额度" | 匿名者用大量 `code_not_found` 可把全体用户打成 429（阈值 300/分钟，成本已高但存在） | 改为按来源分级退避 + 告警不拒绝 |
| B13 | `is_deleted` 明文可被客户端翻转 | 可把条目"隐藏"以规避配额统计（已有墓碑上限 50 条兜底）、旧客户端整档覆盖会"复活"已删条目 | 纳入 MAC（crypto_version=2）+ 写入改 update 合并 |
| B14 | 容量校验仍非原子 | 并发 upload 可小幅超配额（已限制单批 100 条、墓碑上限，放大能力有限） | 额度占位字段 + 事务 |

## 二·六、离线模式下权益可能过期（4.0.27 已缓解）

| 编号 | 问题 | 现状 | 后续 |
|---|---|---|---|
| B16 | 离线模式下权益显示为本地缓存（退款/权益变更不会立即反映） | **已缓解**：`user_info` 写入时打 `_synced_at`；`getUserEntitlement()` 返回 `stale/staleReason/syncedAt`（离线或 >10 分钟未同步即 stale）；会员页顶部显示橙色提示"当前离线，权益为上次同步结果"；联网重进自动纠正；login 超时 8s→15s 且首次超时自动重试一次 | 若要更强：把权益做成**服务端实时校验**（进会员页强制刷新一次），离线时对权益相关操作直接禁用 |

## 三、工程债务（非安全）

| 编号 | 问题 | 方案 |
|---|---|---|
| B7 | `cli.bat cloud functions deploy` 偶发挂死（曾卡 16 分钟，并出现"部署成功但代码是 Hello World 骨架"） | 单次带 `timeout` 调用；部署后用 `deploy-function.ps1` 的哈希校验；必要时改用 CloudBase MCP `updateFunctionCode` |
| B8 | 云函数包体积含完整 `wx-server-sdk` 依赖（`vpayCallback` 云端 CodeSize 约 7.4MB） | 评估按需依赖/分层（layer），降低冷启动 |
| B9 | 覆盖率函数维度仅 58%，支付/同步状态机仍有未测分支 | 按 P1 计划逐步补 `crypto`/`sync`/`vpay` 关键路径 |
| B10 | 免费额度最终形态未定（20 基础 + 邀请 15 + 付费 30 = 最多 70 条） | 上线后看真实分布，再决定是否引入"邀请容量 1 年有效" |

---

## 四、复检方式

1. 轻量自查（每次改动）：`npm run test:gate`（lint + security-scan + 148 项测试）
2. 完整审计（阶段节点/季度）：对 agent 说「跑一轮安全审计」，产物写入 `~/security-audit-skill/<repo>/run-<N>/`
3. 本清单逐条勾掉后，同步更新 run 元数据的 `remediation_status`
