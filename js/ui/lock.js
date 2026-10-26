(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const CASHIER_ROUTES = new Set(['/', '/pos', '/invoices', '/returns', '/products', '/price-check', '/customers']);
  const AWAY_LOCK_MS = 60 * 1000;

  class AppLock {
    constructor() {
      this.selectedProfile = 'owner';
      this.timer = null;
      this.lastActivity = Date.now();
      this.hiddenAt = null;
      this._bound = false;
      this._clockPending = false;
      this._onUnlocked = null;
      this._lockReason = '';
      // Which profile the visible DOM was rendered for. A profile switch must
      // never leave the previous profile's page (or its owner-only numbers) on
      // screen; a same-profile unlock keeps an in-progress invoice intact.
      this._renderedProfile = null;
    }

    bind(options) {
      if (this._bound) return;
      this._bound = true;
      this._onUnlocked = options && options.onUnlocked;
      const submit = document.getElementById('lock-submit');
      const pin = document.getElementById('lock-pin');
      if (submit) submit.addEventListener('click', () => this.submit());
      if (pin) {
        pin.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
        });
      }
      const lockBtn = document.getElementById('header-lock');
      if (lockBtn) {
        lockBtn.addEventListener('click', async () => {
          if (BeeStore.api && BeeStore.api.security) await BeeStore.api.security.lock('قفل يدوي');
          this.show('تم القفل يدوياً');
        });
      }
      const confirm = document.getElementById('clock-confirm');
      if (confirm) confirm.addEventListener('click', () => this.confirmClock());
      const cancel = document.getElementById('clock-cancel');
      if (cancel) cancel.addEventListener('click', async () => {
        const box = document.getElementById('clock-warning');
        if (box) box.style.display = 'none';
        if (BeeStore.api && BeeStore.api.security) await BeeStore.api.security.lock('تحذير الساعة');
        this.show('أكّد تاريخ الهاتف للمتابعة');
      });
      const onActivity = () => this.touch();
      ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((name) => {
        document.addEventListener(name, onActivity, { passive: true });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.hiddenAt = Date.now();
          if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        } else {
          if (this.hiddenAt && Date.now() - this.hiddenAt > AWAY_LOCK_MS &&
            BeeStore.auth && BeeStore.auth.isLocked && !BeeStore.auth.isLocked()) {
            this.lockNow('الغياب عن التطبيق أكثر من دقيقة');
            return;
          }
          this.hiddenAt = null;
          this.touch();
        }
      });
    }

    async start() {
      const state = await BeeStore.api.security.status();
      const data = state.ok ? state.data : { locked: false, configured: false };
      this.applyRoleUI();
      if (data.configured && data.locked) {
        this.show();
        return false;
      }
      this.afterUnlock();
      return true;
    }

    profiles() {
      const box = document.getElementById('lock-profiles');
      if (!box) return [];
      box.innerHTML = '';
      const list = (BeeStore.auth && BeeStore.auth._profiles) || [];
      for (const profile of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lock-profile' + (profile.id === this.selectedProfile ? ' active' : '');
        btn.textContent = profile.name;
        btn.addEventListener('click', () => {
          this.selectedProfile = profile.id;
          this.profiles();
          this.setError('');
          const pin = document.getElementById('lock-pin');
          if (pin) { pin.value = ''; pin.focus(); }
        });
        box.appendChild(btn);
      }
      return list;
    }

    show(reason) {
      this._lockReason = reason || '';
      if (BeeStore.auth && BeeStore.auth._profiles && BeeStore.auth._profiles.length) {
        const ids = BeeStore.auth._profiles.map((p) => p.id);
        if (ids.indexOf(this.selectedProfile) === -1) {
          this.selectedProfile = ids.indexOf('owner') !== -1 ? 'owner' : ids[0];
        }
      }
      this.profiles();
      const sub = document.getElementById('lock-subtitle');
      if (sub) {
        sub.textContent = reason || (this.selectedProfile === 'cashier'
          ? 'ملف الكاشير — أدخل رمز الكاشير'
          : 'اختر الملف وأدخل الرمز السري');
      }
      const screen = document.getElementById('lock-screen');
      if (screen) screen.style.display = 'flex';
      const app = document.getElementById('app');
      if (app) app.style.display = 'none';
      const wizard = document.getElementById('first-run-wizard');
      if (wizard) wizard.style.display = 'none';
      this.stopTimer();
      const pin = document.getElementById('lock-pin');
      if (pin) { pin.value = ''; setTimeout(() => pin.focus(), 80); }
      this.applyRoleUI();
    }

    setError(text) {
      const el = document.getElementById('lock-error');
      if (el) el.textContent = text || '';
    }

    async submit() {
      const pin = document.getElementById('lock-pin');
      const submit = document.getElementById('lock-submit');
      const value = pin ? pin.value.trim() : '';
      if (!/^\d{4,6}$/.test(value)) {
        this.setError('أدخل الرمز السري (4–6 أرقام)');
        return;
      }
      this.setError('');
      if (submit) submit.disabled = true;
      try {
        const res = await BeeStore.api.security.unlock(this.selectedProfile, value);
        if (!res.ok) {
          this.setError(res.error.message);
          if (pin) { pin.value = ''; pin.focus(); }
          return;
        }
        if (pin) pin.value = '';
        const screen = document.getElementById('lock-screen');
        if (screen) screen.style.display = 'none';
        this.afterUnlock();
      } finally {
        if (submit) submit.disabled = false;
      }
    }

    afterUnlock() {
      const app = document.getElementById('app');
      if (app) app.style.display = 'block';
      this.applyPreferences(BeeStore.settingsCache);
      this.applyRoleUI();
      const profile = BeeStore.auth && BeeStore.auth.profile ? BeeStore.auth.profile() : null;
      const switched = !!this._renderedProfile && profile !== this._renderedProfile &&
        !!BeeStore._appStarted && !!BeeStore.router;
      this._renderedProfile = profile;
      // Switching to the cashier while an owner-only page is open must not
      // leave that page's DOM (and its numbers) on screen. Switching either
      // way re-renders, because the owner/cashier views differ on the same
      // route (dashboard, catalog, invoice row actions).
      if (switched && BeeStore.router.rerender) {
        if (!this.canRoute(BeeStore.router.currentRoute || '/')) {
          BeeStore.router.currentRoute = null;
          BeeStore.router.navigate('/');
        } else {
          BeeStore.router.rerender();
        }
      } else if (BeeStore.router && BeeStore.router.currentRoute && !this.canRoute(BeeStore.router.currentRoute)) {
        BeeStore.router.navigate('/');
      }
      this.touch();
      if (this._onUnlocked) this._onUnlocked();
      this.guardClock();
    }

    /** v3-Lite §10: the owner can pick a larger base font for a small phone. */
    applyPreferences(settings) {
      const s = settings || {};
      const large = !!s.largeFont;
      document.documentElement.classList.toggle('large-font', large);
      if (document.body) document.body.classList.toggle('large-font', large);
    }

    touch() {
      this.lastActivity = Date.now();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!BeeStore.auth || !BeeStore.auth.state || BeeStore.auth.isLocked()) return;
      if (!BeeStore.auth.state().configured) return;
      const minutes = Math.max(1, Number(BeeStore.settingsCache && BeeStore.settingsCache.autoLockMinutes) || 5);
      this.timer = setTimeout(() => {
        if (Date.now() - this.lastActivity >= minutes * 60 * 1000) this.lockNow('قفل تلقائي بعد عدم الاستخدام');
        else this.touch();
      }, minutes * 60 * 1000 + 250);
    }

    stopTimer() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }

    lockNow(reason) {
      return BeeStore.api.security.lock(reason).then(() => this.show(reason));
    }

    onLocked() {
      this.show(this._lockReason || 'التطبيق مقفل');
    }

    async guardClock() {
      if (!BeeStore.api || !BeeStore.api.security || !BeeStore.api.security.clockStatus) return;
      const res = await BeeStore.api.security.clockStatus();
      if (!res.ok) return;
      const state = res.data;
      this._clockPending = !!state.pending;
      if (!state.pending) {
        if (BeeStore.clockGuard) await BeeStore.clockGuard.touch();
        return;
      }
      const box = document.getElementById('clock-warning');
      const reasons = document.getElementById('clock-warning-reasons');
      if (reasons) {
        reasons.innerHTML = '';
        for (const text of (state.reasons || [])) {
          const p = document.createElement('p');
          p.className = 'alert alert-danger';
          p.textContent = text;
          reasons.appendChild(p);
        }
      }
      if (box) box.style.display = 'flex';
    }

    async confirmClock() {
      const res = await BeeStore.api.security.confirmClock();
      if (!res.ok) {
        BeeStore.ui.toast(res.error.message, 'error');
        return;
      }
      const box = document.getElementById('clock-warning');
      if (box) box.style.display = 'none';
      this._clockPending = false;
      if (BeeStore.ui) BeeStore.ui.toast('تم تأكيد تاريخ الهاتف');
      this.touch();
    }

    applyRoleUI() {
      const cashier = !!(BeeStore.auth && BeeStore.auth.isCashier());
      document.body.classList.toggle('role-cashier', cashier);
      const allowed = cashier ? CASHIER_ROUTES : null;
      document.querySelectorAll('.sidebar-nav a[data-route]').forEach((a) => {
        a.parentElement.style.display = !allowed || allowed.has(a.getAttribute('data-route')) ? '' : 'none';
      });
      document.querySelectorAll('.sidebar-nav .nav-group-title').forEach((title) => {
        let row = title.nextElementSibling;
        let any = false;
        while (row && !row.classList.contains('nav-group-title')) {
          if (row.style.display !== 'none') any = true;
          row = row.nextElementSibling;
        }
        title.style.display = any ? '' : 'none';
      });
      const chip = document.getElementById('profile-chip');
      if (chip) {
        chip.textContent = cashier ? 'كاشير' : (BeeStore.auth && BeeStore.auth.isLocked() ? 'مقفل' : 'مالك');
        chip.className = 'profile-chip ' + (cashier ? 'profile-chip-cashier' : 'profile-chip-owner');
      }
      const lockBtn = document.getElementById('header-lock');
      if (lockBtn) {
        lockBtn.style.display = BeeStore.auth && BeeStore.auth.state().configured ? '' : 'none';
      }
    }

    canRoute(path) {
      if (!BeeStore.auth || !BeeStore.auth.isCashier()) return true;
      return CASHIER_ROUTES.has(path);
    }
  }

  BeeStore.appLock = new AppLock();
  BeeStore.AppLock = AppLock;
  BeeStore.CASHIER_ROUTES = CASHIER_ROUTES;
  if (typeof module !== 'undefined') module.exports = AppLock;
})(typeof window !== 'undefined' ? window : globalThis);
