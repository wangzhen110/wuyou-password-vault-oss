// 平台判断：iOS 端需按微信规则屏蔽虚拟支付入口（会员/容量包不得在 iOS 提供购买）
function getPlatform() {
  try {
    if (typeof wx.getDeviceInfo === 'function') {
      const info = wx.getDeviceInfo();
      if (info && info.platform) return String(info.platform).toLowerCase();
    }
    const sys = wx.getSystemInfoSync();
    return String((sys && sys.platform) || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function isIOS() {
  return getPlatform() === 'ios';
}

module.exports = { getPlatform, isIOS };
