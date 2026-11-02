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
      el('button', { class: 'tab', onclick: function () { _showTab('unpaid', content); _setActiveTab(this); } }, 'مستحقات غير مدفوعة'),
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
    else if (tab === 'unpaid') _renderUnpaid(container);
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
      _renderExpenseRows(listDiv, res.data, async () => {
        container.innerHTML = '';
        await _renderExpenses(container);
      });
    }
    await _load();
  }

  function _paidOf(e) {
    if (e.paidMinor !== undefined && e.paidMinor !== null) return Number(e.paidMinor) || 0;
    return Number(e.amountMinor) || 0;
  }

  function _statusLabel(status) {
    if (status === 'paid') return 'مدفوع';
    if (status === 'partial') return 'مدفوع جزئياً';
    return 'غير مدفوع';
  }

  function _renderExpenseRows(listDiv, data, reload) {
    listDiv.innerHTML = '';
    if (data.length === 0) {
      listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مصاريف'));
      return;
    }
    const rows = data.map(e => {
      const paid = _paidOf(e);
      const remaining = Math.max(0, (Number(e.amountMinor) || 0) - paid);
      const actions = [];
      if (remaining > 0) {
        actions.push(el('button', {
          class: 'btn btn-sm btn-success',
          onclick: () => _payExpense(e, remaining, reload),
        }, 'دفع'));
      }
      actions.push(el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: () => _deleteExpense(e.id),
      }, 'إلغاء'));
      return [
        formatDate(e.date),
        e.categoryName || '-',
        e.description || '-',
        formatMoney(e.amountMinor),
        formatMoney(paid),
        remaining > 0 ? formatMoney(remaining) : '-',
        _statusLabel(e.paymentStatus || (remaining > 0 ? 'unpaid' : 'paid')),
        el('div', { class: 'row-actions' }, actions),
      ];
    });

    listDiv.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'التاريخ'), el('th', {}, 'التصنيف'), el('th', {}, 'الوصف'),
          el('th', {}, 'المبلغ'), el('th', {}, 'المدفوع'), el('th', {}, 'المتبقي'),
          el('th', {}, 'الحالة'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderUnpaid(container) {
    container.innerHTML = '';
    const asOfInput = input('date', BeeStore.dates.today());
    const body = el('div');
    container.appendChild(el('div', { class: 'filter-row' }, [
      formField('حتى تاريخ', asOfInput),
      el('button', {
        class: 'btn btn-secondary',
        onclick: () => _loadUnpaid(body, asOfInput.value || BeeStore.dates.today()),
      }, 'عرض'),
    ]));
    container.appendChild(body);
    await _loadUnpaid(body, asOfInput.value || BeeStore.dates.today());
  }

  async function _loadUnpaid(body, asOf) {
    body.innerHTML = '';
    const res = await BeeStore.api.expenses.aging(asOf);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const data = res.data;
    const bucketLabels = { '0-30': '0–30 يوم', '31-60': '31–60 يوم', '61-90': '61–90 يوم', '90+': 'أكثر من 90' };
    const cards = Object.keys(bucketLabels).map(key =>
      el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-label' }, bucketLabels[key]),
        el('div', { class: 'stat-value' }, formatMoney(data.buckets[key] || 0)),
      ]));
    cards.push(el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label' }, 'إجمالي المستحق'),
      el('div', { class: 'stat-value' }, formatMoney(data.totalMinor || 0)),
    ]));
    body.appendChild(el('div', { class: 'stats-grid' }, cards));

    if (data.rows.length === 0) {
      body.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مصاريف غير مدفوعة حتى هذا التاريخ'));
      return;
    }
    const rows = data.rows.map(row => [
      formatDate(row.date),
      row.dueDate ? formatDate(row.dueDate) : '-',
      row.categoryName,
      row.description || '-',
      row.payee || '-',
      formatMoney(row.amountMinor),
      formatMoney(row.paidMinor),
      formatMoney(row.remainingMinor),
      String(row.daysPastDue),
      el('button', {
        class: 'btn btn-sm btn-success',
        onclick: () => _payExpense(row, row.remainingMinor, () => _loadUnpaid(body, asOf)),
      }, 'دفع'),
    ]);
    body.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'التاريخ'), el('th', {}, 'الاستحقاق'), el('th', {}, 'التصنيف'),
          el('th', {}, 'الوصف'), el('th', {}, 'المستفيد'), el('th', {}, 'المبلغ'),
          el('th', {}, 'المدفوع'), el('th', {}, 'المتبقي'), el('th', {}, 'العمر'),
          el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  function _payExpense(expenseRow, remaining, done) {
    const expenseId = expenseRow.expenseId || expenseRow.id;
    const amountInput = input('number', BeeStore.money.toMajor(remaining), { min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const noteInput = input('text', '', { placeholder: 'مرجع / ملاحظة' });
    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    BeeStore.settings.get().then(settings => {
      methodSelect.innerHTML = '';
      for (const m of BeeStore.settings.methodOptions(settings)) {
        const pm = BeeStore.settings.paymentMethod(settings, m.value);
        if (pm && pm.kind === 'customer_credit') continue;
        methodSelect.appendChild(el('option', { value: m.value }, m.label));
      }
      const cashDefault = BeeStore.settings.resolvePaymentAccount(settings, 'cash');
      if (cashDefault) methodSelect.value = 'cash';
    });
    const { overlay } = BeeStore.dialogs.openDialog('دفع مصروف مستحق', [
      formField('التاريخ', dateInput, true),
      formField('المبلغ', amountInput, true),
      formField('طريقة الدفع', methodSelect),
      formField('ملاحظة', noteInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const res = await BeeStore.api.expenses.pay(expenseId, {
            date: dateInput.value || BeeStore.dates.today(),
            amountMinor: amount,
            method: methodSelect.value,
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
    const payeeInput = input('text', '', { placeholder: 'اسم المستفيد / المورد' });
    const dueDateInput = input('date', '');
    const statusSelect = select([
      { value: 'paid', label: 'مدفوع بالكامل' },
      { value: 'partial', label: 'مدفوع جزئياً' },
      { value: 'unpaid', label: 'غير مدفوع (مستحق)' },
    ], 'paid');
    const paidInput = input('number', '', { min: 0, step: 0.01 });
    const paidWrap = formField('المبلغ المدفوع الآن', paidInput);
    paidWrap.style.display = 'none';
    statusSelect.addEventListener('change', () => {
      paidWrap.style.display = statusSelect.value === 'partial' ? '' : 'none';
    });
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
      formField('حالة الدفع', statusSelect),
      paidWrap,
      formField('المستفيد', payeeInput),
      formField('تاريخ الاستحقاق', dueDateInput),
      formField('التصنيف', catSelect),
      formField('الوصف', descInput),
      formField('طريقة الدفع', methodSelect),
      formField('الحساب', accSelect),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (saving) return;
          const amount = BeeStore.money.fromMajor(amountInput.value);
          if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
          const status = statusSelect.value;
          let paidMinor = amount;
          if (status === 'unpaid') paidMinor = 0;
          if (status === 'partial') {
            paidMinor = BeeStore.money.fromMajor(paidInput.value);
            if (paidMinor <= 0 || paidMinor >= amount) {
              toast('المبلغ المدفوع يجب أن يكون أكبر من صفر وأقل من الإجمالي', 'error');
              return;
            }
          }
          const baseData = {
            date: dateInput.value || BeeStore.dates.today(),
            amountMinor: amount,
            categoryId: catSelect.value || null,
            description: descInput.value.trim(),
            method: methodSelect.value,
            accountId: accSelect.value || null,
            paymentStatus: status,
            paidMinor,
            payee: payeeInput.value.trim(),
            dueDate: dueDateInput.value || null,
          };
          const settings = await BeeStore.settings.get();
          if (BeeStore.settings.capitalizationWarningNeeded(settings, amount)) {
            saving = false;
            _capitalizationWarning(amount, async (mode, months) => {
              if (mode === 'cancel') return;
              saving = true;
              await saveExpense(baseData, mode === 'spread' ? months : null);
            });
            return;
          }
          saving = true;
          await saveExpense(baseData, null);
        },
      }, 'حفظ'),
    ]);

    let saving = false;

    async function saveExpense(data, months) {
      const res = months
        ? await BeeStore.api.expenses.spread({
          ...data,
          months,
          startMonth: data.date.slice(0, 7),
        })
        : await BeeStore.api.expenses.create(data);
      saving = false;
      if (res.ok) {
        toast(months ? 'تم تسجيل المصروف موزّعاً على ' + months + ' شهراً' : 'تم إضافة المصروف');
        overlay.remove();
        render(document.getElementById('page-content'));
      } else toast(res.error.message, 'error');
    }
  }

  /**
   * v5 §8 capitalization warning while fixed assets are disabled. The owner
   * must explicitly choose normal expense, monthly spread, or cancel.
   * @param {number} amountMinor expense amount
   * @param {function} decide callback (mode, months)
   */
  function _capitalizationWarning(amountMinor, decide) {
    const { overlay } = BeeStore.dialogs.openDialog('هل هذا أصل ثابت؟', [
      el('p', {},
        'هذا المصروف (' + formatMoney(amountMinor) + ') كبير وقد يكون أصلاً ثابتاً. ' +
        'تسجيله كمصروف واحد قد يشوّه أرباح هذا الشهر. اسأل المحاسب قبل المتابعة.'),
      el('p', { class: 'form-hint' },
        'يمكنك تسجيله كمصروف عادي، أو توزيعه على عدة أشهر (مدفوع مقدماً يُستهلك شهرياً)، أو الإلغاء للمراجعة.'),
      el('div', { class: 'dialog-actions' }, [
        el('button', {
          class: 'btn btn-secondary',
          onclick: () => { overlay.remove(); decide('cancel'); },
        }, 'إلغاء'),
        el('button', {
          class: 'btn btn-secondary',
          onclick: () => {
            overlay.remove();
            _askSpreadMonths(amountMinor, (months) => decide('spread', months));
          },
        }, 'توزيع على أشهر'),
        el('button', {
          class: 'btn btn-primary',
          onclick: () => { overlay.remove(); decide('normal'); },
        }, 'مصروف عادي'),
      ]),
    ]);
  }

  function _askSpreadMonths(amountMinor, done) {
    const monthsInput = input('number', '12', { min: 2, max: 120, step: 1 });
    const { overlay } = BeeStore.dialogs.openDialog('توزيع المصروف على أشهر', [
      el('p', { class: 'form-hint' },
        'سيُسجّل المبلغ مدفوعاً مقدماً، ثم يُستهلك ' + formatMoney(amountMinor) +
        ' على الأشهر المختارة ابتداءً من شهر المصروف. راجع المحاسب للتأكد من العمر المناسب.'),
      formField('عدد الأشهر', monthsInput, true, 'شهران على الأقل.'),
      el('div', { class: 'dialog-actions' }, [
        el('button', { class: 'btn btn-secondary', onclick: () => overlay.remove() }, 'إلغاء'),
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const months = Math.floor(BeeStore.money.parseDecimal(monthsInput.value) || 0);
            if (months < 2) { toast('أدخل شهرين على الأقل', 'error'); return; }
            overlay.remove();
            done(months);
          },
        }, 'توزيع'),
      ]),
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
    BeeStore.dialogs.voidDialog(
      'إلغاء المصروف',
      'مصروف',
      async ({ reason }) => {
        const res = await BeeStore.api.expenses.void(id, reason);
        if (res.ok) {
          toast('تم إلغاء المصروف');
          render(document.getElementById('page-content'));
        } else toast(res.error.message, 'error');
      },
      { id: id }
    );
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.expenses = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
