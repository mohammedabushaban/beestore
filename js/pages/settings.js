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
      el('button', { class: 'tab', onclick: function () { _showTab('data', content); _setActiveTab(this); } }, 'البيانات'),
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
    // Render each tab into its own panel. An async tab (e.g. البيانات waits for
    // storage/update info) must not append its cards into a tab the user has
    // already switched to; a detached panel makes late writes harmless.
    const host = container._settingsHost || container;
    host.innerHTML = '';
    const panel = el('div', { class: 'settings-panel' });
    panel._settingsHost = host;
    host.appendChild(panel);
    if (tab === 'general') _renderGeneral(panel);
    else if (tab === 'invoice') _renderInvoice(panel);
    else if (tab === 'payments') _renderPayments(panel);
    else if (tab === 'backup') _renderBackup(panel);
    else if (tab === 'data') _renderData(panel);
    else if (tab === 'maintenance') _renderMaintenance(panel);
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

  /**
   * v3-Lite §2: storage persistence, install state, offline readiness, safe
   * updates, and the automatic pre-migration snapshots. Phone-first wording.
   */
  async function _renderData(container) {
    const pwa = BeeStore.pwa;
    const state = pwa ? pwa.getState() : {
      supported: false, installed: false, offlineReady: false,
      updateAvailable: false, applying: false, online: true, lastError: null,
    };
    const storage = pwa ? await pwa.storageStatus() : { supported: false, persisted: false, usage: null, quota: null };
    const cacheVersion = pwa ? await pwa.getCacheVersion() : null;

    let snapshots = [];
    if (BeeStore.snapshots) {
      try { snapshots = await BeeStore.snapshots.list(); } catch (e) { snapshots = []; }
    }
    const latestSnapshot = snapshots.length ? snapshots[0] : null;

    const settingsRes = await BeeStore.api.settings.get();
    const settings = settingsRes.ok ? settingsRes.data : {};
    const meta = await BeeStore.repo.get('meta', 'meta') || {};
    const collectionCounts = {};
    let totalRecords = 0;
    if (BeeStore.repo && typeof BeeStore.repo.count === 'function') {
      for (const name of (BeeStore.COLLECTIONS || [])) {
        if (name === 'meta') continue;
        const count = await BeeStore.repo.count(name);
        collectionCounts[name] = count;
        totalRecords += count;
      }
    }

    const storageRows = [];
    if (!storage.supported) {
      storageRows.push(el('p', { class: 'alert alert-warning' },
        'هذا المتصفح لا يدعم طلب التخزين الدائم. البيانات تبقى في IndexedDB، لكن المتصفح قد يحذفها إذا ضغطت مساحة الهاتف. احتفظ بنسخة احتياطية خارج الهاتف.'));
    } else {
      storageRows.push(el('p', {}, storage.persisted
        ? '✅ التخزين الدائم مفعّل — المتصفح لن يحذف بيانات التطبيق تلقائياً عند ضغط المساحة.'
        : '⚠️ التخزين الدائم غير مفعّل — قد يحذف المتصفح البيانات عند ضغط مساحة الهاتف.'));
      if (storage.usage != null && storage.quota) {
        const pct = Math.min(100, Math.round((storage.usage / storage.quota) * 100));
        storageRows.push(el('p', { class: 'form-hint' },
          'المستخدم: ' + _formatBytes(storage.usage) + ' من ' + _formatBytes(storage.quota) + ' (' + pct + '%).'));
        if (pct >= 90) {
          storageRows.push(el('p', { class: 'alert alert-danger' },
            '⛔ مساحة التخزين شبه ممتلئة (' + pct + '%). خذ نسخة احتياطية خارج الهاتف الآن، ثم احذف اللقطات القديمة أو البيانات غير الضرورية.'));
        } else if (pct >= 70) {
          storageRows.push(el('p', { class: 'alert alert-warning' },
            '⚠️ مساحة التخزين تقترب من الامتلاء (' + pct + '%). خذ نسخة احتياطية خارج الهاتف وراجع حجم البيانات.'));
        }
        const started = settings.systemStartDate || (meta.createdAt || '').slice(0, 10);
        const startedTime = started ? new Date(started + 'T00:00:00').getTime() : NaN;
        const days = Number.isFinite(startedTime) ? Math.max(1, (Date.now() - startedTime) / 86400000) : null;
        if (days) {
          const yearly = Math.round((storage.usage / days) * 365);
          storageRows.push(el('p', { class: 'form-hint' },
            'تقدير الاستخدام السنوي: ' + _formatBytes(yearly) + ' (بناءً على ' + Math.round(days) + ' يوم).'));
        }
      }
      if (totalRecords > 0) {
        const labels = {
          sales: 'فواتير', products: 'منتجات', variants: 'متغيرات',
          stockMovements: 'حركات مخزون', purchases: 'مشتريات', expenses: 'مصاريف',
        };
        const top = ['sales', 'products', 'variants', 'stockMovements', 'purchases', 'expenses']
          .filter(function (name) { return collectionCounts[name] > 0; })
          .map(function (name) { return labels[name] + ': ' + collectionCounts[name]; });
        storageRows.push(el('p', { class: 'form-hint' },
          'إجمالي السجلات: ' + totalRecords + (top.length ? ' · ' + top.join(' · ') : '')));
      }
      if (!storage.persisted) {
        storageRows.push(el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: async function () {
            const result = await pwa.requestPersistence();
            toast(result.persisted ? 'تم تفعيل التخزين الدائم' : 'لم يمنح المتصفح التخزين الدائم', result.persisted ? 'success' : 'warning');
            _showTab('data', container);
          },
        }, 'طلب تخزين دائم'));
      }
    }

    const installRows = [];
    installRows.push(el('p', {}, state.installed
      ? '✅ التطبيق مثبّت ويعمل كتطبيق مستقل.'
      : '📱 التطبيق يعمل الآن داخل تبويب المتصفح. ثبّته كتطبيق على جهازك ليعمل دون شريط المتصفح.'));
    installRows.push(el('div', { class: 'dialog-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: function () { if (pwa) pwa.install(); },
      }, state.installed ? 'طريقة التثبيت' : 'تثبيت التطبيق'),
      !state.installed && pwa ? el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        onclick: function () { pwa.showInstallGuide(); },
      }, 'دليل التثبيت') : null,
    ]));

    const updateRows = [];
    if (!state.supported) {
      updateRows.push(el('p', { class: 'alert alert-warning' },
        'العمل دون إنترنت غير متاح لأن التطبيق لم يُفتح عبر رابط https. افتح النسخة المنشورة ثم ثبّتها.'));
    } else {
      updateRows.push(el('p', {}, state.offlineReady
        ? '✅ التطبيق محفوظ على الهاتف ويعمل دون إنترنت.'
        : '⏳ جارٍ تجهيز النسخة المحلية. أعد فتح الصفحة مرة واحدة ثم سيعمل التطبيق دون إنترنت.'));
      updateRows.push(el('p', { class: 'form-hint' },
        'الإصدار: ' + (BeeStore.version || '—') + ' · نسخة الكاش: ' + (cacheVersion || '—')));
      if (state.updateAvailable) {
        updateRows.push(el('p', { class: 'alert alert-info' }, '🔄 يوجد تحديث جاهز. حدّث عندما لا تكون في منتصف فاتورة.'));
        updateRows.push(el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: function () {
            if (pwa && pwa.applyUpdate()) toast('جارٍ تطبيق التحديث...', 'info');
          },
        }, 'تحديث الآن'));
      } else {
        updateRows.push(el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: async function () {
            const result = await pwa.checkForUpdate();
            if (!result.ok) toast('تعذّر التحقق من التحديث', 'error');
            else toast(result.updateAvailable ? 'يوجد تحديث متوفر' : 'أنت على أحدث إصدار', result.updateAvailable ? 'info' : 'success');
            setTimeout(function () { _showTab('data', container); }, 1200);
          },
        }, 'التحقق من التحديث'));
      }
    }

    const snapshotRows = [];
    if (!latestSnapshot) {
      snapshotRows.push(el('p', { class: 'form-hint' }, 'لا توجد لقطات محلية بعد. تُنشأ لقطة تلقائياً قبل أي تحديث لقاعدة البيانات.'));
    } else {
      snapshotRows.push(el('div', { class: 'path-box' }, [
        el('span', { class: 'path-icon', 'aria-hidden': 'true' }, '🧷'),
        el('div', { class: 'path-content' }, [
          el('div', { class: 'path-label' }, latestSnapshot.reason === 'pre-migration' ? 'لقطة قبل تحديث البيانات' : 'لقطة محلية'),
          el('div', { class: 'path-meta' }, [
            el('span', {}, BeeStore.dates.formatDateTime(latestSnapshot.createdAt)),
            el('span', {}, _formatBytes(latestSnapshot.size)),
            el('span', {}, (latestSnapshot.documents || 0) + ' سجل'),
          ]),
        ]),
        el('button', {
          class: 'btn btn-sm btn-secondary',
          type: 'button',
          onclick: async function () {
            try {
              await BeeStore.snapshots.download(latestSnapshot.id);
              toast('تم تنزيل اللقطة');
            } catch (e) {
              toast('تعذّر تنزيل اللقطة', 'error');
            }
          },
        }, 'تنزيل'),
      ]));
      snapshotRows.push(el('p', { class: 'form-hint' },
        'تُحفظ آخر ' + ((BeeStore.config && BeeStore.config.snapshotCount) || 10) + ' لقطات محلياً داخل قاعدة بيانات منفصلة. اللقطة ليست بديلاً عن النسخة الاحتياطية خارج الهاتف.'));
    }

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'التخزين على هذا الهاتف'),
      ...storageRows,
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'التطبيق والعمل دون إنترنت'),
      ...installRows,
      el('hr', { class: 'card-divider' }),
      ...updateRows,
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'لقطات الأمان المحلية'),
      ...snapshotRows,
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'معلومات التطبيق'),
      el('p', {}, 'بي ستور — v3-Lite · الإصدار ' + (BeeStore.version || '—')),
      el('p', { class: 'form-hint' }, 'إصدار مخطط البيانات: ' + (BeeStore.schemaVersion || '—') +
        ' · قاعدة البيانات: ' + ((BeeStore.config && BeeStore.config.dbName) || '—')),
      el('p', { class: 'form-hint' },
        'بياناتك مرتبطة بأصل الموقع (المخطط + النطاق + المنفذ). تغيير النطاق أو المنفذ أو http/https ينشئ قاعدة فارغة؛ خذ نسخة احتياطية قبل أي انتقال. تغيير المسار وحده لا ينشئ قاعدة جديدة.'),
    ]));
  }

  async function _renderBackup(container) {
    const fileSync = BeeStore.fileSync;
    const status = fileSync ? fileSync.getStatus() : { supported: false };
    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const backupRes = await BeeStore.api.backup.status();
    const backupStatus = backupRes.ok ? backupRes.data : {};
    const folderName = status.folderName || s.dataFolderName || null;
    const fileName = status.fileName || 'db.json';
    const backupDir = status.backupDir || 'backups';
    const relativePath = folderName ? folderName + '/' + fileName : null;

    let fileInfo = null;
    let backups = [];
    if (fileSync && status.hasHandle) {
      try { fileInfo = await fileSync.getFileInfo(); } catch (e) { /* ignore */ }
      try { backups = await fileSync.listBackups(); } catch (e) { /* ignore */ }
    }

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

    container.appendChild(_offDeviceBackupCard(backupStatus, s, container));

    container.appendChild(_storageLocationCard({
      supported: status.supported,
      hasHandle: !!status.hasHandle,
      needPermission: status.status === 'need-permission',
      folderName,
      fileName,
      backupDir,
      relativePath,
      fileInfo,
      backups,
    }));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'حالة الحفظ في الملف'),
      el('p', {}, status.supported ? 'المتصفح: مدعوم' : 'المتصفح: غير مدعوم'),
      el('p', {}, 'الحالة: ' + statusText),
      status.lastSavedAt ? el('p', {}, 'آخر حفظ: ' + BeeStore.dates.formatDateTime(status.lastSavedAt)) : null,
      el('p', { class: 'form-hint' }, 'يُحفظ مكان المجلد ويُستعاد تلقائياً عند إعادة فتح البرنامج. قد يطلب المتصفح تأكيد الإذن مرة واحدة في كل جلسة.'),
      el('div', { class: 'dialog-actions' }, buttons),
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'استعادة نسخة احتياطية'),
      el('p', {}, 'اختر ملف نسخة احتياطية (.json) — عادي أو مشفّر. سيُتحقق من سلامته وتظهر لك ملخص قبل الاستبدال.'),
      el('p', { class: 'form-hint' }, 'تُنشأ نسخة أمان داخلية تلقائياً قبل الاستعادة. إذا كانت النسخة من جهاز آخر، توقّف عن العمل على الجهاز القديم بعد الاستعادة.'),
      el('button', {
        class: 'btn btn-warning',
        type: 'button',
        onclick: function () { BeeStore.backupUI.restoreFromFile(); },
      }, 'استعادة من ملف'),
    ]));
  }

  function _offDeviceBackupCard(status, settings, container) {
    const methodLabel = status.lastBackupMethod === 'share'
      ? 'تمت مشاركتها خارج الهاتف'
      : status.lastBackupMethod === 'download'
        ? 'نُزّلت على هذا الجهاز — تأكد من نقلها خارج الهاتف'
        : '';
    let statusLine;
    let statusClass = 'form-hint';
    if (status.lastBackupAt) {
      statusLine = 'آخر نسخة احتياطية: ' + BeeStore.dates.formatDateTime(status.lastBackupAt) +
        (methodLabel ? ' — ' + methodLabel : '');
      if (status.critical) {
        statusClass = 'alert alert-danger';
        statusLine = '⚠️ نسخة احتياطية متأخرة جداً. ' + statusLine + ' — مرّ أكثر من ' + Math.floor(status.ageDays || 0) + ' يوم.';
      } else if (status.overdue) {
        statusClass = 'alert alert-warning';
        statusLine = '⚠️ حان وقت النسخة الاحتياطية. ' + statusLine + ' — مرّ أكثر من ' + Math.floor(status.ageDays || 0) + ' يوم.';
      }
    } else {
      statusLine = 'لم تُنشئ نسخة احتياطية خارج الجهاز بعد. الهاتف هو النسخة الوحيدة من بياناتك.';
      statusClass = status.critical ? 'alert alert-danger' : 'alert alert-warning';
    }

    const encryptToggle = el('input', { type: 'checkbox', id: 'backup-encrypt' });
    const passInput = input('password', '', {
      autocomplete: 'new-password',
      placeholder: 'كلمة مرور التشفير',
      disabled: true,
    });
    const passGroup = el('div', { class: 'form-group', style: 'display: none;' }, [
      el('label', { class: 'form-label', for: 'backup-passphrase' }, 'كلمة المرور *'),
      passInput,
      el('p', { class: 'form-hint' }, 'لن تُحفظ كلمة المرور في البرنامج. إن نسيتها لا يمكن استعادة هذه النسخة.'),
    ]);
    passInput.id = 'backup-passphrase';
    encryptToggle.onchange = function () {
      passInput.disabled = !encryptToggle.checked;
      passGroup.style.display = encryptToggle.checked ? 'block' : 'none';
      if (encryptToggle.checked) setTimeout(function () { passInput.focus(); }, 50);
    };

    function options() {
      const encrypt = !!encryptToggle.checked;
      const passphrase = encrypt ? String(passInput.value || '') : null;
      if (encrypt && !passphrase) {
        toast('أدخل كلمة مرور التشفير أولاً', 'error');
        passInput.focus();
        return null;
      }
      return { encrypt: encrypt, passphrase: passphrase };
    }

    return el('div', { class: 'card' }, [
      el('h3', {}, 'نسخة احتياطية خارج الجهاز'),
      el('p', { class: statusClass }, statusLine),
      el('p', {}, 'الهاتف وحده ليس مكاناً آمناً للنسخة الوحيدة. أنشئ نسخة وشاركها إلى Drive أو واتساب أو بريد إلكتروني، أو نزّلها وانقلها خارج الهاتف.'),
      settings.address ? null : el('p', { class: 'alert alert-warning' },
        '⚠️ عنوان المتجر فارغ. أضف العنوان من تبويب «عام» قبل إنشاء النسخة النهائية.'),
      el('div', { class: 'backup-encrypt-row' }, [
        el('label', { for: 'backup-encrypt', style: 'display:flex;align-items:center;gap:8px;cursor:pointer;' }, [
          encryptToggle,
          el('span', {}, 'تشفير بكلمة مرور (موصى به عند الإرسال عبر واتساب)'),
        ]),
      ]),
      passGroup,
      el('div', { class: 'dialog-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: async function () {
            const opts = options();
            if (!opts) return;
            await BeeStore.backupUI.shareBackup(opts);
            _showTab('backup', container);
          },
        }, 'نسخ ومشاركة'),
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: async function () {
            const opts = options();
            if (!opts) return;
            await BeeStore.backupUI.downloadBackup(opts);
            _showTab('backup', container);
          },
        }, 'تنزيل فقط'),
      ]),
      el('p', { class: 'form-hint' }, 'إذا لم يدعم المتصفح مشاركة الملفات، سيُنزّل الملف تلقائياً. ملف النسخة يحمل بصمة SHA-256 للتحقق من سلامته.'),
    ]);
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

  /**
   * Card that answers "where is my data saved?" with the folder name, the
   * JSON file name, its size/date, and the backups folder. The browser never
   * reveals the absolute OS path, so we show exactly what is available and
   * say so in plain Arabic.
   */
  function _storageLocationCard(info) {
    const children = [el('h3', {}, 'مكان حفظ البيانات')];

    if (!info.supported) {
      children.push(el('p', { class: 'alert alert-warning' },
        'هذا المتصفح لا يدعم الحفظ في مجلد. استخدم Chrome أو Edge على الكمبيوتر لربط مجلد وحفظ ملف بيانات قابل للنسخ.'));
      children.push(el('p', { class: 'form-hint' }, [
        'البيانات الحالية محفوظة داخل قاعدة بيانات المتصفح ',
        el('code', { dir: 'ltr' }, BeeStore.config.dbName),
        '.',
      ]));
      return el('div', { class: 'card' }, children);
    }

    if (!info.hasHandle) {
      children.push(el('div', { class: 'storage-browser' }, [
        el('span', { class: 'storage-icon', 'aria-hidden': 'true' }, '🗄️'),
        el('div', {}, [
          el('div', { class: 'storage-title' }, 'البيانات محفوظة داخل المتصفح فقط'),
          el('p', { class: 'form-hint' }, [
            'قاعدة البيانات: ',
            el('code', { dir: 'ltr' }, BeeStore.config.dbName),
            ' (IndexedDB). اربط مجلداً من الزر أدناه لتُحفظ نسخة ',
            el('code', { dir: 'ltr' }, info.fileName),
            ' يمكنك فتحها ونسخها.',
          ]),
          info.folderName ? el('p', { class: 'form-hint' },
            'المجلد المرتبط سابقاً: ' + info.folderName + ' — أعد ربطه لمنح الإذن من جديد.') : null,
        ]),
      ]));
      return el('div', { class: 'card' }, children);
    }

    children.push(el('div', { class: 'path-box' }, [
      el('span', { class: 'path-icon', 'aria-hidden': 'true' }, '📁'),
      el('div', { class: 'path-content' }, [
        el('div', { class: 'path-label' }, 'مسار ملف الحفظ'),
        el('code', { class: 'path-value', dir: 'ltr' }, info.relativePath),
        el('div', { class: 'path-meta' }, [
          el('span', {}, 'اسم الملف: ' + info.fileName),
          el('span', {}, 'المجلد: ' + info.folderName),
        ]),
      ]),
      el('button', {
        class: 'btn btn-sm btn-secondary', type: 'button',
        onclick: () => _copyToClipboard(info.relativePath),
      }, 'نسخ'),
    ]));

    const facts = [];
    if (info.fileInfo) {
      facts.push(el('span', {}, 'الحجم: ' + _formatBytes(info.fileInfo.size)));
      facts.push(el('span', {}, 'آخر تعديل للملف: ' +
        BeeStore.dates.formatDateTime(new Date(info.fileInfo.lastModified).toISOString())));
    } else if (info.needPermission) {
      facts.push(el('span', {}, 'بحاجة إلى إذن المجلد لعرض حجم الملف وتاريخه.'));
    } else {
      facts.push(el('span', {}, 'ملف البيانات لم يُنشأ بعد — اضغط "حفظ الآن".'));
    }
    facts.push(el('span', {}, 'مجلد النسخ الاحتياطية: ' + info.folderName + '/' + info.backupDir + '/'));
    if (info.backups && info.backups.length > 0) {
      facts.push(el('span', {}, 'أحدث نسخة احتياطية: ' + info.backups[0].name));
    }
    children.push(el('div', { class: 'file-facts' }, facts));
    children.push(el('p', { class: 'form-hint' }, [
      'المتصفح لا يسمح لأي تطبيق بمعرفة المسار الكامل للقرص (مثل ',
      el('code', { dir: 'ltr' }, 'C:\\Users\\...'),
      ') لأسباب أمنية، لذلك يظهر اسم المجلد واسم الملف فقط. ' +
      'لتجد الملف افتح المجلد نفسه من مستكشف الملفات.',
    ]));

    return el('div', { class: 'card' }, children);
  }

  function _formatBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024) return bytes + ' بايت';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' كيلوبايت';
    return (bytes / (1024 * 1024)).toFixed(2) + ' ميجابايت';
  }

  function _copyToClipboard(text) {
    if (!text) return;
    const done = () => toast('تم نسخ المسار');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(() => _legacyCopy(text));
      return;
    }
    _legacyCopy(text);
  }

  function _legacyCopy(text) {
    try {
      const ta = el('textarea', { style: 'position:fixed;opacity:0;inset-inline-start:-9999px' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? 'تم نسخ المسار' : 'تعذّر النسخ', ok ? 'success' : 'error');
    } catch (e) {
      toast('تعذّر النسخ', 'error');
    }
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.settings = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
