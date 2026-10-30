# 云端密码储存管家 - 历史 Bug 修复日志

> 版本: v1.0 | 日期: 2026-06-26 | 作者: WorkBuddy（前端）
>
> **历史修复记录，不是当前质量结论。** 文中“全部修复”、文件路径及验证命令只描述当时记录的范围，不代表当前工作树或生产环境已验证。当前状态和验证边界见[项目状态与路线图](docs/项目状态与路线图.md)；加密库由 `crypto.js` 加载本地 `crypto-js.min.js`，无需另行安装 npm 包。

---

## 2026-10-25 · 工具链与依赖层（P0，非业务代码）

> 起因：用户要求「补覆盖率门槛」。执行 `npm run test:coverage` 直接报 `Cannot find module 'signal-exit'`，顺藤摸出四个连带问题。

### 1. `package-lock.json` 与 14 个云函数 lock 被版本号全局替换污染（P0）
- **现象**：`npm install` 持续失败，报 `No matching version found for ansi-styles@^4.3.7`；`node_modules` 长期残缺（eslint 缺 `chalk`、c8 缺 `signal-exit`）
- **根因**：4.3.x 升版本时对 lock 文件做了全局替换，命中依赖版本区间（`^4.3.x`、`4.3.6` 等）与 tarball 地址，产生 `js-yaml@4.3.7`、`web-streams-polyfill@^4.3.7` 等**不存在的版本**
- **影响面**：根项目 + 全部 10 个云函数（部署时 `npm install --production` 会失败，X-16）
- **修复**：删除并重新生成全部 lock（`--registry=npmmirror`）；根依赖重装；全仓 `^4.3.7` 残留归零
- **教训**：**版本号替换只能改 package.json 的 version 字段，必须排除 package-lock.json**（D-01 已补此点）

### 2. `test:gate` 长期不可用（P0）
- **现象**：`npm run lint` 直接崩（缺 chalk），`test:gate` 从未真正跑通；此前记录的「179/179」只是 `npm test`
- **修复**：依赖修复后门禁跑通，暴露并修掉 2 个真实 lint error：
  - `settings.js` 存在重复 `else if (saved.mode === 'clipboard')` 死分支（P-09「补丁摞补丁」）
  - `tests/entitlement-stale.test.js` 正则含裸空格（`no-regex-spaces`）

### 3. 覆盖率工具失效（P1）
- **现象**：c8 缺依赖无法运行，阈值 78/58/71 形同虚设
- **修复**：改用 Node 原生 `--experimental-test-coverage`（Node v24），门槛 67/54/69，实测 67.62/54.51/69.13；`test:gate` 用 `test:coverage` 替代 `npm test`（只跑一遍）
- **说明**：新旧口径不同（c8 vs Node 原生统计范围有差异），不可直接沿用旧数字

### 4. 锁屏「强制更新」遮罩永不显示（P1，业务缺陷）
- **现象**：`lock.wxml` 有遮罩但 `wx:if="{{forceUpdate}}"`，而 `forceUpdate` 在项目中无定义
- **真实情况**：`storage.js` 收到云端 `VERSION_TOO_OLD` 时会设 `app.globalData.forceUpdate = true`，**但锁屏页从未读取** → 门禁触发时用户看不到任何提示
- **修复**：lock.js 增加 `forceUpdate` 数据 + `_syncForceUpdate()` + `onForceUpdateTap()`；遮罩移入 `.page` 内以继承主题变量

### 5. 两处死 UI（L1）
- `settings.wxml` 遗留「加密备份」输入弹窗（备份密码=主密码后已不需要），其 `onBackupConfirm` 从未定义 → 删除
- `account.wxml` / `member.wxml` 各一处无样式占位 class → 清理；`ui:lint` 4 处清零

### 6. 新增 `scripts/guard.js`（防复发）
四项机检：单文件 >800 行（基线制，只拦新增）、敏感文件被 git 跟踪、npm script 引用不存在的文件、shortcut 取舍未登记台账。已挂入 `test:gate`。

后续扩展（同日）：
- **体积闸**：单文件 >300KB 失败 / >150KB 提醒；miniprogram 源码总量相对基线 751,089 字节浮动 >10% 失败
- **`.ps1` 语法闸**：用 PowerShell Parser 解析 `scripts/*.ps1`。**注意**：临时脚本含中文路径必须写 UTF-8 **BOM**，否则 PS 5.1 按 ANSI 解析路径失效、扫到 0 个文件，检查会变成"永远通过"的假绿

