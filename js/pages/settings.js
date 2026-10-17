(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField, textarea } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الإعدادات'));

    const content = el('div', { id: 'settings-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('general', content); _setActiveTab(this); } }, 'عام'),
      el('button', { class: 'tab', onclick: function () { _showTab('invoice', content); _setActiveTab(this); } }, 'الفاتورة والملصقات'),
      el('button', { class: 'tab', onclick: function () { _showTab('payments', content); _setActiveTab(this); } }, 'طرق الدفع'),
      el('button', { class: 'tab', onclick: function () { _showTab('backup', content); _setActiveTab(this); } }, 'النسخ الاحتياطي'),
      el('button', { class: 'tab', onclick: function () { _showTab('maintenance', content); _setActiveTab(this); } }, 'الصيانة'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('general', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'general') _renderGeneral(container);
    else if (tab === 'invoice') _renderInvoice(container);
    else if (tab === 'payments') _renderPayments(container);
    else if (tab === 'backup') _renderBackup(container);
    else if (tab === 'maintenance') _renderMaintenance(container);
  }

  async function _renderGeneral(container) {
    const res = await BeeStore.api.settings.get();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const s = res.data;

    const nameInput = input('text', s.storeName || '');
    const nameArInput = input('text', s.storeNameAr || '');
    const phoneInput = input('text', s.phone || '');
    const addressInput = input('text', s.address || '');

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'معلومات المتجر'),
      formField('اسم المتجر (إنجليزي)', nameInput),
      formField('اسم المتجر (عربي)', nameArInput),
      formField('الهاتف', phoneInput),
      formField('العنوان', addressInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const saveRes = await BeeStore.api.settings.update({
            storeName: nameInput.value.trim(),
            storeNameAr: nameArInput.value.trim(),
            phone: phoneInput.value.trim(),
            address: addressInput.value.trim(),
          });
          if (saveRes.ok) toast('تم الحفظ');
          else toast(saveRes.error.message, 'error');
        },
      }, 'حفظ'),
    ]));
  }

  async function _renderInvoice(container) {
    const res = await BeeStore.api.settings.get();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const s = res.data;

    const prefixInput = input('text', s.invoicePrefix || 'INV');
    const footerInput = textarea(s.invoiceFooter || '');
    const paperSelect = select([
      { value: 'A4', label: 'A4' },
      { value: '80mm', label: '80mm حراري' },
    ], s.invoicePaperSize || 'A4');
    const taxEnabled = select([
      { value: 'true', label: 'مفعل' },
      { value: 'false', label: 'معطل' },
    ], String(s.taxEnabled ? 'true' : 'false'));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'إعدادات الفاتورة'),
      formField('بادئة الفاتورة', prefixInput),
      formField('نص التذييل', footerInput),
      formField('حجم الورق', paperSelect),
      formField('الضريبة', taxEnabled),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const saveRes = await BeeStore.api.settings.update({
            invoicePrefix: prefixInput.value.trim(),
            invoiceFooter: footerInput.value,
            invoicePaperSize: paperSelect.value,
            taxEnabled: taxEnabled.value === 'true',
          });
          if (saveRes.ok) toast('تم الحفظ');
          else toast(saveRes.error.message, 'error');
        },
      }, 'حفظ'),
    ]));
  }

  async function _renderPayments(container) {
    const settingsRes = await BeeStore.api.settings.get();
    if (!settingsRes.ok) { toast(settingsRes.error.message, 'error'); return; }
    const s = settingsRes.data;
    const accRes = await BeeStore.api.accounts.list();
    const accounts = accRes.ok ? accRes.data : [];

    const rows = el('div', { id: 'payment-methods-rows' });

    function _accountOptions(selectedId) {
      const opts = [{ value: '', label: '— بدون حساب —' }];
      for (const a of accounts) opts.push({ value: a.id, label: a.name });
      return select(opts, selectedId || '');
    }

    function _addRow(method) {
      const nameInput = input('text', method ? method.name : '', { placeholder: 'اسم الطريقة (مثل جوال باي)' });
      const accSelect = _accountOptions(method ? method.accountId : '');
      const id = (method && method.id) || BeeStore.ids.randomId('pm');
      const row = el('div', { class: 'payment-method-row', 'data-id': id });
      row.appendChild(el('div', { class: 'form-group', style: 'flex:2; min-width:140px;' }, [el('label', { class: 'form-label' }, 'الاسم'), nameInput]));
      row.appendChild(el('div', { class: 'form-group', style: 'flex:2; min-width:140px;' }, [el('label', { class: 'form-label' }, 'الحساب'), accSelect]));
      row.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => row.remove(), style: 'align-self:flex-end;' }, 'حذف'));
      row._nameInput = nameInput;
      row._accSelect = accSelect;
      rows.appendChild(row);
    }

    const methods = (s.paymentMethods && s.paymentMethods.length) ? s.paymentMethods : BeeStore.settings.methodOptions();
    for (const m of methods) _addRow(m);

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'طرق الدفع'),
      el('p', { class: 'form-hint' }, 'تظهر هذه الطرق في نقطة البيع وعند استلام الدفعات، ويمكن ربط كل طريقة بحساب (الصندوق/البنك).'),
      rows,
      el('div', { class: 'dialog-actions' }, [
        el('button', { class: 'btn btn-secondary', onclick: () => _addRow(null) }, '+ إضافة طريقة'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const list = [];
            rows.querySelectorAll('.payment-method-row').forEach(row => {
              const name = row._nameInput.value.trim();
              if (!name) return;
              list.push({ id: row.getAttribute('data-id'), name, accountId: row._accSelect.value || null });
            });
            if (list.length === 0) { toast('أضف طريقة واحدة على الأقل', 'error'); return; }
            const saveRes = await BeeStore.api.settings.update({ paymentMethods: list });
            if (saveRes.ok) toast('تم الحفظ');
            else toast(saveRes.error.message, 'error');
          },
        }, 'حفظ'),
      ]),
    ]));
  }

  async function _renderBackup(container) {
    const fileSync = BeeStore.fileSync;
    const status = fileSync ? fileSync.getStatus() : { supported: false };
    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const folderName = status.folderName || s.dataFolderName || null;

    let statusText = 'غير متاح في هذا المتصفح';
    if (status.supported) {
      if (!folderName) statusText = 'لم يتم اختيار مجلد بعد';
      else if (status.status === 'ok') statusText = 'متصل — الحفظ يعمل';
      else if (status.status === 'need-permission') statusText = 'بحاجة إلى إذن الكتابة في المجلد';
      else if (status.status === 'error') statusText = 'خطأ: ' + (status.lastError || 'غير معروف');
      else statusText = 'متصل';
    }

    const buttons = [];
    buttons.push(el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        if (!fileSync) return;
        const ok = await fileSync.pickFolder();
        toast(ok ? 'تم اختيار المجلد وحفظه' : 'فشل اختيار المجلد', ok ? 'success' : 'error');
        if (ok) _showTab('backup', container);
      },
    }, folderName ? 'تغيير مجلد البيانات' : 'اختيار مجلد البيانات'));

    if (status.supported && folderName && status.status === 'need-permission') {
      buttons.push(el('button', {
        class: 'btn btn-warning',
        onclick: async () => {
          const ok = await fileSync.requestPermission();
          toast(ok ? 'تم منح الإذن' : 'لم يتم منح الإذن', ok ? 'success' : 'error');
          _showTab('backup', container);
        },
      }, 'السماح بالكتابة في المجلد'));
    }

    if (status.supported && folderName) {
      buttons.push(el('button', {
        class: 'btn btn-secondary',
        onclick: async () => {
          const ok = await fileSync.saveNow();
          toast(ok ? 'تم الحفظ في المجلد' : 'تعذر الحفظ - تحقق من الإذن', ok ? 'success' : 'error');
          _showTab('backup', container);
        },
      }, 'حفظ الآن'));

      buttons.push(el('button', {
        class: 'btn btn-danger',
        onclick: () => {
          confirmDialog('فصل المجلد', 'سيتم نسيان المجلد المحدد (لن تُحذف الملفات). هل تريد المتابعة؟', async () => {
            await fileSync.disconnect();
            toast('تم فصل المجلد');
            _showTab('backup', container);
          });
        },
      }, 'فصل المجلد'));
    }

    buttons.push(el('button', {
      class: 'btn btn-secondary',
      onclick: async () => {
        const res = await BeeStore.api.backup.download();
        if (res.ok) toast('تم تحميل النسخة الاحتياطية');
      },
    }, 'تحميل نسخة احتياطية'));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'حالة الحفظ في الملف'),
      el('p', {}, status.supported ? 'المتصفح: مدعوم' : 'المتصفح: غير مدعوم'),
      el('p', {}, 'مجلد البيانات: ' + (folderName || '—')),
      el('p', {}, 'الحالة: ' + statusText),
      status.lastSavedAt ? el('p', {}, 'آخر حفظ: ' + BeeStore.dates.formatDateTime(status.lastSavedAt)) : null,
      el('p', { class: 'form-hint' }, 'يُحفظ مكان المجلد ويُستعاد تلقائياً عند إعادة فتح البرنامج. قد يطلب المتصفح تأكيد الإذن مرة واحدة في كل جلسة.'),
      el('div', { class: 'dialog-actions' }, buttons),
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'استعادة نسخة احتياطية'),
      el('p', {}, 'يمكنك استعادة نسخة احتياطية من الملفات المحفوظة'),
      el('button', {
        class: 'btn btn-warning',
        onclick: () => {
          const fileInput = el('input', { type: 'file', accept: '.json', style: 'display:none' });
          document.body.appendChild(fileInput);
          fileInput.onchange = () => {
            const file = fileInput.files[0];
            document.body.removeChild(fileInput);
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
              try {
                const data = JSON.parse(e.target.result);
                const res = await BeeStore.api.backup.restore(data);
                if (res.ok) { toast('تم الاستعادة بنجاح'); setTimeout(() => location.reload(), 1500); }
                else toast(res.error.message, 'error');
              } catch (err) {
                toast('ملف غير صالح: ' + err.message, 'error');
              }
            };
            reader.onerror = () => toast('فشل قراءة الملف', 'error');
            reader.readAsText(file);
          };
          fileInput.click();
        },
      }, 'استعادة من ملف'),
    ]));
  }

  async function _renderMaintenance(container) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'الصيانة'),
      el('div', { class: 'dialog-actions' }, [
        el('button', {
          class: 'btn btn-secondary',
          onclick: async () => {
            const res = await BeeStore.api.maintenance.recalculateStock();
            if (res.ok) toast('تم إعادة حساب المخزون: ' + res.data.length + ' تحديث');
            else toast(res.error.message, 'error');
          },
        }, 'إعادة حساب المخزون'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const host = document.getElementById('integrity-result');
            if (host) host.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';
            const res = await BeeStore.api.maintenance.integrityCheck();
            if (host) {
              host.innerHTML = '';
              if (!res.ok) { host.appendChild(el('p', { class: 'alert alert-danger' }, res.error.message)); return; }
              const { errors, warnings } = res.data;
              host.appendChild(errors.length === 0
                ? el('p', { class: 'alert alert-success' }, '✓ الفحص سليم' + (warnings.length ? ' مع ' + warnings.length + ' تنبيهات' : ''))
                : el('p', { class: 'alert alert-danger' }, '⛔ ' + errors.length + ' أخطاء'));
              for (const x of [...errors, ...warnings]) {
                host.appendChild(el('p', {}, (x.level === 'error' ? '⛔ ' : '⚠️ ') + '[' + x.check + '] ' + x.message + (x.recordId ? ' (' + x.recordId + ')' : '')));
              }
            } else if (res.ok) {
              toast(res.data.errors.length === 0 ? 'الفحص سليم' : res.data.errors.length + ' أخطاء', res.data.errors.length === 0 ? 'success' : 'error');
            } else {
              toast(res.error.message, 'error');
            }
          },
        }, 'فحص سلامة البيانات'),
        el('button', {
          class: 'btn btn-info',
          onclick: () => _loadDemoData(),
        }, 'تحميل بيانات تجريبية'),
        el('button', {
          class: 'btn btn-danger',
          onclick: () => _resetAll(),
        }, 'حذف كل البيانات'),
      ]),
      el('div', { id: 'integrity-result' }),
    ]));

    // v2 §12.3: error log viewer (technical details only, no business data).
    const errList = el('div', { id: 'errorlog-list' }, [el('p', {}, 'جاري التحميل...')]);
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'سجل الأخطاء'),
      errList,
      el('div', { class: 'dialog-actions' }, [
        el('button', {
          class: 'btn btn-secondary',
          onclick: async () => {
            await BeeStore.errorLog.diagnostics();
            toast('تم تحميل ملف التشخيص');
          },
        }, 'تحميل التشخيص'),
        el('button', {
          class: 'btn btn-danger',
          onclick: () => {
            BeeStore.ui.confirmDialog('مسح السجل', 'هل تريد مسح سجل الأخطاء؟', async () => {
              await BeeStore.errorLog.clear();
              _showTab('maintenance', container);
            });
          },
        }, 'مسح السجل'),
      ]),
    ]));
    _loadErrorLog(errList);
  }

  async function _loadErrorLog(host) {
    try {
      const entries = await BeeStore.errorLog.list(20);
      host.innerHTML = '';
      if (entries.length === 0) {
        host.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أخطاء مسجلة'));
        return;
      }
      host.appendChild(el('table', { class: 'data-table' }, [el('tbody', {},
        entries.map(e => el('tr', {}, [
          el('td', {}, (e.timestamp || '').slice(0, 19).replace('T', ' ')),
          el('td', {}, e.source || ''),
          el('td', {}, e.message || ''),
        ])))]));
    } catch (e) { host.innerHTML = ''; }
  }

  async function _safetyBackup() {
    // Spec §12: backup first (folder copy if linked + always a file download).
    try { await BeeStore.api.backup.createNow(); } catch (e) { /* folder may be unlinked */ }
    try { await BeeStore.api.backup.download(); } catch (e) { /* ignore */ }
  }

  async function _loadDemoData() {
    const empty = await BeeStore.api.maintenance.isDatabaseEmpty();
    if (!empty.data) {
      const confirm = prompt('اكتب "تأكيد" لتحميل البيانات التجريبية (سيتم حذف البيانات الحالية):');
      if (confirm !== 'تأكيد') return;
      await _safetyBackup();
    }
    const res = await BeeStore.api.maintenance.resetAll();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    if (typeof BeeStore.loadDemoData === 'function') {
      await BeeStore.loadDemoData();
    }
    toast('تم تحميل البيانات التجريبية');
    setTimeout(() => location.reload(), 1500);
  }

  function _resetAll() {
    const confirm = prompt('اكتب "حذف" لحذف كل البيانات والبدء من جديد:');
    if (confirm !== 'حذف') return;
    BeeStore.ui.confirmDialog('حذف كل البيانات', 'هل أنت متأكد؟ سيتم أخذ نسخة احتياطية أولاً، ولا يمكن التراجع!', async () => {
      await _safetyBackup();
      const res = await BeeStore.api.maintenance.resetAll();
      if (res.ok) {
        toast('تم حذف جميع البيانات');
        setTimeout(() => location.reload(), 1500);
      } else {
        toast(res.error.message, 'error');
      }
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.settings = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
