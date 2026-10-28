(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  async function init() {
    const hasIndexedDB = 'indexedDB' in window;
    const hasLocks = 'navigator' in window && 'locks' in navigator;
    const isFile = !!(window.location && window.location.protocol === 'file:');

    // The folder mirror is an optional desktop feature. A phone without the
    // File System Access API is a fully supported target — only a missing
    // IndexedDB (or opening via file://) prevents the app from running.
    if (!hasIndexedDB || isFile) {
      document.getElementById('browser-warning').style.display = 'block';
    }

    BeeStore.repo = new BeeStore.IdbRepository();
    _setupLazyProgress(BeeStore.repo);
    try {
      // A file:// page has no usable IndexedDB: open() may hang forever.
      await _openRepoWithTimeout(BeeStore.repo, 5000);
    } catch (e) {
      _showFatal('تعذّر فتح قاعدة البيانات المحلية (IndexedDB). يحدث هذا عند فتح الملف مباشرة برابط ' +
        'file:// — يمنع المتصفح IndexedDB هناك. شغّل البرنامج عبر خادم محلي ' +
        '(مثال: python -m http.server) أو افتح النسخة المنشورة على رابط https.');
      return;
    }

    // Startup migration: upgrade older exports/data to the current schema.
    // A local snapshot is written first (v3-Lite §2): a failed migration must
    // never be the only copy of the owner's data.
    BeeStore.snapshots = new BeeStore.SnapshotService();
    try {
      const meta = await BeeStore.repo.get('meta', 'meta');
      const stored = (meta && meta.schemaVersion) || 1;
      if (stored < BeeStore.schemaVersion) {
        const dump = await BeeStore.repo.exportAll();
        try {
          await BeeStore.snapshots.create('pre-migration', dump);
        } catch (snapshotError) {
          console.error('pre-migration snapshot failed', snapshotError);
          _showFatal('تعذّر إنشاء نسخة أمان تلقائية قبل تحديث قاعدة البيانات. ' +
            'لم يتم تغيير بياناتك. حرّر مساحة على الهاتف ثم أعد فتح التطبيق، ' +
            'أو تواصل مع من يدعمك لاستعادة نسخة احتياطية.');
          return;
        }
        const migrated = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
        await BeeStore.repo.importAll(migrated);
      }
    } catch (e) {
      console.error('migration failed', e);
    }

    BeeStore.fileSync = new BeeStore.FileSync(BeeStore.repo);
    await BeeStore.fileSync.loadHandle();
    BeeStore.backup = new BeeStore.BackupService(BeeStore.repo, BeeStore.fileSync);

    BeeStore.api = new BeeStore.Api(BeeStore.repo);

    // A1: the chart is initialized for every install (fresh, migrated, or
    // restored). It is idempotent and never rewrites existing chart records.
    // Runs after the API binds services to the repository.
    if (BeeStore.chart && BeeStore.chart.ensureSeeded) {
      try {
        await BeeStore.chart.ensureSeeded();
      } catch (chartError) {
        console.error('chart seeding failed', chartError);
      }
    }

    BeeStore.csv.repo = BeeStore.repo;
    BeeStore.audit.repo = BeeStore.repo;
    if (BeeStore.errorLog) {
      BeeStore.errorLog.repo = BeeStore.repo;
      BeeStore.errorLog.install();
    }

    const storedSettings = await BeeStore.repo.get('meta', 'settings');
    const products = await BeeStore.products.list();

    if (!storedSettings && products.length === 0) {
      BeeStore.wizard = new BeeStore.FirstRunWizard();
      BeeStore.wizard.show();
    } else {
      await BeeStore.settings.ensureDefaults();
      await _startWithLock();
    }

    if (hasLocks) {
      _acquireLock();
    }

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () { /* shown in Settings → البيانات */ });
    }

    if (BeeStore.pwa) BeeStore.pwa.register();
  }

  // v3-Lite §5: a small, non-blocking notice while older months are fetched
  // from IndexedDB. The short delay avoids flicker for fast cached reads.
  function _setupLazyProgress(repo) {
    const box = document.getElementById('lazy-progress');
    const text = document.getElementById('lazy-progress-text');
    let pending = 0;
    let showTimer = null;
    repo.onLazyRead = function (state) {
      if (!box) return;
      if (state.active) {
        pending++;
        if (text && state.label) text.textContent = state.label;
        if (pending === 1 && !showTimer) {
          showTimer = setTimeout(function () {
            showTimer = null;
            if (pending > 0) box.style.display = 'flex';
          }, 150);
        }
        return;
      }
      pending = Math.max(0, pending - 1);
      if (pending === 0) {
        if (showTimer) {
          clearTimeout(showTimer);
          showTimer = null;
        }
        box.style.display = 'none';
      }
    };
  }

  function _openRepoWithTimeout(repo, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('IndexedDB open timed out'));
      }, ms);
      repo.open().then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }, (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function _showFatal(message) {
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:32px;border-radius:8px;text-align:center;max-width:520px;box-shadow:0 4px 24px rgba(0,0,0,.15);line-height:1.9;';
    const h = document.createElement('h2');
    h.textContent = 'تعذّر تشغيل البرنامج';
    const p = document.createElement('p');
    p.textContent = message;
    box.appendChild(h);
    box.appendChild(p);
    document.body.appendChild(box);
  }

  function startApp() {
    if (BeeStore._appStarted) {
      // Returning from the lock screen must keep the current DOM (including an
      // in-progress invoice) untouched. Just make the app visible again.
      document.getElementById('app').style.display = 'block';
      return;
    }
    BeeStore._appStarted = true;
    document.getElementById('app').style.display = 'block';
    if (BeeStore.appLock && BeeStore.appLock.applyPreferences) {
      BeeStore.appLock.applyPreferences(BeeStore.settingsCache);
    }
    _setupSidebar();
    _setupRouter();
    _setupSaveStatus();
    _setupVisibilityHandlers();
    if (BeeStore.period) BeeStore.period.renderHeader();
    BeeStore.router.start();
    if (BeeStore.pwa) BeeStore.pwa.onAppReady();
  }

  async function _startWithLock() {
    BeeStore.settingsCache = await BeeStore.settings.get();
    await BeeStore.auth.init();
    BeeStore.appLock.bind({ onUnlocked: startApp });
    await BeeStore.appLock.start();
  }

  BeeStore._startWithLock = _startWithLock;
  BeeStore._startApp = startApp;

  // Re-run the current page (used when the global period changes).
  BeeStore.router.rerender = function () {
    const cur = BeeStore.router.currentRoute;
    BeeStore.router.currentRoute = null;
    BeeStore.router.navigate(cur || '/');
  };

  BeeStore._setupRouter = _setupRouter;
  BeeStore._setupSaveStatus = _setupSaveStatus;
  BeeStore._setupVisibilityHandlers = _setupVisibilityHandlers;
  BeeStore._setupSidebar = _setupSidebar;

  let sidebarSetup = false;

  function _setupSidebar() {
    if (sidebarSetup) return;
    const sidebar = document.getElementById('sidebar');
    const hamburger = document.querySelector('.hamburger');
    if (!sidebar || !hamburger) return;
    sidebarSetup = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', closeSidebar);
    document.getElementById('app').appendChild(backdrop);

    function openSidebar() {
      sidebar.classList.add('open');
      backdrop.classList.add('show');
      hamburger.setAttribute('aria-expanded', 'true');
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      backdrop.classList.remove('show');
      hamburger.setAttribute('aria-expanded', 'false');
    }
    function toggleSidebar() {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    }

    hamburger.addEventListener('click', toggleSidebar);

    // Close on any nav tap. Delegated + capture so it also fires on touch
    // devices right after the tap, before the link's own handler runs.
    sidebar.addEventListener('click', (e) => {
      const link = e.target && e.target.closest ? e.target.closest('a') : null;
      if (link) closeSidebar();
    }, true);
    // Safety net: any navigation (back/forward, link) closes the sidebar.
    window.addEventListener('hashchange', closeSidebar);
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) closeSidebar();
    });

    BeeStore.toggleSidebar = toggleSidebar;
    BeeStore.closeSidebar = closeSidebar;
  }

  let routeClicksBound = false;

  function _bindRouteClicks() {
    if (routeClicksBound) return;
    routeClicksBound = true;
    // All navigation used to be inline onclick attributes, which CSP blocks.
    // One delegated listener keeps the same routes without inline scripts.
    document.addEventListener('click', (e) => {
      const target = e.target && e.target.closest ? e.target.closest('[data-route]') : null;
      if (!target) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      BeeStore.router.navigate(target.getAttribute('data-route'));
    });
  }

  function _setupRouter() {
    _bindRouteClicks();
    const pages = {
      '/': { title: 'الرئيسية', render: BeeStore.pages.dashboard.render },
      '/days': { title: 'الأيام', render: BeeStore.pages.days.render },
      '/pos': { title: 'فاتورة جديدة', render: BeeStore.pages.pos.render },
      '/invoices': { title: 'الفواتير', render: BeeStore.pages.invoices.render },
      '/returns': { title: 'المرتجعات والاستبدال', render: BeeStore.pages.returns.render },
      '/products': { title: 'المنتجات والمخزون', render: BeeStore.pages.products.render },
      '/stocktake': { title: 'جرد المخزون', render: BeeStore.pages.stocktake.render },
      '/price-check': { title: 'فحص سعر', render: BeeStore.pages.priceCheck.render },
      '/labels': { title: 'الباركود والملصقات', render: BeeStore.pages.labels.render },
      '/purchases': { title: 'المشتريات', render: BeeStore.pages.purchases.render },
      '/suppliers': { title: 'الموردون', render: BeeStore.pages.suppliers.render },
      '/customers': { title: 'الزبائن والديون', render: BeeStore.pages.customers.render },
      '/expenses': { title: 'المصاريف', render: BeeStore.pages.expenses.render },
      '/employees': { title: 'الموظفون والرواتب', render: BeeStore.pages.employees.render },
      '/accounts': { title: 'الحسابات', render: BeeStore.pages.accounts.render },
      '/reports': { title: 'التقارير', render: BeeStore.pages.reports.render },
      '/periods': { title: 'إقفال الشهور', render: BeeStore.pages.periods.render },
      '/settings': { title: 'الإعدادات', render: BeeStore.pages.settings.render },
    };

    for (const [path, page] of Object.entries(pages)) {
      BeeStore.router.register(path, () => {
        if (BeeStore.closeSidebar) BeeStore.closeSidebar();
        document.getElementById('page-title').textContent = page.title;
        const content = document.getElementById('page-content');
        content.innerHTML = '';
        if (BeeStore.appLock && !BeeStore.appLock.canRoute(path)) {
          content.appendChild(document.createElement('div'));
          content.firstChild.className = 'alert alert-warning';
          content.firstChild.textContent = 'هذه الصفحة غير متاحة لملف الكاشير. ' +
            'استخدم فاتورة جديدة أو فحص السعر أو الفواتير.';
          document.querySelectorAll('.sidebar-nav a').forEach(a => {
            a.classList.toggle('active', a.dataset.route === path);
          });
          return;
        }
        // v2 §12.3: a failing page must not blank the whole app.
        try {
          const result = page.render(content);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => _pageFailed(content, page.title, err));
          }
        } catch (err) {
          _pageFailed(content, page.title, err);
        }
        document.querySelectorAll('.sidebar-nav a').forEach(a => {
          a.classList.toggle('active', a.dataset.route === path);
        });
      });
    }
  }

  function _pageFailed(content, title, err) {
    try {
      if (BeeStore.errorLog) BeeStore.errorLog.capture('page:' + title, err && err.message, err && err.stack);
    } catch (e) { /* ignore */ }
    content.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'alert alert-danger';
    box.textContent = 'تعذر عرض صفحة "' + title + '" بسبب خطأ غير متوقع. باقي البرنامج يعمل — جرّب تحديث الصفحة أو افتح صفحة أخرى.';
    content.appendChild(box);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = 'تحديث الصفحة';
    btn.onclick = () => location.reload();
    content.appendChild(btn);
  }

  function _setupSaveStatus() {
    const statusEl = document.getElementById('save-status');
    const headerStatus = document.getElementById('header-save-status');
    if (!statusEl) return;

    const updateStatus = () => {
      const s = BeeStore.fileSync.getStatus();
      let icon, text;
      if (s.status === 'ok') {
        icon = '🟢';
        text = 'محفوظ في الملف' + (s.lastSavedAt ? ' (' + BeeStore.dates.formatDateTime(s.lastSavedAt).slice(11) + ')' : '');
      } else if (s.status === 'pending') {
        icon = '🟡';
        text = 'بانتظار الحفظ...';
      } else if (s.status === 'need-permission') {
        icon = '🟡';
        text = 'اضغط لإعادة السماح بالحفظ';
      } else if (s.status === 'error') {
        icon = '🔴';
        text = 'فشل الحفظ في الملف';
      } else {
        icon = '⚪';
        text = 'الحفظ في الملف غير متاح';
      }
      statusEl.style.display = 'flex';
      document.getElementById('save-status-icon').textContent = icon;
      document.getElementById('save-status-text').textContent = text;
      if (headerStatus) headerStatus.textContent = icon + ' ' + text;
    };

    setInterval(updateStatus, 5000);
    updateStatus();

    statusEl.style.cursor = 'pointer';
    statusEl.title = 'اضغط لإعادة السماح بالحفظ في المجلد';
    statusEl.onclick = async () => {
      const st = BeeStore.fileSync.getStatus();
      if (st.status === 'need-permission') {
        const granted = await BeeStore.fileSync.requestPermission();
        if (granted) BeeStore.ui.toast('تم منح إذن الحفظ');
        else BeeStore.ui.toast('لم يتم منح الإذن', 'error');
        updateStatus();
      } else if (st.status === 'unavailable' && st.supported) {
        const chosen = await BeeStore.fileSync.pickFolder();
        if (chosen) BeeStore.ui.toast('تم اختيار مجلد البيانات');
        updateStatus();
      }
    };

    BeeStore.fileSync.onStatusChange = updateStatus;
  }

  function _setupVisibilityHandlers() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        BeeStore.fileSync.saveNow();
      }
    });
    window.addEventListener('pagehide', () => {
      BeeStore.fileSync.saveNow();
    });
  }

  function _acquireLock() {
    navigator.locks.request(BeeStore.config.lockName, { ifAvailable: true }, (lock) => {
      if (!lock) {
        BeeStore.ui.toast('البرنامج مفتوح في نافذة أخرى', 'error');
        document.getElementById('app').style.display = 'none';
        const msg = document.createElement('div');
        msg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:40px;border-radius:8px;text-align:center;';
        msg.innerHTML = '<h2>البرنامج مفتوح في نافذة أخرى</h2><p>يرجى إغلاق النافذة الأخرى أولاً</p>';
        document.body.appendChild(msg);
        return Promise.resolve();
      }
      return new Promise(() => {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
