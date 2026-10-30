// 诊断日志的安全底线测试（S-07 / K-04）
// 核心断言：任何用户数据、密钥、密文都不得出现在上报内容里，只能出现元数据。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const DIAG = path.join(__dirname, '..', 'miniprogram', 'utils', 'diagnostics.js');

/** 每次测试都重新加载模块（模块内部缓存了 manager 与事件环） */
function freshDiagnostics(wxStub) {
  const captured = [];
  global.wx = Object.assign({
    getRealtimeLogManager: () => ({
      info: (line) => captured.push(line),
      warn: (line) => captured.push(line),
      error: (line) => captured.push(line),
      setFilterMsg: () => {},
    }),
    getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 17.0', model: 'iPhone 14', brand: 'iPhone' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.0.0', version: '8.0.50' }),
  }, wxStub || {});

  delete require.cache[require.resolve(DIAG)];
  return { diag: require(DIAG), captured };
}

test('密码类字段一律脱敏，绝不出现明文', () => {
  const { diag } = freshDiagnostics();
  const out = diag.sanitize({
    password: 'MySecret123',
    pwd: 'MySecret123',
    confirmPassword: 'MySecret123',
    newPassword: 'MySecret123',
    oldPassword: 'MySecret123',
  });
  Object.keys(out).forEach((key) => {
    assert.equal(out[key], '[redacted]', key + ' 必须被脱敏');
  });
  assert.equal(JSON.stringify(out).indexOf('MySecret123'), -1, '序列化后不得出现明文');
});

test('密钥/令牌/密文类字段一律脱敏', () => {
  const { diag } = freshDiagnostics();
  const out = diag.sanitize({
    token: 'abc',
    secret: 'abc',
    apiKey: 'abc',
    ciphertext: 'abc',
    mac: 'abc',
    salt: 'abc',
    verifier: 'abc',
    iv: 'abc',
    openid: 'oABC123',
    session_key: 'abc',
    signature: 'abc',
  });
  Object.keys(out).forEach((key) => {
    assert.equal(out[key], '[redacted]', key + ' 必须被脱敏');
  });
});

test('非标量（对象/数组）直接丢弃，避免整条记录被带上去', () => {
  const { diag } = freshDiagnostics();
  const out = diag.sanitize({
    items: [{ account: 'a@b.com', password: 'x' }],
    nested: { anything: 'value' },
    fn: function () {},
  });
  assert.equal(Object.keys(out).length, 0, '对象/数组/函数不应出现在上报内容里');
});

test('长字符串被截断，避免日志体积失控', () => {
  const { diag } = freshDiagnostics();
  const long = 'x'.repeat(500);
  const out = diag.sanitize({ note: long });
  assert.ok(out.note.length <= 121, '应截断到 120 字符左右，实际 ' + out.note.length);
  assert.ok(out.note.endsWith('…'), '截断应有省略号标记');
});

test('正常元数据（数字/布尔/短字符串）完整保留', () => {
  const { diag } = freshDiagnostics();
  const out = diag.sanitize({ ms: 1234, ok: true, stage: 'unlock_start', ratio: 0.5 });
  assert.deepEqual(out, { ms: 1234, ok: true, stage: 'unlock_start', ratio: 0.5 });
});

test('上报内容里不得含密码明文；设备信息随错误上报但无用户数据', () => {
  const { diag, captured } = freshDiagnostics();
  diag.error('unlock_threw', { password: 'TopSecret999', msg: 'boom' });
  const joined = captured.join('\n');
  assert.equal(joined.indexOf('TopSecret999'), -1, '上报内容不得出现密码明文');
  assert.ok(joined.indexOf('[redacted]') >= 0, '应包含脱敏占位');
  assert.ok(joined.indexOf('iPhone 14') >= 0, '错误上报应带机型信息，便于按机型切片');
});

test('基础库不支持实时日志时，降级为 console 且不抛错', () => {
  delete global.wx;
  delete require.cache[require.resolve(DIAG)];
  const diagNoWx = require(DIAG);
  assert.doesNotThrow(() => {
    diagNoWx.stage('no_wx_stage', { ms: 1 });
    diagNoWx.error('no_wx_error', { msg: 'x' });
  }, '缺少 wx 时不得抛错，诊断不能影响业务');
});
