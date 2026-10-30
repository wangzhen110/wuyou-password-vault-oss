// 云函数 - backupDownload（备份取件下载页）
// 路由：HTTP /bk（网关）
//   GET  /bk?id=xxx            → 返回密码校验页（HTML）
//   POST /bk { id, password }  → 校验备份密码 → 签发 5 分钟下载直链（一次性/限次）
// 安全：
//   - verifier（PBKDF2 结果）只存云端不下发，网页/攻击者无法离线爆破
//   - 密码校验用与加密一致的 PBKDF2 参数（60 万次），穷举成本极高
//   - 下载直链 5 分钟有效；单链接最多下载 5 次（防链接泄露后被反复拉取）

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
// 取件链接为一次性：成功下载一次后立即失效（2026-10-25 用户定）
const ONE_TIME_MESSAGE = '该链接已使用过（一次性有效），请重新导出备份';
const TEMP_URL_MAX_AGE = 300; // 下载直链 5 分钟有效
// 同一取件链接的密码失败上限（2026-10-25 用户定：5 次错误即链接失效，无冷却期）
// 设计与链接寿命无关：达到上限直接置为 disabled，此后即使输对密码也不可用。
const MAX_PASSWORD_ATTEMPTS = 5;
const LOCKED_MESSAGE = '密码错误次数已达上限，取件链接已失效，请重新导出备份';

