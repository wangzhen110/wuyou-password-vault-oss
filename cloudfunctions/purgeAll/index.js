// 云函数 - purgeAll（一次性运维工具，用完可删）
//
// 用途：清空所有业务集合的文档（保留集合结构与索引），用于「完全从零开始」。
// 安全设计：
//   1. 必须传 confirm: 'DELETE_ALL_DATA' 才会执行（防误触）
//   2. 必须与环境变量 PURGE_TOKEN 匹配（防他人调用）
//   3. 支持 dryRun: true 只统计不删除（建议先跑一次确认数量）
//   4. 分批删除（每批 100 条，避开单次限制），逐集合返回删除数
//
// 部署：开发者工具右键 cloudfunctions/purgeAll → 上传并部署（云端安装依赖）
// 调用：云开发控制台 → 云函数 → purgeAll → 测试，参数示例：
//   {"confirm":"DELETE_ALL_DATA","token":"<你设置的PURGE_TOKEN>","dryRun":true}   先看数量
//   {"confirm":"DELETE_ALL_DATA","token":"<你设置的PURGE_TOKEN>"}                  真删

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 业务集合清单（与代码中实际使用的集合一致）
const COLLECTIONS = [
  'users',
  'vault_meta',
  'passwords',
  'orders',
  'invite_records',
  'backup_links',
  'api_audit',
  'counters',
];

const BATCH = 100;

async function purgeCollection(name, dryRun) {
  const coll = db.collection(name);
  let total = 0;
  let removed = 0;

  // 先统计总数
  try {
    const countRes = await coll.count();
    total = countRes.total || 0;
  } catch (e) {
    // 集合不存在
    return { collection: name, skipped: true, reason: e.message };
  }

  if (dryRun) return { collection: name, total, dryRun: true };

  // 分批删除：每次取 100 条 _id 后批量 remove
  for (;;) {
    let ids = [];
    try {
      const page = await coll.field({ _id: true }).limit(BATCH).get();
      ids = (page.data || []).map(d => d._id);
    } catch (e) {
      return { collection: name, total, removed, error: e.message };
    }
    if (ids.length === 0) break;

    try {
      // 云数据库 where 支持 _id in [...] 批量删除
      const delRes = await coll.where({ _id: db.command.in(ids) }).remove();
      removed += (delRes.stats && delRes.stats.removed) || ids.length;
    } catch (e) {
      return { collection: name, total, removed, error: e.message };
    }

    if (ids.length < BATCH) break;
  }

  return { collection: name, total, removed };
}

exports.main = async (event) => {
  const { confirm, token, dryRun } = event || {};

  // 1) 二次确认
  if (confirm !== 'DELETE_ALL_DATA') {
    return { success: false, error: '缺少确认参数', hint: '请传 confirm: "DELETE_ALL_DATA"' };
  }

  // 2) 口令校验（环境变量 PURGE_TOKEN，未设置时拒绝执行，避免裸奔）
  const expected = process.env.PURGE_TOKEN;
  if (!expected) {
    return { success: false, error: '未配置 PURGE_TOKEN 环境变量，拒绝执行' };
  }
  if (token !== expected) {
    return { success: false, error: '口令不正确' };
  }

  const isDryRun = dryRun === true;

  // 关键顺序：清空 backup_links 前，先按其中的 file_id 删除云存储文件。
  // 否则记录先被删掉，file_id 丢失，云存储里的 .pwma 会变成永远删不掉的孤儿文件
  // （2026-10-24 实测踩过：19 个文件只能手动在控制台删）。
  let storageResult = { scanned: 0, deleted: 0, failed: 0, dryRun: isDryRun };
  try {
    const links = [];
    for (let round = 0; round < 20; round++) {
      const page = await db.collection('backup_links').field({ file_id: true }).limit(100).get();
      const docs = page.data || [];
      if (docs.length === 0) break;
      docs.forEach(d => { if (d.file_id) links.push(d.file_id); });
      if (docs.length < 100) break;
      // 若已取满 100 条且不打算删除，直接跳出避免死循环
      if (isDryRun) break;
    }
    storageResult.scanned = links.length;

    if (!isDryRun && links.length > 0) {
      // cloud.deleteFile 单次最多 50 个，分批
      for (let i = 0; i < links.length; i += 50) {
        const batch = links.slice(i, i + 50);
        try {
          const res = await cloud.deleteFile({ fileList: batch });
          const okCount = (res.fileList || []).filter(f => f.status === 0).length;
          storageResult.deleted += okCount;
          storageResult.failed += batch.length - okCount;
        } catch (e) {
          storageResult.failed += batch.length;
        }
      }
    }
  } catch (e) {
    storageResult.error = String((e && e.message) || e);
  }

  const results = [];
  for (const name of COLLECTIONS) {
    results.push(await purgeCollection(name, isDryRun));
  }

  return {
    success: true,
    dryRun: isDryRun,
    finishedAt: new Date().toISOString(),
    storage: storageResult,
    results,
    note: isDryRun
      ? '这是演练模式，未删除任何数据。确认数量无误后去掉 dryRun 再执行一次。'
      : '已清空。云存储中的头像/备份文件需在控制台手动删除。',
  };
};