### 7. `backup:release` 归档成功却返回失败（P1）
- **现象**：脚本输出 `success:true` 且归档文件已生成，但退出码为 1，报 `Access to the path 'dba7...mp4' is denied`
- **根因**：`审核文件/` 下的 9.93MB 演示视频带**只读属性**；`[System.IO.File]::Copy` 会保留该属性，保留策略递归删除工作目录时被拒
- **修复**：复制后显式 `SetAttributes(...Normal)`；删除前递归清除只读属性并兜底 `Remove-Item -Force`
- **教训**：**脚本"做完了事却返回失败"比直接失败更危险**——会让人误以为备份没做成

---

## 修复总览

| 轮次 | 日期 | 修复数量 | 级别 | 状态 |
|------|------|----------|------|------|
| 第一轮 | 06-26 上午 | 5 (P0) + 6 (P1) | 阻塞/严重 | ✅ |
| 第二轮 | 06-26 中午 | 6 (P0/P1) | 接口对齐 | ✅ |
| 第三轮 | 06-26 下午 | 8 (P0/P1/P2) | 组件/样式 | ✅ |

**历史记录总计：25个Bug，全部修复 ✅**（仅代表 2026-06-26 记录范围，不是当前质量结论）

---

## 第一轮：接口对齐Bug（前端搭建后）

### Bug #1 — P0: isLocked vs isUnlocked 命名不一致
- **根因**: app.js 使用 `isLocked`，所有页面读取 `isUnlocked`（不存在的属性）
- **影响**: 锁屏页永远不跳转（`isUnlocked`=undefined），主页永远不拦截 → 安全漏洞
- **修复**: 历史记录中的 5个页面统一改为 `app.globalData.isLocked` / `!app.globalData.isLocked`
- **涉及文件**: index.js(2处), lock.js(2处), detail.js(1处), settings.js(2处), add.js(1处)

### Bug #2 — P0: storage.js 缺失6个方法
- **根因**: 页面调用但不存在
- **修复**: 补充 `hasMasterPassword()` / `setLockState()` / `getLockTimeout()` / `setLockTimeout()` / `getLastSync()` / `getAllPasswords()` / `toggleFavorite()`

### Bug #3 — P0: theme.js 缺失2个方法
- **根因**: pages/lock 和 pages/settings 调用不存在的方法
- **修复**: 补充 `getTheme()` / `setTheme()`

### Bug #4 — P0: sync.js fullSync 签名不匹配
- **根因**: 调用处传 `fullSync(masterKey)` 但函数不需要参数
- **修复**: `fullSync()` 内部自行获取

### Bug #5 — P1: settings.js sync返回字段不一致
- **根因**: `result.uploaded/downloaded` → 代码期望 `result.uploads/downloads`
- **修复**: 统一为 `result.uploads/downloads`

---

## 第二轮：组件层接口对齐 + 资源缺失

> 本轮记录中的组件名和路径属于当时的实现快照；`comp-pwd-generator`、`comp-pwd-item`、`comp-category-tag`、`comp-strength-bar`、`comp-export-modal` 等不在当前 6 个组件基线中。

### Bug #6 — P0: crypto-js.min.js 缺失
- **根因**: crypto.js line 11: `require('./crypto-js.min')` → 文件不存在
- **影响**: 整个加密链路无法启动
- **修复**: 从 cdnjs 下载 crypto-js v4.2.1 min.js (60KB) 放入 miniprogram/utils/

### Bug #7 — P0: comp-lock-screen 首次设置 masterKey 为空
- **根因**: `setMasterPassword` 只存 hash+salt，但 unlock 事件传了 `masterKey:''`
- **影响**: 首次使用后所有加解密操作失败
- **修复**: `setMasterPassword` 后立即调 `verifyMasterPassword` 获取真实派生密钥

### Bug #8 — P1: tabBar 图标缺失
- **根因**: app.json tabBar 引用 `images/tab-home.png` 等4个图标，目录不存在
- **修复**: 移除 iconPath/selectedIconPath，改为纯文字 tabBar

### Bug #9 — P1: comp-pwd-generator 引用错误
- **根因**: 组件调用 `pwGen.generatePassword(opts)` → password-gen.js 导出的是 `generate`
- **修复**: `generatePassword` → `generate`

