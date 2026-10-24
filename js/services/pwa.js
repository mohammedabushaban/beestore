(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const INSTALL_DISMISS_KEY = 'beestore-install-hint-dismissed-at';
  const INSTALL_HINT_AGAIN_MS = 7 * 24 * 60 * 60 * 1000;
  const UPDATE_RECHECK_MS = 30 * 60 * 1000;

  const state = {
    registration: null,
    waiting: null,
    applying: false,
    updateAvailable: false,
    installEvent: null,
    installed: false,
    offlineReady: false,
    lastError: null,
    appReady: false,
  };
  let lastCheckAt = 0;
  let installHintTimer = null;

  /* ------------------------------------------------------------------ *
   * Pure helpers (also exported for the Node regression tests)
   * ------------------------------------------------------------------ */

  function isStandalone(win) {
    win = win || root;
    try {
      if (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* ignore */ }
    return !!(win.navigator && win.navigator.standalone === true);
  }

  function canUseServiceWorker(win) {
    win = win || root;
    if (!win.location || !/^https?:$/.test(win.location.protocol)) return false;
    // http:// on a LAN address is not a secure context; registration would
    // fail. localhost is secure and isSecureContext is true there.
    if (win.isSecureContext === false) return false;
    return !!(win.navigator && 'serviceWorker' in win.navigator);
  }

  /**
   * A reload is safe only when nothing is being typed/saved and no modal
   * (invoice dialog, scanner, first-run wizard, closing wizard) is open.
   * `cartItems` is the POS cart count; `saving` is the POS save flag;
   * `closing` is reserved for the daily-closing wizard.
   */
  function isSafeToUpdate(info) {
    info = info || {};
    return Number(info.cartItems || 0) === 0 &&
      info.saving !== true &&
      info.dialogOpen !== true &&
      info.closing !== true;
  }

  function _isVisible(element, doc) {
    if (!element) return false;
    if (element.hidden) return false;
    if (doc && doc.defaultView && doc.defaultView.getComputedStyle) {
      try {
        const style = doc.defaultView.getComputedStyle(element);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  function collectAppState(win) {
    win = win || root;
    const doc = win.document;
    let cartItems = 0;
    let saving = false;
    let closing = false;
    try {
      const pos = BeeStore.pages && BeeStore.pages.pos;
      if (pos && typeof pos.getCartCount === 'function') cartItems = pos.getCartCount();
      if (pos && typeof pos.isSaving === 'function') saving = pos.isSaving();
      const dayClose = BeeStore.pages && BeeStore.pages.dailyClosing;
      if (dayClose && typeof dayClose.isOpen === 'function') closing = dayClose.isOpen();
    } catch (e) { /* page may not be loaded yet */ }

    // The first-run wizard stays in the DOM with display:none after finishing;
    // it must not count as an open dialog forever.
    let dialogOpen = false;
    if (doc && doc.querySelectorAll) {
      const overlays = doc.querySelectorAll('.dialog-overlay, .wizard-overlay, .modal-backdrop.show');
      for (let i = 0; i < overlays.length; i++) {
        if (_isVisible(overlays[i], doc)) { dialogOpen = true; break; }
      }
    } else if (doc && doc.querySelector) {
      dialogOpen = !!doc.querySelector('.dialog-overlay, .wizard-overlay, .modal-backdrop.show');
    }
    return { cartItems, saving, dialogOpen, closing };
  }

  async function storageStatus(win) {
    win = win || root;
    const nav = win.navigator || {};
    const supported = !!(nav.storage && typeof nav.storage.persisted === 'function');
    if (!supported) return { supported: false, persisted: false, usage: null, quota: null };
    let persisted = false;
    try { persisted = await nav.storage.persisted(); } catch (e) { /* ignore */ }
    let usage = null;
    let quota = null;
    if (typeof nav.storage.estimate === 'function') {
      try {
        const estimate = await nav.storage.estimate();
        usage = Number(estimate.usage || 0);
        quota = Number(estimate.quota || 0);
      } catch (e) { /* ignore */ }
    }
    return { supported: true, persisted, usage, quota };
  }

  async function requestPersistence(win) {
    win = win || root;
    const nav = win.navigator || {};
    if (!nav.storage || typeof nav.storage.persist !== 'function') {
      return { supported: false, persisted: false };
    }
    let persisted = false;
    try { persisted = await nav.storage.persist(); } catch (e) { /* ignore */ }
    return { supported: true, persisted };
  }

  function getState() {
    return {
      supported: canUseServiceWorker(root),
      installed: state.installed || isStandalone(root),
      offlineReady: state.offlineReady,
      updateAvailable: state.updateAvailable,
      applying: state.applying,
      online: root.navigator ? root.navigator.onLine !== false : true,
      lastError: state.lastError ? String(state.lastError.message || state.lastError) : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Update flow
   * ------------------------------------------------------------------ */

  function _markUpdate(worker) {
    state.waiting = worker;
    state.updateAvailable = true;
    _showUpdateBanner();
  }

  function _onControllerChange() {
    state.offlineReady = !!(root.navigator.serviceWorker && root.navigator.serviceWorker.controller);
    if (state.applying) {
      state.applying = false;
      try { root.location.reload(); } catch (e) { /* ignore */ }
    }
  }

  async function register() {
    if (!canUseServiceWorker(root)) return null;
    if (state.registration) return state.registration;

    try {
      const registration = await root.navigator.serviceWorker.register('./sw.js', { scope: './' });
      state.registration = registration;
      state.installed = isStandalone(root);
      state.offlineReady = !!root.navigator.serviceWorker.controller;

      root.navigator.serviceWorker.addEventListener('controllerchange', _onControllerChange);

      if (registration.waiting && root.navigator.serviceWorker.controller) {
        _markUpdate(registration.waiting);
      }

      registration.addEventListener('updatefound', function () {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && root.navigator.serviceWorker.controller) {
            _markUpdate(worker);
          }
        });
      });

      root.addEventListener('online', _refreshOnlineState);
      root.addEventListener('offline', _refreshOnlineState);
      if (root.document) root.document.addEventListener('visibilitychange', _onVisibilityChange);

      // Check once shortly after start; the browser also checks on navigation.
      setTimeout(function () { checkForUpdate().catch(function () { /* ignore */ }); }, 2500);
      return registration;
    } catch (e) {
      state.lastError = e;
      console.error('Service worker registration failed', e);
      return null;
    }
  }

  function _refreshOnlineState() {
    // Kept for the Settings panel; the state is read lazily via getState().
  }

  function _onVisibilityChange() {
    if (!root.document || root.document.visibilityState !== 'visible') return;
    if (!state.registration) return;
    const now = Date.now();
    if (now - lastCheckAt < UPDATE_RECHECK_MS) return;
    lastCheckAt = now;
    checkForUpdate().catch(function () { /* ignore */ });
  }

  async function checkForUpdate() {
    if (!state.registration) return { ok: false, reason: 'unsupported' };
    lastCheckAt = Date.now();
    try {
      await state.registration.update();
      if (state.registration.waiting && root.navigator.serviceWorker.controller) {
        _markUpdate(state.registration.waiting);
      }
      return { ok: true, updateAvailable: state.updateAvailable };
    } catch (e) {
      state.lastError = e;
      return { ok: false, error: e };
    }
  }

  function applyUpdate() {
    const info = collectAppState(root);
    if (!isSafeToUpdate(info)) {
      if (BeeStore.ui && BeeStore.ui.toast) {
        BeeStore.ui.toast('احفظ الفاتورة أو أغلق النوافذ المفتوحة قبل التحديث', 'error');
      }
      return false;
    }
    const registration = state.registration;
    const worker = state.waiting || (registration && registration.waiting);
    if (!worker) {
      if (BeeStore.ui && BeeStore.ui.toast) BeeStore.ui.toast('لا يوجد تحديث جاهز الآن', 'info');
      return false;
    }

    state.applying = true;
    try {
      worker.postMessage({ type: 'SKIP_WAITING' });
    } catch (e) {
      state.applying = false;
      state.lastError = e;
      return false;
    }

    // If the controller never changes, do not leave the app in limbo.
    setTimeout(function () {
      if (!state.applying) return;
      state.applying = false;
      if (BeeStore.ui && BeeStore.ui.toast) {
        BeeStore.ui.toast('تعذّر إكمال التحديث. أغلق التطبيق وأعد فتحه.', 'error');
      }
    }, 10000);
    return true;
  }

  async function getCacheVersion() {
    const controller = root.navigator && root.navigator.serviceWorker && root.navigator.serviceWorker.controller;
    if (!controller || typeof root.MessageChannel !== 'function') return null;
    return new Promise(function (resolve) {
      const channel = new root.MessageChannel();
      let done = false;
      const finish = function (value) {
        if (done) return;
        done = true;
        resolve(value);
      };
      channel.port1.onmessage = function (event) {
        finish(event.data && event.data.version ? event.data.version : null);
      };
      controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      setTimeout(function () { finish(null); }, 1200);
    });
  }

  /* ------------------------------------------------------------------ *
   * Banners (update + install hint)
   * ------------------------------------------------------------------ */

  function _removeBanner() {
    const existing = root.document && root.document.getElementById('pwa-banner');
    if (existing) existing.remove();
  }

  function _bannerShell(className) {
    const ui = BeeStore.ui;
    return ui.el('div', {
      id: 'pwa-banner',
      class: 'pwa-banner ' + className,
      role: 'status',
      'aria-live': 'polite',
    });
  }

  function _showUpdateBanner() {
    if (!state.appReady || !root.document) return;
    const ui = BeeStore.ui;
    if (!ui || !ui.el) return;
    _removeBanner();
    const banner = _bannerShell('pwa-banner-update');
    banner.appendChild(ui.el('span', { class: 'pwa-banner-icon', 'aria-hidden': 'true' }, '🔄'));
    banner.appendChild(ui.el('div', { class: 'pwa-banner-text' }, [
      ui.el('strong', {}, 'تحديث متوفر'),
      ui.el('span', {}, 'النسخة الجديدة جاهزة. حدّث عندما لا تكون في منتصف فاتورة.'),
    ]));
    banner.appendChild(ui.el('div', { class: 'pwa-banner-actions' }, [
      ui.el('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        onclick: function () { applyUpdate(); },
      }, 'تحديث الآن'),
      ui.el('button', {
        class: 'btn btn-sm btn-secondary',
        type: 'button',
        onclick: function () { _removeBanner(); },
      }, 'لاحقاً'),
    ]));
    root.document.body.appendChild(banner);
  }

  function _installHintDismissed() {
    try {
      const at = Number(root.localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
      return at > 0 && (Date.now() - at) < INSTALL_HINT_AGAIN_MS;
    } catch (e) {
      return false;
    }
  }

  function _dismissInstallHint() {
    try { root.localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch (e) { /* ignore */ }
    _removeBanner();
  }

  function _showInstallBanner() {
    if (!state.appReady || !root.document || state.installed || _installHintDismissed()) return;
    if (state.updateAvailable) return; // update banner has priority
    const ui = BeeStore.ui;
    if (!ui || !ui.el) return;
    _removeBanner();
    const banner = _bannerShell('pwa-banner-install');
    banner.appendChild(ui.el('span', { class: 'pwa-banner-icon', 'aria-hidden': 'true' }, '📲'));
    banner.appendChild(ui.el('div', { class: 'pwa-banner-text' }, [
      ui.el('strong', {}, 'ثبّت بي ستور'),
      ui.el('span', {}, 'يعمل دون إنترنت ويُفتح من أيقونة على جهازك.'),
    ]));
    banner.appendChild(ui.el('div', { class: 'pwa-banner-actions' }, [
      ui.el('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        onclick: function () { install(); },
      }, state.installEvent ? 'تثبيت' : 'طريقة التثبيت'),
      ui.el('button', {
        class: 'btn btn-sm btn-secondary',
        type: 'button',
        onclick: _dismissInstallHint,
      }, 'لاحقاً'),
    ]));
    root.document.body.appendChild(banner);
  }

  function _scheduleInstallHint() {
    if (installHintTimer) return;
    installHintTimer = setTimeout(function () {
      installHintTimer = null;
      _showInstallBanner();
    }, 3500);
  }

  function onAppReady() {
    state.appReady = true;
    state.installed = isStandalone(root);
    if (state.updateAvailable) {
      _showUpdateBanner();
      return;
    }
    _scheduleInstallHint();
  }

  function showInstallGuide() {
    const ui = BeeStore.ui;
    const dialogs = BeeStore.dialogs;
    if (!ui || !dialogs || !dialogs.openDialog) return;
    const stepList = function (steps) {
      return ui.el('ol', { class: 'install-steps' }, steps.map(function (step) {
        return ui.el('li', {}, step);
      }));
    };
    let dialogHandle = null;
    const content = ui.el('div', { class: 'install-guide' }, [
      ui.el('p', {}, 'التثبيت يجعل التطبيق يعمل من أيقونة على الشاشة الرئيسية دون شريط المتصفح، ويحفظ بياناتك على هذا الهاتف.'),
      ui.el('h4', {}, 'أندرويد (Chrome)'),
      stepList([
        'افتح رابط التطبيق في Chrome.',
        'اضغط قائمة النقاط الثلاث ⋮ أعلى المتصفح.',
        'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».',
        'اضغط «تثبيت» ثم افتح التطبيق من الأيقونة.',
      ]),
      ui.el('h4', {}, 'آيفون (Safari)'),
      stepList([
        'افتح رابط التطبيق في Safari — ليس داخل واتساب أو فيسبوك.',
        'اضغط زر المشاركة (المربع مع السهم).',
        'اختر «إضافة إلى الشاشة الرئيسية».',
        'اضغط «إضافة» ثم افتح التطبيق من الأيقونة.',
      ]),
      ui.el('h4', {}, 'على الكمبيوتر'),
      ui.el('p', {}, 'في Chrome أو Edge اضغط أيقونة التثبيت بجانب شريط العنوان، أو قائمة المتصفح ثم «تثبيت بي ستور».'),
      ui.el('p', { class: 'form-hint' }, 'يجب فتح التطبيق من رابط https المنشور. فتح ملف index.html مباشرة لا يدعم الحفظ ولا التثبيت.'),
    ]);
    dialogHandle = dialogs.openDialog('تثبيت بي ستور', content, null, {
      footer: [
        ui.el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: function () {
            if (dialogHandle) dialogHandle.close();
          },
        }, 'فهمت'),
      ],
    });
  }

  async function install() {
    if (state.installEvent) {
      const event = state.installEvent;
      state.installEvent = null;
      try {
        // prompt() returns a promise in current Chrome; await it so a rejected
        // prompt (e.g. no trusted user gesture) falls back to the guide.
        await event.prompt();
        const choice = await event.userChoice;
        if (choice && choice.outcome === 'accepted') {
          state.installed = true;
          _removeBanner();
          if (BeeStore.ui && BeeStore.ui.toast) BeeStore.ui.toast('تم تثبيت التطبيق');
        }
      } catch (e) {
        state.lastError = e;
        showInstallGuide();
      }
      return;
    }
    showInstallGuide();
  }

  function _onBeforeInstallPrompt(event) {
    event.preventDefault();
    state.installEvent = event;
    if (state.appReady) _showInstallBanner();
  }

  function _onAppInstalled() {
    state.installed = true;
    state.installEvent = null;
    _removeBanner();
  }

  if (root.addEventListener) {
    root.addEventListener('beforeinstallprompt', _onBeforeInstallPrompt);
    root.addEventListener('appinstalled', _onAppInstalled);
  }

  BeeStore.pwa = {
    register,
    checkForUpdate,
    applyUpdate,
    getState,
    onAppReady,
    getCacheVersion,
    isStandalone: function () { return isStandalone(root); },
    isSafeToUpdate,
    collectAppState: function () { return collectAppState(root); },
    storageStatus: function () { return storageStatus(root); },
    requestPersistence: function () { return requestPersistence(root); },
    showInstallGuide,
    install,
    _canUseServiceWorker: canUseServiceWorker,
  };

  if (typeof module !== 'undefined') {
    module.exports = { isStandalone, canUseServiceWorker, isSafeToUpdate, collectAppState, storageStatus };
  }
})(typeof window !== 'undefined' ? window : globalThis);
