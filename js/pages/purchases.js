(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'المشتريات'));
    if (BeeStore.period) await BeeStore.period.scopeBar(container);

    const content = el('div', { id: 'purchases-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('purchases', content); _setActiveTab(this); } }, 'فواتير المشتريات'),
      el('button', { class: 'tab', onclick: function () { _showTab('returns', content); _setActiveTab(this); } }, 'مرتجعات المشتريات'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('purchases', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'purchases') _renderPurchases(container);
    else _renderPurchaseReturns(container);
  }

  async function _renderPurchases(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addPurchase() }, '+ فاتورة مشتريات');
    container.appendChild(addBtn);
    // v2 §5: period scope + show-all toggle (shared state per tab).
    let showAll = false;
    const scopeBtn = el('button', { class: 'btn btn-sm btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض الشهر' : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');

    const searchInput = input('text', '', { placeholder: 'بحث...', class: 'form-input' });
    container.appendChild(el('div', { class: 'filter-row' }, [searchInput, scopeBtn]));

    const listDiv = el('div', { id: 'purchases-list' });
    container.appendChild(listDiv);

    async function _load() {
      const filters = {};
      if (BeeStore.period && !showAll) {
        const range = BeeStore.period.getRange();
        filters.from = range.from; filters.to = range.to;
      }
      const res = await BeeStore.api.purchases.list(filters);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      let data = res.data;
      const q = searchInput.value.trim().toLowerCase();
      if (q) {
        data = data.filter(p =>
          (p.number || '').toLowerCase().includes(q) ||
          (p.supplierName || '').toLowerCase().includes(q)
        );
      }
      _renderList(listDiv, data);
    }

    searchInput.addEventListener('input', _load);
    await _load();
  }

  async function _renderPurchaseReturns(container) {
    container.appendChild(el('button', { class: 'btn btn-primary', onclick: () => _addPurchaseReturn() }, '+ مرتجع مشتريات'));

    let showAll = false;
    const scopeBtn = el('button', { class: 'btn btn-sm btn-secondary', onclick: async () => {
      showAll = !showAll;
      scopeBtn.textContent = showAll ? 'عرض الشهر' : 'عرض الكل';
      await _load();
    } }, 'عرض الكل');
    container.appendChild(el('div', { class: 'filter-row' }, scopeBtn));

    const listDiv = el('div', { id: 'pret-list' });
    container.appendChild(listDiv);

    async function _load() {
      const filters = {};
      if (BeeStore.period && !showAll) {
        const range = BeeStore.period.getRange();
        filters.from = range.from; filters.to = range.to;
      }
      const res = await BeeStore.api.purchaseReturns.list(filters);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      _renderPretList(listDiv, res.data);
    }
    await _load();
  }

  function _renderPretList(listDiv, data) {
    listDiv.innerHTML = '';
    if (data.length === 0) {
      listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مرتجعات مشتريات'));
      return;
    }
    const rows = data.map(r => [
      r.number,
      formatDate(r.date),
      r.purchaseNumber || '-',
      r.supplierName || '-',
      formatMoney(r.totalMinor),
      r.mode === 'cash_refund' ? 'استرداد نقدي' : 'تخفيض الذمة',
      r.reason || '-',
    ]);
    listDiv.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'), el('th', {}, 'فاتورة الشراء'),
          el('th', {}, 'المورد'), el('th', {}, 'المبلغ'), el('th', {}, 'الطريقة'), el('th', {}, 'السبب'),
        ])),
        el('tbody', {}, rows.map(row => el('tr', {}, row.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _addPurchaseReturn() {
    const purSelect = select([{ value: '', label: 'اختر فاتورة المشتريات' }], '');
    const purRes = await BeeStore.api.purchases.list();
    if (!purRes.ok) { toast(purRes.error.message, 'error'); return; }
    const returnable = purRes.data.filter(p =>
      p.status !== 'void' && (p.lines || []).some(l => (l.qty - (l.returnedQty || 0)) > 0));
    if (returnable.length === 0) { toast('لا توجد فواتير قابلة للإرجاع', 'error'); return; }
    for (const p of returnable) {
      purSelect.appendChild(el('option', { value: p.id }, p.number + ' - ' + (p.supplierName || '')));
    }

    const linesDiv = el('div', { id: 'pret-lines' });
    const modeSelect = select([
      { value: 'reduce_payable', label: 'تخفيض الذمة' },
      { value: 'cash_refund', label: 'استرداد نقدي' },
    ], 'reduce_payable');
    const accSelect = select([{ value: '', label: 'الحساب' }], '');
    BeeStore.api.accounts.list().then(async res => {
      if (!res.ok) return;
      for (const a of res.data) accSelect.appendChild(el('option', { value: a.id }, a.name));
      if (res.data.length === 1) accSelect.value = res.data[0].id;
    });
    const accField = el('div', { class: 'form-group' }, [
      el('label', { class: 'form-label' }, 'حساب الاسترداد'), accSelect,
    ]);
    accField.style.display = 'none';
    modeSelect.addEventListener('change', () => {
      accField.style.display = modeSelect.value === 'cash_refund' ? '' : 'none';
    });
    const reasonInput = input('text', '', { placeholder: 'السبب' });
    const dateInput = input('date', BeeStore.dates.today());

    async function loadLines() {
      linesDiv.innerHTML = '';
      if (!purSelect.value) return;
      const g = await BeeStore.api.purchases.get(purSelect.value);
      const p = g.ok ? g.data : null;
      if (!p) return;
      const vRes = await BeeStore.api.variants.list();
      const vMap = {};
      if (vRes.ok) for (const v of vRes.data) vMap[v.id] = v;
      p.lines.forEach((l, idx) => {
        const max = l.qty - (l.returnedQty || 0);
        if (max <= 0) return;
        const v = vMap[l.variantId];
        const qtyInput = input('number', '0', { min: 0, max });
        qtyInput.dataset.index = String(idx);
        linesDiv.appendChild(el('div', { class: 'return-line' }, [
          el('span', {}, (v ? v.size + ' / ' + v.color : l.variantId)),
          el('span', {}, 'المتاح: ' + max),
          qtyInput,
        ]));
      });
    }
    purSelect.addEventListener('change', loadLines);

    const { overlay } = BeeStore.dialogs.openDialog('مرتجع مشتريات', [
      formField('فاتورة المشتريات', purSelect, true),
      formField('التاريخ', dateInput, true),
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label' }, 'الأصناف'), linesDiv]),
      formField('الطريقة', modeSelect),
      accField,
      formField('السبب', reasonInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!purSelect.value) { toast('اختر الفاتورة', 'error'); return; }
          const lines = [];
          linesDiv.querySelectorAll('input[type=number]').forEach(inp => {
            const qty = Math.floor(Number(inp.value) || 0);
            if (qty > 0) lines.push({ purchaseLineIndex: Number(inp.dataset.index), qty });
          });
          if (lines.length === 0) { toast('أدخل كمية واحدة على الأقل', 'error'); return; }
          const res = await BeeStore.api.purchaseReturns.create({
            purchaseId: purSelect.value,
            date: dateInput.value || BeeStore.dates.today(),
            lines,
            mode: modeSelect.value,
            accountId: modeSelect.value === 'cash_refund' ? (accSelect.value || null) : null,
            reason: reasonInput.value.trim(),
          });
          if (res.ok) { toast('تم إنشاء مرتجع المشتريات'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _renderList(container, purchases) {
    container.innerHTML = '';
    if (purchases.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد مشتريات'));
      return;
    }
    const rows = purchases.map(p => [
      p.number,
      formatDate(p.date),
      p.supplierName || '-',
      formatMoney(p.totalMinor),
      p.status === 'received' ? el('span', { class: 'badge badge-success' }, 'مستلمة')
        : p.status === 'void' ? el('span', { class: 'badge badge-muted' }, 'ملغاة')
        : el('span', { class: 'badge badge-warning' }, p.status),
      p.status === 'void'
        ? ''
        : el('button', { class: 'btn btn-sm btn-danger', onclick: () => _voidPurchase(p.id, p.number) }, 'إلغاء'),
    ]);
    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الرقم'), el('th', {}, 'التاريخ'), el('th', {}, 'المورد'),
          el('th', {}, 'الإجمالي'), el('th', {}, 'الحالة'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

function _addPurchase() {
    const supplierSelect = select([{ value: '', label: 'اختر المورد' }], '');
    BeeStore.api.suppliers.list().then(res => {
      if (res.ok) for (const s of res.data) supplierSelect.appendChild(el('option', { value: s.id }, s.name));
    });

    // Product selector with search capability
    let productSelect = null;
    let variantSelect = null;
    let productSearchTimeout = null;

    async function loadProducts(query) {
      if (productSearchTimeout) clearTimeout(productSearchTimeout);
      productSearchTimeout = setTimeout(async () => {
        const res = await BeeStore.api.products.searchProducts(query || '');
        if (!res.ok) return;
        const products = res.data;
        productSelect.innerHTML = '';
        // Add "Add new product" option at the top
        const addOption = el('option', { value: 'new' }, 'إضافة منتج جديد');
        productSelect.appendChild(addOption);
        for (const p of products) {
          productSelect.appendChild(el('option', { value: p.id }, p.nameAr || p.name || 'منتج ' + p.id));
        }
        // Add "Create variant with this product" option
        productSelect.appendChild(el('option', { value: 'new_variant' }, 'إضافة صنف لهذا المنتج'));
      }, 300);
    }

    // Initialize product selector
    productSelect = select([{ value: '', label: 'اختر المنتج' }], '');
    loadProducts('').then(() => {
      // Keep the search input updated
      const searchInput = productSelect.previousElementSibling;
      if (searchInput && searchInput.classList.contains('form-input')) {
        searchInput.addEventListener('input', (e) => loadProducts(e.target.value));
      }
    });

    // Variant selector (populated based on product selection)
    variantSelect = select([{ value: '', label: 'اختر الصنف' }], '');

    // When product changes, update variants
    productSelect.addEventListener('change', async () => {
      const selectedValue = productSelect.value;
      variantSelect.innerHTML = '<option value="">-- Choose Item --</option>';
      if (selectedValue === 'new') {
        toast('Will open product add page', 'info');
        productSelect.value = '';
        variantSelect.value = '';
        return;
      }
      if (selectedValue === 'new_variant') {
        toast('Adding new item', 'info');
        productSelect.value = '';
        variantSelect.value = '';
        return;
      }
      // Load variants for this product
      try {
        const vRes = await BeeStore.api.variants.list({ productId: selectedValue });
        if (vRes.ok && vRes.data.length > 0) {
          for (const v of vRes.data) {
            variantSelect.appendChild(el('option', { value: v.id }, v.size + ' / ' + v.color));
          }
        } else {
          variantSelect.appendChild(el('option', { value: '', label: 'No variants yet - will be created on save' }));
        }
      } catch (e) {
        variantSelect.appendChild(el('option', { value: '', label: 'No variants yet' }));
      }
    });

    // Load initial variants (empty state)
    variantSelect.innerHTML = '<option value="">-- Choose Item --</option>';

    const qtyInput = input('number', '1', { min: 1 });
    // Price is per unit (unit cost), not total
    const costInput = input('number', '', { min: 0, step: 0.01, placeholder: 'Unit price (per piece)' });

    // Receiving: scan the supplier label → select the variant + prefill cost.
    let scannedVariant = null;
    const selectVariant = (v) => {
      if (!v) return;
      const exists = Array.prototype.some.call(variantSelect.options, (o) => o.value === v.id);
      if (!exists) variantSelect.appendChild(el('option', { value: v.id }, v.size + ' / ' + v.color));
      variantSelect.value = v.id;
      if (!costInput.value) costInput.value = ((v.costMinor || 0) / 100).toFixed(2);
    };
    const variantScanBtn = BeeStore.scanner.scanButton(() => selectVariant(scannedVariant), {
      label: 'Scan',
      title: 'Scan purchase item',
      validate: async (code) => {
        const v = await BeeStore.scanning.lookupVariant(BeeStore.api, code);
        if (!v) {
          toast('Barcode not found: ' + code, 'error', {
            actionText: 'Add Item',
            duration: 12000,
            onAction: () => {
              const productsPage = BeeStore.pages && BeeStore.pages.products;
              if (productsPage && typeof productsPage.render === 'function') {
                document.querySelector('#page-content').innerHTML = '';
                productsPage.render(document.querySelector('#page-content'));
                toast('Navigating to products page', 'info');
              }
            },
          });
        }
        return { ok: false, message: 'Barcode not found' };
      },
    });
    const paymentInput = input('number', '0', { min: 0, step: 0.01, placeholder: 'Paid' });
    const dateInput = input('date', BeeStore.dates.today());

    const { overlay } = BeeStore.dialogs.openDialog('Purchase Invoice', [
      formField('Date', dateInput, true),
      formField('Supplier', supplierSelect, true),
      // Product selection area
      formField('Product Name', productSelect, true),
      // Show variant info below product selection
      formField('Item', variantSelect, true),
      formField('Quantity', qtyInput, true),
      // Clarify: price is unit price
      formField('Unit Price', costInput, true, 'Price per unit (piece)'),
      formField('Paid', paymentInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!supplierSelect.value) { toast('Choose supplier', 'error'); return; }
          if (!productSelect.value) { toast('Choose product', 'error'); return; }
          if (productSelect.value === 'new') {
            toast('Please add product from products page first', 'error');
            return;
          }
          if (productSelect.value === 'new_variant') {
            toast('Item will be added with invoice', 'info');
          }
          const qty = Number(qtyInput.value) || 0;
          if (qty <= 0) { toast('Enter valid quantity', 'error'); return; }
          const cost = BeeStore.money.fromMajor(costInput.value);
          // Find the variantId - if product has variants, use the selected one;
          // otherwise we'll use the product ID as a placeholder and create variant later
          let variantId = variantSelect.value;
          if (!variantId) {
            if (variantSelect.value && variantSelect.value !== '') {
              variantId = variantSelect.value;
            }
          }
          const supplierName = supplierSelect.selectedIndex >= 0 ? supplierSelect.options[supplierSelect.selectedIndex].text : '';
          const res = await BeeStore.api.purchases.create({
            date: dateInput.value || BeeStore.dates.today(),
            supplierId: supplierSelect.value,
            supplierName,
            lines: [{ variantId: variantId || undefined, qty, unitCostMinor: cost }],
            payments: cost > 0 ? [{ method: 'cash', amountMinor: cost * qty }] : [],
          });
          if (res.ok) { toast('Purchase saved'); overlay.remove(); render(document.querySelector('#page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'Save'),
    ]);
  }      const res = await BeeStore.api.purchases.void(id);
      if (res.ok) { toast('تم الإلغاء'); render(document.getElementById('page-content')); }
      else toast(res.error.message, 'error');
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.purchases = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
