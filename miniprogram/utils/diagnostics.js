/**
 * 诊断与实时日志（2026-10-25 引入）
 *
 * 目的：没有真机也能观测线上问题。iOS「解锁卡死」这次暴露的最大短板是——
 * 出问题后只能靠用户口述，拿不到阶段、耗时、错误码。
 *
 * 安全红线（S-07 / K-04）：
 *   1. 只上报「元数据」：阶段名、耗时毫秒、布尔结果、错误码、机型/系统版本
 *   2. 敏感字段一律脱敏为 '[redacted]'：密码、密钥、token、盐、校验值、密文、MAC、iv、openid
 *   3. 对象/数组等非标量不序列化（避免把整个记录带上去）
 *   4. 单条字符串上限 120 字符，事件环缓冲上限 50 条
 *
 * 查看位置：微信公众平台 → 开发管理 → 运维中心 → 实时日志（按 filterMsg 过滤）
 * 能力检测：低版本基础库没有 wx.getRealtimeLogManager，此时自动降级为仅 console
 */

const MAX_STRING = 120;
const MAX_EVENTS = 50;
const FILTER_MSG = 'wuyou-vault';

// 命中即脱敏：key 里含这些词的字段一律不上报原值
// 注：iv 虽是公开参数，但仍属加密材料，一律不上报（2026-10-25 由测试发现遗漏）
const SENSITIVE_KEY = /pass|pwd|secret|token|api_?key|^key$|cipher|plaintext|content|mac|salt|verifier|openid|session|signature|^iv$/i;

const events = [];
let managerResolved = false;
let manager = null;
let deviceInfo = null;

function formatTime() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + d.getMilliseconds();
}

function safeScalar(value) {
  const type = typeof value;
  if (value === null || type === 'undefined') return null;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  // 对象/数组/函数一律不序列化，避免误带敏感数据
  return undefined;
}

/** 脱敏：敏感 key 记为 [redacted]，非标量丢弃 */
function sanitize(payload) {
  const output = {};
  if (!payload || typeof payload !== 'object') return output;
  Object.keys(payload).forEach((key) => {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[redacted]';
      return;
    }
    const scalar = safeScalar(payload[key]);
    if (scalar !== undefined) output[key] = scalar;
  });
  return output;
}

function getManager() {
  if (managerResolved) return manager;
  managerResolved = true;
  try {
    if (typeof wx !== 'undefined' && typeof wx.getRealtimeLogManager === 'function') {
      manager = wx.getRealtimeLogManager();
      if (manager && typeof manager.setFilterMsg === 'function') {
        try { manager.setFilterMsg(FILTER_MSG); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) {
    manager = null;
  }
  return manager;
}

/** 设备信息只采集一次，用于区分机型/系统维度的差异 */
function getDeviceInfo() {
  if (deviceInfo) return deviceInfo;
  deviceInfo = {};
  try {
    if (typeof wx !== 'undefined') {
      const dev = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : null;
      const app = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : null;
      const sys = dev && app ? null : (typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null);
      const merged = dev || sys || {};
      const appMerged = app || sys || {};
      deviceInfo = {
        platform: merged.platform || '',
        system: merged.system || '',
        model: merged.model || '',
        brand: merged.brand || '',
        sdk: appMerged.SDKVersion || '',
        wxver: appMerged.version || '',
      };
    }
  } catch (e) {
    deviceInfo = {};
  }
  return deviceInfo;
}

function emit(level, event, payload) {
  const body = sanitize(payload);
  const line = '[diag][' + event + '] ' + JSON.stringify(body);
  const record = { t: Date.now(), clock: formatTime(), level, event, body };
  events.push(record);
  if (events.length > MAX_EVENTS) events.shift();

  try {
    if (typeof console !== 'undefined' && typeof console[level] === 'function') {
      console[level](line);
    }
  } catch (e) { /* 忽略 */ }

  const mgr = getManager();
  if (mgr && typeof mgr[level] === 'function') {
    try { mgr[level](line); } catch (e) { /* 上报失败绝不影响业务 */ }
  }
  return line;
}

/** 关键阶段打点（正常路径） */
function stage(event, payload) {
  return emit('info', event, payload);
}

/** 可恢复异常 */
function warn(event, payload) {
  return emit('warn', event, payload);
}

/** 进入错误处理路径：自动附带设备信息（不含任何用户数据） */
function error(event, payload) {
  const merged = Object.assign({}, getDeviceInfo(), sanitize(payload));
  return emit('error', event, merged);
}

/** 冷启动时上报一次环境，便于按机型/系统切片查看 */
function init() {
  emit('info', 'app_init', getDeviceInfo());
}

function getRecentEvents() {
  return events.slice();
}

module.exports = {
  init,
  stage,
  warn,
  error,
  sanitize,
  getDeviceInfo,
  getRecentEvents,
  FILTER_MSG,
  SENSITIVE_KEY,
};
