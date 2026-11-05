(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, formatDocDate, toast, confirmDialog } = BeeStore.ui;
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
      formatDocDate(r),
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
      formatDocDate(p),
      p.supplierName || '-',
      formatMoney(p.totalMinor),
      p.status === 'received' ? el('span', { class: 'badge badge-success' }, 'مستلمة')
        : p.status === 'void' ? el('span', { class: 'badge badge-muted' }, 'ملغاة')
        : el('span', { class: 'badge badge-warning' }, p.status),
      el('div', { class: 'row-actions' }, [
        BeeStore.journalView.button(p, { title: 'قيود فاتورة الشراء ' + p.number }),
        p.status === 'void'
          ? null
          : el('button', { class: 'btn btn-sm btn-danger', onclick: () => _voidPurchase(p.id, p.number) }, 'إلغاء'),
      ]),
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

  function _productLabel(product) {
    const name = String(product && product.name || 'منتج');
    const code = String(product && product.itemCode || '').trim();
    return code ? name + ' — ' + code : name;
  }

  function _variantLabel(variant) {
    const dims = [variant && variant.size, variant && variant.color]
      .filter(Boolean).join(' / ');
    return dims || 'افتراضي';
  }

  function _variantOptionLabel(variant) {
    const code = String(variant && variant.itemCode || '').trim();
    const qty = Number(variant && variant.quantity) || 0;
    return _variantLabel(variant) +
      (code ? ' · ' + code : '') +
      ' · متوفر: ' + qty;
  }

  /**
   * v4 R1/R11: purchase entry searches the item catalogue by product name,
   * item code or barcode — not by the size/colour variant list. A product can
   * be created inline with Quick Add and is selected immediately as a line.
   */
  function _addPurchase() {
    const supplierSelect = select([{ value: '', label: 'اختر المورد' }], '');
    BeeStore.api.suppliers.list().then(res => {
      if (res.ok) for (const s of res.data) supplierSelect.appendChild(el('option', { value: s.id }, s.name));
    });

    const productSearchInput = input('text', '', {
      placeholder: 'ابحث باسم المنتج أو الرمز أو الباركود...',
      autocomplete: 'off',
      'aria-label': 'البحث عن منتج للشراء',
    });
    const productStatus = el('p', { class: 'form-hint' }, 'لم يتم اختيار منتج بعد');
    const productResults = el('div', { class: 'search-results', id: 'purchase-product-results' });
    const newProductBtn = el('button', {
      class: 'btn btn-sm btn-secondary',
      type: 'button',
      onclick: () => _quickAddForPurchase(productSearchInput, selectProduct),
    }, '+ منتج جديد');

    const variantSelect = select([{ value: '', label: 'اختر المنتج أولاً' }], '');
    variantSelect.disabled = true;
    const qtyInput = input('number', '1', { min: 1 });
    const costInput = input('number', '', { min: 0, step: 0.01, placeholder: 'سعر الشراء' });
    const paymentInput = input('number', '0', { min: 0, step: 0.01, placeholder: 'المدفوع' });
    const dateInput = input('date', BeeStore.dates.today());

    let selectedProduct = null;
    let selectedVariant = null;
    let variantsById = {};
    let searchTimer = null;
    let searchToken = 0;

    function applyVariant(variant) {
      selectedVariant = variant || null;
      if (!variant) return;
      const cost = Number(variant.costMinor) || 0;
      costInput.value = cost > 0 ? (cost / 100).toFixed(2) : '';
    }

    async function selectProduct(product, preferredVariantId) {
      if (!product) return;
      selectedProduct = product;
      selectedVariant = null;
      variantsById = {};
      productStatus.textContent = 'المنتج المحدد: ' + _productLabel(product);
      productSearchInput.value = product.name || '';
      productResults.innerHTML = '';
      variantSelect.disabled = true;
      variantSelect.innerHTML = '';
      variantSelect.appendChild(el('option', { value: '' }, 'جارٍ تحميل الأصناف...'));

      const res = await BeeStore.api.products.getWithVariants(product.id);
      // A slower request must not overwrite a newer product selection.
      if (selectedProduct !== product) return;
      const variants = res.ok && res.data && Array.isArray(res.data.variants)
        ? res.data.variants.filter(v => v.active !== false)
        : [];
      variantSelect.innerHTML = '';
      if (variants.length === 0) {
        variantSelect.appendChild(el('option', { value: '' }, 'لا توجد أصناف لهذا المنتج'));
        toast('لا توجد أصناف لهذا المنتج. أضف صنفاً من صفحة المنتجات.', 'error');
        return;
      }
      for (const v of variants) {
        variantsById[v.id] = v;
        variantSelect.appendChild(el('option', { value: v.id }, _variantOptionLabel(v)));
      }
      variantSelect.disabled = false;
      const chosen = variants.find(v => v.id === preferredVariantId) ||
        variants.find(v => v.id === product.defaultVariantId) || variants[0];
      variantSelect.value = chosen.id;
      applyVariant(chosen);
    }

    variantSelect.addEventListener('change', () => {
      applyVariant(variantsById[variantSelect.value]);
    });

    function renderProductResults(products) {
      productResults.innerHTML = '';
      if (!products.length) {
        productResults.appendChild(el('p', { class: 'empty-state' }, 'لا توجد منتجات مطابقة.'));
        return;
      }
      for (const p of products) {
        productResults.appendChild(el('button', {
          class: 'search-result-item',
          type: 'button',
          onclick: () => selectProduct(p),
        }, [
          el('span', { class: 'search-result-name' }, p.name || 'منتج'),
          el('span', { class: 'search-result-meta' },
            'الرمز: ' + (p.itemCode || '—') +
            (p.hasVariants ? ' · له أصناف متعددة' : ' · صنف افتراضي')),
        ]));
      }
    }

    async function loadProducts(query) {
      const token = ++searchToken;
      const res = query
        ? await BeeStore.api.products.search(query)
        : await BeeStore.api.products.list();
      if (token !== searchToken) return;
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const products = res.data
        .filter(p => p && p.active !== false)
        .slice(0, 10);
      renderProductResults(products);
    }

    productSearchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadProducts(productSearchInput.value.trim()), 150);
    });
    productSearchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = productResults.querySelector('button.search-result-item');
      if (first) first.click();
    });

    const productScanBtn = BeeStore.scanner.scanButton(async (code) => {
      const variant = await BeeStore.scanning.lookupVariant(BeeStore.api, code);
      if (!variant) {
        toast('باركود غير موجود: ' + code, 'error', {
          actionText: 'إضافة منتج',
          duration: 12000,
          onAction: () => _quickAddForPurchase(productSearchInput, selectProduct, code),
        });
        return;
      }
      const productRes = await BeeStore.api.products.get(variant.productId);
      if (!productRes.ok || !productRes.data) {
        toast('تعذّر العثور على المنتج', 'error');
        return;
      }
      await selectProduct(productRes.data, variant.id);
      toast('تم اختيار ' + _productLabel(productRes.data) + ' — ' + _variantLabel(variant));
    }, { label: 'مسح', title: 'مسح منتج المشتريات' });

    loadProducts('');

    const { overlay } = BeeStore.dialogs.openDialog('فاتورة مشتريات', [
      formField('التاريخ', dateInput, true),
      formField('المورد', supplierSelect, true),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label' }, 'المنتج *'),
        el('div', { class: 'field-with-action' }, [productSearchInput, productScanBtn, newProductBtn]),
        productStatus,
        productResults,
      ]),
      formField('الصنف / الوحدة', variantSelect, true),
      formField('الكمية', qtyInput, true),
      formField('سعر الشراء', costInput, true),
      formField('المدفوع', paymentInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!supplierSelect.value) { toast('اختر المورد', 'error'); return; }
          if (!selectedProduct) { toast('اختر المنتج', 'error'); return; }
          if (!variantSelect.value || !selectedVariant) { toast('اختر الصنف', 'error'); return; }
          const qty = Number(qtyInput.value) || 0;
          if (qty <= 0) { toast('أدخل كمية صحيحة', 'error'); return; }
          const cost = BeeStore.money.fromMajor(costInput.value);
          if (!(cost >= 0)) { toast('أدخل سعر شراء صحيحاً', 'error'); return; }
          const paid = BeeStore.money.fromMajor(paymentInput.value);
          const supplierName = supplierSelect.selectedIndex >= 0 ? supplierSelect.options[supplierSelect.selectedIndex].text : '';
          const res = await BeeStore.api.purchases.create({
            date: dateInput.value || BeeStore.dates.today(),
            supplierId: supplierSelect.value,
            supplierName,
            lines: [{ variantId: selectedVariant.id, qty, unitCostMinor: cost }],
            payments: paid > 0 ? [{ method: 'cash', amountMinor: paid }] : [],
          });
          if (res.ok) { toast('تم حفظ المشتريات'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  /** Opens Quick Add from the purchase dialog and selects the new item. */
  function _quickAddForPurchase(searchInput, selectProduct, barcode) {
    const productsPage = BeeStore.pages && BeeStore.pages.products;
    if (!productsPage || typeof productsPage.quickAdd !== 'function') {
      toast('صفحة المنتجات غير متاحة', 'error');
      return;
    }
    if (BeeStore.auth && BeeStore.auth.isCashier()) {
      toast('إضافة منتج جديد تتطلب صلاحية المالك', 'error');
      return;
    }
    productsPage.quickAdd({
      barcode: barcode || '',
      title: 'منتج جديد من فاتورة المشتريات',
      onSaved: async (data) => {
        if (!data || !data.product) return;
        if (searchInput) searchInput.value = data.product.name || '';
        await selectProduct(data.product, data.variant && data.variant.id);
        toast('تمت إضافة المنتج واختياره');
      },
    });
  }

  function _voidPurchase(id, number) {
    confirmDialog('إلغاء الفاتورة', 'هل أنت متأكد من إلغاء ' + number + '؟', async () => {
      const res = await BeeStore.api.purchases.void(id);
      if (res.ok) { toast('تم الإلغاء'); render(document.getElementById('page-content')); }
      else toast(res.error.message, 'error');
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.purchases = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
