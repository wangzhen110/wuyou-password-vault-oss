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
  return { store, storage: require('../miniprogram/utils/storage') };
}

async function main() {
  const { store, storage } = createHarness();
  const setup = await storage.setMasterPassword('import target password');
  const importer = require('../miniprogram/utils/import');
  const exporter = require('../miniprogram/utils/export');

  const original = {
    version: '1.0',
    data: {
      passwords: [
        {
          id: 'json-entry',
          platform: '邮箱',
          account: 'one@example.com',
          password: 'json-secret',
          securityAnswer: 'json-answer',
          fields: [{ key: 'secret', value: 'field-secret', concealed: true }],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'json-entry',
          platform: 'duplicate',
          account: 'ignored',
          password: 'ignored',
        },
      ],
    },
  };
  const jsonResult = await importer.importJSON(JSON.stringify(original), setup.masterKey);
  assert.equal(jsonResult.success, true);
  assert.equal(jsonResult.count, 1);
  assert.equal(jsonResult.skipped, 1);
  assert.deepEqual(await storage.getAllPasswords(setup.masterKey).then(list => list.map(item => item.id)), ['json-entry']);
  assert.equal(JSON.stringify(store['pwd_passwords']).includes('json-secret'), false);
  assert.equal(JSON.stringify(store['pwd_passwords']).includes('json-answer'), false);

  const beforeInvalidJson = store['pwd_passwords'];
  const invalidJson = await importer.importJSON(JSON.stringify({ data: { passwords: 'not-an-array' } }), setup.masterKey);
  assert.equal(invalidJson.success, false);
  assert.equal(store['pwd_passwords'], beforeInvalidJson);

  const csv = [
    'id,type,platform,account,password,alias,notes,securityQuestion,securityAnswer,bindPhone,pinned,fields,custom_fields,created_at,updated_at',
    'csv-entry,login,"Platform, with comma",csv-user,csv-secret,Alias,"line one',
    'line ""two""",Question,Answer,123,true,"[]","[{""label"":""token"",""value"":""csv-custom"",""concealed"":true}]",2026-02-01T00:00:00.000Z,2026-02-02T00:00:00.000Z',
  ].join('\n');
  const csvResult = await importer.importCSV(csv, setup.masterKey);
  assert.equal(csvResult.success, true);
  assert.equal(csvResult.count, 1);
  const csvEntry = (await storage.getAllPasswords(setup.masterKey)).find(item => item.id === 'csv-entry');
  assert.equal(csvEntry.platform, 'Platform, with comma');
  assert.equal(csvEntry.notes, 'line one\nline "two"');
  assert.equal(csvEntry.custom_fields[0].value, 'csv-custom');
  assert.equal(csvEntry.securityQuestion, 'Question');
  assert.equal(csvEntry.securityAnswer, 'Answer');
  assert.equal(csvEntry.bindPhone, '123');

  const roundTripSource = {
    ...csvEntry,
    id: 'csv-round-trip-source',
    securityQuestion: 'Round-trip question',
    securityAnswer: 'Round-trip answer',
    bindPhone: '555-0100',
  };

  const roundTripCsv = exporter.exportCSV([roundTripSource]);
  const roundTripResult = await importer.importCSV(roundTripCsv, setup.masterKey);
  assert.equal(roundTripResult.success, true);
  assert.equal(roundTripResult.count, 1);
  const roundTripEntry = (await storage.getAllPasswords(setup.masterKey))
    .find(item => item.id === 'csv-round-trip-source');
  assert.equal(roundTripEntry.securityQuestion, 'Round-trip question');
  assert.equal(roundTripEntry.securityAnswer, 'Round-trip answer');
  assert.equal(roundTripEntry.bindPhone, '555-0100');
  const snakeCaseCsv = [
    'id,security_question,security_answer,bind_phone,platform,account,password',
    'snake-entry,Legacy question,Legacy answer,555-0101,Legacy platform,legacy-user,legacy-secret',
  ].join('\n');
  const snakeCaseResult = await importer.importCSV(snakeCaseCsv, setup.masterKey);
  assert.equal(snakeCaseResult.success, true);
  const snakeCaseEntry = (await storage.getAllPasswords(setup.masterKey))
    .find(item => item.id === 'snake-entry');
  assert.equal(snakeCaseEntry.securityQuestion, 'Legacy question');
  assert.equal(snakeCaseEntry.securityAnswer, 'Legacy answer');
  assert.equal(snakeCaseEntry.bindPhone, '555-0101');

  const legacyCsv = 'title,username,password,url,category,notes,favorite\nOld title,old-user,old-secret,https://example.com,,old-note,是';
  const legacyResult = await importer.importCSV(legacyCsv, setup.masterKey);
  assert.equal(legacyResult.success, true);
  assert.equal(legacyResult.count, 1);
  const legacyEntry = (await storage.getAllPasswords(setup.masterKey)).find(item => item.platform === 'Old title');
  assert.equal(legacyEntry.account, 'old-user');
  assert.equal(legacyEntry.password, 'old-secret');
  assert.ok(legacyEntry.custom_fields.some(field => field.label === '网址' && field.value === 'https://example.com'));

  const backupPayload = JSON.stringify({
    data: {
      passwords: [{
        id: 'backup-entry',
        platform: '银行卡',
        account: '',
        password: '',
        fields: [{ key: 'number', label: '卡号', value: '4111111111111111', concealed: true }],
      }],
    },
  });
  const encryptedText = await exporter.exportEncrypted(backupPayload, 'independent backup password');
  assert.equal(typeof encryptedText, 'string');
  const backup = JSON.parse(encryptedText);
  assert.equal(backup.magic, 'PWMA');
  assert.notEqual(backup.meta.salt, setup.meta.salt);

  const wrongPassword = await importer.importEncrypted(encryptedText, 'wrong backup password', setup.masterKey);
  assert.equal(wrongPassword.success, false);
  const changed = { ...backup, envelope: { ...backup.envelope, mac: '0'.repeat(64) } };
  const tampered = await importer.importEncrypted(JSON.stringify(changed), 'independent backup password', setup.masterKey);
  assert.equal(tampered.success, false);
  assert.equal((await storage.getAllPasswords(setup.masterKey)).some(item => item.id === 'backup-entry'), false);

  const restored = await importer.importEncrypted(encryptedText, 'independent backup password', setup.masterKey);
  assert.equal(restored.success, true);
  assert.equal(restored.count, 1);
  const restoredEntry = (await storage.getAllPasswords(setup.masterKey)).find(item => item.id === 'backup-entry');
  assert.equal(restoredEntry.fields[0].value, '4111111111111111');

  console.log('import-export: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
