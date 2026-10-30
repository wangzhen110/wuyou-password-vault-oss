/**
 * Import current and legacy JSON/CSV exports into the encrypted vault.
 */

const storage = require('./storage');
const crypto = require('./crypto');

const CSV_HEADERS = {
  securityquestion: 'securityQuestion',
  security_question: 'securityQuestion',
  securityanswer: 'securityAnswer',
  security_answer: 'securityAnswer',
  bindphone: 'bindPhone',
  bind_phone: 'bindPhone',
  '标题': 'title',
  '账号': 'username',
  '密码': 'password',
  '网址': 'url',
  '分类': 'category',
  '备注': 'notes',
  '收藏': 'favorite',
  '创建时间': 'created_at',
  '更新时间': 'updated_at',
};

function asBoolean(value) {
  return value === true || value === 1 || /^(1|true|yes|y|是)$/i.test(String(value || '').trim());
}

function parseImportedEntry(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('导入条目格式无效');
  }

  const entry = { ...source };
  entry.platform = source.platform || source.title || source.name || '其他';
  entry.account = source.account || source.username || '';
  entry.password = source.password || '';
  entry.alias = source.alias || '';
  entry.notes = source.notes || '';
  entry.securityQuestion = source.securityQuestion || source.security_question || '';
  entry.securityAnswer = source.securityAnswer || source.security_answer || '';
  entry.bindPhone = source.bindPhone || source.bind_phone || '';
  entry.pinned = asBoolean(source.pinned !== undefined
    ? source.pinned
    : (source.is_favorite !== undefined ? source.is_favorite : source.favorite));
  entry.is_deleted = !!source.is_deleted;

  if (source.password_enc && !source.password) {
    throw new Error('此备份使用不兼容的旧版加密格式，请先在旧版本中解锁并导出明文 JSON/CSV');
  }
  if (source.fields !== undefined) {
    if (!Array.isArray(source.fields)) throw new Error('条目 fields 必须为数组');
    entry.fields = source.fields;
  }
  const customFields = source.custom_fields || source.customFields;
  if (customFields !== undefined) {
    if (!Array.isArray(customFields)) throw new Error('条目 custom_fields 必须为数组');
    entry.custom_fields = customFields;
  } else if (source.url) {
    entry.custom_fields = [{ label: '网址', value: String(source.url), concealed: false }];
  }

  return entry;
}

async function importJSON(jsonStr, masterKey) {
  try {
    const parsed = JSON.parse(jsonStr);
    const data = parsed && parsed.data && typeof parsed.data === 'object'
      ? parsed.data
      : parsed;
    if (!data || !Array.isArray(data.passwords)) {
      return { success: false, count: 0, skipped: 0, error: 'JSON格式不识别：passwords 必须为数组' };
    }

    const entries = data.passwords.map(parseImportedEntry);
    const activeEntries = entries.filter(entry => !entry.is_deleted);
    const deletedCount = entries.length - activeEntries.length;
    const result = await storage.importPasswords(activeEntries, masterKey);
    return {
      success: true,
      count: result.count,
      skipped: result.skipped + deletedCount,
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      count: 0,
      skipped: 0,
      error: error && error.message ? error.message : 'JSON导入失败',
    };
  }
}

function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(field);
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function parseCsvFields(value, fieldName) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} 不是有效 JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${fieldName} 必须为数组`);
  return parsed;
}

async function importCSV(csvStr, masterKey) {
  try {
    if (typeof csvStr !== 'string' || !csvStr.trim()) {
      return { success: false, count: 0, skipped: 0, error: 'CSV文件为空或格式错误' };
    }
    const rows = parseCSVRows(csvStr.replace(/^\uFEFF/, ''));
    if (rows.length < 2) {
      return { success: false, count: 0, skipped: 0, error: 'CSV文件为空或格式错误' };
    }

    const headers = rows[0].map(value => {
      const normalized = value.trim();
      const lowerCase = normalized.toLowerCase();
      return CSV_HEADERS[normalized] || CSV_HEADERS[lowerCase] || lowerCase;
    });
    const entries = rows.slice(1).map((values, rowIndex) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = values[index] === undefined ? '' : values[index];
      });
      if (!record.platform && record.title) record.platform = record.title;
      if (!record.account && record.username) record.account = record.username;
      if (!record.password) record.password = '';
      if (record.fields) record.fields = parseCsvFields(record.fields, 'fields');
      if (record.custom_fields) {
        record.custom_fields = parseCsvFields(record.custom_fields, 'custom_fields');
      }
      if (record.url && !record.custom_fields) {
        record.custom_fields = [{ label: '网址', value: record.url, concealed: false }];
      }
      record.pinned = asBoolean(record.pinned || record.favorite);
      record.id = record.id || '';
      if (record.id) record.id = String(record.id);
      if (!record.platform && !record.account && !record.password && !record.notes) {
        throw new Error(`CSV 第 ${rowIndex + 2} 行没有可导入内容`);
      }
      return parseImportedEntry(record);
    });

    const activeEntries = entries.filter(entry => !entry.is_deleted);
    const deletedCount = entries.length - activeEntries.length;
    const result = await storage.importPasswords(activeEntries, masterKey);
    return {
      success: true,
      count: result.count,
      skipped: result.skipped + deletedCount,
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      count: 0,
      skipped: 0,
      error: error && error.message ? error.message : 'CSV导入失败',
    };
  }
}

async function importEncrypted(encryptedText, filePassword, masterKey) {
  try {
    const backup = typeof encryptedText === 'string' ? JSON.parse(encryptedText) : encryptedText;
    if (!backup || backup.magic !== 'PWMA' || backup.format !== 1
        || !backup.meta || !backup.envelope) {
      return { success: false, count: 0, skipped: 0, error: '不是有效的加密备份文件' };
    }

    const verification = await crypto.verifyVaultPassword(filePassword, backup.meta);
    if (!verification.success) {
      return { success: false, count: 0, skipped: 0, error: '解密失败，密码可能不正确' };
    }
    const record = await crypto.decryptRecord(backup.envelope, verification.keys, 'backup');
    if (typeof record.payload !== 'string') throw new Error('备份内容格式无效');
    return importJSON(record.payload, masterKey);
  } catch (error) {
    return {
      success: false,
      count: 0,
      skipped: 0,
      error: '解密失败，密码可能不正确或备份已损坏',
    };
  }
}

module.exports = { importJSON, importCSV, importEncrypted, parseCSVRows };
