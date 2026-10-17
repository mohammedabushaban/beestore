(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الموردون'));

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addSupplier() }, '+ مورد جديد');
    container.appendChild(addBtn);

    const searchInput = input('text', '', { placeholder: 'بحث...', class: 'form-input' });
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));

    const listDiv = el('div', { id: 'suppliers-list' });
    container.appendChild(listDiv);

    async function _load() {
      const res = await BeeStore.api.suppliers.list();
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      let data = res.data;
      const q = searchInput.value.trim().toLowerCase();
      if (q) data = data.filter(s => s.name.toLowerCase().includes(q));
      _renderList(listDiv, data);
    }

    searchInput.addEventListener('input', _load);
    await _load();
  }

  function _renderList(container, suppliers) {
    container.innerHTML = '';
    if (suppliers.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا يوجد موردون'));
      return;
    }
    const rows = suppliers.map(s => [
      s.name,
      s.phone || '-',
      el('button', { class: 'btn btn-sm btn-info', onclick: () => _viewStatement(s.id) }, 'كشف حساب'),
      el('button', { class: 'btn btn-sm btn-success', onclick: () => _paySupplier(s.id, s.name) }, 'دفع'),
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editSupplier(s.id) }, 'تعديل'),
    ]);
    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الاسم'), el('th', {}, 'الهاتف'), el('th', {}, ''), el('th', {}, ''), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  // v2 §5: period-scoped supplier statement with opening/closing rows.
  async function _viewStatement(supplierId) {
    const res = await BeeStore.api.suppliers.statement(supplierId);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const { supplier, purchases, payments, balance } = res.data;
    const settingsRes = await BeeStore.api.settings.get();
    const settings = settingsRes.ok ? settingsRes.data : {};

    const range = BeeStore.period ? BeeStore.period.getRange() : null;
    const inRange = (d) => !range || (d >= range.from && d <= range.to);
    const periodPurchases = purchases.filter(p => inRange(p.date));
    const periodPayments = payments.filter(p => inRange(p.date));
    let opening = null, closing = null;
    if (range) {
      const oRes = await BeeStore.api.suppliers.balance(supplierId, BeeStore.dates.addDays(range.from, -1));
      const cRes = await BeeStore.api.suppliers.balance(supplierId, range.to);
      if (oRes.ok) opening = oRes.data;
      if (cRes.ok) closing = cRes.data;
    }

    const overlay = el('div', { class: 'dialog-overlay' });
    const content = el('div', { class: 'dialog dialog-lg' }, [
      el('div', { class: 'dialog-header' }, [
        el('h3', {}, 'كشف حساب: ' + supplier.name + (range ? ' (' + BeeStore.period.label() + ')' : '')),
        el('button', { class: 'btn-close', onclick: () => overlay.remove() }, '×'),
      ]),
      el('div', { class: 'dialog-body' }, [
        opening !== null ? el('p', {}, 'الرصيد الافتتاحي: ' + formatMoney(opening)) : null,
        el('p', { class: 'text-lg' }, 'الرصيد: ' + formatMoney(closing !== null ? closing : balance)),
        el('h4', {}, 'فواتير المشتريات'),
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'),
              el('th', {}, 'الإجمالي'), el('th', {}, 'المتبقي'),
            ])),
            el('tbody', {}, periodPurchases.map(p => el('tr', {}, [
              el('td', {}, p.number),
              el('td', {}, formatDate(p.date)),
              el('td', {}, formatMoney(p.totalMinor)),
              el('td', {}, formatMoney(p.dueMinor)),
            ]))),
          ])
        ),
        el('h4', {}, 'الدفعات'),
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'التاريخ'), el('th', {}, 'المبلغ'), el('th', {}, 'الطريقة'),
              el('th', {}, 'المحوِّل'), el('th', {}, 'الجوال'),
            ])),
            el('tbody', {}, periodPayments.map(p => el('tr', {}, [
              el('td', {}, formatDate(p.date)),
              el('td', {}, formatMoney(p.amountMinor)),
              el('td', {}, BeeStore.settings.methodLabel(settings, p.method)),
              el('td', {}, p.payerName || '-'),
              el('td', {}, p.payerPhone || '-'),
            ]))),
          ])
        ),
        closing !== null ? el('p', { class: 'total-final' }, 'الرصيد الختامي: ' + formatMoney(closing)) : null,
      ]),
    ]);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
  }

  async function _paySupplier(supplierId, supplierName) {
    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const amountInput = input('number', '', { placeholder: 'المبلغ', min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const dateNotice = el('p', { class: 'period-notice', style: 'display:none' });
    if (BeeStore.period) BeeStore.period.applyDefaultDate(dateInput, dateNotice);
    const methodSelect = BeeStore.dialogs.select(BeeStore.settings.methodOptions(s), 'cash');
    const payerNameInput = input('text', '', { placeholder: 'اسم المحوِّل / الدافع' });
    const payerPhoneInput = input('text', '', { placeholder: 'رقم الجوال أو المحفظة' });

    const { overlay } = BeeStore.dialogs.openDialog('دفع للمورد - ' + supplierName, [
      formField('التاريخ', dateInput, true),
      dateNotice,
      formField('المبلغ', amountInput, true),
      formField('طريقة الدفع', methodSelect),
      formField('اسم المحوِّل', payerNameInput),
      formField('رقم الجوال / المحفظة', payerPhoneInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.suppliers.pay({
            supplierId, amountMinor: amount, method: methodSelect.value,
            payerName: payerNameInput.value, payerPhone: payerPhoneInput.value,
            date: dateInput.value || BeeStore.dates.today(),
          });
          if (res.ok) { toast('تم الدفع'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addSupplier() {
    const nameInput = input('text', '');
    const phoneInput = input('text', '');

    const { overlay } = BeeStore.dialogs.openDialog('مورد جديد', [
      formField('الاسم', nameInput, true),
      formField('الهاتف', phoneInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.suppliers.create({
            name: nameInput.value.trim(),
            phone: phoneInput.value.trim(),
          });
          if (res.ok) { toast('تم إضافة المورد'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _editSupplier(id) {
    BeeStore.api.suppliers.get(id).then(res => {
      if (!res.ok) return;
      const s = res.data;
      const nameInput = input('text', s.name);
      const phoneInput = input('text', s.phone);

      const { overlay } = BeeStore.dialogs.openDialog('تعديل المورد', [
        formField('الاسم', nameInput, true),
        formField('الهاتف', phoneInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await BeeStore.api.suppliers.update(id, {
              name: nameInput.value.trim(),
              phone: phoneInput.value.trim(),
            });
            if (res.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.suppliers = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
