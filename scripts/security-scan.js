// 安全静态扫描（轻量版 SAST，替代 Semgrep 的落地项）
// 用法：node scripts/security-scan.js
// 退出码：0 无问题 / 1 命中问题（可直接放进 test:gate 阻断发版）
//
// 覆盖四类规则（均针对本项目真实风险）：
//   S1 敏感值进日志：console.* 里出现 password / session_key / paySig / AppKey / AppSecret / signature
//   S2 硬编码密钥：疑似 AppSecret（32 位字母数字）、32 位 AppKey、wx 支付密钥
//   S3 明文密钥写入代码：把 VPAY_APP_KEY / VPAY_APP_SECRET 等环境变量名以字符串字面量赋值
//   S4 云函数用户态鉴权：incoming 用户态函数必须调用 getWXContext()（白名单见 AUTH_OPTIONAL）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['miniprogram', 'cloudfunctions', 'scripts', 'sdk'];
const SKIP = new Set(['node_modules', 'crypto-js.min.js']);
const EXT = new Set(['.js']);

// 这些函数是用户态入口，必须能拿到 OPENID
const AUTH_REQUIRED = new Set(['login', 'invite', 'sync', 'pay', 'vpay', 'apiAuth']);

const findings = [];

function report(rule, file, line, message, snippet) {
  findings.push({ rule, file, line, message, snippet: snippet.trim().slice(0, 140) });
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXT.has(path.extname(entry.name))) scanFile(full);
  }
}

const SECRET_IN_LOG = /\b(console\.(log|info|debug|warn|error)|winston|logger)\b[^;\n]{0,200}(password|passwd|session_key|sessionKey|paySig|AppKey|APP_KEY|AppSecret|APP_SECRET|signature|private[_-]?key)/i;
// 32 位字母数字的 AppSecret/AppKey 字面量（排除全小写 hex 的 hash 值）
const HARDCODED_SECRET = /['"`]([A-Za-z0-9]{32})['"`]/;
const HEX32 = /^[0-9a-f]{32}$/i;
// 只匹配明确的密钥类变量名，避免把 localStorage key 名称误判为密钥
const ENV_SECRET_ASSIGN = /(?:\bconst\b|\blet\b|\bvar\b)\s+\w*(secret|appsecret|appkey|apikey|privatekey)\w*\s*=\s*['"`][^'"`]{20,}['"`]/i;

function scanFile(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

    if (SECRET_IN_LOG.test(line)) {
      report('S1', rel, lineNo, '敏感值可能进入日志', line);
    }

    const secretMatch = line.match(HARDCODED_SECRET);
    if (secretMatch && !HEX32.test(secretMatch[1])) {
      // 排除注释中的示例与明显的占位符
      if (!/example|placeholder|xxxx|test|fake|dummy|mock/i.test(line)) {
        report('S2', rel, lineNo, '疑似硬编码密钥（32 位字母数字字面量）', line);
      }
    }

    if (ENV_SECRET_ASSIGN.test(line) && !/process\.env/.test(line)) {
      report('S3', rel, lineNo, '疑似把密钥直接写进变量（应读环境变量）', line);
    }
  });

  // S4：用户态云函数必须调用 getWXContext
  if (rel.startsWith('cloudfunctions/')) {
    const fnName = rel.split('/')[1];
    if (AUTH_REQUIRED.has(fnName) && !text.includes('getWXContext')) {
      report('S4', rel, 1, '用户态云函数未调用 cloud.getWXContext()，存在越权风险', fnName);
    }
  }
}

for (const dir of SCAN_DIRS) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full);
}

if (findings.length === 0) {
  console.log('[security-scan] 通过：未发现 S1-S4 类问题');
  process.exit(0);
}

console.error(`[security-scan] 发现 ${findings.length} 个问题：`);
for (const f of findings) {
  console.error(`  [${f.rule}] ${f.file}:${f.line}  ${f.message}`);
  console.error(`        ${f.snippet}`);
}
process.exit(1);
