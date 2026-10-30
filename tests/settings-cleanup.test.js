// 设置页功能清理：删推荐给朋友 + 删字体大小；安全笔记字数上限显性化
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('settings page drops recommend-to-friend and font-size entries', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/settings.js'), 'utf8');
  // 推荐给朋友入口删除（邀请卡的 open-type="share" 分享按钮保留，属邀请码体系）
  assert.doesNotMatch(wxml, /推荐给朋友/);
  // 字体大小入口与处理函数删除
  assert.doesNotMatch(wxml, /字体大小/);
  assert.doesNotMatch(js, /onFontSize/);
  assert.doesNotMatch(js, /fontSizeLabel/);
  // 保留项：主题 / 手动同步 / 用户协议 / 邀请好友分享按钮
  assert.match(wxml, /title="主题"/);
  assert.match(wxml, /title="手动同步"/);
  assert.match(wxml, /title="用户协议与隐私"/);
  assert.match(wxml, /open-type="share"/);
});

test('theme module pins font size to standard for everyone', () => {
  const themeJs = fs.readFileSync(path.join(ROOT, 'miniprogram/styles/theme.js'), 'utf8');
  const themeWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/styles/theme.wxss'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8');
  // getFontSizeClass 恒返回空串（存量 font-large 设置自动失效）
  assert.match(themeJs, /function getFontSizeClass\(\)\s*\{\s*return '';/s);
  assert.doesNotMatch(themeJs, /setFontSize|getFontSizeList|getFontSize\(/);
  assert.doesNotMatch(themeWxss, /font-large/);
  assert.doesNotMatch(appJs, /globalData\.fontSize/);
});

test('note textarea shows a visible 2000-char counter bound to maxlength', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/add/add.wxml'), 'utf8');
  // 安全笔记 body 走模板 textarea：上限 2000 保持，并显示计数
  assert.match(wxml, /maxlength="2000"/);
  assert.match(wxml, /form-counter/);
  assert.match(wxml, /\{\{item\.value\.length\}\}\/2000/);
});

test('silent wechat login is made visible to users', () => {
  const lockWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');
  const accWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/account/account.wxml'), 'utf8');
  const accJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/account/account.js'), 'utf8');
  // 首次设置主密码时告知微信已自动登录
  assert.match(lockWxml, /微信已自动登录，此密码仅用于加密数据/);
  // 账户页展示微信登录身份（openid 尾号）
  assert.match(accWxml, /微信账号已登录 · ID 尾号/);
  assert.match(accJs, /verifiedOpenid/);
});

test('lock screen shows brand header on top and user avatar as identity', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.wxml'), 'utf8');
  const js = fs.readFileSync(
    path.join(ROOT, 'miniprogram/components/comp-lock-screen/comp-lock-screen.js'), 'utf8');
  // 顶部品牌行：logo 图 + 品牌名（置顶）
  assert.match(wxml, /brand-header-logo" src="\/assets\/app-logo\.png"/);
  assert.match(wxml, /brand-header-name">无忧密码本/);
  // 头像优先显示（读 user_info.avatar_file_id），无头像回退锁图标
  assert.match(wxml, /brand-avatar" src="\{\{userAvatar\}\}"/);
  assert.match(wxml, /wx:else class="brand-icon"/);
  assert.match(js, /avatar_file_id/);
  // 页底品牌小字已随品牌行置顶移除
  assert.doesNotMatch(wxml, /brand-footer/);
  // 资料编辑（官方头像昵称填写形态）：独立编辑页 + form 收集，账户页整卡跳转
  const accWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/account/account.wxml'), 'utf8');
  assert.match(accWxml, /bindtap="goProfileEdit"/);
  assert.match(accWxml, /点击设置昵称/);
  assert.doesNotMatch(accWxml, /profile-editor-mask/);
  const editWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/profile-edit/profile-edit.wxml'), 'utf8');
  const editJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/profile-edit/profile-edit.js'), 'utf8');
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  // 页面已注册
  assert.ok(appJson.pages.includes('pages/profile-edit/profile-edit'), '编辑页需注册进 app.json');
  // 官方形态：form 收集 + chooseAvatar 头像 + nickname 昵称
  assert.match(editWxml, /<form[^>]*bindsubmit="onProfileSave"/);
  assert.match(editWxml, /open-type="chooseAvatar" bindchooseavatar="onChooseAvatar"/);
  assert.match(editWxml, /type="nickname" name="nickname"/);
  assert.match(editWxml, /form-type="submit"/);
  assert.match(editJs, /onProfileSave/);
});
