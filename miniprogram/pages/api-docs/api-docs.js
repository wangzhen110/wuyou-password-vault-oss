// pages/api-docs —— 开放 API 接入文档（应用内可读、代码可复制）
const theme = require('../../styles/theme');

const BASE_URL = 'https://your-cloud-env-id-1448869858.ap-shanghai.app.tcloudbase.com/v1';

Page({
  data: {
    themeClass: '',
    baseUrl: BASE_URL,
    sections: [],
    expanded: {},
  },

  onLoad() {
    this.setData({
      themeClass: theme.getThemeClass(),
      sections: this.buildSections(),
      expanded: { overview: true, flow: true, api: true },
    });
  },

  buildSections() {
    return [
      {
        key: 'overview',
        title: '一、它能做什么',
        blocks: [
          { type: 'p', text: '让第三方程序（脚本、插件、自建服务）读取你在无忧密码本里保存的账号密码，免去手动输入。开放 API 为年度会员专属权益，会员到期后令牌同步失效。' },
          { type: 'list', items: [
            '接口只返回密文（没有明文密码字段）',
            '解密在你自己的程序里完成，需要你的主密码',
            '本版本只读，不支持第三方修改你的密码库',
          ] },
          { type: 'kv', rows: [
            ['Base URL', BASE_URL],
            ['鉴权方式', 'Authorization: Bearer <token>'],
            ['令牌有效期', '30 天，可随时在小程序内吊销'],
            ['限流', '每令牌 60 次/分钟'],
            ['设备上限', '每账号最多 5 台'],
          ] },
          { type: 'code', label: 'Base URL', text: BASE_URL },
        ],
      },
      {
        key: 'flow',
        title: '二、授权流程（三步）',
        blocks: [
          { type: 'list', items: [
            '① 在小程序「开放 API 授权」页点「生成授权码」，得到 8 位码（5 分钟有效）',
            '② 第三方程序提交这个码：POST /v1/token { code, device_name }',
            '③ 你在小程序里看到设备名，点「允许接入」；第三方重新提交即拿到令牌',
          ] },
          { type: 'p', text: '授权码一次性、用后即废。令牌只在成功那一次响应里出现，服务端只存哈希。' },
        ],
      },
      {
        key: 'api',
        title: '三、接口清单',
        blocks: [
          { type: 'kv', rows: [
            ['POST /v1/token', '换取令牌（首次返回 202 待确认）'],
            ['GET /v1/vault/meta', '读取公开参数：kdf / iterations / salt / verifier'],
            ['GET /v1/items', '拉取密文条目（?since=&limit=100）'],
          ] },
          { type: 'code', label: '换取令牌 · 请求', text: 'POST /v1/token\nContent-Type: application/json\n\n{ "code": "12345678", "device_name": "我的脚本" }' },
          { type: 'code', label: '换取令牌 · 成功响应', text: '{\n  "success": true,\n  "token": "<64位十六进制>",\n  "expires_in": 2592000,\n  "scopes": ["items:read"]\n}' },
          { type: 'code', label: '拉取密文 · 响应片段', text: '{\n  "success": true,\n  "items": [{\n    "id": "entry-1",\n    "crypto_version": 1,\n    "iv": "<hex>",\n    "ciphertext": "<hex>",\n    "mac": "<hex>",\n    "salt": "<hex>",\n    "created_at": "...",\n    "updated_at": "...",\n    "is_deleted": false\n  }],\n  "server_time": 1792290000000\n}' },
          { type: 'table', head: ['HTTP', 'error', '说明'], rows: [
            ['401', 'unauthorized', '令牌缺失或无效'],
            ['403', 'token_revoked / token_expired', '被吊销或过期，需重新授权'],
            ['403', 'vip_required', '会员已到期，续费后恢复'],
            ['429', 'rate_limited', '超过 60 次/分钟，退避重试'],
            ['404', 'code_not_found', '授权码不存在'],
            ['410', 'code_expired / code_used', '授权码过期或已使用'],
            ['403', 'rejected_by_user', '用户拒绝了该设备'],
          ] },
        ],
      },
      {
        key: 'crypto',
        title: '四、本地解密规范（关键）',
        blocks: [
          { type: 'p', text: '密码库格式：PBKDF2-HMAC-SHA256（60 万次）+ AES-256-CBC + HMAC-SHA256 认证。以下顺序必须严格一致。' },
          { type: 'code', label: '派生密钥', text: 'material = PBKDF2-HMAC-SHA256(masterPassword, salt, 600000, 64)\nencryptionKey = material[0..32)\nmacKey        = material[32..64)' },
          { type: 'code', label: '校验主密码', text: 'verifier = hex(HMAC-SHA256(macKey, "vault-verifier:v1"))\n// 与 /v1/vault/meta 返回的 verifier 比较' },
          { type: 'code', label: '认证数据（AAD）顺序', text: 'JSON.stringify([\n  crypto_version, salt, id,\n  created_at, updated_at, iv, ciphertext\n])' },
          { type: 'p', text: '顺序：先算 HMAC 并与 mac 常量时间比较（不一致=密文被篡改，必须拒绝），再用 AES-256-CBC 解密，最后 JSON.parse。created_at / updated_at 参与签名，不能改写。' },
        ],
      },
      {
        key: 'sdk',
        title: '五、SDK 用法（Node.js）',
        blocks: [
          { type: 'code', label: '三步取密码', text: 'const { VaultClient } = require("./sdk/wuyou-vault");\n\nconst vault = new VaultClient({ baseUrl: BASE_URL, token });\nawait vault.unlock("用户主密码");\nconst items = await vault.list();\nconst pwd = vault.getField(items[0], "password");' },
          { type: 'p', text: 'SDK 不把密钥写入磁盘；也可以按第四节自行实现，不依赖 SDK。' },
        ],
      },
      {
        key: 'safety',
        title: '六、安全须知',
        blocks: [
          { type: 'list', items: [
            '主密码只在你的设备上使用，任何要求上传主密码的服务都应视为危险',
            '令牌只授予"读取密文"的权限，泄露也无法解密',
            '用户可随时在小程序内吊销设备，立即生效',
            '所有访问都有审计记录（时间、设备、条目数、IP）',
          ] },
        ],
      },
    ];
  },

  onToggle(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ ['expanded.' + key]: !this.data.expanded[key] });
  },

  onCopy(e) {
    const text = e.currentTarget.dataset.text;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },
});
