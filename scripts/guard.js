#!/usr/bin/env node
/**
 * 仓库守卫：把 AGENTS.md 里「可机检」的规则落成脚本。
 *
 * 设计原则（P-05 必要性阶梯 + P-09 反屎山）：
 *   1. 只做确定性检查，不猜、不联网
 *   2. 已有测试覆盖的不重复（版本一致性见 tests/version-and-config.test.js）
 *   3. 历史包袱走「基线」，只拦新增——否则第一次跑就红一片，等于没有守卫
 *
 * 退出码：0 通过 / 1 有违规（可挂进 test:gate）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const problems = [];
const warnings = [];

function fail(rule, message) {
  problems.push({ rule, message });
}
function warn(rule, message) {
  warnings.push({ rule, message });
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 闸一：单文件行数（P-09 闸二「> 800 行必须拆分或说明理由」）
 * 基线 = 已知的历史文件；只有「新增」的超限文件才失败。
 * 基线里的文件若继续膨胀，给 warn 提示（不阻断，避免把重构卡死）。
 * ------------------------------------------------------------------ */
const LINE_LIMIT = 800;
const SIZE_BASELINE = new Map([
  ['miniprogram/utils/storage.js', 1558],
  ['miniprogram/pages/settings/settings.js', 1015],
  ['cloudfunctions/sync/index.js', 968],
]);
const SIZE_EXCLUDE = [/miniprogram\/utils\/vendor\//, /\.min\.js$/];

function checkFileSizes() {
  const files = [
    ...walk(path.join(ROOT, 'miniprogram')),
    ...walk(path.join(ROOT, 'cloudfunctions')),
    ...walk(path.join(ROOT, 'scripts')),
  ].filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const relPath = rel(file);
    if (SIZE_EXCLUDE.some((re) => re.test(relPath))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    if (lines <= LINE_LIMIT) continue;

    if (SIZE_BASELINE.has(relPath)) {
      const base = SIZE_BASELINE.get(relPath);
      if (lines > base) {
        warn('file-size', `${relPath} 已 ${lines} 行（基线 ${base}），继续膨胀请拆分或说明理由`);
      }
      continue;
    }
    fail('file-size', `${relPath} 有 ${lines} 行，超过 ${LINE_LIMIT} 行上限且不在基线内`);
  }
}

/* ------------------------------------------------------------------ *
 * 闸二：敏感文件不得被 git 跟踪（S-08 密钥只走环境变量）
 * ------------------------------------------------------------------ */
const SENSITIVE_TRACKED = [
  /(^|\/)\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^backups\//,
  /^project\.private\.config\.json$/,
];

function checkTrackedSensitiveFiles() {
  let tracked;
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    warn('tracked-secrets', '无法读取 git 索引，跳过敏感文件检查');
    return;
  }
  for (const f of tracked) {
    if (SENSITIVE_TRACKED.some((re) => re.test(f))) {
      fail('tracked-secrets', `敏感文件被 git 跟踪：${f}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 闸三：package.json 里声明的脚本文件必须真实存在
 * （今天踩过：覆盖率脚本依赖 c8，而 c8 已损坏，门禁静默失效）
 * ------------------------------------------------------------------ */
function checkScriptTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  for (const [name, cmd] of Object.entries(scripts)) {
    const matches = [...cmd.matchAll(/scripts[\\/]([\w.-]+\.(?:js|ps1))/g)];
    for (const m of matches) {
      const target = path.join(ROOT, 'scripts', m[1]);
      if (!fs.existsSync(target)) {
        fail('script-target', `npm script "${name}" 引用了不存在的文件 scripts/${m[1]}`);
      }
    }
    const runner = [...cmd.matchAll(/node\s+(scripts[\\/][\w.-]+\.js)/g)];
    for (const m of runner) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) {
        fail('script-target', `npm script "${name}" 引用了不存在的文件 ${m[1]}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 闸四：快捷取舍注释（shortcut）必须登记台账（P-06）
 * 目前代码里 0 处，作为前瞻性守卫：一旦有人写了 shortcut 却没建台账，立刻提醒。
 * ------------------------------------------------------------------ */
function checkShortcutLedger() {
  const files = [
    ...walk(path.join(ROOT, 'miniprogram')),
    ...walk(path.join(ROOT, 'cloudfunctions')),
    ...walk(path.join(ROOT, 'scripts')),
  ].filter((f) => f.endsWith('.js') && !/node_modules|vendor/.test(f));

  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // 用拼接写法，避免本文件被自己扫到
    if (text.includes('// shortcut' + ':')) hits.push(rel(file));
  }
  if (hits.length === 0) return;

  const ledger = path.join(ROOT, 'docs', 'shortcut-ledger.md');
  if (!fs.existsSync(ledger)) {
    fail('shortcut-ledger', `代码里有快捷取舍但缺少 docs/shortcut-ledger.md：${hits.join(', ')}`);
    return;
  }
  const ledgerText = fs.readFileSync(ledger, 'utf8');
  for (const f of hits) {
    const base = path.basename(f);
    if (!ledgerText.includes(base) && !ledgerText.includes(f)) {
      warn('shortcut-ledger', `${f} 含快捷取舍注释（shortcut），但台账中未见该文件`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 闸五：主包体积（D-03「上传前比对包体积」的机检版）
 *
 * 说明：微信侧限制作用于“编译后”的包，而门禁里不等编译，所以这里守两层：
 *   1) 单文件体积 —— 直接抓“往源码里塞大图/大文件”这类事故（4.2.92 曾因图片膨胀到 817KB）
 *   2) 源码总体积 —— 相对基线浮动超过 10% 即失败，逼人显式确认
 * 基线更新方式：确认体积增长合理后，改下面的 MINIPROGRAM_TOTAL_BASELINE。
 * ------------------------------------------------------------------ */
const MINIPROGRAM_TOTAL_BASELINE = 751089; // 2026-10-25 实测：108 个文件合计字节
const TOTAL_GROWTH_LIMIT = 1.1;
const SINGLE_FILE_WARN = 150 * 1024;
const SINGLE_FILE_FAIL = 300 * 1024;

function checkPackageSize() {
  const files = walk(path.join(ROOT, 'miniprogram'));
  let total = 0;

  for (const file of files) {
    const size = fs.statSync(file).size;
    total += size;
    if (size > SINGLE_FILE_FAIL) {
      fail('package-size', `${rel(file)} 单文件 ${Math.round(size / 1024)}KB，超过 ${SINGLE_FILE_FAIL / 1024}KB 上限`);
    } else if (size > SINGLE_FILE_WARN) {
      warn('package-size', `${rel(file)} 单文件 ${Math.round(size / 1024)}KB，建议压缩`);
    }
  }

  const limit = Math.round(MINIPROGRAM_TOTAL_BASELINE * TOTAL_GROWTH_LIMIT);
  if (total > limit) {
    fail(
      'package-size',
      `miniprogram 源码体积 ${total} 字节，超过基线 ${MINIPROGRAM_TOTAL_BASELINE} 的 ${Math.round(
        (TOTAL_GROWTH_LIMIT - 1) * 100
      )}%（上限 ${limit}）。确认合理后请更新基线常量`
    );
  }
}

/* ------------------------------------------------------------------ *
 * 闸六：PowerShell 脚本语法（2026-10-25 实测：含中文的 .ps1 被写坏过一次，
 * 解析阶段就报错，但没有任何检查会发现它）
 * ------------------------------------------------------------------ */
function checkPowerShellSyntax() {
  const dir = path.join(ROOT, 'scripts');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ps1'));
  if (files.length === 0) return;

  // 不拼 -Command（引号会被 cmd 吃掉，导致"永远通过"的假检查）；
  // 改为写临时 .ps1 再 -File 执行。
  const tmp = path.join(os.tmpdir(), `dsh-guard-ps1-${process.pid}.ps1`);
  const psSource = [
    '$bad = @()',
    `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Filter *.ps1 | ForEach-Object {`,
    '  $err = $null',
    '  $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$err)',
    '  if ($err -and $err.Count -gt 0) { $bad += ($_.Name + ": " + $err[0].Message) }',
    '}',
    'if ($bad.Count -gt 0) { $bad -join "|" }',
    '',
  ].join('\r\n');

  let out = '';
  try {
    // 临时脚本内含中文路径，必须写 UTF-8 BOM：PowerShell 5.1 把无 BOM 的 UTF-8 按 ANSI 解析，
    // 路径会读坏、扫到 0 个文件，检查就变成"永远通过"的假绿（2026-10-25 实测踩到）。
    fs.writeFileSync(tmp, '\uFEFF' + psSource, 'utf8');
    out = execSync(`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    warn('ps1-syntax', 'powershell.exe 不可用，跳过 .ps1 语法检查');
    return;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 临时文件清理失败不影响结论 */ }
  }

  if (out) {
    for (const line of out.split('|').map((s) => s.trim()).filter(Boolean)) {
      fail('ps1-syntax', `scripts/${line}`);
    }
  }
}

/* ------------------------------------------------------------------ */

checkFileSizes();
checkPackageSize();
checkPowerShellSyntax();
checkTrackedSensitiveFiles();
checkScriptTargets();
checkShortcutLedger();

if (warnings.length) {
  console.log('[guard] 提醒：');
  for (const w of warnings) console.log(`  - [${w.rule}] ${w.message}`);
}

if (problems.length) {
  console.error('\n[guard] 未通过：');
  for (const p of problems) console.error(`  - [${p.rule}] ${p.message}`);
  console.error(`\n共 ${problems.length} 项违规。`);
  process.exit(1);
}

console.log(`[guard] 通过：${warnings.length} 条提醒，0 项违规`);