function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlPage(linkId, msg, isError) {
  const msgHtml = msg ? `<div class="msg ${isError ? 'err' : 'ok'}">${esc(msg)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>无忧密码本 · 备份取件</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px 16px;
    background: linear-gradient(160deg, #eef7f1 0%, #e3f2e9 45%, #d7ecdf 100%);
  }
  body::before {
    content: ''; position: fixed; top: -120px; right: -120px; width: 320px; height: 320px;
    border-radius: 50%; background: radial-gradient(circle, rgba(23,194,111,0.12), transparent 70%);
    pointer-events: none;
  }
  body::after {
    content: ''; position: fixed; bottom: -140px; left: -100px; width: 360px; height: 360px;
    border-radius: 50%; background: radial-gradient(circle, rgba(23,194,111,0.08), transparent 70%);
    pointer-events: none;
  }
  .card {
    position: relative; width: 100%; max-width: 420px;
    background: #ffffff; border-radius: 20px; padding: 36px 30px 30px;
    box-shadow: 0 8px 40px rgba(16, 60, 38, 0.12), 0 2px 8px rgba(0,0,0,0.04);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
  .brand-icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: linear-gradient(135deg, #17c26f 0%, #0ea55c 100%);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 12px rgba(23, 194, 111, 0.35);
  }
  .brand-icon svg { width: 24px; height: 24px; }
  .brand-text { display: flex; flex-direction: column; }
  .brand-name { font-size: 19px; font-weight: 700; color: #14261c; letter-spacing: 0.5px; }
  .brand-sub { font-size: 11px; color: #8aa598; letter-spacing: 2px; margin-top: 2px; }
  h1 { font-size: 17px; color: #2c3a32; font-weight: 600; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #8a9a91; margin-bottom: 22px; line-height: 1.6; }
  .msg { font-size: 14px; border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; line-height: 1.6; }
  .msg.err { background: #fdeeed; color: #c73e33; border: 1px solid rgba(199,62,51,0.15); }
  .msg.ok { background: #e9f8f0; color: #0e8a4f; border: 1px solid rgba(14,138,79,0.15); }
  .field { margin-bottom: 20px; }
  label { display: block; font-size: 13px; color: #5a6b61; margin-bottom: 8px; font-weight: 500; }
  .input-wrap { position: relative; }
  input {
    width: 100%; font-size: 16px; padding: 14px 16px;
    border: 1.5px solid #d8e2dc; border-radius: 12px;
    outline: none; color: #1a2b22; background: #fafbfa;
    transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  }
  input:focus {
    border-color: #17c26f; background: #fff;
    box-shadow: 0 0 0 4px rgba(23, 194, 111, 0.12);
  }
  input::placeholder { color: #b3c2ba; }
  button {
    width: 100%; font-size: 16px; font-weight: 600; padding: 15px 0;
    border: none; border-radius: 12px; cursor: pointer; color: #fff;
    background: linear-gradient(135deg, #1ed07a 0%, #0ea55c 100%);
    box-shadow: 0 6px 18px rgba(23, 194, 111, 0.35);
    transition: transform 0.15s, box-shadow 0.2s, opacity 0.2s;
    letter-spacing: 1px;
  }
  button:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(23, 194, 111, 0.45); }
  button:active { transform: translateY(0); }
  button:disabled { background: #a8d8bf; box-shadow: none; cursor: not-allowed; transform: none; }
  .tip { font-size: 12px; color: #97a8a0; margin-top: 20px; line-height: 1.8;
         padding-top: 18px; border-top: 1px dashed #e2ebe6; }
  .tip b { color: #5a6b61; font-weight: 500; }
  .footer { text-align: center; margin-top: 22px; font-size: 11px; color: #a8b8b0; letter-spacing: 1px; }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(160deg, #101913 0%, #0d1512 45%, #0a120e 100%); }
    .card { background: #17211b; box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3); }
    .brand-name { color: #e8f2ec; }
    h1 { color: #cfe0d6; }
    .sub { color: #6d8277; }
    label { color: #93a89c; }
    input { border-color: #2c3f34; background: #101913; color: #e8f2ec; }
    input:focus { border-color: #17c26f; background: #0d1512; box-shadow: 0 0 0 4px rgba(23,194,111,0.15); }
    input::placeholder { color: #4a5c51; }
    .tip { color: #5f7268; border-top-color: #24352c; }
    .tip b { color: #93a89c; }
    .msg.err { background: #2a1512; border-color: rgba(199,62,51,0.3); }
    .msg.ok { background: #0f2a1c; border-color: rgba(14,138,79,0.3); }
    .footer { color: #3d4f45; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="10" rx="2.5" fill="#fff"/><path d="M8 10V7a4 4 0 018 0v3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
      </div>
      <div class="brand-text">
        <div class="brand-name">无忧密码本</div>
        <div class="brand-sub">SECURE BACKUP</div>
      </div>
    </div>
    <h1>下载加密备份文件</h1>
    <div class="sub">输入导出时设置的主密码，验证通过后开始下载。<br>文件全程加密，下载后也需密码才能导入。</div>
    <div id="msg">${msgHtml}</div>
    <div class="field" id="pwdField">
      <label for="pwd">主密码</label>
      <div class="input-wrap">
        <input id="pwd" type="password" placeholder="输入主密码" autocomplete="off">
      </div>
    </div>
    <button id="btn" onclick="download()">验证并下载</button>
    <div class="tip">
      <b>安全说明</b><br>
      · 下载直链 5 分钟内有效，请及时保存<br>
      · 备份文件已加密，导入时需再次输入主密码<br>
      · 链接仅本人持有，请勿分享给他人
    </div>
  </div>
  <div class="footer">— 无忧密码本 · 端到端加密 —</div>
  <script>
    var LINK_ID = ${JSON.stringify(esc(linkId))};
    var MSG = ${JSON.stringify(esc(msg || ''))};
    var IS_ERR = ${JSON.stringify(!!isError)};
    if (MSG) {
      var el = document.getElementById('msg');
      el.className = 'msg ' + (IS_ERR ? 'err' : 'ok');
      el.textContent = MSG;
    }
    // 链接已终局失效时隐藏输入与按钮，避免用户继续尝试（服务端已不可用）
    if (IS_ERR && MSG.indexOf('已失效') >= 0) {
      var fieldEl = document.getElementById('pwdField');
      var btnEl = document.getElementById('btn');
      if (fieldEl) fieldEl.style.display = 'none';
      if (btnEl) btnEl.style.display = 'none';
    }
    function download() {
      var pwd = document.getElementById('pwd').value;
      if (!pwd) {
        var el = document.getElementById('msg');
        el.className = 'msg err'; el.textContent = '请输入主密码';
        return;
      }
      var btn = document.getElementById('btn');
      btn.disabled = true; btn.textContent = '校验中，请稍候...';
      fetch(location.pathname + '?id=' + encodeURIComponent(LINK_ID), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: LINK_ID, password: pwd })
      }).then(r => r.json().then(res => ({ status: r.status, res })).catch(() => ({ status: r.status, res: {} })))
        .then(({ status, res }) => {
          var el = document.getElementById('msg');
          if (res.success && res.url) {
            el.className = 'msg ok'; el.textContent = '验证通过，开始下载...';
            btn.textContent = '已开始下载';
            window.location.href = res.url;
            return;
          }
          el.className = 'msg err'; el.textContent = res.error || '下载失败，请重试';
          // 链接已终局失效（密码错误达上限）：永久禁用按钮，不再给重试入口
          if (status === 410) {
            btn.disabled = true;
            btn.textContent = '链接已失效';
            var pwdEl = document.getElementById('pwd');
            if (pwdEl) pwdEl.disabled = true;
            return;
          }
          btn.disabled = false; btn.textContent = '验证并下载';
        }).catch(() => {
          btn.disabled = false; btn.textContent = '验证并下载';
          var el = document.getElementById('msg');
          el.className = 'msg err'; el.textContent = '网络错误，请检查网络后重试';
        });
    }
    document.getElementById('pwd').addEventListener('keydown', e => { if (e.key === 'Enter') download(); });
  </script>
</body>
</html>`;
}

