/**
 * comp-pwd-field 密码输入字段 V6
 * label / value / placeholder / textarea(多行) / showStrength(强度条)
 * 眼睛切换显示隐藏；事件: bind:input / bind:gen（生成按钮）
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    label: { type: String, value: '密码' },
    value: { type: String, value: '' },
    placeholder: { type: String, value: '输入密码' },
    textarea: { type: Boolean, value: false },
    showStrength: { type: Boolean, value: false },
    showGen: { type: Boolean, value: true },
    strength: { type: Number, value: -1 }, // 0弱 1中 2强，-1 不显示
  },
  data: {
    show: false,
  },
  methods: {
    onInput(e) {
      this.triggerEvent('input', { value: e.detail.value });
    },
    onToggle() {
      this.setData({ show: !this.data.show });
    },
    onGen() {
      this.setData({ show: true });
      this.triggerEvent('gen');
    },
  },
});
