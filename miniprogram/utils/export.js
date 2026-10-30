/**
 * Export decrypted entries as plain JSON/CSV or a password-protected backup.
 */

const crypto = require('./crypto');

function exportJSON(passwords, categories) {
  return JSON.stringify({
    version: '1.0',
    exported_at: new Date().toISOString(),
    app: '云端密码储存管家',
    data: {
      passwords: Array.isArray(passwords) ? passwords : [],
      categories: Array.isArray(categories) ? categories : [],
    },
  }, null, 2);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function exportCSV(passwords) {
  const header = [
    'id',
    'type',
    'platform',
    'account',
    'password',
    'alias',
    'notes',
    'securityQuestion',
    'securityAnswer',
    'bindPhone',
    'pinned',
    'fields',
    'custom_fields',
    'created_at',
    'updated_at',
  ];
  const rows = (Array.isArray(passwords) ? passwords : [])
    .filter(entry => entry && !entry.is_deleted)
    .map(entry => [
      entry.id,
      entry.type,
      entry.platform,
      entry.account,
      entry.password,
      entry.alias,
      entry.notes,
      entry.securityQuestion,
      entry.securityAnswer,
      entry.bindPhone,
      entry.pinned ? 'true' : 'false',
      JSON.stringify(Array.isArray(entry.fields) ? entry.fields : []),
      JSON.stringify(Array.isArray(entry.custom_fields) ? entry.custom_fields : []),
      entry.created_at,
      entry.updated_at,
    ].map(csvEscape).join(','));
  return [header.join(','), ...rows].join('\n');
}

async function exportEncrypted(plaintext, filePassword) {
  if (typeof plaintext !== 'string') throw new Error('备份内容必须为字符串');
  if (typeof filePassword !== 'string' || filePassword.length < 6) {
    throw new Error('备份文件密码至少需要 6 个字符');
  }
  const { meta, keys } = await crypto.createVaultMeta(filePassword);
  const now = new Date().toISOString();
  const envelope = await crypto.encryptRecord({
    id: 'backup',
    created_at: now,
    updated_at: now,
    payload: plaintext,
  }, keys, meta);
  return JSON.stringify({
    magic: 'PWMA',
    format: 1,
    meta,
    envelope,
    exported_at: now,
  });
}

function saveToFile(content, filename) {
  if (typeof content !== 'string') throw new Error('文件内容必须为字符串');
  const fs = wx.getFileSystemManager();
  const safeName = String(filename || 'password-vault-backup.pwma').replace(/[\\/:*?"<>|]/g, '_');
  const filePath = wx.env.USER_DATA_PATH + '/' + safeName;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 保存备份文件：
 * - 桌面端（Windows/Mac）：调用 wx.saveFileToDisk，弹出系统「另存为」对话框，由用户选择保存路径
 * - 移动端：小程序沙箱不允许写任意路径，改为转发文件（可发给「文件传输助手」后自行另存）
 * 返回 { mode: 'disk' | 'share' }，供调用方给出对应提示
 */
async function saveBackupFile(filePath, fileName, backupMeta) {
  /**
   * 备份导出主路径（2026-10-23 用户拍板）：生成取件链接——复制到剪贴板 + 弹窗展示，
   * 用户把链接发到电脑（微信/QQ/任意方式），浏览器打开输入主密码即可下载。
   * 桌面端优先「另存为」磁盘（选路径即存）；转发文件面板已退役（被链接方案取代）。
   */
  const name = fileName || filePath.split('/').pop();
  let platform = '';
  try {
    platform = (wx.getDeviceInfo ? wx.getDeviceInfo().platform : wx.getSystemInfoSync().platform) || '';
  } catch (error) {
    platform = '';
  }
  const isDesktop = platform === 'windows' || platform === 'mac' || platform === 'devtools';

  // 桌面端：优先「另存为」磁盘；失败/不可用降级为取件链接
  if (isDesktop && typeof wx.saveFileToDisk === 'function') {
    const toDisk = await new Promise((resolve) => {
      wx.saveFileToDisk({
        filePath,
        success: () => resolve(true),
        fail: (error) => { console.error('[export] 保存到磁盘失败:', error); resolve(false); },
      });
    });
    if (toDisk) return { mode: 'disk' };
  }

  // 全平台主路径：取件链接（上传云存储 + 登记取件 → /bk?id=xxx，输主密码下载）
  const link = await uploadBackupForTempLink(filePath, backupMeta);
  return { mode: 'cloudlink', url: link.url, file_name: name };
}


function shareFile(filePath) {
  // 2026-10-23：返回 Promise 让调用方可感知失败（此前静默 fail 导致电脑端"看似成功实则没转发"）
  return new Promise((resolve) => {
    wx.shareFileMessage({
      filePath,
      fileName: filePath.split('/').pop(),
      success: () => resolve(true),
      fail(error) {
        console.error('分享失败:', error);
        resolve(false);
      },
    });
  });
}

/**
 * 云存储临时链接：备份上传云存储 → 生成限时下载链接（10 分钟有效）。
 * 桌面工具环境的最优导出路径：复制链接 → 电脑浏览器打开 → 直接下载 .pwma。
 * 链接过期自动失效；云端文件可在云开发控制台-存储中管理。
 */
async function uploadBackupForTempLink(filePath, backupMeta) {
  // 备份取件模式（2026-10-23 用户拍板）：上传云存储（私有）→ sync.create_backup_link 登记取件
  // → 返回取件页链接（/bk.html?id=xxx）。下载页要求输入主密码才能换取 5 分钟下载直链（限 5 次），
  // 取件链接 10 分钟失效。没有主密码，拿到链接也无法下载。
  if (!backupMeta || !backupMeta.salt || !backupMeta.verifier) {
    throw new Error('备份加密参数缺失，无法生成取件链接');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cloudPath = 'backups/temp/backup-' + stamp + '.pwma';
  const upload = await wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath });
  if (!upload || !upload.fileID) throw new Error('上传云存储失败');
  const fileID = upload.fileID;

  let reg;
  try {
    reg = await new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'sync',
        data: {
          action: 'create_backup_link',
          client_version: (require('../config') && require('../config').VERSION) || '0.0.0',
          file_id: fileID,
          meta: backupMeta,
        },
        success: r => resolve(r.result || { success: false, error: 'EMPTY' }),
        fail: e => reject(e),
      });
    });
  } catch (e) {
    throw new Error('取件登记网络失败');
  }
  if (!reg || !reg.success || !reg.link_id) {
    throw new Error((reg && reg.error) || '取件登记失败');
  }

  const linkBase = 'https://your-cloud-env-id-1448869858.tcloudbaseapp.com/bk.html';
  return { url: linkBase + '?id=' + reg.link_id, fileID: fileID, link_id: reg.link_id };
}

/** 剪贴板兜底：把备份内容复制到剪贴板（桌面工具不支持文件转发/另存时的最后手段） */
function copyBackupToClipboard(filePath) {
  try {
    const fs = wx.getFileSystemManager();
    const content = fs.readFileSync(filePath, 'utf-8');
    return new Promise((resolve) => {
      wx.setClipboardData({
        data: content,
        success: () => resolve(true),
        fail: () => resolve(false),
      });
    });
  } catch (e) {
    console.error('[export] 读取备份内容失败:', e);
    return Promise.resolve(false);
  }
}

module.exports = { exportJSON, exportCSV, exportEncrypted, saveToFile, shareFile, uploadBackupForTempLink, copyBackupToClipboard, saveBackupFile, csvEscape };
