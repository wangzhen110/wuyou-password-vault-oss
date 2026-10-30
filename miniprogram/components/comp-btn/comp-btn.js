/**
 * comp-btn 统一按钮 V6
 * variant: primary | secondary | danger | ghost
 * size: normal | small
 * 事件: bind:tap
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    variant: { type: String, value: 'primary' },
    size: { type: String, value: 'normal' },
    disabled: { type: Boolean, value: false },
  },
  methods: {
    onTap(e) {
      if (this.data.disabled) return;
      this.triggerEvent('tap', e.detail);
    },
  },
});
