# 历史提案：条目类型扩展方案（V6 联动）

> 版本：v1.0 | 日期：2026-09-28 | 状态：历史设计快照，非当前实现说明
> 触发：用户需求——"不仅仅能存账号密码，还有银行卡、服务器相关信息"
> 当前实现状态与唯一现行状态见[项目状态与路线图](项目状态与路线图.md)；加密封套和云端结构见[加密说明](../miniprogram/utils/CRYPTO_README.md)及[云数据库说明](../CLOUD_DATABASE_SETUP.md)。本文保留当时设计，不是当前字段/API 契约。
> 强关联的 UI 方案也只是历史快照：[UI 重构提案](ui-refactor-proposal.md)。

> **重要更正：** 本提案中的生物识别解锁/re-prompt 是当时设想，当前源码不支持；敏感字段重验使用主密码。提案里的“加密零改动”“同步零改动”和明文 entry 结构不能作为当前云端 schema：当前记录以版本化加密封套同步，细节以加密说明及路线图为准。

---

## 一、成熟方案调研结论

### 1.1 三家怎么做的

| 产品 | 类型数量 | 代表类型 | 扩展机制 |
|------|---------|---------|---------|
| **1Password** | 21 类 | Login / Server / Database / Credit Card / Bank Account / API Credential / SSH Key / Secure Note / Wireless Router / Software License… | 每类固定字段模板 + 任意条目可加自定义字段（8 种字段类型：文本/隐藏/URL/OTP/日期/月年/菜单/邮箱） |
| **Bitwarden** | 4 类 | Login / Card / Identity / Secure Note | 其余全靠自定义字段（Text / Hidden / Boolean / Linked）+ 主密码重验（re-prompt） |
| **KeePassXC** | 模板制 | 内置条目模板（含 Server / Credit card / Database / Wireless） | 用户自建模板，自由度最高、上手成本也最高 |

### 1.2 关键字段细节（值得抄的）

| 来源 | 细节 | 抄法 |
|------|------|------|
| 1Password Server | URL / username / password | 我们扩展为 host / port / 用户名 / 密码或密钥 / 协议下拉 |
| 1Password Database | type / server / port / username / password | 协议下拉涵盖：SSH / RDP / MySQL / Redis / HTTP 等 |
| 1Password Credit Card | card number / verification number / expiry | 卡号掩码显示 `•••• 1234`；有效期用月年格式 |
| 1Password API Credential | username / credential / hostname，桌面端可解码 JWT | 与我们 V2「开发者中台」天然联动，是**独家卖点**——竞品尸体们全没有 |
| 1Password Wireless Router | 网络名 + 密码 → 生成 Wi-Fi 二维码 | 小程序生成 WiFi 二维码很简单，放候选池 |
| Bitwarden re-prompt | 查看 Hidden 字段时要求重输主密码 | 当时提议复用 `verifyMasterPassword`；生物识别部分已被当前源码状态取代 |
| Bitwarden 隐藏字段 | Hidden 类型默认掩码，眼睛图标 + 重验才显示 | 所有密码/密钥/卡号/CVV 字段统一 concealed 机制 |
| 1Password 侧栏分类 | 左侧按类型筛选 | 我们映射为首页顶部的类型筛选 chips（横滑） |

### 1.3 该抄什么、该改什么

- **抄 1Password 的"类型即模板"**：选类型 → 出对应字段表单，零学习成本
- **抄 Bitwarden 的"自定义字段兜底"**：任何条目都能加自定义字段，模板没覆盖的信息有地方放
- **当时提议的敏感字段重验**：卡号/CVV/密钥查看时重验主密码；不包括当前未支持的生物识别
- **不走 1Password 的 21 类**：移动端小程序塞 21 个类型是灾难，维护成本高，90% 用不上
- **不走 KeePassXC 的自由模板**：上手门槛太高，与我们"小白也能用"定位冲突

---

## 二、我们的类型设计：6 类 + 自定义字段

| 类型 | 字段（★=敏感/concealed） | 优先级 | 依据 |
|------|------------------------|--------|------|
| **登录** | 平台 / 账号 / ★密码 / 备用名 / ★密保问题 / 绑定手机 / 备注 | P0 | 现有功能，存量条目默认此类型 |
| **服务器** | 名称 / 主机 host / 端口 / 用户名 / ★密码 / ★SSH私钥 / 协议（SSH/RDP/MySQL/Redis/HTTP/其他 下拉）/ 备注 | P0 | 用户明确要求；配合 V2 开发者定位 |
| **银行卡** | 银行 / 卡号★ / 持卡人 / 有效期（月年）/ ★CVV / 备注 | P0 | 用户明确要求 |
| **安全笔记** | 标题 / 内容（多行） | P1 | 兜底类型，总有模板装不下的信息；有它就不需要自由模板 |
| **API 密钥** | 服务名 / ★Key / ★Secret / 接口地址 / 备注 | P1 | 与 V2 MCP 联动的差异化卖点；开发者用户刚需 |
| **Wi-Fi** | 网络名 / ★密码 / 加密方式（WPA2/WPA3/开放） | P2 候选池 | 1Password 抄简化版；后续可加二维码分享 |

