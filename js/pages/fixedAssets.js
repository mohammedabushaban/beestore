(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, formatDocDate, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField, textarea } = BeeStore.dialogs;

  const STATUS_LABELS = { active: 'قيد الاستخدام', disposed: 'مباع' };
  const ROW_STATUS_LABELS = { posted: 'مُرحّل', pending: 'لم يُرحّل', cancelled: 'ملغى بالبيع' };

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الأصول الثابتة'));
    const settings = await BeeStore.settings.get();
    if (settings.fixedAssetsEnabled !== true) {
      renderDisabled(container, settings);
      return;
    }
    const content = el('div', { id: 'fixed-assets-content' });
    container.appendChild(content);
    await _renderRegister(content);
  }

  function renderDisabled(container, settings) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'وحدة الأصول الثابتة غير مفعّلة'),
      el('p', { class: 'form-hint' },
        'تُستخدم هذه الوحدة لتسجيل المعدات والأثاث والأجهزة وإهلاكها شهرياً بدلاً من تحميل تكلفتها على شهر واحد. راجع المحاسب أولاً، ثم فعّلها من الإعدادات ← الرواتب والأصول.'),
      el('p', { class: 'form-hint' },
        'حد التنبيه الحالي للمصروفات الكبيرة: ' +
        BeeStore.money.format(settings.capitalizationWarnThresholdMinor || 0)),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => BeeStore.router.navigate('/settings'),
      }, 'فتح الإعدادات'),
    ]));
  }

  async function _renderRegister(container) {
    container.innerHTML = '';
    const today = BeeStore.dates.today();
    const [listRes, registerRes] = await Promise.all([
      BeeStore.api.fixedAssets.list(),
      BeeStore.api.fixedAssets.register(today),
    ]);
    if (!listRes.ok) { toast(listRes.error.message, 'error'); return; }
    if (!registerRes.ok) { toast(registerRes.error.message, 'error'); return; }
    const assets = listRes.data;
    const register = registerRes.data;
    const byId = {};
    for (const row of register.rows) byId[row.id] = row;

    container.appendChild(el('div', { class: 'stats-grid' }, [
      el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-label' }, 'تكلفة الأصول'),
        el('div', { class: 'stat-value' }, formatMoney(register.costMinor)),
      ]),
      el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-label' }, 'مجمع الإهلاك'),
        el('div', { class: 'stat-value' }, formatMoney(register.accumulatedMinor)),
      ]),
      el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-label' }, 'القيمة الدفترية'),
        el('div', { class: 'stat-value' }, formatMoney(register.netMinor)),
      ]),
      el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-label' }, 'متبقي غير مدفوع'),
        el('div', { class: 'stat-value' }, formatMoney(
          assets.reduce((sum, a) => sum + Math.max(0,
            (Number(a.costMinor) || 0) - (Number(a.paidMinor) || 0)), 0))),
      ]),
    ]));

    const addBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => _addAsset(() => _renderRegister(container)),
    }, '+ أصل ثابت جديد');
    container.appendChild(el('div', { class: 'filter-row' }, [addBtn]));

    if (assets.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصول ثابتة مسجلة'));
      return;
    }

    const rows = assets.map(asset => {
      const reg = byId[asset.id];
      const cost = Number(asset.costMinor) || 0;
      const paid = Number(asset.paidMinor) || 0;
      const outstanding = Math.max(0, cost - paid);
      const life = Math.max(1, Number(asset.usefulLifeMonths) || 1);
      const monthly = Math.floor((cost - (Number(asset.salvageValueMinor) || 0)) / life);
      const actions = [
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: () => _showSchedule(asset),
        }, 'جدول الإهلاك'),
      ];
      if (asset.status === 'active') {
        if (outstanding > 0) {
          actions.push(el('button', {
            class: 'btn btn-sm btn-success',
            onclick: () => _payAsset(asset, () => _renderRegister(container)),
          }, 'سداد'));
        }
        actions.push(el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => _disposeAsset(asset, () => _renderRegister(container)),
        }, 'بيع / تخريد'));
      }
      actions.push(el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => _showPayments(asset, () => _renderRegister(container)),
      }, 'الدفعات'));
      actions.push(BeeStore.journalView.button(asset, { title: 'قيود الأصل ' + asset.name }));
      return [
        asset.name,
        formatDocDate(asset, 'purchaseDate'),
        formatMoney(cost),
        String(life),
        formatMoney(monthly),
        formatMoney(reg ? reg.accumulatedMinor : 0),
        formatMoney(reg ? reg.netMinor : 0),
        formatMoney(outstanding),
        STATUS_LABELS[asset.status] || asset.status,
        el('div', { class: 'row-actions' }, actions),
      ];
    });

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الأصل'), el('th', {}, 'تاريخ الشراء'), el('th', {}, 'التكلفة'),
          el('th', {}, 'العمر (أشهر)'), el('th', {}, 'الإهلاك الشهري'),
          el('th', {}, 'مجمع الإهلاك'), el('th', {}, 'القيمة الدفترية'),
          el('th', {}, 'غير مدفوع'), el('th', {}, 'الحالة'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _loadPaymentMethods(methodSelect, accSelect) {
    const res = await BeeStore.api.accounts.list();
    if (!res.ok || res.data.length === 0) return;
    const settings = await BeeStore.settings.get();
    methodSelect.innerHTML = '';
    for (const m of BeeStore.settings.methodOptions(settings)) {
      methodSelect.appendChild(el('option', { value: m.value }, m.label));
    }
    methodSelect.value = methodSelect.options.length ? methodSelect.options[0].value : 'cash';
    const cashDefault = BeeStore.settings.resolvePaymentAccount(settings, 'cash');
    for (const a of res.data) accSelect.appendChild(el('option', { value: a.id }, a.name));
    if (cashDefault) accSelect.value = cashDefault;
    if (!cashDefault && res.data.length === 1) accSelect.value = res.data[0].id;
  }

  function _addAsset(done) {
    const nameInput = input('text', '', { placeholder: 'مثال: رف عرض، ماكينة خياطة' });
    const dateInput = input('date', BeeStore.dates.today());
    const costInput = input('number', '', { min: 0, step: 0.01 });
    const lifeInput = input('number', '24', { min: 1, step: 1 });
    const salvageInput = input('number', '0', { min: 0, step: 0.01 });
    const paidInput = input('number', '', { min: 0, step: 0.01, placeholder: 'اتركه فارغاً للشراء الآجل' });
    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    const noteInput = textarea('');
    _loadPaymentMethods(methodSelect, accSelect);

    const { overlay } = BeeStore.dialogs.openDialog('أصل ثابت جديد', [
      formField('اسم الأصل', nameInput, true),
      formField('تاريخ الشراء', dateInput, true),
      formField('التكلفة', costInput, true),
      formField('العمر الإنتاجي (أشهر)', lifeInput, true,
        'يبدأ الإهلاك في الشهر التالي للشراء. القيمة المتبقية تُوزّع على آخر شهر.'),
      formField('القيمة التخريدية', salvageInput, false, 'القيمة المتوقعة في نهاية العمر. صفر إن لم تكن معروفة.'),
      formField('المدفوع الآن', paidInput, false, 'اتركه فارغاً إذا كان الشراء آجلاً بالكامل.'),
      formField('طريقة الدفع', methodSelect),
      formField('الحساب', accSelect),
      formField('ملاحظة', noteInput),
      el('p', { class: 'form-hint' },
        'سيُنشأ قيد الشراء وجدول الإهلاك الكامل. لا يمكن حذف الأصل؛ البيع يُغلق الأصل ويُلغي الإهلاك المستقبلي فقط.'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const cost = BeeStore.money.fromMajor(costInput.value);
          if (!nameInput.value.trim()) { toast('اسم الأصل مطلوب', 'error'); return; }
          if (cost <= 0) { toast('أدخل تكلفة صحيحة', 'error'); return; }
          const paidText = String(paidInput.value || '').trim();
          const paid = paidText === '' ? 0 : BeeStore.money.fromMajor(paidText);
          const res = await BeeStore.api.fixedAssets.create({
            name: nameInput.value.trim(),
            purchaseDate: dateInput.value || BeeStore.dates.today(),
            costMinor: cost,
            usefulLifeMonths: Math.floor(BeeStore.money.parseDecimal(lifeInput.value) || 0),
            salvageValueMinor: BeeStore.money.fromMajor(salvageInput.value),
            paidMinor: paid,
            method: methodSelect.value,
            accountId: accSelect.value || null,
            note: noteInput.value.trim(),
          });
          if (res.ok) {
            toast('تم تسجيل الأصل وجدول الإهلاك');
            overlay.remove();
            if (done) done();
          } else toast(res.error.message, 'error');
        },
      }, 'حفظ الأصل'),
    ]);
  }

  function _payAsset(asset, done) {
    const outstanding = Math.max(0,
      (Number(asset.costMinor) || 0) - (Number(asset.paidMinor) || 0));
    const amountInput = input('number', BeeStore.money.toMajor(outstanding), { min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    const noteInput = input('text', '', { placeholder: 'مرجع / ملاحظة' });
    _loadPaymentMethods(methodSelect, accSelect);

    const { overlay } = BeeStore.dialogs.openDialog('سداد دفعة أصل ثابت', [
      el('p', { class: 'form-hint' }, 'المتبقي على الأصل: ' + formatMoney(outstanding)),
      formField('التاريخ', dateInput, true),
      formField('المبلغ', amountInput, true),
      formField('طريقة الدفع', methodSelect),
      formField('الحساب', accSelect),
      formField('ملاحظة', noteInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.fixedAssets.pay(asset.id, {
            date: dateInput.value || BeeStore.dates.today(),
            amountMinor: amount,
            method: methodSelect.value,
            accountId: accSelect.value || null,
            note: noteInput.value.trim(),
          });
          if (res.ok) {
            toast('تم تسجيل الدفعة');
            overlay.remove();
            if (done) done();
          } else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _disposeAsset(asset, done) {
    const dateInput = input('date', BeeStore.dates.today());
    const proceedsInput = input('number', '0', { min: 0, step: 0.01 });
    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    const noteInput = input('text', '', { placeholder: 'ملاحظة / سبب البيع' });
    _loadPaymentMethods(methodSelect, accSelect);

    const { overlay } = BeeStore.dialogs.openDialog('بيع / تخريد أصل ثابت', [
      el('p', { class: 'form-hint' },
        'سيُعكس الإهلاك المستقبلي فقط، ويُسجّل الفرق بين ثمن البيع والقيمة الدفترية ربحاً أو خسارة.'),
      formField('تاريخ البيع', dateInput, true),
      formField('ثمن البيع', proceedsInput, false, 'اتركه صفراً في حالة التخريد بدون مقابل.'),
      formField('طريقة الاستلام', methodSelect),
      formField('الحساب', accSelect),
      formField('ملاحظة', noteInput),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => {
          const amount = BeeStore.money.fromMajor(proceedsInput.value);
          confirmDialog('تأكيد بيع الأصل',
            'لا يمكن التراجع عن البيع من هذه الشاشة. هل تريد المتابعة؟',
            async () => {
              overlay.remove();
              const res = await BeeStore.api.fixedAssets.dispose(asset.id, {
                date: dateInput.value || BeeStore.dates.today(),
                proceedsMinor: amount,
                method: methodSelect.value,
                accountId: accSelect.value || null,
                note: noteInput.value.trim(),
              });
              if (res.ok) {
                toast('تم تسجيل بيع الأصل');
                if (done) done();
              } else toast(res.error.message, 'error');
            }, { confirmText: 'تأكيد البيع' });
        },
      }, 'حفظ البيع'),
    ]);
  }

  async function _showSchedule(asset) {
    const res = await BeeStore.api.fixedAssets.schedule(asset.id);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const rows = res.data.map(item => [
      item.month,
      formatMoney(item.amountMinor),
      ROW_STATUS_LABELS[item.status] || item.status,
    ]);
    const { overlay } = BeeStore.dialogs.openDialog('جدول إهلاك ' + asset.name, [
      el('p', { class: 'form-hint' },
        'الإهلاك الشهري = (التكلفة − القيمة التخريدية) ÷ العمر، والباقي في آخر شهر. يبدأ الشهر التالي للشراء.'),
      el('div', { class: 'table-wrapper', style: 'max-height:55vh; overflow:auto;' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'الشهر'), el('th', {}, 'المبلغ'), el('th', {}, 'الحالة'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ),
      el('button', { class: 'btn btn-secondary', onclick: () => overlay.remove() }, 'إغلاق'),
    ], { large: true });
  }

  async function _showPayments(asset, done) {
    const res = await BeeStore.api.fixedAssets.payments(asset.id);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const rows = res.data.map(payment => [
      formatDocDate(payment),
      formatMoney(payment.amountMinor),
      payment.method || '-',
      payment.note || '-',
      BeeStore.journalView.button(payment, { title: 'قيد دفعة الأصل' }) || '',
      el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: () => {
          confirmDialog('إلغاء دفعة الأصل',
            'سيُعكس قيد الدفعة في تاريخها الأصلي. هل تريد المتابعة؟',
            async () => {
              const voidRes = await BeeStore.api.fixedAssets.voidPayment(payment.id,
                'إلغاء من شاشة الأصول');
              if (voidRes.ok) {
                toast('تم إلغاء الدفعة');
                overlay.remove();
                if (done) done();
              } else toast(voidRes.error.message, 'error');
            }, { confirmText: 'إلغاء الدفعة' });
        },
      }, 'إلغاء'),
    ]);
    const { overlay } = BeeStore.dialogs.openDialog('دفعات ' + asset.name, [
      rows.length === 0
        ? el('p', { class: 'empty-state' }, 'لا توجد دفعات لاحقة')
        : el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'التاريخ'), el('th', {}, 'المبلغ'),
              el('th', {}, 'الطريقة'), el('th', {}, 'ملاحظة'), el('th', {}, 'القيد'), el('th', {}, ''),
            ])),
            el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
          ])
        ),
      el('button', { class: 'btn btn-secondary', onclick: () => overlay.remove() }, 'إغلاق'),
    ], { large: true });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.fixedAssets = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
