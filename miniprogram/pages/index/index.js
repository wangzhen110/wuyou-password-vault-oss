// pages/index 密码列表主页 V4.0 - 类型图标/副标题 + 筛选chips + 搜索扩展(fields联合匹配)
const app = getApp();
const storage = require('../../utils/storage');
const demoMode = require('../../utils/demo-mode');
const theme = require('../../styles/theme');
const member = require('../../utils/member');
const templates = require('../../utils/entry-templates');

const PLATFORM_COLORS = {
  '微信': { bg: '#07C160', color: '#FFFFFF' },
  '抖音': { bg: '#FE2C55', color: '#FFFFFF' },
  '淘宝': { bg: '#FF5000', color: '#FFFFFF' },
  '支付宝': { bg: '#1677FF', color: '#FFFFFF' },
  '银行卡': { bg: '#F59E0B', color: '#FFFFFF' },
  'WiFi': { bg: '#6366F1', color: '#FFFFFF' },
  'QQ': { bg: '#12B7F5', color: '#FFFFFF' },
  '邮箱': { bg: '#7C3AED', color: '#FFFFFF' },
  '游戏': { bg: '#EF4444', color: '#FFFFFF' },
  '会员': { bg: '#ED6A0C', color: '#FFFFFF' },
  '办公': { bg: '#3B82F6', color: '#FFFFFF' },
  '其他': { bg: '#969799', color: '#FFFFFF' }
};

// 4.3.11 分组配置（本地存储，仅展示偏好，不同步云端）
const GROUP_ORDER_KEY = 'group_order';
const GROUP_NAMES_KEY = 'group_names';
const GROUP_HIDDEN_KEY = 'group_hidden';