### Bug #10 — P1: 全线字段命名不一致 (camelCase → snake_case)
- **根因**: 页面使用 `isDeleted/isFavorite/categoryId`，DESIGN.md 规定 `is_deleted/is_favorite/category_id`
- **修复**: 12处统一改为 snake_case
  - index.js: `is_deleted`(1) + `is_favorite`(1) + `category_id`(1)
  - settings.js: `is_deleted`(3)
  - detail.js: `category_id`(1)
  - add.js: `category_id`(3)
  - detail.wxml: `is_favorite`(1)
  - comp-pwd-item.wxml: `is_favorite`(1) + `category_id`(1)

---

## 第三轮：CSS变量 + 主题重写 + 组件Bug

### Bug #11 — P0: CSS 变量三套体系冲突
- **根因**: app.wxss、theme.wxss、theme.json 三套不同变量体系并存，页面引用大量未定义变量
- **修复**: theme.wxss 作为唯一真相来源，app.wxss 改为 `@import` 引入，仅保留工具类
- **统一变量**: `--text-primary`, `--bg-page`, `--bg-card`, `--bg-input`, `--color-primary`, `--radius-sm/md/lg/full`, `--shadow-card/float`

### Bug #12 — P0: 主题切换无效
- **根因**: 旧方案用 JS 动态注入 CSS 变量，但 WeChat 小程序不支持 `style.setProperty()`
- **修复**: `.page` 类 + `@media (prefers-color-scheme)` + `.theme-dark/.theme-light` class override
- 历史记录中的 5个页面 WXML 统一包裹 `<view class="page {{themeClass}}">`；当前源码有 7 个页面
- theme.js 新增 `getThemeClass()` 辅助函数

### Bug #13 — P1: strength-bar 组件逻辑错误
- **根因**: 内部 `levelMap` 和传入的 `level` 属性混淆，渲染不一致
- **修复**: 重构为直接接受 `score`/`color`/`label` 三个属性（由调用方计算后传入）

### Bug #14 — P1: add.wxml + generator.wxml 属性绑定错误
- **根因**: strength-bar 使用旧属性名 `level`
- **修复**: 改为 `score="{{strength.score}}"` / `color="{{strength.color}}"` / `label="{{strength.label}}"`

### Bug #15 — P1: settings.js 缺失 onCloseExport
- **根因**: `comp-export-modal` 触发 `cancel` 事件但 settings.js 无对应方法
- **修复**: 新增 `onCloseExport()` → `setData({ showExport: false })`

### Bug #16 — P1: settings.js 变量名冲突
- **根因**: `const theme = require(...)` 与 `data.theme` 字段冲突，`theme.setTheme()` 报错
- **修复**: `const thisTheme = theme` 别名引用

### Bug #17 — P1: 云函数日期查询兼容性
- **根因**: `new Date(queryTime)` 可能因时区/格式解析失败
- **修复**: 改为直接 ISO 8601 字符串比较

### Bug #18 — P1: 分类图标显示
- **根因**: 预设图标从文本名（chat/bank/mail）改为 emoji（💬🏦📧🛒📁）
- **修复**: categories 数据中的 icon 字段改为 emoji

### Bug #19 — P2: password-gen.js checkStrength 缺少 level 字段
- **根因**: 返回 `{score, color}` 但 comp-strength-bar 旧版需要 `level`
- **修复**: 补充 `label` 字段（新版组件改为接受 score/color/label）

### Bug #20 — P2: detail.wxml 条件渲染冗余
- **根因**: 多余的 `data-cancel` 属性
- **修复**: 移除

---

## 安全性Bug（高优先级标记）

| Bug ID | 安全影响 | 严重程度 |
|--------|----------|----------|
| #1 | 锁屏不生效，可跳过验证直接访问密码 | 🔴 严重 |
| #7 | 首次使用后所有加密失效（masterKey为空） | 🔴 严重 |
| #6 | 加密库缺失，整个安全体系不可用 | 🔴 严重 |
| #11 | CSS变量缺失导致UI不可用 | 🟡 中等 |
| #12 | 主题切换完全失效 | 🟡 中等 |

---

## 修复验证方法

```bash
# 验证 locks 检查
grep -rn "isLocked\|isUnlocked" miniprogram/pages/

# 验证字段命名
grep -rn "isDeleted\|isFavorite\|categoryId" miniprogram/
# 应返回空 → 全部已改为 snake_case

# 验证 crypto-js 文件存在
ls -la miniprogram/utils/crypto-js.min.js

# 验证 CSS 变量无冲突
grep -rn "\-\-text-primary" miniprogram/
# 应在 app.wxss 中只出现在 @import 的 theme.wxss 中
```

---

## 修复统计

