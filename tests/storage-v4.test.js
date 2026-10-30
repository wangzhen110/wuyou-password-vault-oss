const assert = require('node:assert/strict');

function createHarness() {
  const store = {};
  let nextByte = 1;
  const app = { globalData: { isLocked: false, masterKey: null, openid: null } };
  global.wx = {
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '';
    },
    setStorageSync(key, value) {
      store[key] = value;
    },
    removeStorageSync(key) {
      delete store[key];
    },
    getRandomValues({ length, success }) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) bytes[index] = nextByte++ & 0xff;
      success({ randomValues: bytes.buffer });
    },
    cloud: {
      callFunction({ fail }) {
        if (fail) fail(new Error('cloud unavailable'));
      },
    },
  };
  global.getApp = () => app;
  delete require.cache[require.resolve('../miniprogram/utils/storage')];
  return {
    app,
    store,
    storage: require('../miniprogram/utils/storage'),
  };
}

async function main() {
  const { store, storage } = createHarness();
  const templates = require('../miniprogram/utils/entry-templates');
  const setup = await storage.setMasterPassword('storage regression password');
  assert.equal(setup.success, true);

  assert.equal(templates.getTemplate('nope').name, '登录');
  assert.equal(templates.getEntryType({}), 'login');
  assert.equal(templates.getEntryType({ type: 'ghost' }), 'login');
  assert.deepEqual(templates.TYPE_ORDER, ['login', 'server', 'bankcard', 'note', 'apikey']);
  assert.deepEqual(templates.emptyFields('login'), []);

  const serverFields = templates.emptyFields('server');
  assert.equal(serverFields.length, 6);
  assert.equal(serverFields.find(field => field.key === 'sshkey').concealed, true);
  assert.equal(serverFields.find(field => field.key === 'proto').value, '');
  assert.equal(templates.getTemplate('server').fields.find(field => field.key === 'proto').options.length, 6);
  assert.equal(templates.getTemplate('bankcard').fields.find(field => field.key === 'number').rePrompt, true);
  assert.equal(templates.getTemplate('bankcard').fields.find(field => field.key === 'cvv').rePrompt, true);
  assert.ok(templates.getTemplate('apikey').fields.every(field => !field.rePrompt));

  const login = await storage.addPassword({
    platform: '淘宝',
    account: 'a@b.c',
    password: 'login-secret',
    alias: '',
    notes: '',
    securityQuestion: '',
    securityAnswer: 'answer-secret',
    bindPhone: '',
  }, setup.masterKey);
  assert.equal(login.type, 'login');
  assert.deepEqual(Object.keys(login).sort(), [
    'account', 'alias', 'api_access', 'bindPhone', 'created_at', 'created_timestamp', 'id',
    'is_deleted', 'notes', 'password', 'pinned', 'platform', 'securityAnswer',
    'securityQuestion', 'type', 'updated_at',
  ]);
  // API 访问打标预埋：默认不可访问，显式开启才为 true
  assert.equal(login.api_access, false);
  const apiFlagged = await storage.addPassword({
    platform: 'dev-key',
    account: 'ci-bot',
    password: 'k-secret',
    api_access: true,
  }, setup.masterKey);
  assert.equal(apiFlagged.api_access, true);
  assert.equal(login.securityAnswer, 'answer-secret');

  const server = await storage.addPassword({
    type: 'server',
    platform: '服务器',
    fields: [{ key: 'host', label: '主机地址', value: '10.0.0.5', concealed: false }],
    custom_fields: [{ label: '机房', value: '北京三区', concealed: true }],
    securityAnswer: 'server-answer',
  }, setup.masterKey);
  assert.equal(server.type, 'server');
  assert.equal(server.fields[0].value, '10.0.0.5');
  assert.equal(server.custom_fields[0].value, '北京三区');
  assert.equal(server.securityAnswer, 'server-answer');

  const envelopes = store['pwd_passwords'];
  assert.ok(envelopes.every(record => record.crypto_version === 1));
  assert.ok(!JSON.stringify(envelopes).includes('login-secret'));
  assert.ok(!JSON.stringify(envelopes).includes('answer-secret'));
  assert.ok(!JSON.stringify(envelopes).includes('北京三区'));

  await storage.updatePassword(server.id, { type: 'login', notes: 'changed' }, setup.masterKey);
  const updated = (await storage.getAllPasswords(setup.masterKey)).find(entry => entry.id === server.id);
  assert.equal(updated.type, 'login');
  assert.equal(updated.notes, 'changed');
  assert.equal('fields' in updated, false);
  assert.equal(updated.custom_fields[0].value, '北京三区');

  const concurrent = await Promise.all([
    storage.addPassword({ platform: '并发一', account: 'one', password: 'secret-one' }, setup.masterKey),
    storage.addPassword({ platform: '并发二', account: 'two', password: 'secret-two' }, setup.masterKey),
  ]);
  assert.equal(concurrent.length, 2);
  assert.equal((await storage.getAllPasswords(setup.masterKey)).length, 5);

  const pending = store['pwd_pending_sync'];
  assert.equal(pending.length, 6);
  assert.equal(new Set(pending.map(item => item.queue_id)).size, pending.length);
  assert.equal(pending.filter(item => item.action === 'add' && item.data.crypto_version === 1).length, 5);
  assert.ok(pending.every(item => item.collection === 'passwords'));

  assert.equal(templates.getSubtitle({ type: 'login', account: 'a@b.c' }), 'a@b.c');
  assert.equal(templates.getSubtitle({
    type: 'server',
    fields: [{ key: 'host', value: '10.0.0.5' }, { key: 'port', value: '22' }],
  }), '10.0.0.5:22');
  assert.equal(templates.getSubtitle({
    type: 'bankcard',
    fields: [{ key: 'number', value: '6222 0000 1111 2222' }],
  }), '•••• 2222');
  assert.equal(templates.getSubtitle({ platform: 'legacy', account: '' }), 'legacy');

  console.log('storage-v4: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
