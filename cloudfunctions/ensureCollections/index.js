// 云函数 ensureCollections：确保业务集合存在（幂等，可重复调用）
// 用途：创建订单和加密密码库元数据集合，返回创建与可写状态
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const REQUIRED_COLLECTIONS = ['orders', 'vault_meta']

// 维护函数仅允许管理员调用；对外只返回通用错误码，细节写日志
function adminAllowed() {
  const list = (process.env.ADMIN_OPENIDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (list.length === 0) return false; // 未配置管理员时一律拒绝（默认安全）
  const ctx = cloud.getWXContext() || {};
  return list.includes(ctx.OPENID);
}

exports.main = async (event) => {
  if (!adminAllowed()) {
    console.warn('[ensureCollections] 非管理员调用被拒绝');
    return { success: false, error: 'forbidden' };
  }
  const db = cloud.database()
  const results = {}

  for (const name of REQUIRED_COLLECTIONS) {
    try {
      // 优先使用 createCollection API（wx-server-sdk 2.x 支持）
      if (typeof db.createCollection === 'function') {
        await db.createCollection(name)
        results[name] = 'CREATED'
      } else {
        // 兜底：管理员写入探针，部分版本云函数端写入会自动建集合
        try {
          const probe = await db.collection(name).add({ data: { _probe: true, ts: Date.now() } })
          // 探针文档写入成功后立即删除
          await db.collection(name).doc(probe._id).remove()
          results[name] = 'AUTO_CREATED_BY_WRITE'
        } catch (e) {
          if (String(e.errCode) === '-502005' || String(e.message).includes('COLLECTION_NOT_EXIST') || String(e.message).includes('-502005')) {
            results[name] = 'CREATE_NOT_SUPPORTED: ' + e.message
          } else {
            // 集合已存在等情况
            console.error('[ensureCollections]', name, e && e.message); results[name] = 'EXISTS_OR_ERROR'
          }
        }
      }
    } catch (e) {
      // createCollection 报错：可能是已存在
      const msg = String(e.message || e)
      if (msg.includes('exist') || msg.includes('-502001')) {
        results[name] = 'ALREADY_EXISTS'
      } else {
        console.error('[ensureCollections]', name, e && e.message); results[name] = 'ERROR'
      }
    }
  }

  const collectionVerify = {}
  for (const name of REQUIRED_COLLECTIONS) {
    try {
      const probe = await db.collection(name).add({
        data: { _verify: true, createdAt: Date.now() }
      })
      await db.collection(name).doc(probe._id).remove()
      collectionVerify[name] = 'WRITABLE_OK'
    } catch (e) {
      console.error('[ensureCollections] verify', name, e && e.message); collectionVerify[name] = 'VERIFY_ERROR'
    }
  }

  const success = REQUIRED_COLLECTIONS.every(name => collectionVerify[name] === 'WRITABLE_OK')
  return {
    success,
    results,
    verify: collectionVerify.orders || 'SKIPPED',
    collection_verify: collectionVerify,
  }
}
