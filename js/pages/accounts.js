(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الحسابات'));

    const content = el('div', { id: 'accounts-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('accounts', content); _setActiveTab(this); } }, 'الحسابات'),
      el('button', { class: 'tab', onclick: function () { _showTab('ledger', content); _setActiveTab(this); } }, 'كشف حساب'),
      el('button', { class: 'tab', onclick: function () { _showTab('transfers', content); _setActiveTab(this); } }, 'التحويلات'),
      el('button', { class: 'tab', onclick: function () { _showTab('owner', content); _setActiveTab(this); } }, 'معاملات المالك'),
      el('button', { class: 'tab', onclick: function () { _showTab('closing', content); _setActiveTab(this); } }, 'إغلاق اليوم'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('accounts', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'accounts') _renderAccounts(container);
    else if (tab === 'ledger') _renderLedger(container);
    else if (tab === 'transfers') _renderTransfers(container);
    else if (tab === 'owner') _renderOwner(container);
    else if (tab === 'closing') _renderClosing(container);
  }

  async function _renderAccounts(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addAccount() }, '+ حساب جديد');
    container.appendChild(addBtn);

    const res = await BeeStore.api.accounts.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const rows = await Promise.all(res.data.map(async acc => {
      const balanceRes = await BeeStore.api.accounts.balance(acc.id);
      const balance = balanceRes.ok ? balanceRes.data : 0;
      return [
        acc.name,
        acc.type === 'cash' ? 'نقدي' : acc.type === 'bank' ? 'بنك' : 'محفظة',
        formatMoney(balance),
        el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editAccount(acc.id) }, 'تعديل'),
      ];
    }));

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الاسم'), el('th', {}, 'النوع'), el('th', {}, 'الرصيد'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderLedger(container) {
    const accSelect = select([{ value: '', label: 'اختر الحساب' }], '');
    const res = await BeeStore.api.accounts.list();
    if (res.ok) for (const a of res.data) accSelect.appendChild(el('option', { value: a.id }, a.name));

    const fromInput = input('date', BeeStore.dates.startOfMonth());
    const toInput = input('date', BeeStore.dates.today());

    container.appendChild(el('div', { class: 'filter-row' }, [
      accSelect, fromInput, toInput,
      el('button', { class: 'btn btn-secondary', onclick: () => _loadLedger(accSelect.value, fromInput.value, toInput.value) }, 'عرض'),
    ]));

    const resultDiv = el('div', { id: 'ledger-result' });
    container.appendChild(resultDiv);

    async function _loadLedger(accountId, from, to) {
      if (!accountId) { toast('اختر الحساب', 'error'); return; }
      const ledgerRes = await BeeStore.api.accounts.ledger(accountId, { from, to });
      if (!ledgerRes.ok) { toast(ledgerRes.error.message, 'error'); return; }
      const movements = ledgerRes.data;
      resultDiv.innerHTML = '';
      if (movements.length === 0) {
        resultDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد حركات'));
        return;
      }
      const rows = movements.map(m => [
        formatDate(m.date),
        m.description,
        m.amountMinor >= 0 ? formatMoney(m.amountMinor) : '(' + formatMoney(Math.abs(m.amountMinor)) + ')',
        formatMoney(m.balanceAfter),
      ]);
      resultDiv.appendChild(el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'التاريخ'), el('th', {}, 'البيان'), el('th', {}, 'المبلغ'), el('th', {}, 'الرصيد'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ));
    }
  }

  async function _renderTransfers(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addTransfer() }, '+ تحويل جديد');
    container.appendChild(addBtn);

    const res = await BeeStore.api.accounts.list();
    if (!res.ok) return;

    const transfers = await BeeStore.repo.list('transfers');
    transfers.sort((a, b) => b.date.localeCompare(a.date));

    const accountMap = {};
    for (const a of res.data) accountMap[a.id] = a;

    const rows = transfers.map(t => [
      formatDate(t.date),
      accountMap[t.fromAccountId] ? accountMap[t.fromAccountId].name : '-',
      accountMap[t.toAccountId] ? accountMap[t.toAccountId].name : '-',
      formatMoney(t.amountMinor),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'التاريخ'), el('th', {}, 'من'), el('th', {}, 'إلى'), el('th', {}, 'المبلغ'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderOwner(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addOwnerTx() }, '+ معاملة جديدة');
    container.appendChild(addBtn);

    const txs = await BeeStore.repo.list('ownerTransactions');
    txs.sort((a, b) => b.date.localeCompare(a.date));

    const rows = txs.map(t => [
      formatDate(t.date),
      t.type === 'capital_in' ? 'رأس مال' : 'سحب',
      formatMoney(t.amountMinor),
      t.note || '-',
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'التاريخ'), el('th', {}, 'النوع'), el('th', {}, 'المبلغ'), el('th', {}, 'ملاحظة'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderClosing(container) {
    const dateInput = input('date', BeeStore.dates.today());
    container.appendChild(el('div', { class: 'filter-row' }, [
      dateInput,
      el('button', { class: 'btn btn-primary', onclick: () => _openClosing(dateInput.value) }, 'فتح إغلاق اليوم'),
    ]));
  }

  async function _openClosing(date) {
    const salesRes = await BeeStore.api.reports.dailyClosing(date);
    const salesByMethod = salesRes.ok ? salesRes.data.salesByMethod : {};
    const totalSales = salesRes.ok ? salesRes.data.totalSales : 0;
    const refundMinor = salesRes.ok ? salesRes.data.refundMinor : 0;

    const cashSales = salesByMethod['cash'] || 0;
    const expenses = salesRes.ok ? salesRes.data.totalExpenses : 0;

    const expectedCash = cashSales - expenses;
    const countedInput = input('number', '', { placeholder: 'النقد المعدود', min: 0, step: 0.01 });
    const noteInput = input('text', '', { placeholder: 'ملاحظة' });

    const { overlay } = BeeStore.dialogs.openDialog('إغلاق اليوم - ' + date, [
      el('p', {}, 'إجمالي المبيعات: ' + formatMoney(totalSales)),
      refundMinor > 0 ? el('p', {}, 'مرتجعات نقدية: -' + formatMoney(refundMinor)) : null,
      el('p', {}, 'مبيعات نقدية (صافي): ' + formatMoney(cashSales)),
      el('p', {}, 'المصاريف: ' + formatMoney(expenses)),
      el('p', { style: 'font-weight:600' }, 'المتوقع في الصندوق: ' + formatMoney(expectedCash)),
      formField('النقد المعدود', countedInput),
      formField('ملاحظة', noteInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const counted = BeeStore.money.fromMajor(countedInput.value);
          const res = await BeeStore.api.transactions.dailyClosing({
            date,
            salesByMethod,
            expensesMinor: expenses,
            expectedCashMinor: expectedCash,
            countedCashMinor: counted,
            differenceMinor: counted - expectedCash,
            note: noteInput.value.trim(),
          });
          if (res.ok) { toast('تم حفظ الإغلاق'); overlay.remove(); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addAccount() {
    const nameInput = input('text', '');
    const typeSelect = select([
      { value: 'cash', label: 'نقدي' },
      { value: 'bank', label: 'بنك' },
      { value: 'wallet', label: 'محفظة' },
    ], 'cash');
    const balanceInput = input('number', '0', { min: 0, step: 0.01 });

    const { overlay } = BeeStore.dialogs.openDialog('حساب جديد', [
      formField('الاسم', nameInput, true),
      formField('النوع', typeSelect),
      formField('الرصيد الافتتاحي', balanceInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.accounts.create({
            name: nameInput.value.trim(),
            type: typeSelect.value,
            openingBalanceMinor: BeeStore.money.fromMajor(balanceInput.value),
          });
          if (res.ok) { toast('تم إضافة الحساب'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _editAccount(id) {
    BeeStore.api.accounts.get(id).then(res => {
      if (!res.ok) return;
      const acc = res.data;
      const nameInput = input('text', acc.name);
      const balanceInput = input('number', ((acc.openingBalanceMinor || 0) / 100).toFixed(2));

      const { overlay } = BeeStore.dialogs.openDialog('تعديل الحساب', [
        formField('الاسم', nameInput, true),
        formField('الرصيد الافتتاحي', balanceInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await BeeStore.api.accounts.update(id, {
              name: nameInput.value.trim(),
              openingBalanceMinor: BeeStore.money.fromMajor(balanceInput.value),
            });
            if (res.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
    });
  }

  function _addTransfer() {
    const fromSelect = select([{ value: '', label: 'من' }], '');
    const toSelect = select([{ value: '', label: 'إلى' }], '');
    BeeStore.api.accounts.list().then(res => {
      if (res.ok) for (const a of res.data) {
        fromSelect.appendChild(el('option', { value: a.id }, a.name));
        toSelect.appendChild(el('option', { value: a.id }, a.name));
      }
    });

    const amountInput = input('number', '', { min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());

    const { overlay } = BeeStore.dialogs.openDialog('تحويل بين الحسابات', [
      formField('التاريخ', dateInput, true),
      formField('من حساب', fromSelect, true),
      formField('إلى حساب', toSelect, true),
      formField('المبلغ', amountInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!fromSelect.value || !toSelect.value) { toast('اختر الحسابين', 'error'); return; }
          if (fromSelect.value === toSelect.value) { toast('لا يمكن التحويل لنفس الحساب', 'error'); return; }
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.transactions.transfer({
            fromAccountId: fromSelect.value,
            toAccountId: toSelect.value,
            amountMinor: amount,
            date: dateInput.value || BeeStore.dates.today(),
          });
          if (res.ok) { toast('تم التحويل'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  async function _addOwnerTx() {
    const typeSelect = select([
      { value: 'capital_in', label: 'رأس مال' },
      { value: 'withdrawal', label: 'سحب شخصي' },
    ], 'capital_in');
    const amountInput = input('number', '', { min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const noteInput = input('text', '', { placeholder: 'ملاحظة' });
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    const accRes = await BeeStore.api.accounts.list();
    if (accRes.ok) {
      for (const a of accRes.data) accSelect.appendChild(el('option', { value: a.id }, a.name));
      const settings = await BeeStore.settings.get();
      const defaultAccountId = BeeStore.settings.resolvePaymentAccount(settings, 'cash');
      if (defaultAccountId) accSelect.value = defaultAccountId;
      if (!defaultAccountId && accRes.data.length === 1) accSelect.value = accRes.data[0].id;
    }

    const { overlay } = BeeStore.dialogs.openDialog('معاملة المالك', [
      formField('التاريخ', dateInput, true),
      formField('النوع', typeSelect, true),
      formField('المبلغ', amountInput, true),
      formField('الحساب', accSelect, true),
      formField('ملاحظة', noteInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          if (!accSelect.value) { toast('اختر الحساب', 'error'); return; }
          const res = await BeeStore.api.transactions.ownerTransaction({
            type: typeSelect.value,
            amountMinor: amount,
            accountId: accSelect.value,
            date: dateInput.value || BeeStore.dates.today(),
            note: noteInput.value.trim(),
          });
          if (res.ok) { toast('تم الحفظ'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.accounts = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
