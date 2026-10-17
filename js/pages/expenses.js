(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'المصاريف'));
    if (BeeStore.period) await BeeStore.period.scopeBar(container);

    const content = el('div', { id: 'expenses-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('expenses', content); _setActiveTab(this); } }, 'المصاريف'),
      el('button', { class: 'tab', onclick: function () { _showTab('categories', content); _setActiveTab(this); } }, 'التصنيفات'),
      el('button', { class: 'tab', onclick: function () { _showTab('recurring', content); _setActiveTab(this); } }, 'المصاريف المتكررة'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('expenses', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'expenses') _renderExpenses(container);
    else if (tab === 'categories') _renderCategories(container);
    else if (tab === 'recurring') _renderRecurring(container);
  }

  async function _renderExpenses(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addExpense() }, '+ مصروف جديد');
    // v2 §5: period scope + show-all toggle.
    let showAll = false;
    const scopeBtn = el('button', { class: 'btn btn-sm btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض الشهر' : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');
    container.appendChild(el('div', { class: 'filter-row' }, [addBtn, scopeBtn]));

    const listDiv = el('div', {});
    container.appendChild(listDiv);

    async function _load() {
      const filters = {};
      if (BeeStore.period && !showAll) {
        const range = BeeStore.period.getRange();
        filters.from = range.from; filters.to = range.to;
      }
      const res = await BeeStore.api.expenses.list(filters);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      _renderExpenseRows(listDiv, res.data);
    }
    await _load();
  }

  function _renderExpenseRows(listDiv, data) {
    listDiv.innerHTML = '';
    if (data.length === 0) {
      listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مصاريف'));
      return;
    }
    const rows = data.map(e => [
      formatDate(e.date),
      e.categoryName || '-',
      e.description || '-',
      formatMoney(e.amountMinor),
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => _deleteExpense(e.id) }, 'إلغاء'),
    ]);

    listDiv.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'التاريخ'), el('th', {}, 'التصنيف'), el('th', {}, 'الوصف'),
          el('th', {}, 'المبلغ'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderCategories(container) {
    const res = await BeeStore.api.expenses.categories();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addCategory() }, '+ تصنيف جديد');
    container.appendChild(addBtn);

    const rows = res.data.map(c => [c.name, c.active ? 'نشط' : 'غير نشط']);
    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, 'الاسم'), el('th', {}, 'الحالة')])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderRecurring(container) {
    const res = await BeeStore.api.expenses.recurring();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addRecurring() }, '+ متكرر جديد');
    container.appendChild(addBtn);

    // v2 §6.2: generation must target the month the user is viewing (the
    // global period), not always today's month — otherwise the created
    // expenses land outside the scoped list and look "unsaved".
    const sel = BeeStore.period ? BeeStore.period.get() : null;
    const genMonth = (sel && sel.mode === 'month') ? sel.month : BeeStore.dates.today().slice(0, 7);
    const genLabel = BeeStore.period ? BeeStore.period.monthLabel(genMonth) : genMonth;
    const genBtn = el('button', { class: 'btn btn-success', onclick: () => _generateRecurring(genMonth, genLabel) }, 'توليد مصاريف ' + genLabel);
    container.appendChild(genBtn);

    const rows = res.data.map(r => [
      r.description || '-',
      String(r.dayOfMonth),
      formatMoney(r.amountMinor),
      r.active ? 'نشط' : 'غير نشط',
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الوصف'), el('th', {}, 'اليوم'), el('th', {}, 'المبلغ'), el('th', {}, 'الحالة'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  function _addExpense() {
    const dateInput = input('date', BeeStore.dates.today());    const dateNotice = el('p', { class: 'period-notice', style: 'display:none' });
    // v2 §3: default to the selected period (today / last day of month).
    if (BeeStore.period) BeeStore.period.applyDefaultDate(dateInput, dateNotice);
    const catSelect = select([{ value: '', label: 'بدون تصنيف' }], '');
    BeeStore.api.expenses.categories().then(res => {
      if (res.ok) for (const c of res.data) catSelect.appendChild(el('option', { value: c.id }, c.name));
    });

    const amountInput = input('number', '', { min: 0, step: 0.01 });
    const descInput = input('text', '', { placeholder: 'الوصف' });
    const methodSelect = select([
      { value: 'cash', label: 'نقداً' },
      { value: 'card', label: 'بطاقة' },
      { value: 'bank', label: 'تحويل بنكي' },
      { value: 'wallet', label: 'محفظة إلكترونية' },
    ], 'cash');
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    BeeStore.api.accounts.list().then(async res => {
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
    });

    const { overlay } = BeeStore.dialogs.openDialog('مصروف جديد', [
      formField('التاريخ', dateInput, true),
      dateNotice,
      formField('المبلغ', amountInput, true),
      formField('التصنيف', catSelect),
      formField('الوصف', descInput),
      formField('طريقة الدفع', methodSelect),
      formField('الحساب', accSelect),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.expenses.create({
            date: dateInput.value || BeeStore.dates.today(),
            amountMinor: amount,
            categoryId: catSelect.value || null,
            description: descInput.value.trim(),
            method: methodSelect.value,
            accountId: accSelect.value || null,
          });
          if (res.ok) { toast('تم إضافة المصروف'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addCategory() {
    const nameInput = input('text', '', { placeholder: 'اسم التصنيف' });
    const { overlay } = BeeStore.dialogs.openDialog('تصنيف جديد', [
      formField('الاسم', nameInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.expenses.createCategory({ name: nameInput.value.trim() });
          if (res.ok) { toast('تم الإضافة'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addRecurring() {
    const amountInput = input('number', '', { min: 0, step: 0.01 });
    const dayInput = input('number', '1', { min: 1, max: 31 });
    const descInput = input('text', '', { placeholder: 'الوصف' });

    const { overlay } = BeeStore.dialogs.openDialog('مصروف متكرر', [
      formField('المبلغ', amountInput, true),
      formField('اليوم من الشهر', dayInput),
      formField('الوصف', descInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.expenses.createRecurring({
            amountMinor: amount,
            dayOfMonth: Number(dayInput.value) || 1,
            description: descInput.value.trim(),
          });
          if (res.ok) { toast('تم الإضافة'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  async function _generateRecurring(month, label) {
    const res = await BeeStore.api.expenses.generateRecurring(month);
    if (res.ok) {
      toast('تم توليد ' + res.data.length + ' مصروف' + (label ? ' لشهر ' + label : ''));
      render(document.getElementById('page-content'));
    } else toast(res.error.message, 'error');
  }

  function _deleteExpense(id) {
    BeeStore.ui.confirmDialog('إلغاء المصروف', 'هل تريد إلغاء هذا المصروف؟ سيبقى ظاهراً في السجلات.', async () => {
      const reason = prompt('سبب الإلغاء:');
      if (!reason || !reason.trim()) return;
      const res = await BeeStore.api.expenses.void(id, reason.trim());
      if (res.ok) { toast('تم إلغاء المصروف'); render(document.getElementById('page-content')); }
      else toast(res.error.message, 'error');
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.expenses = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
