/**
 * 条目类型模板中心 V4.0
 *
 * 对应方案：docs/item-types-proposal.md（6 类 + 自定义字段，Wi-Fi 后置候选池）
 * 职责：
 *  - add 页：按模板动态渲染表单（emptyFields 生成空白字段区）
 *  - detail 页：按模板分组渲染 + concealed/re-prompt 判断
 *  - index 页：类型图标 key + 副标题（getSubtitle）
 *
 * 数据结构（写入 entry，随整条对象 AES 加密、同步透传）：
 *  entry.type           "login" | "server" | "bankcard" | "note" | "apikey"
 *                       存量条目无此字段，读取时缺省视为 "login"
 *  entry.fields         [{ key, label, value, concealed }]  非 login 类型的结构化字段
 *  entry.custom_fields  [{ label, value, concealed }]       用户自建字段（任意类型可加）
 *
 * 铁律：登录类条目保持原有扁平字段（platform/account/password…），
 *       列表、搜索、复制逻辑零改动；只有新建非登录类型才写 fields。
 */

const TEMPLATES = {
  login: {
    name: '登录',
    icon: 'lock',
    fields: [], // 沿用扁平字段
  },
  server: {
    name: '服务器',
    icon: 'server',
    fields: [
      { key: 'host', label: '主机地址', concealed: false },
      { key: 'port', label: '端口', concealed: false, input: 'number' },
      { key: 'user', label: '用户名', concealed: false },
      { key: 'pass', label: '密码', concealed: true },
      { key: 'sshkey', label: 'SSH私钥', concealed: true, input: 'textarea' },
      { key: 'proto', label: '协议', concealed: false, input: 'select',
        options: ['SSH', 'RDP', 'MySQL', 'Redis', 'HTTP', '其他'] },
    ],
  },
  bankcard: {
    name: '银行卡',
    icon: 'card',
    fields: [
      { key: 'bank', label: '银行', concealed: false },
      { key: 'number', label: '卡号', concealed: true, format: 'cardno', rePrompt: true },
      { key: 'holder', label: '持卡人', concealed: false },
      { key: 'expiry', label: '有效期', concealed: false, input: 'monthyear' },
      { key: 'cvv', label: 'CVV', concealed: true, input: 'number', rePrompt: true },
    ],
  },
  note: {
    name: '安全笔记',
    icon: 'note',
    fields: [
      { key: 'body', label: '内容', concealed: false, input: 'textarea' },
    ],
  },
  apikey: {
    name: 'API密钥',
    icon: 'key',
    fields: [
      { key: 'service', label: '服务名', concealed: false },
      { key: 'key', label: 'Key', concealed: true, input: 'textarea' },
      { key: 'secret', label: 'Secret', concealed: true, input: 'textarea' },
      { key: 'endpoint', label: '接口地址', concealed: false },
    ],
  },
  // Wi-Fi 类型在候选池（P2），模板先不注册，避免 add 页选择器出现未实现类型
};

/** 默认类型：存量条目与新条目兜底 */
const DEFAULT_TYPE = 'login';

/** add 页类型选择器顺序（登录永远第一，默认选中） */
const TYPE_ORDER = ['login', 'server', 'bankcard', 'note', 'apikey'];

/**
 * 取类型模板。未知类型（含脏数据）一律回退 login，防渲染崩溃。
 */
function getTemplate(type) {
  return TEMPLATES[type] || TEMPLATES[DEFAULT_TYPE];
}

function getTypeName(type) {
  return getTemplate(type).name;
}

/** index/detail 纯 CSS 图标 key（V6 图标体系） */
function getIcon(type) {
  return getTemplate(type).icon;
}

/**
 * 判断 entry 的有效类型（存量条目无 type → login）
 */
function getEntryType(entry) {
  if (!entry || !entry.type) return DEFAULT_TYPE;
  return TEMPLATES[entry.type] ? entry.type : DEFAULT_TYPE;
}

/**
 * 按模板生成空白 fields 数组（add 页选类型后初始化表单用）
 * 只产出数据 4 键（key/label/value/concealed），渲染所需的
 * input/options/format/rePrompt 元数据渲染时从模板实时查。
 */
function emptyFields(type) {
  const tpl = getTemplate(type);
  if (!tpl.fields.length) return [];
  return tpl.fields.map(f => ({
    key: f.key,
    label: f.label,
    value: '',
    concealed: !!f.concealed,
  }));
}

/**
 * 从 entry.fields 里取指定 key 的值（无则返回空串）
 */
function getFieldValue(entry, key) {
  if (!entry || !Array.isArray(entry.fields)) return '';
  const found = entry.fields.find(f => f.key === key);
  return found ? (found.value || '') : '';
}

/**
 * index 页列表副标题（对应方案 4.2 副标题表）
 * login → 账号；server → host:port；bankcard → •••• 尾号4位；
 * note → 内容首行截断；apikey → 服务名
 */
function getSubtitle(entry) {
  if (!entry) return '';
  const type = getEntryType(entry);

  if (type === 'login') {
    return entry.account || entry.platform || '';
  }
  if (type === 'server') {
    const host = getFieldValue(entry, 'host');
    const port = getFieldValue(entry, 'port');
    if (!host) return '';
    return port ? host + ':' + port : host;
  }
  if (type === 'bankcard') {
    const num = (getFieldValue(entry, 'number') || '').replace(/\s+/g, '');
    return num ? '•••• ' + num.slice(-4) : '';
  }
  if (type === 'note') {
    const body = getFieldValue(entry, 'body') || '';
    const firstLine = body.split('\n')[0].trim();
    return firstLine.length > 20 ? firstLine.slice(0, 20) + '…' : firstLine;
  }
  if (type === 'apikey') {
    return getFieldValue(entry, 'service');
  }
  return '';
}

module.exports = {
  DEFAULT_TYPE,
  TYPE_ORDER,
  getTemplate,
  getTypeName,
  getIcon,
  getEntryType,
  emptyFields,
  getFieldValue,
  getSubtitle,
};
