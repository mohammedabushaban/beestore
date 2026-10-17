(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'المرتجعات والاستبدال'));

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _newReturn() }, '+ مرتجع / استبدال');
    container.appendChild(addBtn);
    // v2 §5: period scope + show-all toggle.
    if (BeeStore.period) await BeeStore.period.scopeBar(container);
    let showAll = false;

    const searchInput = input('text', '', { placeholder: 'بحث في المرتجعات (رقم الفاتورة أو الزبون أو السبب)...', class: 'form-input' });
    const scopeBtn = el('button', { class: 'btn btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض الشهر' : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');
    container.appendChild(el('div', { class: 'filter-row' }, [searchInput, scopeBtn]));

    const listDiv = el('div', { id: 'returns-list' });
    container.appendChild(listDiv);

    async function _load() {
      const q = searchInput.value.trim().toLowerCase();
      const filters = {};
      if (BeeStore.period && !showAll) {
        const range = BeeStore.period.getRange();
        filters.from = range.from; filters.to = range.to;
      }
      const res = await BeeStore.api.returns.list(filters);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      let data = res.data;
      if (q) {
        data = data.filter(r =>
          (r.saleNumber || '').toLowerCase().includes(q) ||
          r.number.toLowerCase().includes(q) ||
          (r.customerName || '').toLowerCase().includes(q) ||
          (r.reason || '').toLowerCase().includes(q)
        );
      }
      _renderList(listDiv, data);
    }

    searchInput.addEventListener('input', _load);
    await _load();
  }

  function _renderList(container, returns) {
    container.innerHTML = '';
    if (returns.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مرتجعات'));
      return;
    }
    const rows = returns.map(r => [
      r.number,
      formatDate(r.date),
      r.reason || '-',
      formatMoney(r.refundMinor),
      r.refundMode === 'cash_refund' ? 'استرداد نقدي' : r.refundMode === 'customer_credit' ? 'رصيد زبون' : 'استبدال',
    ]);
    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'), el('th', {}, 'السبب'),
          el('th', {}, 'المبلغ'), el('th', {}, 'الطريقة'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _newReturn() {
    const saleNumberInput = input('text', '', { placeholder: 'رقم الفاتورة أو اسم الزبون أو الهاتف' });
    const resultsDiv = el('div', { class: 'search-results' });

    async function _doSearch() {
      const query = saleNumberInput.value.trim();
      if (!query) { toast('أدخل رقم الفاتورة أو الهاتف', 'error'); return; }
      resultsDiv.innerHTML = '';
      const byNumber = await BeeStore.api.sales.getByNumber(query);
      if (byNumber.ok && byNumber.data) {
        overlay.remove();
        _showReturnForm(byNumber.data);
        return;
      }
      const res = await BeeStore.api.sales.searchForReturn(query);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const sales = res.data.filter(s => s.status !== 'void');
      if (sales.length === 0) { toast('لا توجد فاتورة مطابقة', 'error'); return; }
      if (sales.length === 1) {
        overlay.remove();
        _showReturnForm(sales[0]);
        return;
      }
      for (const s of sales) {
        resultsDiv.appendChild(el('button', {
          class: 'search-result-item',
          onclick: () => { overlay.remove(); _showReturnForm(s); },
        }, [
          el('span', { class: 'search-result-name' }, s.number + ' — ' + (s.customerName || 'نقدي')),
          el('span', { class: 'search-result-meta' }, formatDate(s.date) + ' • ' + formatMoney(s.totalMinor)),
        ]));
      }
    }

    const { overlay } = BeeStore.dialogs.openDialog('مرتجع / استبدال', [
      formField('رقم الفاتورة أو الهاتف', saleNumberInput, true),
      el('button', { class: 'btn btn-primary', onclick: _doSearch }, 'بحث'),
      resultsDiv,
    ]);
    setTimeout(() => saleNumberInput.focus(), 100);
    saleNumberInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _doSearch(); });
  }

  function _showReturnForm(sale) {
    const linesDiv = el('div', { id: 'return-lines' });
    const lines = sale.lines.map((line, idx) => {
      const maxReturn = line.qty - (line.returnedQty || 0);
      const qtyInput = input('number', '0', { min: 0, max: maxReturn });
      qtyInput.dataset.index = idx;
      const restockCheck = el('input', { type: 'checkbox' });
      restockCheck.checked = true;
      restockCheck.dataset.index = idx;

      return el('div', { class: 'return-line' }, [
        el('span', {}, line.productName + ' - ' + line.size + ' - ' + line.color),
        el('span', {}, 'Max: ' + maxReturn),
        qtyInput,
        el('label', {}, 'إعادة للمخزون'),
        restockCheck,
      ]);
    });
    lines.forEach(row => linesDiv.appendChild(row));

    const reasonInput = input('text', '', { placeholder: 'السبب' });
    const dateInput = input('date', BeeStore.dates.today());
    const refundMode = select([
      { value: 'cash_refund', label: 'استرداد نقدي' },
      { value: 'customer_credit', label: 'رصيد زبون' },
      { value: 'exchange', label: 'استبدال' },
    ], 'cash_refund');

    const accountSelect = select([{ value: '', label: 'اختر الحساب' }], '');
    BeeStore.api.accounts.list().then(async res => {
      if (!res.ok || res.data.length === 0) return;
      const settings = await BeeStore.settings.get();
      const cashDefault = BeeStore.settings.resolvePaymentAccount(settings, 'cash');
      for (const a of res.data) {
        accountSelect.appendChild(el('option', { value: a.id }, a.name));
      }
      if (cashDefault) accountSelect.value = cashDefault;
    });
    const accountField = el('div', { class: 'form-group', id: 'return-account-field' }, [
      el('label', { class: 'form-label' }, 'حساب الاسترداد'),
      accountSelect,
    ]);

    const exchangeItems = [];
    const exchangePanel = el('div', { id: 'exchange-panel', class: 'card', style: 'display:none' }, [
      el('h4', {}, 'أصناف الاستبدال'),
    ]);
    _buildExchangePicker(exchangePanel, exchangeItems);

    refundMode.addEventListener('change', () => {
      const v = refundMode.value;
      accountField.style.display = v === 'cash_refund' ? '' : 'none';
      exchangePanel.style.display = v === 'exchange' ? '' : 'none';
    });
    accountField.style.display = '';
    exchangePanel.style.display = 'none';

    const { overlay, dialog } = BeeStore.dialogs.openDialog('مرتجع للفاتورة ' + sale.number, [
      el('h4', {}, 'الأصناف'),
      linesDiv,
      formField('التاريخ', dateInput, true),
      formField('السبب', reasonInput),
      formField('طريقة الاسترداد', refundMode),
      accountField,
      exchangePanel,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const returnLines = [];
          let totalQty = 0;
          linesDiv.querySelectorAll('.return-line').forEach(row => {
            const idx = Number(row.querySelector('input[type=number]').dataset.index);
            const qty = Number(row.querySelector('input[type=number]').value) || 0;
            const restock = row.querySelector('input[type=checkbox]').checked;
            if (qty > 0) {
              returnLines.push({ saleLineIndex: idx, qty, restock });
              totalQty += qty;
            }
          });
          if (totalQty === 0) { toast('أدخل كمية واحدة على الأقل', 'error'); return; }
          const exchangeLines = refundMode.value === 'exchange'
            ? exchangeItems
                .filter(it => (Number(it.qtyEl.value) || 0) > 0)
                .map(it => ({ variantId: it.variantId, qty: Number(it.qtyEl.value), unitPriceMinor: it.unitPriceMinor }))
            : undefined;
          const res = await BeeStore.api.returns.create({
            saleId: sale.id,
            date: dateInput.value || BeeStore.dates.today(),
            lines: returnLines,
            reason: reasonInput.value.trim(),
            refundMode: refundMode.value,
            refundMethod: refundMode.value === 'cash_refund' ? accountSelect.value || null : null,
            exchangeLines: refundMode.value === 'exchange' ? exchangeLines || [] : undefined,
          });
          if (res.ok) { toast('تم إنشاء المرتجع'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _buildExchangePicker(panel, items) {
    const searchInput = input('text', '', { placeholder: 'باركود أو اسم الصنف...' });
    const results = el('div', { class: 'search-results' });
    const itemsDiv = el('div', { id: 'exchange-items' });

    searchInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      let variant = null;
      const barcodeRes = await BeeStore.api.variants.byBarcode(q);
      if (barcodeRes.ok && barcodeRes.data) variant = barcodeRes.data;
      else {
        const sRes = await BeeStore.api.variants.search(q);
        if (sRes.ok && sRes.data.length > 0) variant = sRes.data[0];
      }
      if (!variant) { toast('الصنف غير موجود', 'error'); return; }
      if (items.some(it => it.variantId === variant.id)) { toast('الصنف مضاف مسبقاً', 'error'); return; }
      const qtyEl = input('number', '1', { min: 1, style: 'width:60px' });
      const item = {
        variantId: variant.id,
        productName: variant.productName || '',
        size: variant.size,
        color: variant.color,
        unitPriceMinor: variant.priceMinor,
        qtyEl,
      };
      items.push(item);
      const row = el('div', { class: 'exchange-line' }, [
        el('span', {}, (item.productName || variant.productId) + ' - ' + variant.size + ' - ' + variant.color + ' @ ' + formatMoney(variant.priceMinor)),
        qtyEl,
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => {
            row.remove();
            const idx = items.indexOf(item);
            if (idx > -1) items.splice(idx, 1);
          },
        }, 'حذف'),
      ]);
      itemsDiv.appendChild(row);
      searchInput.value = '';
      searchInput.focus();
    });

    panel.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'form-label' }, 'أضف صنفاً للاستبدال (Enter)'),
      searchInput,
      results,
    ]));
    panel.appendChild(itemsDiv);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.returns = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
