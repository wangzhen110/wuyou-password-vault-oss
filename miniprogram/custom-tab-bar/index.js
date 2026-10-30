// 自定义 tabBar：跟随应用内主题（tab-bar 独立于页面 DOM，吃不到页面 themeClass 变量作用域）
const theme = require('../styles/theme');

Component({
  data: {
    selected: 0,
    themeClass: '',
    list: [
      { index: 0, path: '/pages/index/index', text: '密码' },
      { index: 1, path: '/pages/settings/settings', text: '设置' }
    ]
  },
  lifetimes: {
    attached() {
      this.refreshTheme();
    }
  },
  pageLifetimes: {
    show() {
      this.refreshTheme();
    }
  },
  methods: {
    refreshTheme() {
      const effective = theme.getEffectiveTheme();
      this.setData({ themeClass: effective === 'light' ? 'theme-light' : '' });
    },
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const path = e.currentTarget.dataset.path;
      this.setData({ selected: index });
      wx.switchTab({ url: path });
    }
  }
});
