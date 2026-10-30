// 云开发定时清理函数（TTL 替代方案）
// 背景：tcb UpdateTable API 不支持 TTL 索引（2026-10-23 实测），故用定时触发器
//      按 expire_at 字段（Date 类型）批量清理过期记录。
// 触发：每日 03:00 定时触发器（janitor-daily）；也支持手动 invoke（无参数）。
// 安全：无 HTTP 入口；仅由定时触发器/控制台手动调用；清理范围硬编码，不接受外部参数。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 清理目标：集合 + 到期字段（均为 Date 类型 expire_at）
const CLEANUP_TARGETS = [
  { name: 'api_codes', field: 'expire_at' },     // 授权码，保留 1 天
  { name: 'api_tokens', field: 'expire_at' },    // 已过期令牌
  { name: 'otp_requests', field: 'expire_at' },  // 一次性交付请求，保留 7 天
  { name: 'api_audit', field: 'expire_at' },     // 审计日志，保留 90 天
  // 备份取件记录：字段名是 expires_at（带 s，与上面不同），且必须同步删除云存储里的 .pwma 文件，
  // 否则 backups/temp/ 会无限堆积（2026-10-24 发现 19 个残留文件）
  { name: 'backup_links', field: 'expires_at', fileField: 'file_id' },
];

exports.main = async () => {
  const now = new Date();
  const results = {};
  let totalRemoved = 0;
  const errors = [];

  for (const { name, field, fileField } of CLEANUP_TARGETS) {
    try {
      let removed = 0;
      let filesDeleted = 0;

      if (fileField) {
        // 需要同步清理云存储文件的集合：先取出记录 → deleteFile → 再删记录
        for (let round = 0; round < 50; round++) {
          const page = await db.collection(name)
            .where({ [field]: _.lt(now) })
            .limit(100)
            .get();
          const docs = (page.data || []);
          if (docs.length === 0) break;

          const fileIds = docs.map(d => d[fileField]).filter(Boolean);
          if (fileIds.length > 0) {
            try {
              const delRes = await cloud.deleteFile({ fileList: fileIds });
              filesDeleted += (delRes.fileList || []).filter(f => f.status === 0).length;
            } catch (e) {
              // 文件可能已不存在，不影响记录清理
              errors.push({ collection: name, message: 'deleteFile: ' + String((e && e.message) || e) });
            }
          }

          const ids = docs.map(d => d._id);
          const del = await db.collection(name).where({ _id: _.in(ids) }).remove();
          const n = (del.stats && del.stats.removed) || ids.length;
          removed += n;
          if (docs.length < 100) break;
        }
        results[name] = { records: removed, files: filesDeleted };
        totalRemoved += removed;
      } else {
        // 纯记录清理：where().remove() 服务端批量删除
        for (let round = 0; round < 50; round++) {
          const res = await db.collection(name)
            .where({ [field]: _.lt(now) })
            .remove();
          const n = (res.stats && res.stats.removed) || 0;
          removed += n;
          if (n === 0) break;
        }
        results[name] = removed;
        totalRemoved += removed;
      }
    } catch (e) {
      errors.push({ collection: name, message: String((e && e.message) || e) });
    }
  }

  return {
    success: errors.length === 0,
    cleaned: results,
    totalRemoved,
    errors,
    ran_at: now.toISOString(),
  };
};
