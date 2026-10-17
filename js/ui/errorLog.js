(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v2 §12.3: global error handling. Never a blank screen: window errors and
  // unhandled rejections are stored (last 200, IndexedDB `errorLog` — ids and
  // technical details only, no business data) and shown in a friendly Arabic
  // dialog with a "copy details" button. Viewable in Settings → Maintenance.
  const MAX_STORED = 200;
  const buffer = [];
  let dialogOpen = false;

  function _now() {
    try { return new Date().toISOString(); }
    catch (e) { return ''; }
  }

  function _rid() {
    try { return BeeStore.ids.randomId('err'); }
    catch (e) { return 'err_' + Math.random().toString(36).slice(2); }
  }

  async function capture(source, message, stack) {
    const entry = {
      id: _rid(),
      timestamp: _now(),
      source: String(source || 'unknown').slice(0, 80),
      message: String(message || '').slice(0, 500),
      stack: String(stack || '').slice(0, 2000),
      url: '',
      userAgent: '',
    };
    try {
      entry.url = String(location.hash || '').slice(0, 120);
      entry.userAgent = String(navigator.userAgent || '').slice(0, 200);
    } catch (e) { /* non-browser env */ }
    buffer.unshift(entry);
    if (buffer.length > MAX_STORED) buffer.length = MAX_STORED;
    const repo = BeeStore.errorLog && BeeStore.errorLog.repo;
    if (repo) {
      try {
        await repo.transaction(async (tx) => {
          tx.put('errorLog', entry);
          const all = await tx.list('errorLog');
          if (all.length > MAX_STORED) {
            all.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
            for (const old of all.slice(MAX_STORED)) tx.remove('errorLog', old.id);
          }
        });
      } catch (e) { /* logging must never break the app */ }
    }
    _showDialog(entry);
    return entry;
  }

  function _showDialog(entry) {
    try {
      if (typeof document === 'undefined' || dialogOpen) return;
      if (!BeeStore.ui) return;
      dialogOpen = true;
      const { el } = BeeStore.ui;
      const overlay = el('div', { class: 'dialog-overlay', role: 'alertdialog', 'aria-modal': 'true' });
      const dialog = el('div', { class: 'dialog' }, [
        el('div', { class: 'dialog-header' }, [el('h3', {}, 'حدث خطأ غير متوقع')],
        ),
        el('div', { class: 'dialog-body' }, [
          el('p', {}, 'نعتذر — حدث خطأ أثناء العمل. بياناتك محفوظة، ويمكنك متابعة الاستخدام.'),
          el('p', { class: 'form-hint' }, entry.message || 'تفاصيل غير متاحة'),
        ]),
        el('div', { class: 'dialog-actions' }, [
          el('button', {
            class: 'btn btn-secondary',
            onclick: async () => {
              const text = 'BeeStore error\n' + entry.timestamp + '\n' + entry.source + '\n' + entry.message + '\n' + entry.url;
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(text);
                } else {
                  const ta = el('textarea', {}, text);
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  ta.remove();
                }
                BeeStore.ui.toast('تم نسخ تفاصيل الخطأ');
              } catch (e) { BeeStore.ui.toast('تعذر النسخ', 'error'); }
            },
          }, 'نسخ تفاصيل الخطأ'),
          el('button', {
            class: 'btn btn-primary',
            onclick: () => { dialogOpen = false; overlay.remove(); },
          }, 'متابعة'),
        ]),
      ]);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    } catch (e) { dialogOpen = false; /* last resort: stay silent */ }
  }

  async function list(limit) {
    const repo = BeeStore.errorLog && BeeStore.errorLog.repo;
    if (repo) {
      try {
        const all = await repo.list('errorLog');
        all.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        return all.slice(0, limit || MAX_STORED);
      } catch (e) { /* fall through to buffer */ }
    }
    return buffer.slice(0, limit || MAX_STORED);
  }

  async function clear() {
    buffer.length = 0;
    const repo = BeeStore.errorLog && BeeStore.errorLog.repo;
    if (repo) {
      try {
        await repo.transaction(async (tx) => {
          const all = await tx.list('errorLog');
          for (const e of all) tx.remove('errorLog', e.id);
        });
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  // Diagnostics download: technical details + ids only, no business data.
  async function diagnostics() {
    const entries = await list(MAX_STORED);
    const payload = {
      generatedAt: _now(),
      dbVersion: BeeStore.config ? BeeStore.config.dbVersion : null,
      schemaVersion: BeeStore.schemaVersion || null,
      errors: entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'beestore-diagnostics.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }

  function install() {
    if (typeof window === 'undefined' || install._done) return;
    install._done = true;
    window.addEventListener('error', (e) => {
      capture('window.onerror', e.message || 'Script error', e.error && e.error.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      const msg = reason && reason.message ? reason.message : String(reason);
      capture('unhandledrejection', msg, reason && reason.stack);
    });
  }

  BeeStore.errorLog = { repo: null, install, capture, list, clear, diagnostics };
  if (typeof module !== 'undefined') module.exports = BeeStore.errorLog;
})(typeof window !== 'undefined' ? window : globalThis);