**已否决/后置**：身份证、护照、社保号等证件类（个人敏感信息，合规审查风险高，非用户刚需，后置）；21 类全抄；自由模板制。

---

## 三、数据模型改造（向后兼容）

### 3.1 现有结构（storage.js addPassword）

```javascript
{ id, platform, account, password, alias, notes, securityQuestion,
  bindPhone, pinned, is_deleted, created_at, updated_at, created_timestamp }
```

### 3.2 目标结构（增量字段，存量数据零迁移）

```javascript
{
  ...原字段不动,
  type: "login",            // 新增："login" | "server" | "bankcard" | "note" | "apikey"
                            // 存量条目读取时缺省视为 "login"，写入时才补字段
  fields: [                 // 新增：非登录类型的结构化字段 + 任意类型的自定义字段
    { key: "host",   label: "主机",   value: "10.0.0.5",  concealed: false },
    { key: "port",   label: "端口",   value: "22",        concealed: false },
    { key: "sshkey", label: "SSH私钥", value: "-----BEGIN...", concealed: true }
  ],
  custom_fields: [          // 新增：用户自建字段（Bitwarden 模式）
    { label: "机房位置", value: "北京三区", concealed: false }
  ]
}
```

**当时的设计决策（非当前云端契约）：**

1. **登录类条目保持原有扁平字段**（platform/account/password…），列表、搜索、复制逻辑一行不改；只有新建非登录类型才写 `fields`——把改造风险压到最小
2. **加密粒度**：当时假设整条 entry 对象加密。当前源码使用版本化封套；具体参数见[加密说明](../miniprogram/utils/CRYPTO_README.md)。
3. **同步零改动**：这是本提案中的旧假设，不能作为当前结论。客户端同步与云函数均有字段校验；云端允许字段和部署说明见[云数据库说明](../CLOUD_DATABASE_SETUP.md)。
4. **容量计数不变**：1 条 = 1 条，不分类型（容量体系不动，会员逻辑不动）
5. **搜索兼容**：index 搜索逻辑扩展为「标题/账号 + fields[].value」联合匹配

### 3.3 字段模板定义（新增 utils/entry-templates.js）

```javascript
// 每个类型一份模板，add 页渲染表单、detail 页渲染展示共用
module.exports = {
  login:    { name: "登录",   icon: "lock",    fields: [] },  // 沿用扁平字段
  server:   { name: "服务器", icon: "server",
    fields: [
      { key: "host",   label: "主机地址", concealed: false },
      { key: "port",   label: "端口",     concealed: false, input: "number" },
      { key: "user",   label: "用户名",   concealed: false },
      { key: "pass",   label: "密码",     concealed: true },
      { key: "sshkey", label: "SSH私钥",  concealed: true,  input: "textarea" },
      { key: "proto",  label: "协议",     concealed: false, input: "select",
        options: ["SSH", "RDP", "MySQL", "Redis", "HTTP", "其他"] }
    ]},
  bankcard: { name: "银行卡", icon: "card",
    fields: [
      { key: "bank",   label: "银行",     concealed: false },
      { key: "number", label: "卡号",     concealed: true, format: "cardno" },
      { key: "holder", label: "持卡人",   concealed: false },
      { key: "expiry", label: "有效期",   concealed: false, input: "monthyear" },
      { key: "cvv",    label: "CVV",      concealed: true,  input: "number", rePrompt: true }
    ]},
  note:     { name: "安全笔记", icon: "note",
    fields: [ { key: "body", label: "内容", concealed: false, input: "textarea" } ]},
  apikey:   { name: "API密钥", icon: "key",
    fields: [
      { key: "service", label: "服务名",  concealed: false },
      { key: "key",     label: "Key",    concealed: true,  input: "textarea" },
      { key: "secret",  label: "Secret", concealed: true,  input: "textarea" },
      { key: "endpoint",label: "接口地址", concealed: false }
    ]}
};
```

`rePrompt: true` 的字段（卡号、CVV）：本提案设想查看明文时重验主密码；“或生物识别”是已被当前源码事实取代的旧设想。

---

## 四、用户操作流程调整（三个页面）

### 4.1 新增页（add）——最大变化

1. 顶部新增**类型选择器**：横滑胶囊（登录 / 服务器 / 银行卡 / 笔记 / API密钥），1Password 同款交互；默认「登录」
2. 选类型 → 下方字段区按模板动态渲染（文本框 / 密码框 / 下拉 / 多行 / 月年）
3. 底部固定「+ 添加自定义字段」（名称 + 值 + 是否隐藏）
4. 保存逻辑：登录类走原 `addPassword`；其他类型 `fields` 打包进同一函数（addPassword 加 type/fields 参数即可）

