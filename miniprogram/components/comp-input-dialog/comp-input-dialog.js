// 通用输入弹窗：替代 editable showModal（其 placeholder 在部分平台渲染为实字、输入框宽度不可控）。
// fields: [{ key, label, placeholder, password }]；confirm 事件 detail: { values }；close 事件无 detail。
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    fields: { type: Array, value: [] },
    confirmText: { type: String, value: '确认' },
    cancelText: { type: String, value: '取消' },
    busyText: { type: String, value: '处理中...' },
    busy: { type: Boolean, value: false },
    error: { type: String, value: '' },
  },

  data: {
    values: {},
  },

  observers: {
    'visible, fields'(visible, fields) {
      if (!visible) return;
      // 打开时预填 fields[].value（2026-10-23：主密码提示修改需要回显原值）
      const initial = {};
      (fields || []).forEach((f) => {
        if (f && f.key) initial[f.key] = f.value !== undefined && f.value !== null ? f.value : '';
      });
      this.setData({ values: initial });
    },
  },

  methods: {
    noop() {},

    _onInput(e) {
      const key = e.currentTarget.dataset.key;
      if (!key) return;
      this.setData({ ['values.' + key]: e.detail.value });
    },

    _onCancel() {
      if (this.data.busy) return;
      this.triggerEvent('close');
    },

    _onConfirm() {
      if (this.data.busy) return;
      this.triggerEvent('confirm', { values: this.data.values });
    },
  },
});