function htmlResponse(html) {
  // 网关要求 {statusCode, headers, body} 响应对象：直接返回字符串会被包装成 JSON 导致浏览器显示源码
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
}

function json(body, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/**
 * 与端侧 crypto.js 完全一致的 verifier 计算（2026-10-23 修正）：
 *   material = PBKDF2-HMAC-SHA256(password, salt, iterations) → 64 字节
 *   encryptionKey = material[0..32)，macKey = material[32..64)
 *   verifier = HMAC-SHA256(key=macKey, message='vault-verifier:v1') 的 hex
 */
function computeVerifier(password, saltHex, iterations) {
  const saltBuf = Buffer.from(saltHex, 'hex');
  const material = crypto.pbkdf2Sync(password, saltBuf, iterations, 64, 'sha256');
  const macKey = material.slice(32, 64);
  return crypto.createHmac('sha256', macKey).update('vault-verifier:v1').digest('hex');
}

function verifyPassword(password, salt, iterations, verifier) {
  try {
    const computed = computeVerifier(password, salt, iterations);
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(verifier, 'hex');
    return Promise.resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
  } catch (e) {
    console.error('[backupDownload] 校验异常:', e);
    return Promise.resolve(false);
  }
}

async function handleGet(query) {
  const linkId = String((query && query.id) || '').trim();
  if (!/^[0-9a-f]{24}$/.test(linkId)) {
    return htmlResponse(htmlPage('', '取件链接无效', true));
  }
  const res = await db.collection('backup_links').where({ link_id: linkId }).limit(1).get();
  const rec = res.data && res.data[0];
  if (!rec) return htmlResponse(htmlPage(linkId, '取件链接不存在或已被清理', true));
  if (Number(rec.failed_attempts || 0) >= MAX_PASSWORD_ATTEMPTS) {
    return htmlResponse(htmlPage(linkId, LOCKED_MESSAGE, true));
  }
  if (rec.status !== 'active') return htmlResponse(htmlPage(linkId, '该取件链接已被停用', true));
  if (Number(rec.downloads || 0) >= 1) return htmlResponse(htmlPage(linkId, ONE_TIME_MESSAGE, true));
  return htmlResponse(htmlPage(linkId, '', false));
}

async function handlePost(rawBody) {
  let body = rawBody;
  if (rawBody && typeof rawBody.body === 'string') {
    try { body = JSON.parse(rawBody.body); } catch (e) { body = {}; }
  }
  const linkId = String((body && body.id) || '').trim();
  const password = String((body && body.password) || '');
  if (!/^[0-9a-f]{24}$/.test(linkId) || !password) {
    return json({ success: false, error: '参数无效' }, 400);
  }

  const res = await db.collection('backup_links').where({ link_id: linkId }).limit(1).get();
  const rec = res.data && res.data[0];
  if (!rec) return json({ success: false, error: '取件链接不存在' }, 404);
  if (rec.status !== 'active') return json({ success: false, error: '取件链接已被停用' }, 410);
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
    return json({ success: false, error: '取件链接已过期（10 分钟有效期）' }, 410);
  }
  if (Number(rec.downloads || 0) >= 1) {
    return json({ success: false, error: ONE_TIME_MESSAGE }, 410);
  }

  // 失败次数已达上限：链接终局失效（兜底，正常路径下 status 已经是 disabled）
  if (Number(rec.failed_attempts || 0) >= MAX_PASSWORD_ATTEMPTS) {
    return json({ success: false, error: LOCKED_MESSAGE }, 410);
  }

  const ok = await verifyPassword(password, rec.salt, rec.iterations, rec.verifier);
  if (!ok) {
    const nextCount = Number(rec.failed_attempts || 0) + 1;
    const updateData = { failed_attempts: nextCount, last_failed_at: db.serverDate() };
    const reachedLimit = nextCount >= MAX_PASSWORD_ATTEMPTS;
    if (reachedLimit) {
      // 终局失效：链接已无用 → 立刻删掉云存储里的备份文件，并让记录尽快被回收
      await deleteFileQuietly(rec.file_id);
      updateData.status = 'disabled';
      updateData.file_id = null;              // 文件已删，避免 janitor 重复删除报错
      updateData.expires_at = new Date();     // 立即到期 → 下一次扫尾/ janitor 回收记录
    }
    await db.collection('backup_links').doc(rec._id).update({ data: updateData });
    if (reachedLimit) return json({ success: false, error: LOCKED_MESSAGE }, 410);
    return json({ success: false, error: '主密码不正确' }, 403);
  }

  const urls = await cloud.getTempFileURL({
    fileList: [{ fileID: rec.file_id, maxAge: TEMP_URL_MAX_AGE }],
  });
  const item = urls.fileList && urls.fileList[0];
  if (!item || !item.tempFileURL) return json({ success: false, error: '生成下载链接失败，请重试' }, 500);

  await db.collection('backup_links').doc(rec._id).update({
    data: {
      downloads: db.command.inc(1),
      last_download_at: db.serverDate(),
      failed_attempts: 0,
      last_failed_at: null,
      status: 'disabled', // 一次性：下载成功即失效，防止链接被转发后重复取件
      // 下载直链 5 分钟有效，留 1 分钟余量；到期后由扫尾/janitor 删除文件与记录
      expires_at: new Date(Date.now() + TEMP_URL_MAX_AGE * 1000 + 60 * 1000),
    },
  });

  return json({ success: true, url: item.tempFileURL });
}

