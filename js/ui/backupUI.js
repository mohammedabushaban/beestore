(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const COLLECTION_LABELS = {
    products: 'المنتجات',
    variants: 'المتغيرات',
    customers: 'الزبائن',
    suppliers: 'الموردون',
    sales: 'الفواتير',
    salesReturns: 'المرتجعات',
    purchases: 'المشتريات',
    purchaseReturns: 'مرتجعات المشتريات',
    expenses: 'المصاريف',
    customerPayments: 'دفعات الزبائن',
    supplierPayments: 'دفعات الموردين',
    stockMovements: 'حركات المخزون',
    accounts: 'الحسابات',
    employees: 'الموظفون',
  };

  function _toast(message, type) {
    if (BeeStore.ui && BeeStore.ui.toast) BeeStore.ui.toast(message, type || 'success');
  }

  function _pickFile() {
    return new Promise(function (resolve) {
      const input = root.document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      root.document.body.appendChild(input);
      let settled = false;
      const finish = function (file) {
        if (settled) return;
        settled = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(file || null);
      };
      input.onchange = function () { finish(input.files && input.files[0]); };
      input.oncancel = function () { finish(null); };
      input.click();
      // Some browsers do not fire cancel; keep the input harmless until a
      // later restore attempt replaces it.
    });
  }

  function _fileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      const reader = new root.FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('تعذّر قراءة الملف')); };
      reader.readAsText(file);
    });
  }

  function _askPassphrase(title, message) {
    return new Promise(function (resolve) {
      const dialogs = BeeStore.dialogs;
      const ui = BeeStore.ui;
      const pass = dialogs.input('password', '', {
        autocomplete: 'current-password',
        placeholder: 'كلمة المرور',
      });
      let handle = null;
      let settled = false;
      const finish = function (value) {
        if (settled) return;
        settled = true;
        if (handle) handle.close();
        resolve(value);
      };
      const content = ui.el('div', {}, [
        ui.el('p', {}, message || 'هذه النسخة مشفرة. أدخل كلمة المرور التي استخدمتها عند إنشائها.'),
        dialogs.formField('كلمة المرور', pass, true),
        ui.el('p', { class: 'form-hint' }, 'كلمة المرور لا تُحفظ في البرنامج. إن نسيتها لا يمكن استعادة النسخة.'),
      ]);
      handle = dialogs.openDialog(title || 'نسخة مشفرة', content, null, {
        footer: [
          ui.el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            onclick: function () { finish(null); },
          }, 'إلغاء'),
          ui.el('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: function () {
              const value = String(pass.value || '');
              if (!value) { _toast('أدخل كلمة المرور', 'error'); pass.focus(); return; }
              finish(value);
            },
          }, 'متابعة'),
        ],
      });
      const close = handle.dialog.querySelector('.btn-close');
      if (close) close.onclick = function () { finish(null); };
      handle.overlay.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') finish(null);
      });
      setTimeout(function () { pass.focus(); }, 80);
    });
  }

  function _summaryContent(info, fileName) {
    const ui = BeeStore.ui;
    const dialogs = BeeStore.dialogs;
    const summary = info.summary || {};
    const counts = summary.counts || {};
    const rows = [];
    for (const name of Object.keys(COLLECTION_LABELS)) {
      if (counts[name]) {
        rows.push(ui.el('div', { class: 'backup-summary-row' }, [
          ui.el('span', {}, COLLECTION_LABELS[name]),
          ui.el('strong', {}, String(counts[name])),
        ]));
      }
    }
    const shown = Object.keys(COLLECTION_LABELS).reduce(function (sum, name) {
      return sum + (counts[name] || 0);
    }, 0);
    const other = Math.max(0, Number(summary.total || 0) - shown);
    if (other > 0) {
      rows.push(ui.el('div', { class: 'backup-summary-row' }, [
        ui.el('span', {}, 'سجلات أخرى'),
        ui.el('strong', {}, String(other)),
      ]));
    }

    const items = [
      ui.el('p', {}, fileName ? 'الملف: ' + fileName : 'ملف نسخة احتياطية'),
      ui.el('div', { class: 'backup-summary-grid' }, [
        ui.el('div', {}, [ui.el('span', { class: 'form-hint' }, 'تاريخ النسخة'), ui.el('strong', {}, summary.createdAt ? BeeStore.dates.formatDateTime(summary.createdAt) : 'غير معروف')]),
        ui.el('div', {}, [ui.el('span', { class: 'form-hint' }, 'إجمالي السجلات'), ui.el('strong', {}, String(summary.total || 0))]),
        ui.el('div', {}, [ui.el('span', { class: 'form-hint' }, 'إصدار البيانات'), ui.el('strong', {}, String(summary.schemaVersion || '—'))]),
        ui.el('div', {}, [ui.el('span', { class: 'form-hint' }, 'الجهاز'), ui.el('strong', {}, summary.deviceId || 'غير معروف')]),
      ]),
    ];
    if (rows.length) {
      items.push(ui.el('div', { class: 'backup-summary-list' }, rows));
    }
    if (summary.newest) {
      const label = COLLECTION_LABELS[summary.newest.collection] || summary.newest.collection;
      items.push(ui.el('p', { class: 'form-hint' }, 'أحدث سجل: ' + label +
        (summary.newest.number ? ' — ' + summary.newest.number : '') +
        (summary.newest.date ? ' — ' + BeeStore.dates.formatDateTime(summary.newest.date) : '')));
    }

    const warnings = info.warnings || [];
    if (warnings.length) {
      items.push(ui.el('div', { class: 'backup-warning-list' }, warnings.map(function (warning) {
        return ui.el('div', { class: 'alert alert-warning' }, warning.message);
      })));
    }
    items.push(ui.el('div', { class: 'alert alert-danger' }, 'سيتم استبدال كل البيانات الحالية على هذا الجهاز بمحتوى النسخة. ستُنشأ نسخة أمان داخلية قبل الاستعادة، لكنها لا تغني عن نسخة خارج الجهاز.'));
    items.push(ui.el('p', { class: 'form-hint' }, 'بعد الاستعادة سيُعاد تحميل البرنامج. لا تعمل على جهازين في الوقت نفسه على نفس البيانات.'));

    const wrapper = ui.el('div', { class: 'backup-summary' }, items);
    return wrapper;
  }

  function _confirmRestore(info, fileName) {
    return new Promise(function (resolve) {
      const ui = BeeStore.ui;
      const dialogs = BeeStore.dialogs;
      let handle = null;
      let settled = false;
      const finish = function (value) {
        if (settled) return;
        settled = true;
        if (handle) handle.close();
        resolve(value);
      };
      const confirmInput = dialogs.input('text', '', {
        autocomplete: 'off',
        placeholder: 'استعادة',
        'aria-label': 'اكتب استعادة للتأكيد',
      });
      const content = _summaryContent(info, fileName);
      content.appendChild(dialogs.formField('للتأكيد اكتب كلمة: استعادة', confirmInput, true,
        'هذا الإجراء يستبدل كل البيانات الحالية. لن يكتمل الزر قبل كتابة الكلمة.'));
      const confirmBtn = ui.el('button', {
        class: 'btn btn-warning',
        type: 'button',
        onclick: function () {
          if (String(confirmInput.value || '').trim() !== 'استعادة') {
            _toast('اكتب كلمة «استعادة» للتأكيد', 'error');
            confirmInput.focus();
            return;
          }
          finish(true);
        },
      }, 'استعادة الآن');
      confirmBtn.disabled = true;
      confirmInput.addEventListener('input', function () {
        confirmBtn.disabled = String(confirmInput.value || '').trim() !== 'استعادة';
      });
      handle = dialogs.openDialog('مراجعة النسخة الاحتياطية', content, null, {
        large: true,
        footer: [
          ui.el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            onclick: function () { finish(false); },
          }, 'إلغاء'),
          confirmBtn,
        ],
      });
      const close = handle.dialog.querySelector('.btn-close');
      if (close) close.onclick = function () { finish(false); };
      handle.overlay.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') finish(false);
      });
    });
  }

  /**
   * Full restore flow: pick file → passphrase (if encrypted) → checksum and
   * summary review → safety snapshot → import → reload. Used by Settings and
   * the first-run wizard (new-phone flow).
   */
  async function restoreFromFile(options) {
    options = options || {};
    const file = await _pickFile();
    if (!file) return { ok: false, cancelled: true };

    let data;
    try {
      data = JSON.parse(await _fileText(file));
    } catch (error) {
      _toast('ملف غير صالح: تعذّرت قراءة JSON', 'error');
      return { ok: false, error: { code: 'INVALID_DATA', message: error.message } };
    }

    let passphrase = null;
    let info = null;
    let attempts = 0;
    while (true) {
      const result = await BeeStore.api.backup.inspect(data, { passphrase: passphrase });
      if (result.ok) { info = result.data; break; }
      const code = result.error && result.error.code;
      if ((code === 'WRONG_PASSPHRASE' || code === 'PASSPHRASE_REQUIRED') && attempts < 3) {
        attempts++;
        passphrase = await _askPassphrase(
          'نسخة مشفرة',
          code === 'WRONG_PASSPHRASE'
            ? 'كلمة المرور غير صحيحة. حاول مرة أخرى.'
            : 'هذه النسخة مشفرة. أدخل كلمة المرور التي استخدمتها عند إنشائها.'
        );
        if (passphrase === null) return { ok: false, cancelled: true };
        continue;
      }
      _toast((result.error && result.error.message) || 'تعذّر فحص النسخة الاحتياطية', 'error');
      return result;
    }

    const confirmed = await _confirmRestore(info, file.name);
    if (!confirmed) return { ok: false, cancelled: true };

    const restored = await BeeStore.api.backup.restore(data, { passphrase: passphrase });
    if (!restored.ok) {
      _toast((restored.error && restored.error.message) || 'تعذّرت الاستعادة', 'error');
      return restored;
    }

    _toast('تمت الاستعادة بنجاح — سيُعاد تحميل البرنامج');
    if (typeof options.onDone === 'function') {
      try { options.onDone(restored.data); } catch (e) { /* ignore */ }
    }
    if (options.reload !== false) {
      setTimeout(function () { root.location.reload(); }, 900);
    }
    return restored;
  }

  async function shareBackup(options) {
    const result = await BeeStore.api.backup.share(options || {});
    if (!result.ok) {
      _toast((result.error && result.error.message) || 'تعذّر إنشاء النسخة الاحتياطية', 'error');
      return result;
    }
    const data = result.data || {};
    if (data.method === 'share') {
      _toast('تمت المشاركة — احفظ الملف في Drive أو واتساب أو بريد إلكتروني');
    } else if (data.method === 'download') {
      _toast('تم تنزيل الملف — انقله خارج الهاتف (Drive أو واتساب)');
    } else if (data.method === 'cancelled') {
      _toast('أُلغيت المشاركة — لم تُسجّل نسخة جديدة', 'info');
    }
    if (data.warning) _toast('تم النسخ، لكن: ' + data.warning, 'error');
    return result;
  }

  async function downloadBackup(options) {
    const result = await BeeStore.api.backup.download(options || {});
    if (!result.ok) {
      _toast((result.error && result.error.message) || 'تعذّر إنشاء النسخة الاحتياطية', 'error');
      return result;
    }
    _toast('تم تنزيل النسخة — انقلها خارج الهاتف');
    if (result.data && result.data.warning) _toast('تم التنزيل، لكن: ' + result.data.warning, 'error');
    return result;
  }

  BeeStore.backupUI = {
    restoreFromFile: restoreFromFile,
    shareBackup: shareBackup,
    downloadBackup: downloadBackup,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.backupUI;
})(typeof window !== 'undefined' ? window : globalThis);
