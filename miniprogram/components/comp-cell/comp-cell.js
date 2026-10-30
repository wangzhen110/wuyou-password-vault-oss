/**
 * comp-cell 列表原子单元 V6
 * 左图标（icon key，纯CSS）+ 标题 + 副文案 + 右侧（值/箭头/开关/自定义 slot）
 * 事件: bind:tap
 */
Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    icon: { type: String, value: '' },      // 纯CSS图标 key：lock/server/card/note/key/gear/font/cloud/finger/msg/headset/info/share
    iconTone: { type: String, value: 'green' }, // green | plain
    title: { type: String, value: '' },
    desc: { type: String, value: '' },      // 副文案（可选）
    value: { type: String, value: '' },     // 右侧文本值（可选）
    arrow: { type: Boolean, value: false },
  },
  methods: {
    onTap() {
      this.triggerEvent('tap');
    },
  },
});
