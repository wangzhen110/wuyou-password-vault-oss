/**
 * 页面静态检查：JS 语法 + require 路径存在性 + wxml 事件处理器对齐
 * 用法：node tests/check-page.js [pages/add/add]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'miniprogram');
const requestedPage = process.argv[2];

function collectPages() {
  if (requestedPage) return [requestedPage];
  const pagesRoot = path.join(ROOT, 'pages');
  return fs.readdirSync(pagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.posix.join('pages', entry.name, entry.name))
    .filter(page => fs.existsSync(path.join(ROOT, page + '.js')))
    .sort();
}

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) fail++;
}

function checkPage(page) {
  console.log(`\n检查页面: ${page}`);
  // 1. JS 语法 + require 路径
  const jsPath = path.join(ROOT, page + '.js');
  if (!fs.existsSync(jsPath)) {
    ok(false, `${page}.js 存在`);
    return;
  }
  const src = fs.readFileSync(jsPath, 'utf8');
let syntaxOk = true;
try {
  new Function(
    src
      .replace(/getApp\(\)/g, '({globalData:{}})')
      .replace(/require\((['"])([^'"]+)\1\)/g, (m, q, p) => {
        const base = path.dirname(jsPath);
        const full = path.join(base, p.endsWith('.js') ? p : p + '.js');
        if (!fs.existsSync(full)) throw new Error('missing require: ' + p);
        return '({})';
      })
  );
} catch (e) {
  syntaxOk = false;
  console.log('  FAIL js 语法/依赖:', e.message);
}
ok(syntaxOk, page + '.js 语法 + require 路径');

// 2. wxml 事件处理器存在性
const wxmlPath = path.join(ROOT, page + '.wxml');
if (fs.existsSync(wxmlPath)) {
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const handlers = [...new Set(
    [...wxml.matchAll(/(?:bind|catch)[a-z]*=["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map(m => m[1])
  )];
  const missing = handlers.filter(h => !src.includes(h));
  ok(missing.length === 0, 'wxml 处理器齐全' + (missing.length ? '，缺: ' + missing.join(',') : '（' + handlers.length + ' 个）'));

  // 3. wxml data 绑定字段在 js data 中声明（抽查顶层字段）
  const binds = [...new Set(
    [...wxml.matchAll(/\{\{\s*([a-z][A-Za-z0-9_]*)[\s.]/g)].map(m => m[1])
  ).add(...[...wxml.matchAll(/\{\{\s*([a-z][A-Za-z0-9_]*)\s*\}\}/g)].map(m => m[1]))];
  const dataMatch = src.match(/data:\s*\{([\s\S]*?)\n {2}\},/);
  const dataSrc = dataMatch ? dataMatch[1] : '';
  const knownExtras = ['item', 'index', 'idx', 'opt', 'oi', 'h', 'true', 'false', 'null', 'd'];
  const missBind = binds.filter(b => !knownExtras.includes(b) && !dataSrc.includes(b) && !src.includes(b + ':') && !src.includes("'" + b + "'") && !src.includes('"' + b + '"'));
  ok(missBind.length === 0, 'wxml 数据绑定基本对齐' + (missBind.length ? '，可疑: ' + missBind.join(',') : '（' + binds.length + ' 个绑定）'));
}

// 4. JSON usingComponents 路径存在（页面和组件均递归检查）
const jsonPath = path.join(ROOT, page + '.json');
if (fs.existsSync(jsonPath)) {
  const conf = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const comps = conf.usingComponents || {};
  const pageDir = path.dirname(jsonPath);
  const missComp = Object.entries(comps).filter(([, p]) => {
    const base = p.startsWith('/') ? ROOT : pageDir;
    return !fs.existsSync(path.join(base, p.endsWith('.js') ? p : p + '.js'));
  });
  ok(missComp.length === 0, 'usingComponents 路径有效' + (missComp.length ? '，缺: ' + missComp.map(([k]) => k).join(',') : ''));
}
}

function checkComponentTree(filePath, visited = new Set()) {
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  const confPath = filePath.replace(/\.js$/, '.json');
  if (!fs.existsSync(confPath)) return [];
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const baseDir = path.dirname(confPath);
  const missing = [];

  for (const [name, componentPath] of Object.entries(conf.usingComponents || {})) {
    const componentFile = path.join(
      componentPath.startsWith('/') ? ROOT : baseDir,
      componentPath.replace(/^\//, '').replace(/\.js$/, '') + '.js'
    );
    if (!fs.existsSync(componentFile)) {
      missing.push(`${name}: ${componentPath}`);
      continue;
    }
    missing.push(...checkComponentTree(componentFile, visited));
  }
  return missing;
}

const componentFiles = [];
function collectComponents(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectComponents(fullPath);
    else if (entry.name.endsWith('.js') && fs.existsSync(fullPath.replace(/\.js$/, '.json'))) {
      const conf = JSON.parse(fs.readFileSync(fullPath.replace(/\.js$/, '.json'), 'utf8'));
      if (conf.component) componentFiles.push(fullPath);
    }
  }
}
collectComponents(path.join(ROOT, 'components'));
const missingNestedComponents = componentFiles.flatMap(filePath => checkComponentTree(filePath));
ok(
  missingNestedComponents.length === 0,
  '组件内部 usingComponents 路径有效' +
    (missingNestedComponents.length ? '，缺: ' + missingNestedComponents.join(', ') : `（${componentFiles.length} 个组件）`)
);

for (const page of collectPages()) checkPage(page);

console.log(fail ? '结果: ' + fail + ' 项失败' : '结果: 全部通过');
process.exit(fail ? 1 : 0);
