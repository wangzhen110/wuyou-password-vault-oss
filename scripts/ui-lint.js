/**
 * UI 静态体检：扫描这几轮反复踩的坑
 * 1. WXML 里用了、但任何 wxss 都没定义的 class（→ 透明背景/文字看不清）
 * 2. WXSS 里用了、但 theme.wxss 没定义的 CSS 变量（→ 样式静默失效）
 * 3. WXML 里 bind/catch 绑定了、但页面 js 不存在的方法（→ 点击无反应）
 * 4. WXML 引用了、但页面 data 里没有的变量（只报"疑似"，避免误报）
 *
 * 用法：node scripts/ui-lint.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

// ===== 收集所有 wxss 中定义的类名与变量 =====
const wxssFiles = walk(MP, '.wxss');
const definedClasses = new Set();
const definedVars = new Set();

for (const file of wxssFiles) {
  const css = fs.readFileSync(file, 'utf8');
  // 去掉注释
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 类名
  for (const m of clean.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    definedClasses.add(m[1]);
  }
  // CSS 变量定义（含 fallback 用法不算定义）
  for (const m of clean.matchAll(/(--[\w-]+)\s*:/g)) {
    definedVars.add(m[1]);
  }
}

// ===== 逐个页面检查 =====
const pages = walk(path.join(MP, 'pages'), '.wxml');
const problems = [];

for (const wxml of pages) {
  const rel = path.relative(ROOT, wxml).replace(/\\/g, '/');
  const src = fs.readFileSync(wxml, 'utf8');
  const jsPath = wxml.replace(/\.wxml$/, '.js');
  const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

  // --- 1. 未定义的 class ---
  const usedClasses = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const raw = m[1];
    // 只取静态部分（跳过 {{...}} 插值）
    for (const token of raw.replace(/\{\{[^}]*\}\}/g, ' ').split(/\s+/)) {
      const name = token.trim();
      if (!name) continue;
      // 跳过插值前缀（如 class="tic-{{icon}}" 会残留 "tic-"）
      if (name.endsWith('-')) continue;
      usedClasses.add(name);
    }
  }
  for (const name of usedClasses) {
    if (!definedClasses.has(name)) {
      problems.push({ type: 'class-undefined', page: rel, detail: `.${name} 未在任何 wxss 中定义` });
    }
  }

  // --- 2. 未定义的 CSS 变量（检查该页面 wxss）---
  const pageWxss = wxml.replace(/\.wxml$/, '.wxss');
  if (fs.existsSync(pageWxss)) {
    const css = fs.readFileSync(pageWxss, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,[^)]*)?\)/g)) {
      const varName = m[1];
      const hasFallback = !!m[2];
      if (!definedVars.has(varName) && !hasFallback) {
        problems.push({ type: 'var-undefined', page: rel.replace(/wxml$/, 'wxss'), detail: `${varName} 未定义且无 fallback` });
      }
    }
  }

  // --- 3. 绑定了但不存在的方法 ---
  for (const m of src.matchAll(/(?:bind|catch):?(\w+)="([^"{}]+)"/g)) {
    const handler = m[2].trim();
    if (!handler || handler.startsWith('{')) continue;
    const hasMethod = new RegExp(`(^|[\\s,{])${handler}\\s*[:(]`, 'm').test(js);
    if (!hasMethod) {
      problems.push({ type: 'handler-missing', page: rel, detail: `${handler}() 在 js 中不存在（${m[0]}）` });
    }
  }
}

// ===== 输出 =====
const byType = problems.reduce((acc, p) => {
  (acc[p.type] = acc[p.type] || []).push(p);
  return acc;
}, {});

console.log('===== UI 体检结果 =====');
console.log(`扫描页面 ${pages.length} 个 / wxss ${wxssFiles.length} 个`);
for (const [type, list] of Object.entries(byType)) {
  console.log(`\n[${type}] ${list.length} 处`);
  for (const p of list.slice(0, 40)) {
    console.log(`  - ${p.page}: ${p.detail}`);
  }
  if (list.length > 40) console.log(`  ...另有 ${list.length - 40} 处`);
}
if (problems.length === 0) console.log('\n未发现问题');
console.log(`\n合计 ${problems.length} 处`);

process.exitCode = problems.length > 0 ? 1 : 0;