async function deleteFileQuietly(fileId) {
  if (!fileId) return;
  try {
    await cloud.deleteFile({ fileList: [fileId] });
  } catch (e) {
    // 文件可能已被清理，不影响主流程
  }
}

/**
 * 顺手清理已过期的取件记录与临时文件（2026-10-25）。
 * 背景：janitor 是每日 03:00 触发，失效链接的 .pwma 会占着云存储到第二天。
 * 这里在每次请求末尾做小批量扫尾（limit 10），让清理随流量发生，janitor 仍作为兜底。
 */
async function sweepExpiredLinks(limit = 10) {
  try {
    const page = await db.collection('backup_links')
      .where({ expires_at: db.command.lt(new Date()) })
      .limit(limit)
      .get();
    const docs = (page && page.data) || [];
    if (docs.length === 0) return;

    for (const doc of docs) {
      if (doc.file_id) await deleteFileQuietly(doc.file_id);
    }
    const ids = docs.map(d => d._id).filter(Boolean);
    if (ids.length > 0) {
      await db.collection('backup_links').where({ _id: db.command.in(ids) }).remove();
    }
  } catch (e) {
    console.error('[backupDownload] 清理过期取件记录失败:', e);
  }
}

exports.main = async (event) => {
  try {
    await sweepExpiredLinks(); // 顺带回收过期链接与临时文件，避免堆积到次日 janitor
    console.error('[backupDownload][diag] event keys:', JSON.stringify(Object.keys(event || {})));
    let raw = event;
    if (raw && typeof raw.body === 'string' && !raw.id) {
      try { raw = JSON.parse(raw.body); } catch (e) { /* body 非 JSON，按原样处理 */ }
    }
    const method = (raw.httpMethod || raw.method || (raw.id !== undefined ? 'POST' : 'GET')).toUpperCase();
    if (method === 'POST' || raw.password !== undefined) {
      return await handlePost(raw);
    }
    return handleGet(raw.queryStringParameters || raw);
  } catch (e) {
    console.error('[backupDownload] 处理失败:', e);
    return json({ success: false, error: '服务暂时不可用，请稍后重试' }, 500);
  }
};
