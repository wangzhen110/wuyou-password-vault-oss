/**
 * comp-nav-bar 自定义导航栏 V6
 * title / back(返回箭头) / transparent(透出页面底色)
 * 状态栏高度自动适配；事件: bind:back
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    title: { type: String, value: '' },
    back: { type: Boolean, value: false },
    transparent: { type: Boolean, value: false },
  },
  data: {
    statusBarHeight: 20,
  },
  lifetimes: {
    attached() {
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        this.setData({ statusBarHeight: info.statusBarHeight || 20 });
      } catch (e) {
        this.setData({ statusBarHeight: 20 });
      }
    },
  },
  methods: {
    onBack() {
      this.triggerEvent('back');
      wx.navigateBack({ fail: () => {} });
    },
  },
});
