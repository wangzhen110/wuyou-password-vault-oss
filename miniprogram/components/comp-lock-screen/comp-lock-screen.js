// comp-lock-screen V4.0 - 品牌质感升级 + 方法对齐
const storage = require('../../utils/storage');
const demoMode = require('../../utils/demo-mode');
const diagnostics = require('../../utils/diagnostics');

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 15 * 60;

Component({
  properties: {
    // 主密码提示（lock 页从 user_info.master_hint 传入，空串则不显示入口）
    hint: {
      type: String,
      value: ''
    },
    visible: {
      type: Boolean,
      value: true
    },
    // 主题类：'theme-dark' | 'theme-light'（页面按系统/用户设置传入，随 onThemeChange 实时更新）
    themeClass: {
      type: String,
      value: 'theme-dark'
    }
  },

  data: {
    showHint: false,
    password: '',
    confirmPassword: '',
    inviteCode: '',      // 首次注册可选邀请码
    errorMsg: '',
    shake: false,
    isFirstUse: false,
    recoveryMode: false,
    // 首次设置：主密码与确认密码同屏，一次提交（step 字段已废弃）
    attemptCount: 0,
    locked: false,
    lockoutRemain: '',
    showPwd: false,
    showConfirmPwd: false,
    inputFocused: false,
    canSubmit: false,
    submitting: false,
    // 解锁过程可观测性（2026-10-25 iOS 卡「解锁中」排查）：
    // 分阶段文案 + 已用秒数 + 停滞提示，把黑盒变成用户能复述的事实
    unlockStage: '',
    unlockPct: 0,
    unlockElapsed: 0,
    unlockStalled: false,
    userAvatar: '',      // 已设置的头像：解锁时显示，直观确认"解锁的是我的库"
    brandTop: 96,        // 品牌行 top（px）：与胶囊对齐后略低，attached 时按真实坐标覆盖
  },

  lifetimes: {
    attached() {
      const isFirst = !storage.hasMasterPassword();
      const attemptCount = wx.getStorageSync('_attempt_count') || 0;
      const lockoutUntil = wx.getStorageSync('_lockout_until') || 0;
      const now = Date.now();
      let locked = false;

      if (lockoutUntil > now) {
        locked = true;
        this._startLockoutTimer(lockoutUntil);
      }

      // 品牌行垂直位置：与右上角胶囊按钮对齐后略低一点（用胶囊真实坐标，各机型一致）
      let brandTop = 96;
      try {
        const rect = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
        if (rect && rect.bottom) brandTop = rect.bottom + 8;
      } catch (e) { /* 取不到胶囊坐标时用兜底值 */ }

      // 被邀请进入：首次设置时回填邀请码。
      // 优先取本次进入小程序的场景参数（分享卡片 query，冷/热启动都可靠），
      // 其次取首页转存的 pending_invite_code。
      let inviteCode = '';
      if (isFirst) {
        try {
          let fromEnter = '';
          if (typeof wx.getEnterOptionsSync === 'function') {
            const enter = wx.getEnterOptionsSync();
            fromEnter = enter && enter.query && enter.query.invite_code ? enter.query.invite_code : '';
          }
          const pending = storage.get('pending_invite_code');
          inviteCode = String(fromEnter || pending || '').trim();
        } catch (e) { /* 无待用邀请码时保持空 */ }
      }

      // 已设置过头像的用户：锁屏顶部显示头像替代锁图标
      let userAvatar = '';
      try {
        const user = storage.get('user_info') || {};
        if (user && typeof user.avatar_file_id === 'string' && user.avatar_file_id) {
          userAvatar = user.avatar_file_id;
        }
      } catch (e) { /* 用户信息缺失时回退锁图标 */ }

      this.setData({
        isFirstUse: isFirst,
        attemptCount,
        locked,
        userAvatar,
        brandTop,
        inviteCode,
      });

    }
  },

  methods: {
    /** 解锁模式：显示/隐藏主密码提示 */
    onToggleHint() {
      this.setData({ showHint: !this.data.showHint });
    },


    /** 换设备恢复模式：云端有密码库而本地没有，要求输入原主密码 */
    setRecoveryMode(remoteMeta) {
      this._recoveryMeta = remoteMeta || null;
      this.setData({ isFirstUse: false, recoveryMode: true });
    },

    _startLockoutTimer(lockoutUntil) {
      const timer = setInterval(() => {
        const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
        if (remaining <= 0) {
          clearInterval(timer);
          this.setData({
            locked: false,
            lockoutRemain: '',
            attemptCount: 0,
          });
          wx.setStorageSync('_attempt_count', 0);
          wx.setStorageSync('_lockout_until', 0);
        } else {
          const min = Math.floor(remaining / 60);
          const sec = remaining % 60;
          this.setData({ lockoutRemain: min + '分' + (sec > 0 ? sec + '秒' : '') });
        }
      }, 1000);
      this._lockoutTimer = timer;
    },

    _updateCanSubmit() {
      const { password, isFirstUse, confirmPassword } = this.data;
      let can = false;
      if (this.data.submitting) {
        can = false;
      } else if (isFirstUse) {
        can = password.length >= 6 && confirmPassword.length >= 6;
      } else {
        can = password.length >= 6 && !this.data.locked;
      }
      this.setData({ canSubmit: can });
    },

    /** 首次注册强度计算：与 createVaultMeta 规则一致（8 位；12 位以下须字母+数字） */
    _pwdStrength(pw) {
      if (typeof pw !== 'string' || pw.length < 8) return 0;
      const hasAlpha = /[A-Za-z]/.test(pw);
      const hasDigit = /[0-9]/.test(pw);
      if (pw.length < 12 && (!hasAlpha || !hasDigit)) return 0;
      return pw.length >= 12 ? 2 : 1;
    },

    onInput(e) {
      const value = e && e.detail ? e.detail.value : '';
      if (this.data.isFirstUse) {
        this.setData({ pwdStrength: this._pwdStrength(value) });
      }

      this.setData({ password: e.detail.value, errorMsg: '' }, () => this._updateCanSubmit());
    },

    onConfirmInput(e) {
      this.setData({ confirmPassword: e.detail.value, errorMsg: '' }, () => this._updateCanSubmit());
    },

    onInviteInput(e) {
      this.setData({ inviteCode: e.detail.value });
    },

    /** 首次注册带邀请码时，完善资料后由 profile-edit 页透传到主页 verify_invite 链路自动绑定 */
    _buildPostSetupUrl() {
      const code = (this.data.inviteCode || '').trim();
      // 首次注册先引导完善个人资料（头像昵称，可跳过），再进主页
      return '/pages/profile-edit/profile-edit?first=1' + (code ? '&invite_code=' + encodeURIComponent(code) : '');
    },

    onFocus() {
      this.setData({ inputFocused: true });
    },

    onBlur() {
      this.setData({ inputFocused: false });
    },

    onToggleShow() {
      this.setData({ showPwd: !this.data.showPwd });
    },

    /** 进入演示模式：不校验主密码，只读示例数据，重启自动退出 */
    onEnterDemo() {
      if (this.data.submitting) return;
      demoMode.enter();
      wx.reLaunch({ url: '/pages/index/index' });
    },

    onToggleConfirmShow() {
      this.setData({ showConfirmPwd: !this.data.showConfirmPwd });
    },

    async onSubmit() {
      // 已经解锁过（上次跳转失败）：直接再次跳转，不重复跑 KDF
      if (this._unlockedTarget) {
        this._goHomeAfterUnlock(this._unlockedTarget);
        return;
      }
      if (!this.data.canSubmit || this.data.locked || this.data.submitting) return;

      const { password, isFirstUse, confirmPassword } = this.data;
      const app = getApp();
      const initialIdentity = app.globalData.verifiedOpenid || app.globalData.openid || null;
      const initialLoginRequestId = app._loginRequestId || 0;

      if (password.length < 6) {
        this._showError('主密码至少6位');
        return;
      }

      if (isFirstUse) {
        // 两个输入框同屏展示，一次校验后直接提交（不再分步，避免"填完还被要求再输一次"）
        if (password !== confirmPassword) {
          this._showError('两次输入的密码不一致，请检查');
          return;
        }
      }

      this.setData({ submitting: true, canSubmit: false });
      this._beginUnlockProgress();
      diagnostics.stage('unlock_start', { firstUse: !!isFirstUse, recovery: !!this._recoveryMeta });
      // 解锁耗时打点（KDF 60 万次在低端机是主要成本，用真机数据代替猜测）
      const perf = typeof wx.getPerformance === 'function' ? wx.getPerformance() : null;
      const startedAt = perf && typeof perf.now === 'function' ? perf.now() : Date.now();
      let unlocked = false;
      try {
        let result;
        try {
          // 恢复模式：用云端元数据校验原主密码（校验通过后元数据会写入本地）
          const remoteMeta = (!isFirstUse && this._recoveryMeta) ? this._recoveryMeta : undefined;
          result = isFirstUse
            ? await storage.setMasterPassword(password)
            : await storage.verifyMasterPassword(password, remoteMeta, {
                onProgress: (ratio) => this._onKdfProgress(ratio),
              });
        } catch (error) {
          diagnostics.error('unlock_threw', {
            firstUse: !!isFirstUse,
            name: String((error && error.name) || 'Error'),
            msg: String((error && error.message) || 'unknown'),
          });
          this._showError(isFirstUse ? '设置失败，请重试' : '验证失败，请重试');
          return;
        }

        const finishedAt = perf && typeof perf.now === 'function' ? perf.now() : Date.now();
        const elapsedMs = Math.round(finishedAt - startedAt);
        app.globalData.lastUnlockMs = elapsedMs;
        console.log('[unlock] KDF+校验耗时 ' + elapsedMs + 'ms');
        diagnostics.stage('unlock_derived', {
          ms: elapsedMs,
          firstUse: !!isFirstUse,
          ok: !!(result && result.success),
        });

        if (isFirstUse) {
          if (!result || !result.success || !result.masterKey) {
            this._showError(this._getResultError(result, '设置失败，请重试'));
            return;
          }
          if (initialIdentity && (app.globalData.verifiedOpenid !== initialIdentity
              || app.globalData.openid !== initialIdentity
              || app._loginRequestId !== initialLoginRequestId)) {
            this._showError('登录状态已变化，请重新设置');
            return;
          }
        } else if (result && result.success && result.masterKey) {
          if (initialIdentity && (app.globalData.verifiedOpenid !== initialIdentity
              || app.globalData.openid !== initialIdentity
              || app._loginRequestId !== initialLoginRequestId)) {
            this._showError('登录状态已变化，请重新解锁');
            return;
          }
          wx.setStorageSync('_attempt_count', 0);
          app.globalData.isLocked = false;
          app.globalData.masterKey = result.masterKey;
          storage.set('last_active', Date.now());
          storage.setLockState(false);
          unlocked = true;
          this._startPendingSyncRecovery(app);
          this._unlockedTarget = '/pages/index/index';
          this._goHomeAfterUnlock(this._unlockedTarget);
        } else {
          const operationError = this._getResultError(result, '');
          if (operationError) {
            this._showError(operationError);
            return;
          }
          const newCount = this.data.attemptCount + 1;
          wx.setStorageSync('_attempt_count', newCount);
          this.setData({ attemptCount: newCount });

          if (newCount >= MAX_ATTEMPTS) {
            const lockoutUntil = Date.now() + LOCKOUT_SECONDS * 1000;
            wx.setStorageSync('_lockout_until', lockoutUntil);
            this.setData({ locked: true });
            this._startLockoutTimer(lockoutUntil);
            this._showError('已锁定，请15分钟后重试');
          } else {
            this._showError('密码错误，还剩' + (MAX_ATTEMPTS - newCount) + '次机会');
          }
        }

        if (isFirstUse) {
          wx.setStorageSync('_attempt_count', 0);
          const app = getApp();
          app.globalData.isLocked = false;
          app.globalData.masterKey = result.masterKey;
          storage.set('last_active', Date.now());
          storage.setLockState(false);
          unlocked = true;
          this._startPendingSyncRecovery(app);
          this._unlockedTarget = this._buildPostSetupUrl();
          this._goHomeAfterUnlock(this._unlockedTarget);
        }
      } finally {
        this._endUnlockProgress();
        if (!unlocked) {
          this.setData({ submitting: false }, () => this._updateCanSubmit());
        }
      }
    },

    /**
     * 解锁过程打点（2026-10-25）：iOS 用户报告卡在「解锁中」无法进入。
     * 无真机日志时无法定位，故把过程显式化：阶段文案 + 已用秒数 + 20 秒停滞提示 + 重试出口。
     */
    /**
     * 解锁成功后跳首页（2026-10-25 iOS 卡「解密中」修复）。
     * 原实现成功后 unlocked=true，finally 便不再复位 submitting；
     * 一旦 wx.reLaunch 失败（iOS 键盘收起瞬间跳转存在失败可能，且是静默失败），
     * 按钮会永久停在「解密中」，用户彻底卡死。
     * 三条保险：① reLaunch 显式 fail 回调；② 1.5s 看门狗；③ 失败后可再次点击直接进入（不重复解密）。
     */
    _goHomeAfterUnlock(url) {
      const target = url || '/pages/index/index';
      const recover = () => {
        if (this._wentHome) return;
        this._wentHome = true;
        diagnostics.warn('unlock_nav_fail', { target: target, afterMs: Date.now() - (this._unlockNavAt || Date.now()) });
        this.setData({
          submitting: false,
          errorMsg: '已解锁，页面跳转未成功，请再点一次进入',
        }, () => this._updateCanSubmit());
      };
      this._unlockNavAt = Date.now();
      setTimeout(() => {
        wx.reLaunch({
          url: target,
          success: () => {
            this._wentHome = true;
            diagnostics.stage('unlock_nav_ok', { target: target, ms: Date.now() - (this._unlockNavAt || Date.now()) });
          },
          fail: (err) => {
            diagnostics.error('unlock_nav_error', { errMsg: String((err && err.errMsg) || 'unknown') });
            recover();
          },
        });
      }, 200);
      // 看门狗：成功跳转后本组件会被销毁；若 1.5s 后仍未标记完成，判定跳转失败
      setTimeout(() => { if (!this._wentHome) recover(); }, 1500);
    },

    _beginUnlockProgress() {
      this._unlockStartedAt = Date.now();
      this.setData({ unlockStage: '正在解密…', unlockPct: 0, unlockElapsed: 0, unlockStalled: false });
      if (this._unlockTimer) clearInterval(this._unlockTimer);
      this._unlockTimer = setInterval(() => {
        const sec = Math.round((Date.now() - (this._unlockStartedAt || Date.now())) / 1000);
        const patch = { unlockElapsed: sec };
        // 20 秒仍未完成：提示用户并暴露「重试」出口，避免无限等待
        if (sec >= 20 && !this.data.unlockStalled) patch.unlockStalled = true;
        this.setData(patch);
      }, 1000);
    },

    /** KDF 进度回调：每前进 10% 才 setData，避免高频渲染 */
    _onKdfProgress(ratio) {
      const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
      if (pct === 100 || pct - (this.data.unlockPct || 0) >= 10) {
        this.setData({ unlockPct: pct });
      }
    },

    _endUnlockProgress() {
      if (this._unlockTimer) {
        clearInterval(this._unlockTimer);
        this._unlockTimer = null;
      }
      if (this.data.unlockStage || this.data.unlockElapsed || this.data.unlockStalled) {
        this.setData({ unlockStage: '', unlockPct: 0, unlockElapsed: 0, unlockStalled: false });
      }
    },

    /** 停滞时的逃生出口：复位提交态，允许重新输入/重试 */
    onRetryUnlock() {
      this._endUnlockProgress();
      this.setData({ submitting: false, errorMsg: '' }, () => this._updateCanSubmit());
    },

    _startPendingSyncRecovery(app) {
      if (!app || !app.globalData || !app.globalData.syncBindingPending
          || typeof app._resumeVaultBinding !== 'function') return;
      app._resumeVaultBinding().catch(() => undefined);
    },

    _getResultError(result, fallback) {
      if (result && typeof result.error === 'string' && result.error.trim()) {
        return result.error;
      }
      const failedIds = result
        && result.migration
        && Array.isArray(result.migration.failed_ids)
        ? result.migration.failed_ids
        : [];
      return failedIds.length ? '旧数据迁移未完成，请重试' : fallback;
    },

    _showError(msg) {
      this.setData({ errorMsg: msg, shake: true });
      setTimeout(() => this.setData({ shake: false }), 500);
    }
  },

  detached() {
    if (this._lockoutTimer) clearInterval(this._lockoutTimer);
  }
});