| 类别 | 数量 |
|------|------|
| 接口缺失（方法不存在） | 8 |
| 命名不一致（camelCase/snake_case） | 12处 |
| 逻辑错误（空值/冲突） | 3 |
| 组件属性绑定错误 | 3 |
| 文件/资源缺失 | 2 |
| CSS变量/主题 | 2 |

---

*文档由 WorkBuddy 生成，基于实际修复记录*

---

## 2026-10-25 · 安全修复（取件链接 + 支付错误信息）

来源：4.3.7 源码级安全自查（run-3）发现项 F1 / F2。

### 1. F1 取件页无密码尝试限制（中危）—— cloudfunctions/backupDownload

- **现象**：密码输错多少次都不计数，可无限猜；且每次尝试都触发一次 PBKDF2 60 万次计算（计算型 DoS + 计费风险）。
- **修复**：同一链接累计输错 **5 次即终局失效**（`status = disabled`），此后即使密码正确也不可用。
- **失效即清理**：删除云存储中的备份文件、`file_id` 置空、`expires_at` 置为当前时间，记录尽快回收。
- **验证**：`tests/backup-download-guard.test.js`（6 项用例：首错/达上限/失效后正确密码被拒/GET 提示/成功清零/一次性失效）。

### 2. 取件链接改为一次性（2026-10-25 用户拍板）

- 成功下载一次即失效，防止链接被转发后重复取件。
- **不能过早删文件**：成功后把 `expires_at` 推迟到「下载直链 5 分钟 + 1 分钟余量」，否则直链会断。

### 3. 及时清理（三层保障）

| 层 | 触发 | 动作 |
|---|---|---|
| L1 即时 | 业务判定文件不再需要 | 直接 deleteFile + 记录置失效 |
| L2 惰性 | 每次请求顺手扫尾（limit 10） | 查 `expires_at < now` → 先删文件 → 再删记录 |
| L3 兜底 | janitor 每日 03:00 | 批量同一流程 |

- 实测（2026-10-25 14:40，MCP 查询）：`backups/temp/` = **0 文件**、`backup_links` = **0 记录**。

### 4. F2 支付下单失败回传内部错误原文（低危）—— cloudfunctions/pay

- **修复**：对外统一返回 `下单失败，请稍后重试` + `code = ORDER_CREATE_FAILED`，内部错误原文只写日志。
- **保留**：`PACK_LIMIT`（"永久容量补充包最多购买 3 次"）仍回自有业务文案——那是产品话术，不是泄露。

**部署状态**：`backupDownload`、`pay` 均已部署，并通过云端代码哈希与本地一致性校验。

*记录日期：2026-10-25*

---

## 2026-10-25 · iOS 解锁卡死（一直显示「解密中」）

**现象**：iOS 上设置主密码后，再次进入输入密码点解锁，界面永远停在「解密中/解锁中」，无法进入小程序。

**定位过程（未能拿到真机日志，靠代码推断 + 本机实测）**：
- 本机实测项目真实 PBKDF2 实现（60 万次）：**810ms**（V8）。按移动端慢 3~5 倍估算约 2~5 秒，且每 1 万次让出事件循环 → **不可能"卡一分钟"**，故排除"KDF 太慢"。
- 发现真实缺陷：解锁成功后 `unlocked = true`，而 `finally` 里是 `if (!unlocked) 才复位 submitting`。
  → **一旦 `wx.reLaunch` 跳转失败（iOS 键盘收起瞬间跳转存在静默失败可能），按钮永久停在「解密中」，用户彻底卡死。**

**修复（4.3.9）**：
1. `_goHomeAfterUnlock()`：reLaunch 显式 `success`/`fail` 回调 + 1.5s 看门狗；跳转失败时复位按钮并提示「已解锁，页面跳转未成功，请再点一次进入」。
2. 记录 `_unlockedTarget`：再次点击直接跳转，**不重复跑 KDF**（避免用户二次等待）。
3. 解锁过程可视化：按钮显示阶段与解密百分比；下方显示「已用 N 秒，请勿退出」；超过 20 秒展示「耗时超出预期，可点重试」+ 重试按钮（逃生出口）。
4. 键盘确认键生效：两个密码框补 `bindconfirm="onSubmit"` + `confirm-type="done"`（此前按键盘「完成」毫无反应）。

**新增测试**：`tests/crypto-progress.test.js`（2 项）——进度回调单调递增且到 1；回调抛异常不影响密钥派生。

**验证状态（如实标注，2026-10-25 更新）**：

