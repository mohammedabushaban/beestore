(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, formatDocDate, toast } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'المرتجعات والاستبدال'));

    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _newReturn() }, '+ مرتجع / استبدال');
    container.appendChild(addBtn);
    // v2 §5: period scope + show-all toggle.
    if (BeeStore.period) await BeeStore.period.scopeBar(container);
    let showAll = false;
    let unlinkedOnly = false;

    const searchInput = input('text', '', { placeholder: 'بحث في المرتجعات (رقم الفاتورة أو الزبون أو السبب)...', class: 'form-input' });
    const scopeBtn = el('button', { class: 'btn btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض الشهر' : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');
    const unlinkedBtn = el('button', { class: 'btn btn-secondary', onclick: async () => {
      unlinkedOnly = !unlinkedOnly;
      unlinkedBtn.textContent = unlinkedOnly ? 'عرض كل المرتجعات' : 'بدون مرجع فقط';
      await _load();
    } }, 'بدون مرجع فقط');
    container.appendChild(el('div', { class: 'filter-row' }, [searchInput, scopeBtn, unlinkedBtn]));

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
          (r.reason || '').toLowerCase().includes(q) ||
          (!r.saleId && ('بدون فاتورة بدون مرجع').includes(q))
        );
      }
      if (unlinkedOnly) {
        data = data.filter(r => !r.saleId ||
          (Array.isArray(r.flags) && r.flags.indexOf('NO_REFERENCE') >= 0));
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
    const rows = returns.map(r => {
      const reference = r.saleNumber
        ? r.saleNumber
        : el('span', { class: 'badge badge-warning' }, 'بدون فاتورة');
      return [
        r.number,
        reference,
        formatDocDate(r),
        r.customerName || 'زبون عام',
        r.reason || '-',
        formatMoney(r.refundMinor),
        r.refundMode === 'cash_refund' ? 'استرداد نقدي' : r.refundMode === 'customer_credit' ? 'رصيد زبون' : 'استبدال',
        BeeStore.journalView.button(r, { title: 'قيود المرتجع ' + r.number }) || '',
      ];
    });
    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الرقم'), el('th', {}, 'المرجع'), el('th', {}, 'التاريخ'),
          el('th', {}, 'الزبون'), el('th', {}, 'السبب'), el('th', {}, 'المبلغ'),
          el('th', {}, 'الطريقة'), el('th', {}, ''),
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
          el('span', { class: 'search-result-meta' }, formatDocDate(s) + ' • ' + formatMoney(s.totalMinor)),
        ]));
      }
    }

    const { overlay } = BeeStore.dialogs.openDialog('مرتجع / استبدال', [
      el('p', { class: 'form-hint' },
        'ابحث برقم الفاتورة للربط، أو أنشئ مرتجعاً بدون فاتورة عند عدم توفرها.'),
      formField('رقم الفاتورة أو الهاتف', saleNumberInput, false),
      el('div', { class: 'filter-row' }, [
        el('button', { class: 'btn btn-primary', onclick: _doSearch }, 'بحث بالفاتورة'),
        el('button', {
          class: 'btn btn-secondary',
          onclick: () => { overlay.remove(); _showUnlinkedReturnForm(); },
        }, 'مرتجع بدون فاتورة'),
      ]),
      resultsDiv,
    ]);
    setTimeout(() => saleNumberInput.focus(), 100);
    saleNumberInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _doSearch(); });
  }

  /** v4 R9: item-only return without an invoice reference. */
  async function _showUnlinkedReturnForm(options) {
    options = options || {};
    const items = [];
    const itemsDiv = el('div');
    const searchInput = input('text', '', {
      placeholder: 'باركود أو اسم الصنف... (Enter)',
    });
    const results = el('div', { class: 'search-results' });

    function addVariant(variant) {
      if (!variant || !variant.id) return;
      if (items.some(it => it.variantId === variant.id)) {
        toast('الصنف مضاف مسبقاً', 'error');
        return;
      }
      const qtyEl = input('number', '1', { min: 1, step: 1, style: 'width:70px' });
      const priceEl = input('number',
        ((Number(variant.priceMinor) || 0) / 100).toFixed(2),
        { min: 0, step: 0.01, style: 'width:100px' });
      const restockEl = el('input', { type: 'checkbox' });
      restockEl.checked = true;
      const item = {
        variantId: variant.id,
        productName: variant.productName || '',
        itemCode: variant.itemCode || '',
        listPriceMinor: Number(variant.priceMinor) || 0,
        qtyEl, priceEl, restockEl,
      };
      const row = el('div', {
        class: 'return-line',
        style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #eee;padding:6px 0;',
      }, [
        el('span', { style: 'flex:1;min-width:160px;' }, [
          (item.productName || variant.productId),
          item.itemCode ? ' · ' + item.itemCode : '',
          ' — القائمة: ' + formatMoney(item.listPriceMinor),
        ].join('')),
        qtyEl, priceEl,
        el('label', {}, 'إعادة للمخزون'), restockEl,
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => {
            row.remove();
            const idx = items.indexOf(item);
            if (idx > -1) items.splice(idx, 1);
          },
        }, 'حذف'),
      ]);
      items.push(item);
      itemsDiv.appendChild(row);
      searchInput.value = '';
      searchInput.focus();
    }

    async function addByQuery(query) {
      const q = String(query || '').trim();
      if (!q) return;
      let variant = null;
      const barcodeRes = await BeeStore.api.variants.byBarcode(q);
      if (barcodeRes.ok && barcodeRes.data) variant = barcodeRes.data;
      else {
        const searchRes = await BeeStore.api.variants.search(q);
        if (searchRes.ok && searchRes.data.length > 0) variant = searchRes.data[0];
      }
      if (!variant) { toast('الصنف غير موجود', 'error'); return; }
      addVariant(variant);
    }

    searchInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      await addByQuery(searchInput.value);
    });
    const scanBtn = BeeStore.scanner.scanButton(async (code) => {
      searchInput.value = code;
      await addByQuery(code);
    }, { label: 'مسح' });

    const customersRes = await BeeStore.api.customers.list();
    const customerSelect = select([{ value: '', label: 'بدون زبون' }], '');
    if (customersRes.ok) {
      for (const c of customersRes.data) {
        customerSelect.appendChild(el('option', { value: c.id }, c.name));
      }
    }
    const dateInput = input('date', options.date || BeeStore.dates.today());
    const reasonInput = input('text', '', {
      placeholder: 'سبب المرتجع (مطلوب)',
    });
    const refundMode = select([
      { value: 'cash_refund', label: 'استرداد نقدي' },
      { value: 'customer_credit', label: 'رصيد زبون' },
    ], 'cash_refund');
    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    BeeStore.api.settings.get().then(res => {
      if (!res.ok) return;
      const methods = (res.data.paymentMethods || [])
        .filter(m => BeeStore.settings.methodKind(res.data, m.id) !== 'customer_credit');
      methodSelect.textContent = '';
      for (const method of methods) {
        methodSelect.appendChild(el('option', { value: method.id }, method.name));
      }
      if (methods.some(m => m.id === 'cash')) methodSelect.value = 'cash';
    });
    const accountField = formField('طريقة رد المبلغ', methodSelect);

    const { overlay } = BeeStore.dialogs.openDialog('مرتجع بدون فاتورة', [
      el('p', { class: 'alert alert-warning' },
        'بدون فاتورة: السعر الافتراضي هو سعر القائمة، وتكلفة الإرجاع تُحسب بمتوسط التكلفة الحالي. السبب مطلوب.'),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label' }, 'إضافة صنف'),
        el('div', { class: 'field-with-action' }, [searchInput, scanBtn]),
        results,
      ]),
      itemsDiv,
      formField('التاريخ', dateInput, true),
      formField('السبب', reasonInput, true),
      formField('الزبون (اختياري)', customerSelect),
      formField('طريقة الاسترداد', refundMode),
      accountField,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!reasonInput.value.trim()) {
            toast('سبب المرتجع مطلوب', 'error');
            return;
          }
          if (items.length === 0) {
            toast('أضف صنفاً واحداً على الأقل', 'error');
            return;
          }
          const lines = [];
          for (const item of items) {
            const qty = Math.floor(Number(item.qtyEl.value) || 0);
            if (qty <= 0) {
              toast('أدخل كمية صحيحة لكل صنف', 'error');
              return;
            }
            const priceMinor = BeeStore.money.fromMajor(item.priceEl.value);
            if (priceMinor < 0) {
              toast('سعر الاسترداد لا يمكن أن يكون سالباً', 'error');
              return;
            }
            lines.push({
              variantId: item.variantId,
              qty,
              unitPriceMinor: priceMinor,
              restock: item.restockEl.checked,
            });
          }
          const customerId = customerSelect.value || null;
          const res = await BeeStore.api.returns.create({
            saleId: null,
            date: dateInput.value || BeeStore.dates.today(),
            lines,
            reason: reasonInput.value.trim(),
            customerId,
            customerName: customerId && customerSelect.selectedOptions[0]
              ? customerSelect.selectedOptions[0].text : null,
            refundMode: refundMode.value,
            refundPaymentMethod: refundMode.value === 'cash_refund'
              ? (methodSelect.value || 'cash') : null,
          });
          if (res.ok) {
            toast('تم إنشاء المرتجع بدون فاتورة');
            overlay.remove();
            render(document.getElementById('page-content'));
          } else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ], null, { large: true });
    setTimeout(() => searchInput.focus(), 100);
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

    const methodSelect = select([{ value: 'cash', label: 'نقداً' }], 'cash');
    BeeStore.api.settings.get().then(res => {
      if (!res.ok) return;
      const methods = (res.data.paymentMethods || [])
        .filter(m => BeeStore.settings.methodKind(res.data, m.id) !== 'customer_credit');
      methodSelect.textContent = '';
      for (const method of methods) {
        methodSelect.appendChild(el('option', { value: method.id }, method.name));
      }
      if (methods.some(m => m.id === 'cash')) methodSelect.value = 'cash';
    });
    const accountField = el('div', { class: 'form-group', id: 'return-account-field' }, [
      el('label', { class: 'form-label' }, 'طريقة رد المبلغ'),
      methodSelect,
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
            refundPaymentMethod: refundMode.value === 'cash_refund' ? methodSelect.value || 'cash' : null,
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

    async function addByQuery(q) {
      q = String(q || '').trim();
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
    }

    searchInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      await addByQuery(searchInput.value);
    });

    const scanBtn = BeeStore.scanner.scanButton(async (code) => {
      searchInput.value = code;
      await addByQuery(code);
    }, { label: 'مسح' });

    panel.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'form-label' }, 'أضف صنفاً للاستبدال (Enter)'),
      el('div', { class: 'field-with-action' }, [searchInput, scanBtn]),
      results,
    ]));
    panel.appendChild(itemsDiv);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.returns = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
