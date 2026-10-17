(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الموظفون والرواتب'));

    const content = el('div', { id: 'employees-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('employees', content); _setActiveTab(this); } }, 'الموظفون'),
      el('button', { class: 'tab', onclick: function () { _showTab('payroll', content); _setActiveTab(this); } }, 'الرواتب'),
      el('button', { class: 'tab', onclick: function () { _showTab('advances', content); _setActiveTab(this); } }, 'السلف'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('employees', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'employees') _renderEmployees(container);
    else if (tab === 'payroll') _renderPayroll(container);
    else if (tab === 'advances') _renderAdvances(container);
  }

  function _rerenderTab(index) {
    const content = document.getElementById('employees-content');
    if (!content) return;
    content.innerHTML = '';
    if (index === 0) _renderEmployees(content);
    else if (index === 1) _renderPayroll(content);
    else _renderAdvances(content);
    const tabsWrap = content.previousElementSibling;
    if (tabsWrap) {
      const tabs = tabsWrap.querySelectorAll('.tab');
      tabs.forEach(t => t.classList.remove('active'));
      if (tabs[index]) tabs[index].classList.add('active');
    }
  }

  function _rerenderPayrollTab() { _rerenderTab(1); }
  function _rerenderAdvancesTab() { _rerenderTab(2); }

  async function _renderEmployees(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addEmployee() }, '+ موظف جديد');
    container.appendChild(addBtn);

    const res = await BeeStore.api.employees.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const rows = res.data.map(emp => [
      emp.name,
      emp.position || '-',
      emp.phone || '-',
      formatMoney(emp.baseSalaryMinor),
      emp.active ? 'نشط' : 'غير نشط',
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editEmployee(emp.id) }, 'تعديل'),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الاسم'), el('th', {}, 'المنصب'), el('th', {}, 'الهاتف'),
          el('th', {}, 'الراتب'), el('th', {}, 'الحالة'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderPayroll(container) {
    const monthInput = input('month', BeeStore.dates.monthKey());
    const prepareBtn = el('button', { class: 'btn btn-primary', onclick: async () => {
      const res = await BeeStore.api.payroll.prepare(monthInput.value);
      if (res.ok) { toast('تم إنشاء ' + res.data.length + ' سجل راتب'); _rerenderPayrollTab(); }
      else toast(res.error.message, 'error');
    } }, 'تحضير الرواتب');

    container.appendChild(el('div', { class: 'filter-row' }, [monthInput, prepareBtn]));

    const res = await BeeStore.api.payroll.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const rows = res.data.map(p => [
      p.employeeName,
      p.month,
      formatMoney(p.netMinor),
      p.status === 'paid' ? 'مدفوع' : 'مسودة',
      p.status !== 'paid' ? el('button', { class: 'btn btn-sm btn-success', onclick: () => _payPayroll(p.id) }, 'دفع') : '-',
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الموظف'), el('th', {}, 'الشهر'), el('th', {}, 'الصافي'),
          el('th', {}, 'الحالة'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderAdvances(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addAdvance() }, '+ سلفة جديدة');
    container.appendChild(addBtn);

    const res = await BeeStore.api.employees.list();
    if (!res.ok) return;

    const allAdvances = [];
    for (const emp of res.data) {
      const advRes = await BeeStore.api.payroll.advances(emp.id);
      if (advRes.ok) {
        for (const a of advRes.data) {
          allAdvances.push({ ...a, employeeName: emp.name });
        }
      }
    }

    const rows = allAdvances.map(a => [
      a.employeeName,
      formatDate(a.date),
      formatMoney(a.amountMinor),
      formatMoney(a.repaidMinor || 0),
      formatMoney(a.amountMinor - (a.repaidMinor || 0)),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الموظف'), el('th', {}, 'التاريخ'), el('th', {}, 'المبلغ'),
          el('th', {}, 'المسدد'), el('th', {}, 'المتبقي'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  function _addEmployee() {
    const nameInput = input('text', '');
    const phoneInput = input('text', '');
    const positionInput = input('text', '');
    const salaryInput = input('number', '', { min: 0, step: 0.01 });

    const { overlay } = BeeStore.dialogs.openDialog('موظف جديد', [
      formField('الاسم', nameInput, true),
      formField('الهاتف', phoneInput),
      formField('المنصب', positionInput),
      formField('الراتب الأساسي', salaryInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.employees.create({
            name: nameInput.value.trim(),
            phone: phoneInput.value.trim(),
            position: positionInput.value.trim(),
            baseSalaryMinor: BeeStore.money.fromMajor(salaryInput.value),
          });
          if (res.ok) { toast('تم إضافة الموظف'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _editEmployee(id) {
    BeeStore.api.employees.get(id).then(res => {
      if (!res.ok) return;
      const emp = res.data;
      const nameInput = input('text', emp.name);
      const phoneInput = input('text', emp.phone);
      const positionInput = input('text', emp.position);
      const salaryInput = input('number', (emp.baseSalaryMinor / 100).toFixed(2));

      const { overlay } = BeeStore.dialogs.openDialog('تعديل الموظف', [
        formField('الاسم', nameInput, true),
        formField('الهاتف', phoneInput),
        formField('المنصب', positionInput),
        formField('الراتب', salaryInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await BeeStore.api.employees.update(id, {
              name: nameInput.value.trim(),
              phone: phoneInput.value.trim(),
              position: positionInput.value.trim(),
              baseSalaryMinor: BeeStore.money.fromMajor(salaryInput.value),
            });
            if (res.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
    });
  }

  function _payPayroll(id) {
    const methodSelect = select([
      { value: 'cash', label: 'نقداً' },
      { value: 'bank', label: 'تحويل بنكي' },
    ], 'cash');
    const dateInput = input('date', BeeStore.dates.today());
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    const repayInput = input('number', '0', { min: 0, step: 0.01, placeholder: 'سداد السلف (اختياري)' });
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

    const { overlay } = BeeStore.dialogs.openDialog('دفع الراتب', [
      formField('تاريخ الدفع', dateInput, true),
      formField('طريقة الدفع', methodSelect),
      formField('الحساب', accSelect),
      formField('سداد السلف', repayInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const repay = BeeStore.money.fromMajor(repayInput.value);
          const res = await BeeStore.api.payroll.pay(id, methodSelect.value, accSelect.value || null, '', repay, dateInput.value || BeeStore.dates.today());
          if (res.ok) { toast('تم دفع الراتب'); overlay.remove(); _rerenderPayrollTab(); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _addAdvance() {
    const empSelect = select([{ value: '', label: 'اختر الموظف' }], '');
    BeeStore.api.employees.list().then(res => {
      if (res.ok) for (const e of res.data) empSelect.appendChild(el('option', { value: e.id }, e.name));
    });

    const amountInput = input('number', '', { min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());

    const { overlay } = BeeStore.dialogs.openDialog('سلفة جديدة', [
      formField('الموظف', empSelect, true),
      formField('التاريخ', dateInput, true),
      formField('المبلغ', amountInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!empSelect.value) { toast('اختر الموظف', 'error'); return; }
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.payroll.createAdvance({
            employeeId: empSelect.value, amountMinor: amount,
            date: dateInput.value || BeeStore.dates.today(),
          });
          if (res.ok) { toast('تم إضافة السلفة'); overlay.remove(); _rerenderAdvancesTab(); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.employees = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
