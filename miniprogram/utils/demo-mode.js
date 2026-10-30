// 演示模式（供小程序审核与首次体验使用）
// 设计原则（安全红线）：
//   1. 演示数据只存在于内存，重启即失效，不落任何存储键；
//   2. 演示模式下所有写操作（新增/编辑/删除/导入/同步）一律拒绝；
//   3. 绝不读取、绝不污染真实密码库；退出后需正常输入主密码才能进入真实数据。

const ENTRIES = [
  {
    id: 'demo-1',
    type: 'login',
    platform: '示例邮箱',
    account: 'demo@example.com',
    password: 'Demo#2026Pass',
    url: 'https://mail.example.com',
    note: '演示数据，可点开查看详情与复制',
    pinned: true,
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-18T08:30:00.000Z',
    is_deleted: false,
  },
  {
    id: 'demo-2',
    type: 'login',
    platform: '示例购物站',
    account: 'shopper01',
    password: 'Shop$Buy8848',
    url: 'https://shop.example.com',
    note: '演示数据',
    pinned: false,
    created_at: '2026-10-02T10:20:00.000Z',
    updated_at: '2026-10-16T11:00:00.000Z',
    is_deleted: false,
  },
  {
    id: 'demo-3',
    type: 'server',
    platform: '示例云服务器',
    account: 'root',
    password: 'Srv#Demo2026',
    url: '203.0.113.10',
    note: '演示数据：服务器类条目',
    pinned: false,
    created_at: '2026-10-03T14:00:00.000Z',
    updated_at: '2026-10-15T09:12:00.000Z',
    is_deleted: false,
  },
  {
    id: 'demo-4',
    type: 'bankcard',
    platform: '示例银行',
    account: '6222 0000 0000 0000',
    password: '123456',
    url: '',
    note: '演示数据：银行卡类条目',
    pinned: false,
    created_at: '2026-10-05T08:40:00.000Z',
    updated_at: '2026-10-14T16:25:00.000Z',
    is_deleted: false,
  },
  {
    id: 'demo-5',
    type: 'note',
    platform: '示例安全笔记',
    account: '',
    password: '',
    url: '',
    note: '这条是演示用的安全笔记：密码本支持存备注类内容，同样端到端加密。',
    pinned: false,
    created_at: '2026-10-06T12:00:00.000Z',
    updated_at: '2026-10-13T10:05:00.000Z',
    is_deleted: false,
  },
];

function app() {
  try {
    return getApp();
  } catch (e) {
    return null;
  }
}

function isActive() {
  const instance = app();
  return !!(instance && instance.globalData && instance.globalData.demoMode === true);
}

function enter() {
  const instance = app();
  if (!instance) return false;
  if (!instance.globalData) instance.globalData = {};
  instance.globalData.demoMode = true;
  instance.globalData.isLocked = false;
  // 关键：进入演示模式必须清掉真实主密钥，避免后续操作把演示数据写进真实库
  instance.globalData.masterKey = null;
  return true;
}

function exit() {
  const instance = app();
  if (!instance) return false;
  if (instance.globalData) {
    instance.globalData.demoMode = false;
    instance.globalData.masterKey = null;
    instance.globalData.isLocked = true;
  }
  return true;
}

/** 返回条目副本，避免调用方修改内置演示数据 */
function getEntries() {
  return ENTRIES.map(entry => ({ ...entry }));
}

/** 演示模式统一拒绝写入 */
function blocked() {
  return { success: false, error: '演示模式仅供体验，不支持修改数据' };
}

module.exports = { isActive, enter, exit, getEntries, blocked };