| 层级 | 状态 |
|---|---|
| 代码缺陷本身 | ✅ 已确证（`unlocked=true` 后 `finally` 不复位，是客观存在的逻辑漏洞） |
| 修复逻辑（跳转失败/无回调两条分支） | ✅ **自动化行为测试覆盖**：`tests/lock-unlock-recovery.test.js`（4 项） |
| 测试有效性 | ✅ 已做**反向验证**：故意移除"复位 submitting"后该测试报 2 处失败，还原后哈希一致（`e63750e4af5ba32f`） |
| iOS 真机行为 | ⏳ **未验证**——当前手头没有苹果手机，无法真机确认 |

> 说明：模拟器无法复现此问题（模拟器没有真实软键盘，`wx.reLaunch` 几乎不会在键盘收起瞬间失败，且运行引擎是 V8 而非 iOS 的 JavaScriptCore）。因此该分支只能用桩件测试 + 真机两种方式验证。**拿到 iPhone 后必须复核**。

若真机仍卡住，界面会显示卡在第几秒、解密百分比多少，可据此进一步定位。

*记录日期：2026-10-25 · 版本 4.3.9 · 包体积 557.9 KB*

---

## 2026-10-25 · 接入实时日志与全局错误上报（4.3.10）

**动机**：iOS 解锁卡死只能靠用户口述定位，拿不到阶段/耗时/错误码。手机型号不可能全买，改为让现场数据回流。

**改动**：
1. 新增 `miniprogram/utils/diagnostics.js`：实时日志封装，能力检测降级（低版本基础库无 `wx.getRealtimeLogManager` 时仅走 console）。
2. `app.js` 启动时上报一次环境（平台/系统/机型/品牌/基础库/微信版本），并接管 `wx.onError` 与 `wx.onUnhandledRejection`。
3. 解锁链路埋点：`unlock_start` / `unlock_derived`（含真实耗时 ms）/ `unlock_threw` / `unlock_nav_ok` / `unlock_nav_fail` / `unlock_nav_error`。
4. 文档：新增 `docs/诊断与实时日志.md`（查看路径、事件对照表、典型判读）。

**安全（S-07）**：只上报元数据；密码/密钥/token/密文/MAC/iv/salt/verifier/openid/signature 一律脱敏为 `[redacted]`；对象与数组直接丢弃；字符串截断 120 字符；上报失败不影响业务。

**测试**：`tests/diagnostics.test.js`（7 项）。其中「iv 必须脱敏」这项**在写完后立刻抓出了我自己代码的遗漏**（敏感词表最初漏了 iv），已修复。

**验证状态**：逻辑与脱敏由单测保证；**线上真实日志需等有真实用户使用后才有数据**（当前无 iOS 设备）。

*记录日期：2026-10-25 · 版本 4.3.10 · 包体积 560.8 KB*

---

## 2026-10-25 · 密码页改版（抽屉式分组，4.3.11）

**需求来源**：用户反馈「密码页布局不太好」，经 6 轮原型确认后定案。设计见 `docs/密码页改版设计.md`。

**布局变更**：
- 顶部从 4 个区块（品牌头 150rpx + 大搜索框 104 + chips 80 + 列表栏 70 ≈ 492rpx）压缩为：信息栏 92rpx + 工具栏 88 + 常驻搜索 88 = **268rpx**
- 条目行高 144rpx → **92rpx**；一屏可见 **6~7 条 → 约 12 条**

**功能**：
- 按平台名自动分组，仅 1 条的平台也成组
- 「全部」平铺、按录入时间倒序；选某平台后组内可按「工作/个人/其他」二次折叠
- 覆盖式抽屉（560rpx = Material 上限 280dp），**从信息栏下方开始，头像与容量不被遮挡**
- 搜索框常驻，跨分组实时过滤
- 行尾「···」可复制账号/查看/删除

**风格红旗（用户硬要求：不能有 AI 味儿）**：
- 未引入任何 emoji 图标，三横/加号/放大镜/三点全部 CSS 自绘（复用已有 `.search-icon-*`）
- 无渐变按钮、无毛玻璃、无多层阴影；圆角/阴影/字号全部取现有 token

**与已确认原型的差异（如实记录）**：
- 编辑分组 v1 用 `showActionSheet` 实现（重命名/置顶排序/隐藏），**未做原型里的拖动排序与新建空分组** —— 为控制首版风险，留待真机验证后补
- 组内二次折叠用启发式关键词匹配（`shortcut:` 已登记在设计文档）

*记录日期：2026-10-25 · 版本 4.3.11 · 包体积 574.8 KB*