### 4.2 首页（index）

1. 列表项加**类型图标**（纯 CSS，遵循无 emoji 铁律）+ 副标题按类型变化：

| 类型 | 图标 | 副标题 |
|------|------|--------|
| 登录 | 锁（现有） | 账号 |
| 服务器 | 机架 | `10.0.0.5:22` |
| 银行卡 | 卡片 | `•••• 1234` |
| 笔记 | 纸张 | 内容首行截断 |
| API密钥 | 钥匙 | 服务名 |

2. 顶部搜索框下方加**类型筛选 chips**（全部/登录/服务器/银行卡/…），横滑，1Password 侧栏分类的移动端等价物
3. 空状态文案不变

### 4.3 详情页（detail）

1. 按 `entry-templates.js` 分组渲染：非敏感字段直接显示 + 一键复制；concealed 字段眼睛切换
2. `rePrompt` 字段点击眼睛 → 弹重验（本提案设想为主密码；当前源码不支持生物识别）
3. 卡号格式化：显示 4 位分段、复制时输出纯数字（去空格）
4. 服务器类型加「一键复制 host:port」快捷操作
5. 编辑入口复用 add 页（同模板渲染）

---

## 五、合规与审核注意（提前说清，防白忙）

| 事项 | 结论 |
|------|------|
| 存银行卡要不要支付类目？ | **不要**。这是用户自存自己的信息（备忘录性质），与 1Password/Bitwarden 同理。现有「工具-备忘录」类目覆盖 |
| 页面文案红线 | 全程避免"支付/付款/快捷支付/刷脸付"字样，防审核误判为支付业务；银行卡按钮就叫"银行卡" |
| 隐私指引 | 需更新收集说明（用户主动录入的银行卡信息、服务器信息），备案通过后、随本功能版本一起更新隐私保护指引 |
| CVV 存储 | 1Password 同样存 verification number，行业惯例允许；我们默认掩码 + re-prompt 双保险 |
| 审计 | V2 MCP 的 get_secret 对非登录类型通用返回 fields，审计日志 action 不变 |

---

## 六、排期：与 V6 重构合并执行

add/detail/index 三个页面 V6 重构和本方案重叠度 100%，**合并成一个版本做**：

| 步骤 | 内容 | 预估 |
|------|------|------|
| 1 | utils/entry-templates.js + storage.js 增量改造（type/fields/custom_fields，登录类零变化） | 1 天 |
| 2 | V6 组件库（照原重构方案抽 8 个 comp-*） | 2.5 天 |
| 3 | add 页重构 + 类型选择器 + 动态表单 | 1.5 天 |
| 4 | detail 页重构 + 类型渲染 + re-prompt 重验 | 1.5 天 |
| 5 | index 页重构 + 类型图标/副标题/筛选 chips + 搜索扩展 | 1.5 天 |
| 6 | 其余页面照原 V6 计划（锁屏/设置/会员/协议/TabBar） | 2 天 |
| 7 | 全量回归（重点：存量登录条目全链路不变） | 1 天 |

**合计约 11 个工作日**（原 V6 单独 6.5 天 + 类型扩展单独 ~4.5 天，合并省 ~4 天重复工作）。

版本策略不变：动工前打 tag `v3.2.0-pre-refactor`；本版本完成后随备案通过一起提审（版本号建议直接升 **v4.0.0**——数据模型 + UI 双大改，配得上大版本号）。

---

## 七、已否决项

| 提案 | 否决原因 |
|------|---------|
| 抄全 1Password 的 21 类 | 移动端选择器灾难 + 维护成本高，90% 用不上 |
| 纯自定义字段制（Bitwarden 路线） | 用户每次填字段要自己想名称，负担大；固定模板 + 自定义字段兜底才是最优解 |
| 自由模板制（KeePassXC 路线） | 上手门槛高，与小白定位冲突 |
| 身份证/护照/社保号类型 | 合规审查风险高，非当前刚需，后置 |
| 条目附件/文件上传 | 包体与审核风险（参考 avatar 教训），云存储方案后置另议 |
| 字段级独立加密 | 现有整条 AES 加密已够，字段级改造收益低风险高 |
| Wi-Fi 类型进首发 | 候选池，先做用户明确要的 |

---

## 八、TODO

- [ ] 用户确认类型清单（尤其：API 密钥类型要不要进首发 P1）
- [ ] entry-templates.js 落地（与 V6 步骤 1 合并）
- [ ] re-prompt 重验交互稿（复用锁屏验证还是独立弹层）
- [ ] 隐私保护指引更新文案（银行卡/服务器信息收集说明）
