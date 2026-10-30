// pages/member 会员升级页
const app = getApp();
const storage = require('../../utils/storage');
const theme = require('../../styles/theme');
const demoMode = require('../../utils/demo-mode');
const member = require('../../utils/member');

// 日期格式化：用于会员到期提示
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 订单时间格式化：今年省略年份，跨年保留完整日期
function formatOrderTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => (n < 10 ? '0' + n : String(n));
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${ymd} ${hm}`;
}

Page({
  data: {
    themeClass: '',
    isVip: false,
    vipExpireText: '',
    // 容量
    capacityText: '',
    entitlementStale: false,
    entitlementStaleText: '',
    freeCapacity: 20,
    inviteCapacity: 0,
    paidCapacity: 0,
    // 档位
    products: [],
    selectedId: 'yearly_vip',
    paying: false,
    recovering: false,
    // 支付返回后的等待确认窗口
    confirming: false,
    confirmTip: '正在确认支付结果…',
    // 购买入口开关：开启——虚拟商品统一通过小程序虚拟支付能力（wx.requestVirtualPayment）售卖，
    // Android 走微信支付、iOS 走 Apple 支付（需小程序简称 + 微信 8.0.68+ + iOS 15+）。
    payEnabled: true,
    // 非正式版（体验版/开发版）不开放购买，避免测试产生真实订单与扣款
    payDisabledTitle: '会员权益（暂未开放）',
    pendingOrderNo: '',
    orderStatusText: '',
    // 历史订单弹窗
    ordersDialog: { visible: false, loading: false, error: '', list: [] },
  },

  onLoad() {
    // 全端统一走小程序虚拟支付（wx.requestVirtualPayment 内部按设备路由：Android 微信支付 / iOS Apple 支付）
    // 微信规则：虚拟商品购买必须接入虚拟支付能力，且该能力已支持 iOS，不得在 iOS 端屏蔽购买
    // 演示模式不开放购买：演示数据不落库，支付会产生真实订单，必须禁用（2026-10-24 用户要求）
    const inDemo = demoMode.isActive();
    this.setData({
      themeClass: theme.getThemeClass(),
      payEnabled: !inDemo,
      payDisabledTitle: inDemo ? '演示模式不支持购买' : '会员权益（暂未开放）',
    });
    this.refresh();
  },

  onShow() {
    this.refresh();
    // 从微信支付页返回：有待确认订单且窗口未显示时才启动等待流程
    // （窗口已显示 = onPaymentSubmitted 已触发 = requestPay 内部正在轮询，不重复）
    if (this.data.pendingOrderNo && !this.data.confirming) {
      this._waitForPayment(this.data.pendingOrderNo);
      return Promise.resolve();
    }
    return this.onRecoverOrder(true);
  },

  /** 支付返回后的确认窗口：轮询订单状态，直到到账或超时 */
  async _waitForPayment(outTradeNo) {
    if (this._waitForPaymentActive) return;
    this._waitForPaymentActive = true;
    this.setData({ confirming: true, confirmTip: '正在确认支付结果…' });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      let result = null;
      try {
        result = await member.recoverPendingOrder(outTradeNo);
      } catch (error) {
        result = null;
      }
      if (result && result.success && result.status === 'paid') {
        this._waitForPaymentActive = false;
        this.setData({ confirming: false, pendingOrderNo: '', orderStatusText: '权益已到账' });
        wx.showToast({ title: '权益已到账', icon: 'success' });
        this.refresh();
        return;
      }
      if (result && result.status === 'closed') {
        this._waitForPaymentActive = false;
        this.setData({ confirming: false, pendingOrderNo: '', orderStatusText: '订单已关闭' });
        wx.showModal({
          title: '订单已关闭',
          content: '这笔订单未完成支付。如已扣款，请稍后重新进入本页查看，或联系客服。',
          showCancel: false,
        });
        return;
      }
      if (i >= 3) this.setData({ confirmTip: '仍在确认中，请稍候…' });
    }

    this.setData({ confirming: false });
    wx.showModal({
      title: '支付结果确认中',
      content: '支付已提交，微信正在通知服务器。通常十几秒内到账；若稍后仍未看到权益，请重新进入会员页查看。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  async refresh() {
    const ent = member.getUserEntitlement();
    const masterKey = app.globalData.masterKey;
    if (!masterKey) return;

    // 权益过期但在线：主动拉一次云端权益自愈（成功后 stale 消失），
    // 不再要求用户"联网后重进"；失败靠 10 秒节流防接口风暴
    if (ent.stale && ent.staleReason === 'expired' && typeof app.refreshUserInfo === 'function') {
      const now = Date.now();
      if (!this._lastEntitlementFetchAt || now - this._lastEntitlementFetchAt > 10 * 1000) {
        this._lastEntitlementFetchAt = now;
        app.refreshUserInfo(() => this.refresh());
      }
    }

    let passwords;
    try {
      passwords = await storage.getAllPasswords(masterKey);
    } catch (error) {
      wx.showToast({ title: '容量信息加载失败，请重试', icon: 'none' });
      return;
    }
    const activeCount = passwords.filter(p => !p.is_deleted).length;

    let vipExpireText = '';
    if (ent.vipExpireAt) {
      const d = new Date(ent.vipExpireAt);
      vipExpireText = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }

    // 补充包已购次数（每份 +10 条永久容量，最多 3 份）
    const PACK_MAX_TIMES = 3;
    const packUsed = Math.min(PACK_MAX_TIMES, Math.floor((ent.paidCapacity || 0) / 10));

    // 状态行只放一句短文案，明细走 cap-detail 分解行，避免长文本把标签挤成竖排
    const capacityText = ent.isVip
      ? `已用 ${activeCount} 条 / ${ent.effectiveCapacity} 条`
      : `已用 ${activeCount} 条 / ${ent.permanentCapacity} 条`;

    this.setData({
      // 离线或长时间未同步时，权益可能不是最新（涉及退款/权益变更）
      entitlementStale: !!ent.stale,
      entitlementStaleText: ent.staleReason === 'offline'
        ? '当前处于离线状态，权益显示为上次同步结果，联网后会自动更新'
        : '权益信息已超过 10 分钟未同步，可能不是最新，请联网后重进',
      isVip: ent.isVip,
      vipExpireText,
      capacityText,
      freeCapacity: ent.freeCapacity,
      inviteCapacity: ent.inviteCapacity,
      paidCapacity: ent.paidCapacity,
      memberCapacity: ent.memberCapacity,
      products: [
        {
          id: 'permanent_pack',
          name: '永久容量补充包',
          price: '9.9',
          unit: '元',
          desc: '新增 10 条永久容量',
          // 已购次数提示：让用户清楚还能买几次（上限 3 次 / +30 条）
          badgeText: packUsed >= PACK_MAX_TIMES
            ? `已购 ${packUsed}/${PACK_MAX_TIMES} 次 · 已达上限`
            : `已购 ${packUsed}/${PACK_MAX_TIMES} 次 · 还可购买 ${PACK_MAX_TIMES - packUsed} 次`,
          disabled: packUsed >= PACK_MAX_TIMES,
          highlights: ['永久容量 +10 条', '一次购买长期有效', `最多购买 ${PACK_MAX_TIMES} 次（共 +${PACK_MAX_TIMES * 10} 条）`],
        },
        {
          id: 'yearly_vip',
          name: '年度会员',
          price: '39',
          unit: '元/年',
          desc: '会员容量 500 条起 + 开放 API',
          badgeText: ent.isVip && ent.vipExpireAt
            ? `已是会员 · ${formatDate(ent.vipExpireAt)} 到期（可续费叠加）`
            : '',
          highlights: ['容量上限 500 条（已购/邀请容量叠加）', '开放 API 读取加密数据', '邀请好友再获 3 个月会员'],
          recommended: true,
        },
      ],
    });
  },

  onSelect(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.products.find(item => item.id === id);
    if (target && target.disabled) {
      wx.showToast({ title: '该补充包已达购买上限（3 次）', icon: 'none' });
      return;
    }
    this.setData({ selectedId: id });
  },

  async onPay() {
    if (!this.data.payEnabled) {
      wx.showToast({ title: '会员购买功能即将开放', icon: 'none' });
      return;
    }
    if (this.data.paying || this.data.recovering) return;
    const productId = this.data.selectedId;
    this.setData({ paying: true });

    let result;
    try {
      result = await member.requestPay(productId, {
        // 支付提交瞬间（用户在微信支付页完成付款）立即亮出等待窗口
        onPaymentSubmitted: (outTradeNo) => {
          this.setData({
            pendingOrderNo: outTradeNo,
            confirming: true,
            confirmTip: '正在确认支付结果…',
          });
        },
      });
    } catch (error) {
      wx.showModal({
        title: '支付状态待确认',
        content: '支付请求未完成，状态可能仍在确认中，请稍后查询，勿重复下单',
        showCancel: false,
      });
      return;
    } finally {
      this.setData({ paying: false });
    }

    if (!result.success && !result.cancelled && result.out_trade_no
        && result.code !== 'BALANCE_RECONCILIATION_REQUIRED') {
      // 支付已发起但结果未定 → 立即显示等待确认窗口
      this.setData({
        pendingOrderNo: result.out_trade_no,
        orderStatusText: '支付结果待确认，请稍候…',
      });
      this._waitForPayment(result.out_trade_no);
      return;
    }

    if (result.success) {
      this._waitForPaymentActive = false;
      this.setData({ pendingOrderNo: '', confirming: false, orderStatusText: '权益已到账' });
      wx.showToast({ title: '权益已到账', icon: 'success' });
      this.refresh();
    } else if (result.cancelled) {
      this._waitForPaymentActive = false;
      this.setData({
        pendingOrderNo: result.out_trade_no || '',
        confirming: false,
        orderStatusText: '支付已取消，订单仍待确认',
      });
      wx.showToast({ title: '已取消支付，可查询订单', icon: 'none' });
    } else {
      if (result.out_trade_no) {
        this.setData({
          pendingOrderNo: result.out_trade_no,
          orderStatusText: '订单状态待确认',
        });
      }
      wx.showModal({
        title: result.code === 'PACK_LIMIT' ? '无法购买' : '支付未完成',
        content: result.error || '支付失败，请稍后再试',
        showCancel: false,
      });
    }
  },

  async onRecoverOrder(silent = false) {
    if (this.data.recovering) return;
    this.setData({ recovering: true });
    try {
      const result = await member.recoverPendingOrder(this.data.pendingOrderNo);
      if (result.success && result.status === 'paid') {
        this.setData({ pendingOrderNo: '', orderStatusText: '权益已到账' });
        if (!silent) wx.showToast({ title: '权益已到账', icon: 'success' });
        this.refresh();
        return;
      }

      const statusText = {
        pending: '订单待确认，请稍后查询',
        reconciliation_required: '订单状态仍在确认，请稍后重试',
        closed: '订单已关闭',
        refunded: '订单已退款',
        manual_review: '退款待人工复核',
        none: '没有待确认的订单',
      }[result.status] || result.error || '订单状态暂无法确认';
      this.setData({
        pendingOrderNo: result.out_trade_no || (result.status === 'none' ? '' : this.data.pendingOrderNo),
        orderStatusText: result.status === 'none' ? '' : statusText,
      });
      // 任何状态都要给用户明确反馈，避免"点了没反应"
      if (!silent) {
        wx.showToast({ title: statusText, icon: 'none' });
      }
    } catch (error) {
      this.setData({ orderStatusText: '订单查询失败，请稍后重试' });
      if (!silent) wx.showToast({ title: '订单查询失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ recovering: false });
    }
  },

  /** 查询历史订单：拉取最近 20 条并弹窗展示（自动恢复待确认订单的逻辑保留在 onShow 静默路径） */
  async onListOrders() {
    if (this.data.ordersDialog.loading) return;
    this.setData({ ordersDialog: { visible: true, loading: true, error: '', list: [] } });
    try {
      const res = await new Promise((resolve, reject) => {
        wx.cloud.callFunction({
          name: 'pay',
          data: { action: 'list_orders' },
          success: resolve,
          fail: reject,
        });
      });
      const result = (res && res.result) || {};
      if (!result.success) {
        throw new Error(result.error || '查询失败');
      }
      const statusText = {
        paid: '已到账',
        pending: '待支付',
        closed: '已关闭',
        refunded: '已退款',
      };
      const list = (result.orders || []).map(order => ({
        outTradeNo: order.out_trade_no || '',
        name: order.product_name || (order.product_id === 'yearly_vip' ? '年度会员' : '容量补充包'),
        amountText: `¥${((Number(order.total_fee) || 0) / 100).toFixed(2)}`,
        statusText: statusText[order.status] || '确认中',
        statusKey: statusText[order.status] ? order.status : 'unknown',
        timeText: formatOrderTime(order.paid_at || order.created_at),
      }));
      this.setData({ ordersDialog: { visible: true, loading: false, error: '', list } });
    } catch (error) {
      this.setData({
        ordersDialog: {
          visible: true,
          loading: false,
          error: (error && error.message) || '订单查询失败，请稍后重试',
          list: [],
        },
      });
    }
  },

  closeOrdersDialog() {
    this.setData({ 'ordersDialog.visible': false });
  },

  /** 复制完整订单号（向客服/后台报单号查询用） */
  onCopyOrderNo(e) {
    const no = e && e.currentTarget && e.currentTarget.dataset.no;
    if (!no) return;
    wx.setClipboardData({
      data: no,
      success: () => wx.showToast({ title: '订单号已复制', icon: 'success' }),
    });
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement?tab=agreement' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/agreement/agreement?tab=privacy' });
  },
});
