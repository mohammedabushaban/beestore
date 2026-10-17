(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الزبائن والديون'));

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addCustomer() }, '+ زبون جديد');
    container.appendChild(addBtn);

    const searchInput = input('text', '', { placeholder: 'بحث...', class: 'form-input' });
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));

    const listDiv = el('div', { id: 'customers-list' });
    container.appendChild(listDiv);

    async function _load() {
      const res = await BeeStore.api.customers.list();
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      let data = res.data;
      const q = searchInput.value.trim().toLowerCase();
      if (q) data = data.filter(c => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q));
      _renderList(listDiv, data);
    }

    searchInput.addEventListener('input', _load);
    await _load();
  }

  function _renderList(container, customers) {
    container.innerHTML = '';
    if (customers.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا يوجد زبائن'));
      return;
    }
    const rows = customers.map(c => [
      c.name,
      c.phone || '-',
      el('button', { class: 'btn btn-sm btn-info', onclick: () => _viewStatement(c.id) }, 'كشف حساب'),
      el('button', { class: 'btn btn-sm btn-success', onclick: () => _receivePayment(c.id, c.name) }, 'استلام دفعة'),
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editCustomer(c.id) }, 'تعديل'),
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

  async function _viewStatement(customerId) {
    const res = await BeeStore.api.customers.statement(customerId);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const { customer, sales, payments, balance } = res.data;
    const settingsRes = await BeeStore.api.settings.get();
    const settings = settingsRes.ok ? settingsRes.data : {};

    // v2 §5: period-scoped statement with opening/closing balance rows.
    const range = BeeStore.period ? BeeStore.period.getRange() : null;
    const inRange = (d) => !range || (d >= range.from && d <= range.to);
    const periodSales = sales.filter(s => inRange(s.date));
    const periodPayments = payments.filter(p => inRange(p.date));
    let opening = null, closing = null;
    if (range) {
      const oRes = await BeeStore.api.customers.balance(customerId, BeeStore.dates.addDays(range.from, -1));
      const cRes = await BeeStore.api.customers.balance(customerId, range.to);
      if (oRes.ok) opening = oRes.data;
      if (cRes.ok) closing = cRes.data;
    }

    const overlay = el('div', { class: 'dialog-overlay' });
    const content = el('div', { class: 'dialog dialog-lg' }, [
      el('div', { class: 'dialog-header' }, [
        el('h3', {}, 'كشف حساب: ' + customer.name + (range ? ' (' + BeeStore.period.label() + ')' : '')),
        el('button', { class: 'btn-close', onclick: () => overlay.remove() }, '×'),
      ]),
      el('div', { class: 'dialog-body' }, [
        opening !== null ? el('p', {}, 'الرصيد الافتتاحي: ' + formatMoney(opening)) : null,
        el('p', { class: 'text-lg' }, 'الرصيد: ' + formatMoney(closing !== null ? closing : balance)),
        el('h4', {}, 'الفواتير'),
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'),
              el('th', {}, 'الإجمالي'), el('th', {}, 'المتبقي'),
            ])),
            el('tbody', {}, periodSales.map(s => el('tr', {}, [
              el('td', {}, s.number),
              el('td', {}, formatDate(s.date)),
              el('td', {}, formatMoney(s.totalMinor)),
              el('td', {}, formatMoney(s.dueMinor)),
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

  async function _receivePayment(customerId, customerName) {
    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const amountInput = input('number', '', { placeholder: 'المبلغ', min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const dateNotice = el('p', { class: 'period-notice', style: 'display:none' });
    if (BeeStore.period) BeeStore.period.applyDefaultDate(dateInput, dateNotice);
    const methodSelect = BeeStore.dialogs.select(BeeStore.settings.methodOptions(s), 'cash');
    const payerNameInput = input('text', '', { placeholder: 'اسم المحوِّل / الدافع' });
    const payerPhoneInput = input('text', '', { placeholder: 'رقم الجوال أو المحفظة' });

    const { overlay } = BeeStore.dialogs.openDialog('استلام دفعة - ' + customerName, [
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
          const res = await BeeStore.api.customers.receivePayment({
            customerId, amountMinor: amount, method: methodSelect.value,
            payerName: payerNameInput.value, payerPhone: payerPhoneInput.value,
            date: dateInput.value || BeeStore.dates.today(),
          });
          if (res.ok) { toast('تم استلام الدفعة'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addCustomer() {
    const nameInput = input('text', '');
    const phoneInput = input('text', '');
    const addressInput = input('text', '');

    const { overlay } = BeeStore.dialogs.openDialog('زبون جديد', [
      formField('الاسم', nameInput, true),
      formField('الهاتف', phoneInput),
      formField('العنوان', addressInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.customers.create({
            name: nameInput.value.trim(),
            phone: phoneInput.value.trim(),
            address: addressInput.value.trim(),
          });
          if (res.ok) { toast('تم إضافة الزبون'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _editCustomer(id) {
    BeeStore.api.customers.get(id).then(res => {
      if (!res.ok) return;
      const c = res.data;
      const nameInput = input('text', c.name);
      const phoneInput = input('text', c.phone);
      const addressInput = input('text', c.address);

      const { overlay } = BeeStore.dialogs.openDialog('تعديل الزبون', [
        formField('الاسم', nameInput, true),
        formField('الهاتف', phoneInput),
        formField('العنوان', addressInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await BeeStore.api.customers.update(id, {
              name: nameInput.value.trim(),
              phone: phoneInput.value.trim(),
              address: addressInput.value.trim(),
            });
            if (res.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.customers = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
