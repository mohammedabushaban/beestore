(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, statusBadge, emptyState, table, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الفواتير'));
    // v2 §5: period-scoped flows — the selected period applies automatically.
    if (BeeStore.period) await BeeStore.period.scopeBar(container);
    let showAll = false;

    const searchInput = el('input', { type: 'text', class: 'form-input', placeholder: 'بحث برقم الفاتورة أو اسم الزبون...' });
    const statusSelect = el('select', { class: 'form-input' }, [
      el('option', { value: '' }, 'كل الحالات'),
      el('option', { value: 'paid' }, 'مدفوع'),
      el('option', { value: 'partial' }, 'مدفوع جزئياً'),
      el('option', { value: 'unpaid' }, 'غير مدفوع'),
      el('option', { value: 'void' }, 'ملغي'),
    ]);
    const scopeBtn = el('button', { class: 'btn btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض ' + BeeStore.period.label() : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');

    const filterRow = el('div', { class: 'filter-row' }, [
      searchInput,
      statusSelect,
      scopeBtn,
      el('button', { class: 'btn btn-secondary', onclick: () => _load() }, 'تصفية'),
    ]);
    container.appendChild(filterRow);

    const listDiv = el('div', { id: 'invoices-list' });
    container.appendChild(listDiv);

    async function _load() {
      const filters = { search: searchInput.value.trim() };
      if (statusSelect.value) filters.status = statusSelect.value;
      if (BeeStore.period && !showAll) {
        const range = BeeStore.period.getRange();
        filters.from = range.from; filters.to = range.to;
      }
      const res = await BeeStore.api.sales.list(filters);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      _renderList(listDiv, res.data);
    }

    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _load(); });
    statusSelect.addEventListener('change', _load);
    await _load();
  }

  function _returnBadge(sale) {
    if (!sale.returnStatus || sale.returnStatus === 'none') return null;
    const full = sale.returnStatus === 'full';
    return el('span', {
      class: 'badge ' + (full ? 'badge-info' : 'badge-warning'),
      title: full ? 'تم إرجاع كامل الفاتورة' : 'تم إرجاع جزء من الفاتورة',
    }, full ? 'مرتجع كامل' : 'مرتجع جزئي');
  }

  function _renderList(container, invoices) {
    container.innerHTML = '';
    if (invoices.length === 0) {
      container.appendChild(emptyState('لا توجد فواتير'));
      return;
    }
    const rows = invoices.map(inv => {
      const hasReturns = inv.returnStatus && inv.returnStatus !== 'none';
      return [
        inv.number,
        formatDate(inv.date),
        inv.customerName || 'نقدي',
        formatMoney(inv.totalMinor),
        inv.dueMinor > 0 ? formatMoney(inv.dueMinor) : '-',
        el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap; align-items:center' }, [
          statusBadge(inv.status),
          _returnBadge(inv),
        ]),
        el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _viewInvoice(inv.id) }, 'عرض'),
        (inv.status !== 'void' && inv.dueMinor > 0 && inv.customerId)
          ? el('button', { class: 'btn btn-sm btn-success', onclick: () => _receiveInvoicePayment(inv) }, 'دفعة')
          : '',
        el('button', { class: 'btn btn-sm btn-primary', onclick: () => BeeStore.print.printInvoice(inv.id) }, 'طباعة'),
        (inv.status === 'void' || inv.returnStatus !== 'none')
          ? ''
          : el('button', { class: 'btn btn-sm btn-danger', onclick: () => _voidInvoice(inv.id, inv.number) }, 'إلغاء'),
      ];
    });
    container.appendChild(table(
      ['الرقم', 'التاريخ', 'الزبون', 'الإجمالي', 'المتبقي', 'الحالة', 'عرض', 'دفعة', 'طباعة', 'إلغاء'],
      rows
    ));
  }

  async function _receiveInvoicePayment(sale) {
    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const amountInput = input('number', BeeStore.money.toMajor(sale.dueMinor), { placeholder: 'المبلغ', min: 0, step: 0.01 });
    const dateInput = input('date', BeeStore.dates.today());
    const dateNotice = el('p', { class: 'period-notice', style: 'display:none' });
    if (BeeStore.period) BeeStore.period.applyDefaultDate(dateInput, dateNotice);
    const methodSelect = select(BeeStore.settings.methodOptions(s), 'cash');
    const payerNameInput = input('text', '', { placeholder: 'اسم المحوِّل / الدافع' });
    const payerPhoneInput = input('text', '', { placeholder: 'رقم الجوال أو المحفظة' });

    const { overlay } = BeeStore.dialogs.openDialog('استلام دفعة - فاتورة ' + sale.number, [
      el('p', {}, 'الزبون: ' + (sale.customerName || 'نقدي') + ' • المتبقي: ' + formatMoney(sale.dueMinor)),
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
          if (amount > sale.dueMinor) { toast('المبلغ أكبر من المتبقي (' + formatMoney(sale.dueMinor) + ')', 'error'); return; }
          const res = await BeeStore.api.customers.receivePayment({
            customerId: sale.customerId,
            saleId: sale.id,
            amountMinor: amount,
            method: methodSelect.value,
            payerName: payerNameInput.value,
            payerPhone: payerPhoneInput.value,
            date: dateInput.value || BeeStore.dates.today(),
          });
          if (res.ok) { toast('تم استلام الدفعة'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  async function _viewInvoice(id) {
    const res = await BeeStore.api.sales.printData(id);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const { sale, customer, settings, payments, returns } = res.data;
    const overlay = el('div', { class: 'dialog-overlay' });
    const refundedMinor = (returns || []).reduce((sum, r) => sum + (r.refundMinor || 0), 0);
    const content = el('div', { class: 'dialog dialog-lg' }, [
      el('div', { class: 'dialog-header' }, [
        el('h3', {}, 'فاتورة ' + sale.number),
        _returnBadge(sale),
        el('button', { class: 'btn-close', onclick: () => overlay.remove() }, '×'),
      ]),
      el('div', { class: 'dialog-body' }, [
        el('p', {}, 'التاريخ: ' + formatDate(sale.date)),
        customer ? el('p', {}, 'الزبون: ' + customer.name) : null,
        (sale.contactPhone || (customer && customer.phone)) ? el('p', {}, 'الجوال: ' + (sale.contactPhone || customer.phone)) : null,
        sale.payerName ? el('p', {}, 'المحوِّل: ' + sale.payerName) : null,
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'المنتج'), el('th', {}, 'المقاس'), el('th', {}, 'اللون'),
            el('th', {}, 'الكمية'), el('th', {}, 'السعر'), el('th', {}, 'الإجمالي'),
          ])),
          el('tbody', {}, sale.lines.map(line => el('tr', {}, [
            el('td', {}, line.productName),
            el('td', {}, line.size),
            el('td', {}, line.color),
            el('td', {}, line.returnedQty ? line.qty + ' (مرتجع ' + line.returnedQty + ')' : String(line.qty)),
            el('td', {}, formatMoney(line.unitPriceMinor)),
            el('td', {}, formatMoney(line.lineTotalMinor)),
          ]))),
        ]),
        el('div', { class: 'invoice-totals' }, [
          el('p', {}, 'المجموع الفرعي: ' + formatMoney(sale.subtotalMinor)),
          sale.discountMinor > 0 ? el('p', {}, 'الخصم: -' + formatMoney(sale.discountMinor)) : null,
          sale.taxMinor > 0 ? el('p', {}, 'الضريبة: ' + formatMoney(sale.taxMinor)) : null,
          el('p', { class: 'total-final' }, 'الإجمالي: ' + formatMoney(sale.totalMinor)),
          el('p', {}, 'المدفوع: ' + formatMoney(sale.paidMinor)),
          el('p', {}, 'المتبقي: ' + formatMoney(sale.dueMinor)),
          refundedMinor > 0 ? el('p', { style: 'color:#856404; font-weight:600' }, 'المرتجع: -' + formatMoney(refundedMinor)) : null,
        ]),
        (returns && returns.length) ? el('div', { class: 'card' }, [
          el('h4', {}, 'المرتجعات'),
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'), el('th', {}, 'المبلغ'), el('th', {}, 'الطريقة'), el('th', {}, 'السبب'),
            ])),
            el('tbody', {}, returns.map(r => el('tr', {}, [
              el('td', {}, r.number),
              el('td', {}, formatDate(r.date)),
              el('td', {}, formatMoney(r.refundMinor)),
              el('td', {}, r.refundMode === 'cash_refund' ? 'استرداد نقدي' : r.refundMode === 'customer_credit' ? 'رصيد زبون' : 'استبدال'),
              el('td', {}, r.reason || '-'),
            ]))),
          ]),
        ]) : null,
        (payments && payments.length) ? el('div', { class: 'card' }, [
          el('h4', {}, 'الدفعات'),
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'التاريخ'), el('th', {}, 'طريقة الدفع'), el('th', {}, 'المبلغ'),
              el('th', {}, 'المحوِّل'), el('th', {}, 'الجوال'),
            ])),
            el('tbody', {}, payments.map(p => el('tr', {}, [
              el('td', {}, formatDate(p.date)),
              el('td', {}, BeeStore.settings.methodLabel(settings || {}, p.method)),
              el('td', {}, formatMoney(p.amountMinor)),
              el('td', {}, p.payerName || '-'),
              el('td', {}, p.payerPhone || '-'),
            ]))),
          ]),
        ]) : null,
        sale.installmentPlan ? el('div', { class: 'card' }, [
          el('h4', {}, 'خطة الأقساط'),
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, '#'), el('th', {}, 'تاريخ الاستحقاق'), el('th', {}, 'المبلغ'), el('th', {}, 'المدفوع'), el('th', {}, 'الحالة'),
            ])),
            el('tbody', {}, sale.installmentPlan.schedule.map(inst => el('tr', {}, [
              el('td', {}, String(inst.n)),
              el('td', {}, inst.dueDate),
              el('td', {}, formatMoney(inst.amountMinor)),
              el('td', {}, formatMoney(inst.paidMinor)),
              el('td', {}, inst.status === 'paid' ? 'مدفوع' : inst.status === 'overdue' ? 'متأخر' : 'معلق'),
            ]))),
          ]),
        ]) : null,
        (sale.dueMinor > 0 && sale.customerId) ? el('button', {
          class: 'btn btn-success',
          onclick: () => { overlay.remove(); _receiveInvoicePayment(sale); },
        }, 'استلام دفعة (' + formatMoney(sale.dueMinor) + ')') : null,
        el('button', { class: 'btn btn-primary', onclick: () => BeeStore.print.printInvoice(sale.id) }, 'طباعة'),
      ]),
    ]);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
  }

  function _voidInvoice(id, number) {
    confirmDialog('إلغاء الفاتورة', 'هل أنت متأكد من إلغاء الفاتورة ' + number + '؟', async () => {
      const reason = prompt('سبب الإلغاء:');
      if (!reason) return;
      const res = await BeeStore.api.sales.void(id, reason);
      if (res.ok) {
        toast('تم إلغاء الفاتورة');
        render(document.getElementById('page-content'));
      }
      else toast(res.error.message, 'error');
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.invoices = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
