const storage = require('./utils/storage');
const theme = require('./styles/theme');
const sync = require('./utils/sync');
const demoMode = require('./utils/demo-mode');
const diagnostics = require('./utils/diagnostics');

const LOGIN_TIMEOUT_MS = 15000;
// 离线后的自动重连间隔（与首页红灯呼吸节奏配合）
const RECONNECT_INTERVAL_MS = 8000;
const RECONNECT_MAX_INTERVAL_MS = 30000;
// 前台定时一致性检测间隔（云端 vs 本地：加密参数 + 条目统计）
const CONSISTENCY_INTERVAL_MS = 5 * 60 * 1000;
const LOGIN_START_DELAY_MS = 120;

App({
  globalData: {
    isLocked: true,
    masterKey: null,
    theme: 'dark',
    fontSize: 'normal',
    isFirstUse: false,
    openid: null,           // 本次云登录确认的用户 OpenID
    verifiedOpenid: null,
    syncAllowed: false,
    syncBindingPending: false,
    userInfo: null,         // 用户信息（容量、会员等）
    totalCapacity: 30,      // 总容量
    offlineMode: false,     // 离线模式（云不可达，本地优先）
  },

  /**
   * 诊断初始化（2026-10-25）
   * 上报冷启动环境 + 接管全局错误/未捕获 Promise。
   * 实时日志查看：公众平台 → 开发管理 → 运维中心 → 实时日志（filterMsg = wuyou-vault）
   * 安全：只上报元数据，敏感字段由 utils/diagnostics 统一脱敏（不上报密码/密文/token）。
   */
  _initDiagnostics() {
    try {
      diagnostics.init();
    } catch (error) { /* 诊断绝不阻塞启动 */ }

    try {
      if (typeof wx.onError === 'function') {
        wx.onError((err) => {
          try {
            diagnostics.error('app_error', {
              msg: String((err && (err.message || err.errMsg)) || err || 'unknown'),
              stack: String((err && err.stack) || '').slice(0, 120),
            });
          } catch (e) { /* 忽略 */ }
        });
      }
    } catch (error) { /* 低版本基础库无此 API */ }

    try {
      if (typeof wx.onUnhandledRejection === 'function') {
        wx.onUnhandledRejection((res) => {
          try {
            const reason = res && res.reason;
            diagnostics.error('unhandled_rejection', {
              msg: String((reason && (reason.message || reason.errMsg)) || reason || 'unknown'),
            });
          } catch (e) { /* 忽略 */ }
        });
      }
    } catch (error) { /* 低版本基础库无此 API */ }
  },

  /**
   * 主动检查小程序更新（官方 wx.getUpdateManager）
   * - onUpdateReady：新包已下载完 → 弹窗让用户重启立即生效
   * - onUpdateFailed：下载失败 → 静默，下次冷启动会重试
   */
  _checkUpdate() {
    try {
      if (typeof wx.getUpdateManager !== 'function') return;
      const um = wx.getUpdateManager();
      um.onUpdateReady(() => {
        wx.showModal({
          title: '发现新版本',
          content: '新版本已准备好，重启后即可使用。',
          confirmText: '立即重启',
          cancelText: '稍后',
          success: (res) => {
            if (res.confirm) um.applyUpdate();
          },
        });
      });
      um.onUpdateFailed(() => {
        // 静默失败：网络等原因，下次冷启动微信会重试
      });
    } catch (e) { /* 低版本基础库不支持，忽略 */ }
  },

  onLaunch() {
    // 诊断：冷启动上报一次环境（机型/系统/基础库），并接管全局错误与未捕获 Promise。
    // 目的：没有真机也能观测线上问题（2026-10-25 iOS 解锁卡死暴露的短板）。
    this._initDiagnostics();

    // 小程序版本更新检测（2026-10-24 加）：微信默认只在冷启动异步下载新包，
    // 下载完要等「下一次冷启动」才生效，用户完全无感知——发版后常出现
    // 「后台已发布但用户还是旧版」。这里主动提示并让用户立即重启应用新版本。
    this._checkUpdate();

    try {
      wx.removeStorageSync('master_key_cache');
      wx.removeStorageSync('pwd_master_key_cache');
      wx.removeStorageSync('_biometric_enabled');
    } catch (error) {
      console.warn('[security] 清理旧版密钥缓存失败');
    }

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({ env: 'your-cloud-env-id', traceUser: true });
    }

    // 网络状态监听：真断网才亮红灯；网络恢复立即重连，不必等退避间隔
    this.globalData.networkConnected = true;
    if (typeof wx.getNetworkType === 'function') {
      wx.getNetworkType({
        success: (res) => {
          const connected = res.networkType !== 'none';
          this.globalData.networkConnected = connected;
        },
      });
    }
    if (typeof wx.onNetworkStatusChange === 'function') {
      wx.onNetworkStatusChange((res) => {
        const connected = !!res.isConnected;
        this.globalData.networkConnected = connected;
        if (connected) {
          console.log('[network] 网络已恢复，立即重连');
          this._clearReconnectTimer();
          this._reconnectAttempts = 0;
          if (this.globalData.offlineMode) this._login();
        } else {
          console.warn('[network] 网络已断开');
          this.setOfflineMode(true);
        }
        this._notifyNetworkPages();
      });
    }

    const savedTheme = theme.getTheme();
    this.globalData.theme = savedTheme;

    // 系统主题切换实时跟随（需 app.json darkmode:true 才会触发）
    // 仅在用户主题为"跟随系统"时刷新：更新所有在栈页面的 themeClass 并同步自定义 tabBar
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        if (!res || !res.theme) return;
        if (theme.getTheme() !== 'auto') return;
        const pages = getCurrentPages() || [];
        pages.forEach((page) => {
          if (!page || typeof page.setData !== 'function') return;
          if (page.data && page.data.themeClass !== undefined) {
            page.setData({ themeClass: theme.getThemeClass(res.theme) });
          }
          if (typeof page.getTabBar === 'function') {
            const tabBar = page.getTabBar();
            if (tabBar && typeof tabBar.refreshTheme === 'function') tabBar.refreshTheme();
          }
        });
      });
    }

    this.globalData.totalCapacity = 30;
    this._checkLock();

    // 先让锁屏页完成首屏渲染，再后台确认云身份，避免网络请求拖慢扫码进入。
    setTimeout(() => this._login(), LOGIN_START_DELAY_MS);

    // 全局返回键适配
    wx.onBackPress && wx.onBackPress(() => {
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      if (currentPage && currentPage.route === 'pages/lock/lock') {
        return false;
      }
      if (currentPage && currentPage.route !== 'pages/index/index') {
        wx.reLaunch({ url: '/pages/index/index' });
        return true;
      }
      return false;
    });
  },

  onShow(options) {
    // 分享卡片进入（冷启动走 onLaunch/页面 onLoad，热启动只有这里能拿到 query）：
    // 转存邀请码，供首页/锁屏消费绑定
    try {
      const code = options && options.query && options.query.invite_code;
      if (code && typeof code === 'string') {
        storage.set('pending_invite_code', code);
      }
    } catch (error) {
      console.warn('[invite] 转存邀请码失败');
    }

    // 每次回到前台都重新检查锁定超时（后台超过 lock_timeout 自动上锁）
    this._checkLock();
    // 回到前台后安排一次云端/本地一致性检测（已解锁才执行）
    this._scheduleConsistencyCheck(1500);

    if (this.globalData.isLocked && !demoMode.isActive()) {
      // 从缓存恢复容量（不能粗暴重置成 30，否则会员容量显示错）
      this.globalData.totalCapacity = storage.get('total_capacity') || 30;
      // 当前不在锁屏页才跳转（冷启动入口本身就是锁屏页，无需跳）
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      if (current && current.route !== 'pages/lock/lock') {
        wx.reLaunch({ url: '/pages/lock/lock' });
      }
      return;
    }

    storage.set('last_active', Date.now());
    this._startActiveTimer();
    this._startSyncTimer();
    // 回到前台：距上次自动同步满 1 小时才同步（避免频繁请求）
    sync.intervalSync()
      .then(result => {
        if (result && result.skipped) return;
        if (result && result.success) this.setOfflineMode(false);
        else if (result && result.success === false) this.setOfflineMode(true);
      })
      .catch(() => this.setOfflineMode(true));
  },

  /**
   * 临时豁免「切后台立即锁定」（2026-10-24）
   * 用于预期内的后台跳转：分享转发、图片预览保存、选文件、支付等。
   * @param {number} [ms=60000] 豁免时长，到期自动恢复锁定策略
   */
  holdUnlocked(ms) {
    try {
      this.globalData.keepUnlocked = true;
      clearTimeout(this._keepUnlockedTimer);
      this._keepUnlockedTimer = setTimeout(() => {
        try { this.globalData.keepUnlocked = false; } catch (e) { /* 忽略 */ }
      }, ms || 60000);
    } catch (e) { /* 忽略 */ }
  },

  onHide() {
    this._stopActiveTimer();
    this._stopSyncTimer();
    this._clearConsistencyTimer();

    // 安全策略（2026-10-24 用户要求）：切到后台立即锁定并清空内存密钥，
    // 回来必须重新输入主密码。
    // 例外：keepUnlocked 标记为真时跳过锁定——用于「预期内的后台跳转」：
    //   支付（拉起微信支付）、导入备份（chooseMessageFile 选文件）等，
    //   这些场景若被锁会直接打断用户正在完成的流程。
    if (!this.globalData.keepUnlocked && !demoMode.isActive()) {
      this.globalData.isLocked = true;
      this.globalData.masterKey = null;
    }
  },

  /** 缓存身份只作提示；每次启动都必须等待本次云登录确认。 */
  _login() {
    this._loginRequestId = (this._loginRequestId || 0) + 1;
    this.globalData.openid = null;
    this.globalData.verifiedOpenid = null;
    this.globalData.syncAllowed = false;
    this.globalData.syncBindingPending = false;
    this._silentRefresh(this._loginRequestId);
  },

  _silentRefresh(requestId = this._loginRequestId) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      if (requestId === this._loginRequestId) this._handleLoginFailure();
      return;
    }

    const timeoutMs = Number(this._loginTimeoutMs) > 0
      ? Number(this._loginTimeoutMs)
      : LOGIN_TIMEOUT_MS;
    let settled = false;
    let timer = null;
    const finish = (handler) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (requestId !== this._loginRequestId) return;
      handler();
    };

    timer = setTimeout(() => {
      finish(() => {
        // 首次超时不直接降级：自动重试一次，避免冷启动/弱网误判为离线
        if (!this._loginRetriedOnce) {
          this._loginRetriedOnce = true;
          console.warn('[login] 首次超时，自动重试一次');
          this._login();
          return;
        }
        console.warn('[login] 请求超时，进入离线模式');
        this._handleLoginFailure();
      });
    }, timeoutMs);

    wx.cloud.callFunction({
      name: 'login',
      success: (res) => {
        finish(() => {
          const result = res && res.result;
          const openid = result && result.openid;
          if (!result || !result.success || typeof openid !== 'string' || !openid.trim()) {
            console.error('[login] 失败:', result && result.error);
            this._handleLoginFailure();
            return;
          }

          const { capacity, is_new_user, user, invite_code } = result;
          // 云端判定为全新账号，但本地还有旧密码库/旧身份残留 → 自动清理（从零开始）
          if (is_new_user) {
            const info = wx.getStorageInfoSync();
            const staleKeys = (info.keys || []).filter(k =>
              k === 'vault_meta' || k.indexOf('pwd_') === 0 || k === 'openid' || k === 'sync_owner');
            if (staleKeys.length > 0) {
              console.error('[stale] 云端全新账号但本地存在旧残留，自动清理:', staleKeys.join(','));
              this._purgeLocalStale();
              return; // 清理后 reLaunch 重走启动，不再继续本次登录写入
            }
          }
          const identity = storage.confirmLoginIdentity(openid);
          this.globalData.openid = openid;
          this.globalData.verifiedOpenid = openid;
          this.globalData.syncAllowed = identity.allowed;
          this.globalData.syncBindingPending = identity.reason === 'owner_unknown';
          // 记录同步时间：权益属于服务端权威数据，离线/过期时前端需明确提示
          user._synced_at = Date.now();
          this.globalData.userInfo = user;
          this.globalData.totalCapacity = capacity || 30;
          this.globalData.inviteCode = invite_code;
          this.globalData.isFirstUse = is_new_user;

          storage.set('user_info', user);
          storage.set('total_capacity', capacity || 30);
          storage.set('invite_code', invite_code);

          if (!identity.allowed) {
            if (this.globalData.syncBindingPending && this.globalData.masterKey
                && !this.globalData.isLocked) {
              this.setOfflineMode(true);
              this._resumeVaultBinding();
              return;
            }
            this.globalData.masterKey = null;
            this.globalData.isLocked = true;
            storage.setLockState(true);
            this.setOfflineMode(true);
            if (identity.newlyBlocked) {
              this._handleAccountSwitch(openid, capacity, user, invite_code);
            }
            return;
          }

          this._clearReconnectTimer();
          this._reconnectAttempts = 0;
          this.setOfflineMode(false);
          console.log('[login] 身份已确认, 容量:', capacity);
          // 每次登录成功强制同步一次（用户 2026-10-24 要求）
          sync.forceSync();
        });
      },
      fail: () => {
        finish(() => this._handleLoginFailure());
      }
    });
  },

  /**
   * 登录失败时撤销本次运行身份，保持离线且禁止同步。
   */
  /**
   * 云端账号全新但本地有旧残留（清库重置/换测试号）→ 自动清理本地旧状态，
   * 保证用户进入全新注册流程（2026-10-23：云端清零后真机旧缓存导致设置失败）。
   * 清理后 reLaunch 重走启动流程，让锁屏页以"首次设置"模式重新渲染。
   */
  _purgeLocalStale() {
    try {
      const info = wx.getStorageInfoSync();
      const PURGE_EXACT = [
        'vault_meta', 'user_info', 'total_capacity', 'invite_code',
        'last_backup', 'last_sync_time', 'master_hash', 'master_salt',
        'master_key_cache', 'pwd_master_key_cache', '_biometric_enabled',
        'pending_invite_code', 'openid', 'sync_owner', 'sync_blocked',
      ];
      let removed = 0;
      (info.keys || []).forEach((k) => {
        if (PURGE_EXACT.includes(k) || k.indexOf('pwd_') === 0 || k.indexOf('identity_') === 0) {
          wx.removeStorageSync(k);
          removed += 1;
        }
      });
      console.error('[stale] 检测到云端全新账号，已自动清理本地旧残留:', removed, '项');
    } catch (e) {
      console.warn('[stale] 清理失败:', e);
      return;
    }
    // 重走启动：锁屏页将检测不到本地密码库，进入"首次设置"模式
    wx.reLaunch({ url: '/pages/lock/lock' });
  },

  _handleLoginFailure() {
    this.globalData.openid = null;
    this.globalData.verifiedOpenid = null;
    this.globalData.syncAllowed = false;
    this.globalData.syncBindingPending = false;
    console.warn('[login] 进入离线模式，数据仅存本机');
    this.setOfflineMode(true);
    this._scheduleReconnect();
  },

  /** 排定下一次一致性检测（前台每 5 分钟；首次延迟由调用方决定） */
  _scheduleConsistencyCheck(delayMs) {
    this._clearConsistencyTimer();
    const timer = setTimeout(() => {
      this._consistencyTimer = null;
      this.runConsistencyCheck().finally(() => {
        if (!this.globalData.offlineMode) this._scheduleConsistencyCheck(CONSISTENCY_INTERVAL_MS);
      });
    }, delayMs === undefined ? CONSISTENCY_INTERVAL_MS : delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._consistencyTimer = timer;
  },

  _clearConsistencyTimer() {
    if (this._consistencyTimer) {
      clearTimeout(this._consistencyTimer);
      this._consistencyTimer = null;
    }
  },

  /**
   * 云端 vs 本地一致性检测：
   * - 一致：静默记录
   * - 云端有新数据 / 本地有待上传：自动 full_sync（双向）并提示
   * - 加密参数不一致（另一设备改过主密码）：弹窗警告，绝不自动覆盖
   */
  async runConsistencyCheck() {
    const g = this.globalData;
    if (!g.verifiedOpenid || g.offlineMode || g.isLocked || !g.masterKey) {
      return { skipped: true };
    }
    if (this._consistencyRunning) return { skipped: true };
    this._consistencyRunning = true;
    try {
      const result = await storage.checkConsistency();
      storage.set('last_consistency', {
        checked_at: result.checkedAt,
        status: result.status,
        local_count: result.localCount,
        remote_count: result.remoteCount,
      });

      if (result.status === 'meta_mismatch') {
        wx.showModal({
          title: '检测到密码库不一致',
          content: '云端与本机的加密参数不一致，可能你在另一台设备上修改过主密码。为避免覆盖，已暂停自动同步。请确认需要保留哪一份，或联系客服处理。',
          showCancel: false,
          confirmText: '知道了',
        });
        return result;
      }

      if (result.status === 'cloud_ahead' || result.status === 'pending_upload') {
        if (this._loginRequestId === 0) return result;
        const syncRes = await storage.syncFromCloud(null, g.masterKey);
        if (syncRes && syncRes.success !== false) {
          wx.showToast({ title: '已同步最新数据', icon: 'none', duration: 2000 });
          storage.set('last_consistency', {
            checked_at: Date.now(),
            status: 'in_sync',
            local_count: result.localCount,
            remote_count: result.remoteCount,
          });
        }
      }
      return result;
    } catch (error) {
      // 检测失败静默（网络抖动常见），不打扰用户；下次定时器会再试
      console.warn('[consistency] 检测失败:', error && error.message ? error.message : error);
      return { skipped: true, error: error && error.message };
    } finally {
      this._consistencyRunning = false;
    }
  },

  /** 离线后按固定间隔自动重连（对应首页红灯的呼吸动画：灯在呼吸=正在重试） */
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    // 真断网时不必空转重试，等网络恢复事件即可
    if (this.globalData.networkConnected === false) {
      console.log('[login] 当前无网络，等待网络恢复后再重连');
      return;
    }
    const attempt = Number(this._reconnectAttempts || 0);
    const delay = Math.min(RECONNECT_INTERVAL_MS * Math.pow(2, attempt), RECONNECT_MAX_INTERVAL_MS);
    this._reconnectAttempts = attempt + 1;

    const timer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.globalData.offlineMode) return;
      this._loginRetriedOnce = false;
      console.log('[login] 离线中，第', attempt + 1, '次自动重连，下次间隔', delay, 'ms');
      this._login();
    }, delay);
    // Node 测试环境下 unref，避免定时器把进程挂住（小程序返回 number，无此方法）
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._reconnectTimer = timer;
  },

  /** 通知页面网络/离线状态变化 */
  _notifyNetworkPages() {
    const pages = getCurrentPages();
    pages.forEach((p) => {
      if (p && typeof p.onNetworkChange === 'function') {
        try { p.onNetworkChange(this.globalData.networkConnected, this.globalData.offlineMode); } catch (e) { /* ignore */ }
      }
    });
  },

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  },

  async _resumeVaultBinding() {
    const openid = this.globalData.verifiedOpenid;
    const masterKey = this.globalData.masterKey;
    const requestId = this._loginRequestId;
    if (!this.globalData.syncBindingPending || !openid || !masterKey || this.globalData.isLocked) {
      return;
    }
    const claim = await storage.claimLocalVaultOwner(
      openid,
      masterKey,
      storage.getLocalVaultMeta(),
    );
    if (requestId !== this._loginRequestId
        || this.globalData.verifiedOpenid !== openid
        || this.globalData.masterKey !== masterKey
        || this.globalData.isLocked) {
      return;
    }
    if (!claim.success) {
      this.setOfflineMode(true);
      return;
    }
    const synced = await storage.syncFromCloud(null, masterKey);
    if (requestId !== this._loginRequestId
        || this.globalData.verifiedOpenid !== openid
        || this.globalData.masterKey !== masterKey
        || this.globalData.isLocked) {
      return;
    }
    this.globalData.syncBindingPending = false;
    this.setOfflineMode(!(synced && synced.success));
  },

  /**
   * 账号切换时保留本地密码库并隔离同步；当前版本不提供迁移流程。
   */
  _handleAccountSwitch(newOpenid, capacity, user, invite_code) {
    this.globalData.masterKey = null;
    this.globalData.isLocked = true;
    this.globalData.syncAllowed = false;
    this.globalData.syncBindingPending = false;
    storage.setLockState(true);
    this.setOfflineMode(true);

    wx.showModal({
      title: '本地密码库同步已隔离',
      content: '当前微信身份与本地密码库归属不一致或无法确认。本机加密数据已保留，可使用原主密码解锁；为避免数据混入其他账号，云同步已停用。本版本不提供安全迁移流程，不会自动迁移。',
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        this.globalData.userInfo = user;
        this.globalData.totalCapacity = capacity || 30;
        this.globalData.inviteCode = invite_code;
        wx.reLaunch({ url: '/pages/lock/lock' });
      }
    });
  },

  /**
   * 离线模式状态切换，通知当前页面刷新横幅
   */
  setOfflineMode(v) {
    if (this.globalData.offlineMode === v) return;
    this.globalData.offlineMode = v;
    const pages = getCurrentPages();
    pages.forEach((p) => {
      if (p && typeof p.onOfflineChange === 'function') {
        try { p.onOfflineChange(v); } catch (e) { /* 页面未实现时忽略 */ }
      }
    });
  },

  /**
   * 加载用户信息（从缓存）
   */
  _loadUserInfo() {
    const userInfo = storage.get('user_info');
    const capacity = storage.get('total_capacity');
    if (userInfo) {
      this.globalData.userInfo = userInfo;
    }
    if (capacity) {
      this.globalData.totalCapacity = capacity;
    }
  },

  /**
   * 刷新用户信息（从云端）
   */
  refreshUserInfo(callback) {
    wx.cloud.callFunction({
      name: 'login',
      success: (res) => {
        if (res.result && res.result.success) {
          const { capacity, user, invite_code } = res.result;
          // 刚从服务端拉回的权益天然新鲜：补同步时间戳，否则 stale 提示
          // 会基于登录时刻的旧时间误报"已超过 10 分钟未同步"（支付到账场景实测）
          user._synced_at = Date.now();
          this.globalData.userInfo = user;
          this.globalData.totalCapacity = capacity;
          this.globalData.inviteCode = invite_code;
          storage.set('user_info', user);
          storage.set('total_capacity', capacity);
          storage.set('invite_code', invite_code);
          if (callback) callback(res.result);
        } else if (callback) {
          callback(null);
        }
      },
      fail: () => {
        if (callback) callback(null);
      }
    });
  },

  _checkLock() {
    const lockTimeout = storage.getLockTimeout();
    const lastActive = storage.get('last_active') || 0;
    const now = Date.now();
    const masterKey = this.globalData.masterKey;
    const hasSessionKey = !!(masterKey && masterKey.encryptionKey && masterKey.macKey);

    if (!hasSessionKey || now - lastActive > lockTimeout * 1000) {
      this.globalData.isLocked = true;
      this.globalData.masterKey = null;
    } else {
      this.globalData.isLocked = false;
    }
  },

  _activeTimer: null,
  _startActiveTimer() {
    this._stopActiveTimer();
    this._activeTimer = setInterval(() => {
      if (!this.globalData.isLocked) {
        storage.set('last_active', Date.now());
      }
    }, 30000);
  },
  _stopActiveTimer() {
    if (this._activeTimer) {
      clearInterval(this._activeTimer);
      this._activeTimer = null;
    }
  },

  /** 前台每小时同步一次（后台会被系统挂起，回到前台由 onShow 的 intervalSync 兜底） */
  _syncTimer: null,
  _startSyncTimer() {
    this._stopSyncTimer();
    this._syncTimer = setInterval(() => {
      if (this.globalData.isLocked) return;
      sync.intervalSync().catch(() => {});
    }, 60 * 60 * 1000);
  },
  _stopSyncTimer() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  },

  lockApp() {
    this.globalData.isLocked = true;
    this.globalData.masterKey = null;
    this._stopActiveTimer();
    storage.setLockState(true);
  },

  unlockApp(masterKey) {
    this.globalData.isLocked = false;
    this.globalData.masterKey = masterKey;
    storage.set('last_active', Date.now());
    storage.setLockState(false);
    this._startActiveTimer();
  },

  switchTheme(newTheme) {
    theme.setTheme(newTheme);
  },
});
