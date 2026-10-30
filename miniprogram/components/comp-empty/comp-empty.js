/** comp-empty 空状态 V6：纯 CSS 图标 + 标题 + 描述 + 行动按钮 */
Component({
  options: { addGlobalClass: true },
  properties: {
    title: { type: String, value: '暂无数据' },
    description: { type: String, value: '' },
    buttonText: { type: String, value: '' },
  },
  methods: {
    onButtonTap() {
      this.triggerEvent('action');
    },
  },
});
