// 云函数 - inviteQrcode
// 用途：生成带邀请码的小程序码（scene=邀请码），供邀请卡片图片使用
// 实现：走 HTTPS 直连微信接口（AppID + AppSecret 换 access_token），
//       不使用 cloud.openapi 云调用（该路径需云函数 config.json 权限，MCP 部署方式不识别）

const https = require('https');

const APP_ID = process.env.WX_APP_ID || '';
const APP_SECRET = process.env.VPAY_APP_SECRET || '';

// access_token 实例内缓存（微信有效期 7200s，提前 5 分钟失效）
let tokenCache = { value: '', expiresAt: 0 };

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('请求微信接口超时')));
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const path = `/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
  const buffer = await httpsRequest({ hostname: 'api.weixin.qq.com', path, method: 'GET' });
  let data;
  try {
    data = JSON.parse(buffer.toString());
  } catch (e) {
    throw new Error('access_token 响应解析失败');
  }
  if (!data.access_token) {
    throw new Error(data.errmsg || '获取 access_token 失败');
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (Number(data.expires_in) || 7200) - 300) * 1000,
  };
  return tokenCache.value;
}

exports.main = async (event) => {
  const code = String(event.invite_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return { success: false, error: '邀请码格式无效' };
  }
  if (!APP_ID || !APP_SECRET) {
    return { success: false, error: '缺少微信凭据环境变量（WX_APP_ID / VPAY_APP_SECRET）' };
  }

  const envVersion = ['release', 'trial', 'develop'].includes(event.env_version)
    ? event.env_version
    : 'release';

  try {
    const token = await getAccessToken();
    const body = JSON.stringify({
      scene: code,
      page: 'pages/lock/lock',
      check_path: false,
      env_version: envVersion,
      width: 430,
      auto_color: false,
      is_hyaline: false,
    });
    const buffer = await httpsRequest({
      hostname: 'api.weixin.qq.com',
      path: `/wxa/getwxacodeunlimit?access_token=${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body);

    // 成功返回图片二进制；失败返回 JSON（以 '{' 开头）
    if (buffer.length && buffer[0] === 0x7b) {
      let errMsg = '小程序码生成失败';
      try {
        const err = JSON.parse(buffer.toString());
        errMsg = err.errmsg || errMsg;
        // 40001: access_token 失效 → 清缓存，下次重取
        if (Number(err.errcode) === 40001) tokenCache = { value: '', expiresAt: 0 };
      } catch (e) { /* 保留默认错误 */ }
      return { success: false, error: errMsg };
    }
    if (!buffer.length) return { success: false, error: '小程序码返回为空' };

    return { success: true, base64: buffer.toString('base64'), env_version: envVersion };
  } catch (error) {
    console.error('[inviteQrcode] 生成失败:', error);
    return { success: false, error: (error && error.message) || '小程序码生成失败' };
  }
};