Page({
  data: {
    topBarHeight: 70,
    passwords: [],
    filteredPasswords: [],
    searchText: '',
    activeType: 'all',   // 筛选 chips：all | login | server | ...
    // 4.3.11 抽屉式分组
    currentGroup: '全部',
    currentGroupLabel: '全部',
    groupedList: [],
    drawerGroups: [],
    drawerOpen: false,
    drawerTop: 92,
    groupCollapsed: {},
    typeChips: [],
    loading: true,
    themeClass: '',
    capacity: 30,
    usedCount: 0,
    nickName: '',
    avatarFileId: '',
    capacityPercent: 0,
    isVip: false,
    overflowCount: 0,
    offlineMode: false,
    // 列表排序：key=seq|created|updated|name，asc=true 为正序
    sortKey: 'updated',
    sortAsc: false,
    sortLabel: '最近更新',
  },

  onLoad(options) {
    this._restoreSortPref();
    this.setData({ themeClass: theme.getThemeClass() });

    // 安全守卫：未设置主密码的新用户（含被邀请用户）必须先走 lock 页创建密码库，
    // 否则通过邀请分享直接进首页会「不设密码就能用」
    const hasVault = typeof storage.hasMasterPassword === 'function' && storage.hasMasterPassword();
    // 演示模式例外：无密码库也可浏览示例数据（演示模式内所有写操作一律拒绝，不接触真实库）
    if (!hasVault && !demoMode.isActive()) {
      if (options && options.invite_code) {
        storage.set('pending_invite_code', options.invite_code);
      }
      wx.reLaunch({ url: '/pages/lock/lock' });
      return;
    }

    // 处理邀请码（本次带参 or 上次被拦下时暂存的）
    const pending = (options && options.invite_code) || storage.get('pending_invite_code');
    if (pending) {
      storage.remove('pending_invite_code');
      this._handleInviteCode(pending);
    }

    this.loadData();
  },

  /** 排序偏好：本地记忆，跨次打开保持 */
  _restoreSortPref() {
    const pref = (typeof storage.get === 'function' ? storage.get('list_sort') : null) || {};
    const valid = ['seq', 'created', 'updated', 'name'];
    const key = valid.includes(pref.key) ? pref.key : 'updated';
    const asc = typeof pref.asc === 'boolean' ? pref.asc : false;
    this.setData({
      sortKey: key,
      sortAsc: asc,
      sortLabel: this._sortLabelOf(key, asc),
    });
  },

  _sortLabelOf(key, asc) {
    if (key === 'seq') return asc ? '编号正序' : '编号反序';
    if (key === 'created') return asc ? '最早创建' : '最新创建';
    if (key === 'name') return asc ? '名称 A-Z' : '名称 Z-A';
    return asc ? '最早更新' : '最近更新';
  },

  /** 排序面板 */
  onSortTap() {
    // wx.showActionSheet 的 itemList 上限为 6 项（微信限制）
    const items = ['编号正序（#1 起）', '编号反序', '最近更新', '最新创建', '名称 A-Z', '名称 Z-A'];
    const presets = [
      { key: 'seq', asc: true },
      { key: 'seq', asc: false },
      { key: 'updated', asc: false },
      { key: 'created', asc: false },
      { key: 'name', asc: true },
      { key: 'name', asc: false },
    ];
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const preset = presets[res.tapIndex];
        if (!preset) return;
        this.setData({
          sortKey: preset.key,
          sortAsc: preset.asc,
          sortLabel: this._sortLabelOf(preset.key, preset.asc),
        });
        if (typeof storage.set === 'function') storage.set('list_sort', preset);
        this.applySearch();
      },
    });
  },

  onShow() {
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const topH = (win.statusBarHeight || 20) + 50;
      if (this.data.topBarHeight !== topH) this.setData({ topBarHeight: topH });
    } catch (e) { /* 保持默认 */ }
    this.setData({ themeClass: theme.getThemeClass() });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      tabBar.setData({ selected: 0 });
      // tab-bar 组件在页面 DOM 外，pageLifetimes 不可靠，页面 show 时主动同步主题
      if (typeof tabBar.refreshTheme === 'function') tabBar.refreshTheme();
    }
    this.setData({ offlineMode: !!app.globalData.offlineMode });
    this._loadProfile();

    if (!app.globalData.isLocked) {
      this.loadData();
    }

    // 暂存邀请码兜底消费：热启动时 onLoad 不执行，扫码带来的邀请码要在 show 时补上
    const pendingInvite = typeof storage.get === 'function' ? storage.get('pending_invite_code') : null;
    if (pendingInvite) {
      storage.remove('pending_invite_code');
      this._handleInviteCode(pendingInvite);
    }
  },

  /** 读取个人资料：有头像/昵称就替换首页默认的 logo 与品牌名 */
  _loadProfile() {
    const app = getApp();
    const cached = typeof storage.get === 'function' ? storage.get('user_info') : null;
    const user = (app && app.globalData && app.globalData.userInfo) || cached || {};
    this.setData({
      nickName: typeof user.nick_name === 'string' ? user.nick_name : '',
      avatarFileId: typeof user.avatar_file_id === 'string' ? user.avatar_file_id : '',
    });
  },

  /**
   * 离线模式状态变化（由 app.setOfflineMode 通知）
   */
  onOfflineChange(v) {
    this.setData({ offlineMode: !!v });
  },

  /** 网络状态变化（真断网立即红灯，不必等登录超时） */
  onNetworkChange(connected, offline) {
    this.setData({ offlineMode: !!offline || connected === false });
  },

  /**
   * 处理邀请码
   */
  _handleInviteCode(inviteCode) {
    wx.cloud.callFunction({
      name: 'invite',
      data: {
        action: 'verify_invite',
        invite_code: inviteCode,
        // “实际注册并使用”判定：仅当本地已创建密码库（已设置主密码）时上报
        vault_ready: storage.hasMasterPassword ? storage.hasMasterPassword() : false,
      },
      success: (res) => {
        const r = res.result;
        if (r && r.success) {
          wx.showToast({
            title: r.invitee_reward || '已绑定，容量 +5',
            icon: 'success',
            duration: 3000
          });
          // 刷新用户信息，并在拉回最新权益后立即重算页面容量（否则要等切页回来才变）
          app.refreshUserInfo(() => {
            this._loadProfile();
            this.loadData();
          });
        } else {
          // 失败原因用弹窗（toast 3 秒消失，用户看不到被拒原因）
          const reasonMap = {
            INVITEE_TOO_OLD: '邀请码仅限 30 天内注册的新用户使用。你当前账号注册已超过 30 天，无法通过邀请扩容。',
            ALREADY_INVITED: '该账号已经使用过邀请码，不能重复使用。',
            SELF_INVITE: '不能使用自己分享的邀请码。',
            VAULT_NOT_READY: '请先设置主密码完成密码库创建，再使用邀请码。',
            INVITEE_NOT_REGISTERED: '请先完成注册后再使用邀请码。',
          };
          const code = r && r.code;
          const msg = reasonMap[code] || (r && r.error) || '邀请码无效';
          wx.showModal({
            title: '邀请码未能生效',
            content: msg,
            showCancel: false,
            confirmText: '知道了',
          });
        }
      },
      fail: () => {
        wx.showModal({
          title: '网络错误',
          content: '邀请码绑定请求失败，请检查网络后重试。',
          showCancel: false,
          confirmText: '知道了',
        });
      }
    });
  },

  /** 退出演示模式：清空演示状态并回到锁屏，真实数据需主密码才能进 */
  onExitDemo() {
    demoMode.exit();
    wx.reLaunch({ url: '/pages/lock/lock' });
  },

  /** 点击头部资料区（头像+昵称）：与设置页资料卡一致，进入「我的账户」 */
  onGoAccount() {
    // 演示模式下不进入账户页：账户页含资料编辑写路径，避免演示数据混入真实库
    if (this.data.demoMode) return;
    wx.navigateTo({ url: '/pages/account/account' });
  },

  async loadData() {
    const demo = demoMode.isActive();
    const masterKey = app.globalData.masterKey;
    if (!masterKey && !demo) {
      this.setData({ loading: false });
      return;
    }
    if (demo) this.setData({ demoMode: true });

    let passwords;
    try {
      passwords = (await storage.getAllPasswords(masterKey))
        .filter(p => !p.is_deleted);
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      return;
    }

    // 附加条目编号（服务端 counters 分配，本地映射缓存）
    const seqMap = typeof storage.getSeqMap === 'function' ? storage.getSeqMap() : {};
    passwords.forEach(p => { p.seq = seqMap[p.id] || null; });

    const ent = member.getUserEntitlement();
    // 总容量 = 会员 500 条基础 + 邀请/付费叠加（免费态即永久容量），不再写死 500
    const capacityPercent = ent.isVip ? 0 : Math.min(100, Math.round(passwords.length / ent.permanentCapacity * 100));

    // 到期降级状态：超出永久容量的条目只读
    const overflowCount = ent.isVip ? 0 : Math.max(0, passwords.length - ent.permanentCapacity);

    // 筛选 chips：全部 + 首发五类（Wi-Fi 候选池不进）
    const counts = {};
    passwords.forEach(p => {
      const t = templates.getEntryType(p);
      counts[t] = (counts[t] || 0) + 1;
    });
    const typeChips = [{ type: 'all', name: '全部', count: passwords.length }].concat(
      templates.TYPE_ORDER.map(t => ({
        type: t,
        name: templates.getTypeName(t),
        count: counts[t] || 0,
      }))
    );

    this.setData({
      passwords,
      typeChips,
      capacity: ent.effectiveCapacity,
      usedCount: passwords.length,
      capacityPercent,
      isVip: ent.isVip,
      overflowCount,
      loading: false
    }, () => {
      this.applySearch();
    });
  },

  onSearchInput(e) {
    this.setData({ searchText: e.detail.value });
    // 300ms 防抖：applySearch 全量过滤+排序+克隆，逐键触发在接近容量上限时会掉帧
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.applySearch(), 300);
  },

  onClearSearch() {
    this.setData({ searchText: '' });
    this.applySearch();
  },

  /** 类型筛选 chips（1Password 侧栏分类的移动端等价物） */
  onTypeChip(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.activeType) return;
    this.setData({ activeType: type });
    this.applySearch();
  },

  /** 按当前排序规则排序（未编号的条目始终排在末尾，避免 #0 混在前面） */
  _sortList(list) {
    const { sortKey, sortAsc } = this.data;
    const dir = sortAsc ? 1 : -1;
    const ts = (v) => {
      const t = new Date(v || 0).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    return list.slice().sort((a, b) => {
      if (sortKey === 'seq') {
        const sa = Number(a.seq) || 0;
        const sb = Number(b.seq) || 0;
        if (sa === 0 && sb === 0) return 0;
        if (sa === 0) return 1;   // 无编号排最后
        if (sb === 0) return -1;
        return (sa - sb) * dir;
      }
      if (sortKey === 'name') {
        const na = String(a.platform || '').toLowerCase();
        const nb = String(b.platform || '').toLowerCase();
        return na.localeCompare(nb, 'zh-Hans-CN') * dir;
      }
      const va = sortKey === 'created'
        ? (Number(a.created_timestamp) || ts(a.created_at))
        : ts(a.updated_at);
      const vb = sortKey === 'created'
        ? (Number(b.created_timestamp) || ts(b.created_at))
        : ts(b.updated_at);
      return (va - vb) * dir;
    });
  },

  applySearch() {
    let filtered = [...this.data.passwords];
    const { searchText, activeType } = this.data;

    // 类型筛选
    if (activeType !== 'all') {
      filtered = filtered.filter(p => templates.getEntryType(p) === activeType);
    }

    if (searchText.trim()) {
      const keyword = searchText.trim().toLowerCase();
      // V4：标题/账号 + fields[].value + custom_fields 联合匹配
      filtered = filtered.filter(p => {
        if ((p.platform || '').toLowerCase().includes(keyword) ||
            (p.account || '').toLowerCase().includes(keyword) ||
            (p.notes && p.notes.toLowerCase().includes(keyword))) {
          return true;
        }
        const inFields = Array.isArray(p.fields) && p.fields.some(f =>
          (f.value || '').toLowerCase().includes(keyword) || (f.label || '').toLowerCase().includes(keyword));
        if (inFields) return true;
        return Array.isArray(p.custom_fields) && p.custom_fields.some(f =>
          (f.value || '').toLowerCase().includes(keyword) || (f.label || '').toLowerCase().includes(keyword));
      });
    }

    const pinned = filtered.filter(p => p.pinned);
    const unpinned = filtered.filter(p => !p.pinned);
    // 置顶组内 + 非置顶组内分别按当前排序规则排序
    filtered = [...this._sortList(pinned), ...this._sortList(unpinned)];

    // V4：列表项类型图标 + 按类型副标题（方案 4.2 副标题表）
    filtered = filtered.map(item => {
      const type = templates.getEntryType(item);
      const colors = PLATFORM_COLORS[item.platform] || PLATFORM_COLORS['其他'];
      return {
        ...item,
        iconBg: type === 'login' ? colors.bg : '#E8F8EF',
        iconColor: type === 'login' ? colors.color : '#2CD06A',
        platformLetter: (item.platform || '·').charAt(0),
        entryType: type,
        typeIcon: templates.getIcon(type),
        typeTag: type === 'login' ? '' : templates.getTypeName(type),
        subtitle: templates.getSubtitle(item),
      };
    });

    this._buildGroups(filtered);
    this.setData({ filteredPasswords: filtered });
  },

  /**
   * 4.3.11：按平台名自动分组。
   * - 「全部」= 平铺，按录入时间倒序（用户明确要求），不折叠
   * - 选中某平台 = 只显示该平台条目，组内按「工作/个人/其他」二次折叠
   * - 仅 1 条的平台也单独成组（用户确认）
   */
  _buildGroups(list) {
    const all = list.slice();
    // 防御：storage.get 在个别运行环境/测试桩里可能不存在，缺失时按无配置处理
    const readCfg = (key) => {
      try {
        return (typeof storage.get === 'function' ? storage.get(key) : null) || {};
      } catch (error) {
        return {};
      }
    };
    const groupOrder = readCfg(GROUP_ORDER_KEY);
    const groupNames = readCfg(GROUP_NAMES_KEY);
    const groupHidden = readCfg(GROUP_HIDDEN_KEY);

    const map = {};
    all.forEach((it) => {
      const key = it.platform || '未命名';
      (map[key] = map[key] || []).push(it);
    });

    let keys = Object.keys(map);
    if (groupOrder.length) {
      keys.sort((a, b) => {
        const ia = groupOrder.indexOf(a);
        const ib = groupOrder.indexOf(b);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    } else {
      keys.sort((a, b) => map[b].length - map[a].length);
    }

    const drawerGroups = keys.filter((k) => !groupHidden[k]).map((k) => ({
      key: k,
      label: groupNames[k] || k,
      count: map[k].length,
      color: (PLATFORM_COLORS[k] || PLATFORM_COLORS['其他']).color,
    }));

    const byCreatedDesc = (a, b) =>
      (Number(b.created_timestamp) || 0) - (Number(a.created_timestamp) || 0);

    const current = this.data.currentGroup;
    if (current === '全部' || !map[current]) {
      const flat = all.sort(byCreatedDesc);
      this.setData({
        currentGroup: '全部',
        currentGroupLabel: '全部',
        drawerGroups,
        groupedList: flat.length
          ? [{ key: '全部', label: '全部', count: flat.length, flat: true, collapsed: false, items: flat }]
          : [],
      });
      return;
    }

    const items = map[current].slice().sort(byCreatedDesc);
    const collapsedMap = this.data.groupCollapsed || {};
    const groupedList = this._bucketize(items).map((b) => {
      const key = current + '::' + b.label;
      return {
        key,
        label: b.label,
        count: b.items.length,
        collapsed: !!collapsedMap[key],
        items: b.items,
      };
    });

    this.setData({
      currentGroup: current,
      currentGroupLabel: groupNames[current] || current,
      drawerGroups,
      groupedList,
    });
  },

  /** 组内二次折叠（v1 启发式关键词；不足 3 条不折叠） */
  _bucketize(items) {
    if (items.length < 3) return [{ label: '全部 ' + items.length + ' 条', items }];
    const work = [];
    const personal = [];
    const other = [];
    items.forEach((it) => {
      const t = ((it.platform || '') + (it.account || '')).toLowerCase();
      if (/work|corp|企业|公司|shop|店/.test(t)) work.push(it);
      else if (/life|me|main|个人|生活|主号/.test(t)) personal.push(it);
      else other.push(it);
    });
    const out = [];
    if (work.length) out.push({ label: '工作 / 店铺', items: work });
    if (personal.length) out.push({ label: '个人', items: personal });
    if (other.length) out.push({ label: '其他', items: other });
    return out;
  },

  /** 抽屉顶部位置 = 信息栏底部（保证头像与容量不被遮挡） */
  _updateDrawerTop() {
    const query = this.createSelectorQuery();
    query.select('.infobar').boundingClientRect();
    query.exec((res) => {
      const rect = res && res[0];
      if (rect && rect.bottom) this.setData({ drawerTop: Math.round(rect.bottom) });
    });
  },

  onToggleDrawer() {
    this._updateDrawerTop();
    this.setData({ drawerOpen: !this.data.drawerOpen });
  },

  onCloseDrawer() {
    this.setData({ drawerOpen: false });
  },

  onDrawerNoop() {},

  onSelectGroup(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ currentGroup: key, drawerOpen: false }, () => this.applySearch());
  },

  onToggleGroup(e) {
    const key = e.currentTarget.dataset.key;
    const map = Object.assign({}, this.data.groupCollapsed);
    map[key] = !map[key];
    this.setData({ groupCollapsed: map }, () => this._buildGroups(this.data.filteredPasswords));
  },

  /** 行尾「···」：轻量操作，重操作仍走详情页 */
  onRowMore(e) {
    const item = e.currentTarget.dataset.item || {};
    const list = ['复制账号', '查看详情', '删除'];
    wx.showActionSheet({
      itemList: list,
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.setClipboardData({
            data: item.account || '',
            fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
          });
        } else if (res.tapIndex === 1) {
          this._openItem(item);
        } else if (res.tapIndex === 2) {
          this._confirmDelete(item);
        }
      },
      fail: () => {},
    });
  },

  _openItem(item) {
    if (!item || !item.id) return;
    wx.navigateTo({ url: '/pages/add/add?id=' + encodeURIComponent(item.id) });
  },

  _confirmDelete(item) {
    if (!item || !item.id) return;
    wx.showModal({
      title: '删除这条密码？',
      content: item.platform || '',
      confirmText: '删除',
      confirmColor: '#E64340',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await storage.deletePassword(item.id);
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadData();
        } catch (error) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },

  /** 编辑分组：改名 / 排序 / 隐藏（v1 用 actionSheet + 逐项操作，不做拖拽） */
  onOpenGroupEditor() {
    this.setData({ drawerOpen: false });
    wx.showActionSheet({
      itemList: ['重命名分组', '调整分组顺序', '隐藏分组'],
      success: (res) => {
        if (res.tapIndex === 0) this._renameGroup();
        else if (res.tapIndex === 1) this._reorderGroup();
        else this._hideGroup();
      },
      fail: () => {},
    });
  },

  _renameGroup() {
    const groups = this.data.drawerGroups || [];
    if (!groups.length) return;
    wx.showActionSheet({
      itemList: groups.map((g) => g.label),
      success: (res) => {
        const target = groups[res.tapIndex];
        if (!target) return;
        wx.showModal({
          title: '重命名分组',
          editable: true,
          placeholderText: target.label,
          success: (r) => {
            const name = (r.content || '').trim();
            if (!r.confirm || !name) return;
            const names = Object.assign({}, storage.get(GROUP_NAMES_KEY) || {});
            names[target.key] = name;
            storage.set(GROUP_NAMES_KEY, names);
            this.applySearch();
            wx.showToast({ title: '已重命名', icon: 'none' });
          },
        });
      },
      fail: () => {},
    });
  },

  _reorderGroup() {
    const groups = this.data.drawerGroups || [];
    if (groups.length < 2) {
      wx.showToast({ title: '分组不足 2 个', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: groups.map((g) => '置顶：' + g.label),
      success: (res) => {
        const target = groups[res.tapIndex];
        if (!target) return;
        const rest = groups.filter((g) => g.key !== target.key).map((g) => g.key);
        storage.set(GROUP_ORDER_KEY, [target.key].concat(rest));
        this.applySearch();
        wx.showToast({ title: '已置顶', icon: 'none' });
      },
      fail: () => {},
    });
  },

  _hideGroup() {
    const groups = this.data.drawerGroups || [];
    if (!groups.length) return;
    wx.showActionSheet({
      itemList: groups.map((g) => '隐藏：' + g.label),
      success: (res) => {
        const target = groups[res.tapIndex];
        if (!target) return;
        const hidden = Object.assign({}, storage.get(GROUP_HIDDEN_KEY) || {});
        hidden[target.key] = true;
        storage.set(GROUP_HIDDEN_KEY, hidden);
        if (this.data.currentGroup === target.key) this.setData({ currentGroup: '全部' });
        this.applySearch();
        wx.showToast({ title: '已隐藏（可在编辑分组恢复）', icon: 'none' });
      },
      fail: () => {},
    });
  },

  onPasswordTap(e) {
    const item = e.currentTarget.dataset.item;
    if (item && item.id) {
      wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id });
    }
  },

  onPasswordLongPress(e) {
    const item = e.currentTarget.dataset.item;
    if (!item) return;

    wx.showActionSheet({
      itemList: [item.pinned ? '取消置顶' : '置顶', '删除'],
      success: async (res) => {
        switch (res.tapIndex) {
          case 0:
            try {
              const result = await storage.togglePin(item.id, app.globalData.masterKey);
              if (!result) {
                wx.showToast({ title: '置顶失败，请重试', icon: 'none' });
                return;
              }
              await this.loadData();
            } catch (error) {
              wx.showToast({ title: '置顶失败，请重试', icon: 'none' });
            }
            break;
          case 1:
            wx.showModal({
              title: '确认删除',
              content: '确定要删除「' + item.platform + '」吗？',
              success: async (modalRes) => {
                if (modalRes.confirm) {
                  try {
                    const deleted = await storage.deletePassword(item.id, app.globalData.masterKey);
                    if (!deleted) {
                      wx.showToast({ title: '删除失败，请重试', icon: 'none' });
                      return;
                    }
                    wx.showToast({ title: '已删除', icon: 'success' });
                    await this.loadData();
                  } catch (error) {
                    wx.showToast({ title: '删除失败，请重试', icon: 'none' });
                  }
                }
              }
            });
            break;
        }
      }
    });
  },

  /**
   * 新增入口：容量拦截（PRD：仅触达上限时弹出，无主动骚扰）
   */
  onAdd() {
    const check = member.canAdd(this.data.usedCount);
    if (check.allowed) {
      wx.navigateTo({ url: '/pages/add/add' });
      return;
    }

    const ent = member.getUserEntitlement();
    const canInvite = ent.inviteCapacity < 20; // 免费邀请额度未满，可继续邀请扩容

    wx.showModal({
      title: '容量已满',
      content: canInvite
        ? '你的容量已用完。邀请好友双方各得 5 条永久容量（最多邀请 3 人），也可以开通年度会员获得 500 条容量（已购与邀请容量继续叠加）。'
        : '你的容量已用完。开通年度会员可获得 500 条容量（已购与邀请容量继续叠加），已存内容不受影响。',
      cancelText: canInvite ? '邀请好友' : '暂不',
      confirmText: '升级会员',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/member/member' });
        } else if (res.cancel && canInvite) {
          this.goInvite();
        }
      },
    });
  },

  /** 邀请好友扩容：转发带邀请码 */
  goInvite() {
    const inviteCode = app.globalData.inviteCode
      || (app.globalData.userInfo && app.globalData.userInfo.invite_code)
      || storage.get('invite_code') || '';
    if (!inviteCode) {
      wx.showToast({ title: '邀请码获取中，请稍后再试', icon: 'none' });
      return;
    }
    // 分享面板需通过右上角菜单或 button open-type=share 触发，这里提示用户
    wx.showToast({ title: '请点右上角「...」转发给好友', icon: 'none', duration: 2500 });
  },

  /** 跳转会员页 */
  goMember() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  /** 分享（携带邀请码） */
  onShareAppMessage() {
    // 转发面板与后续跳转聊天会切出小程序，临时豁免锁定
    if (app && typeof app.holdUnlocked === 'function') app.holdUnlocked();
    const inviteCode = app.globalData.inviteCode
      || (app.globalData.userInfo && app.globalData.userInfo.invite_code)
      || storage.get('invite_code') || '';
    return {
      title: '帮我点一下，密码本容量翻倍',
      path: '/pages/index/index?invite_code=' + inviteCode,
    };
  }
});
