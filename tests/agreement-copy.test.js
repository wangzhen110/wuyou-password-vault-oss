const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname,
  '..',
  'miniprogram',
  'pages',
  'agreement',
  'agreement.js',
);
const source = fs.readFileSync(sourcePath, 'utf8');
let pageDefinition;

vm.runInNewContext(source, {
  Page(definition) {
    pageDefinition = definition;
  },
  require() {
    return { getThemeClass: () => '', getFontSizeClass: () => '' };
  },
  wx: { setNavigationBarTitle() {} },
});

function readTab(tab) {
  const page = {
    ...pageDefinition,
    data: {},
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  pageDefinition.onLoad.call(page, { tab });
  return page.data.content.sections.flatMap(section => section.p).join('\n');
}

const about = readTab('about');
const agreement = readTab('agreement');
const privacy = readTab('privacy');
const allCopy = [about, agreement, privacy].join('\n');

// 禁止绝对化承诺与自夸话术
assert.doesNotMatch(allCopy, /彻底删除全部|无后台残留|服务器无任何明文|只存储密文|零知识架构|绝对安全/);
assert.doesNotMatch(allCopy, /我们不会主动删除你的任何已存数据/);
assert.doesNotMatch(allCopy, /一经购买成功不支持退款/);
// 不再出现工程审计腔措辞（用户读不懂的源码/核实类表述）
assert.doesNotMatch(allCopy, /当前源码|需另行核实|尚需核实|需以实际部署和运营配置核实/);
// 保留真实边界表述：删除不等于立即物理清除、主密码不可找回
assert.match(allCopy, /不承诺立即物理擦除|随系统维护逐步清理/);
assert.match(allCopy, /不提供主密码找回/);
// 付费方案与现行一致
assert.match(agreement, /年度会员.{0,30}容量上限500条/);
assert.match(agreement, /9\.9元\/份.*最多购买3次|永久容量补充包.{0,20}9\.9元/);
assert.match(agreement, /退款规则/);
assert.match(agreement, /到期3天内续费/);
// 隐私政策如实声明当前收集范围（含头像昵称——账户页资料功能已上线）
assert.match(privacy, /OpenID/);
assert.match(privacy, /头像与昵称/);
assert.match(privacy, /微信支付/);
assert.match(privacy, /剪贴板/);
assert.match(privacy, /境内/);
// 页面结构与更新日期
const wxml = fs.readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'pages', 'agreement', 'agreement.wxml'),
  'utf8',
);
assert.match(wxml, /comp-nav-bar/);
assert.match(wxml, /最后更新：2026年10月20日/);
console.log('agreement-copy: all checks passed');
