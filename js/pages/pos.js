(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast, confirmDialog } = BeeStore.ui;
  const { input, select } = BeeStore.dialogs;

  const DEFAULT_METHODS = [
    { id: 'cash', name: 'نقداً', icon: '💵' },
    { id: 'card', name: 'بطاقة', icon: '💳' },
    { id: 'bank', name: 'تحويل بنكي', icon: '🏦' },
    { id: 'wallet', name: 'محفظة إلكترونية', icon: '📱' },
    { id: 'jawwal', name: 'جوال باي', icon: '📲' },
    { id: 'palpay', name: 'بال باي', icon: '📲' },
  ];

  let cart = [];
  let customerId = null;
  let customerName = '';
  let contactPhone = '';
  let payerName = '';
  let payments = [];
  let discount = { type: 'amount', value: 0 };
  let lastSaleId = null;
  let settings = null;
  let keydownHandler = null;
  let searchToken = 0;
  // v2 §12.1.3: one key per invoice intent — double clicks/Enter echo safely.
  let pendingKey = null;
  let saving = false;
  const refs = {};

  function _newPendingKey() {
    try { pendingKey = BeeStore.ids.randomId('key'); }
    catch (e) { pendingKey = 'key_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
    return pendingKey;
  }

  async function render(container) {
    cart = [];
    customerId = null;
    customerName = '';
    contactPhone = '';
    payerName = '';
    payments = [];
    discount = { type: 'amount', value: 0 };
    lastSaleId = null;
    saving = false;
    _newPendingKey();
    settings = await BeeStore.settings.get();
    for (const k of Object.keys(refs)) delete refs[k];

    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'فاتورة جديدة'));

    const mainRow = el('div', { class: 'pos-layout' }, [
      _buildLeftPanel(),
      _buildRightPanel(),
    ]);
    container.appendChild(mainRow);

    _setupKeyboardShortcuts();
    setTimeout(() => {
      const barcodeInput = document.getElementById('pos-barcode');
      if (barcodeInput) barcodeInput.focus();
    }, 100);
  }

  function _buildLeftPanel() {
    const barcodeInput = input('text', '', { 
      placeholder: 'باركود أو اسم المنتج... (F2)', 
      id: 'pos-barcode',
      autocomplete: 'off',
      'aria-label': 'باركود أو اسم المنتج'
    });
    barcodeInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        // Enter adds the line and must never submit/save the invoice.
        e.preventDefault();
        e.stopPropagation();
        const code = barcodeInput.value.trim();
        barcodeInput.value = '';
        barcodeInput.focus();
        await _addScanToCart(code);
      }
    });

    const searchInput = input('text', '', { 
      placeholder: 'بحث بالاسم أو الباركود...', 
      id: 'pos-search',
      autocomplete: 'off',
      'aria-label': 'بحث المنتجات'
    });
    searchInput.addEventListener('input', async () => {
      const q = searchInput.value.trim();
      const resultsDiv = document.getElementById('pos-search-results');
      if (q.length < 2) {
        if (resultsDiv) resultsDiv.innerHTML = '';
        return;
      }
      const res = await BeeStore.api.products.search(q);
      if (res.ok) _showSearchResults(res.data);
    });

    const categorySelect = select([{ value: '', label: 'كل التصنيفات' }], '');
    categorySelect.setAttribute('aria-label', 'تصنيف المنتجات');
    BeeStore.api.categories.list().then(res => {
      if (res.ok) {
        for (const c of res.data) {
          categorySelect.appendChild(el('option', { value: c.id }, c.name));
        }
      }
    });
    categorySelect.addEventListener('change', () => {
      _filterByCategory(categorySelect.value);
    });

    const cartTable = el('div', { id: 'pos-cart', class: 'pos-cart' }, [
      el('p', { class: 'empty-state' }, 'أضف منتجات للفاتورة'),
    ]);

    return el('div', { class: 'pos-left' }, [
      el('div', { class: 'card pos-search-card' }, [
        el('div', { class: 'form-row', style: 'gap: 8px; flex-wrap: wrap;' }, [
          el('div', { class: 'form-group', style: 'flex: 1; min-width: 140px;' }, [
            el('label', { class: 'form-label' }, 'التصنيف'),
            categorySelect,
          ]),
          el('div', { class: 'form-group', style: 'flex: 1; min-width: 180px;' }, [
            el('label', { class: 'form-label' }, 'باركود'),
            el('div', { class: 'field-with-action' }, [
              barcodeInput,
              BeeStore.scanner.scanButton((code) => _addScanToCart(code), {
                label: 'مسح',
                title: 'مسح أصناف الفاتورة',
                continuous: true,
                hint: 'امسح باركود الصنف — يُضاف تلقائياً للفاتورة',
              }),
            ]),
          ]),
          el('div', { class: 'form-group', style: 'flex: 1; min-width: 140px;' }, [
            el('label', { class: 'form-label' }, 'بحث'),
            searchInput,
          ]),
        ]),
        el('div', { id: 'pos-search-results', class: 'search-results' }),
      ]),
      cartTable,
    ]);
  }

  function _buildRightPanel() {
    const dateInput = input('date', BeeStore.dates.today());
    dateInput.setAttribute('aria-label', 'تاريخ الفاتورة');
    refs.dateInput = dateInput;
    const dateNotice = el('p', { class: 'period-notice', style: 'display:none' });
    refs.dateNotice = dateNotice;
    // v2 §3: default to the selected period (today / last day of month).
    if (BeeStore.period) BeeStore.period.applyDefaultDate(dateInput, dateNotice);
    const customerSelect = select([{ value: '', label: 'نقدي (بدون زبون)' }], '');
    customerSelect.setAttribute('aria-label', 'اختر الزبون');
    refs.customerSelect = customerSelect;
    const contactPhoneInput = input('text', '', { placeholder: 'رقم الجوال (اختياري)', 'aria-label': 'رقم الجوال' });
    refs.contactPhoneInput = contactPhoneInput;
    contactPhoneInput.addEventListener('input', () => { contactPhone = contactPhoneInput.value; });
    const payerNameInput = input('text', '', { placeholder: 'اسم المحوِّل (اختياري)', 'aria-label': 'اسم المحوِّل' });
    refs.payerNameInput = payerNameInput;
    payerNameInput.addEventListener('input', () => { payerName = payerNameInput.value; });
    const customerPhoneById = {};
    BeeStore.api.customers.list().then(res => {
      if (res.ok) {
        for (const c of res.data) {
          customerSelect.appendChild(el('option', { value: c.id }, c.name));
          if (c.phone) customerPhoneById[c.id] = c.phone;
        }
      }
    });
    customerSelect.addEventListener('change', () => {
      customerId = customerSelect.value || null;
      customerName = customerSelect.selectedOptions[0] ? customerSelect.selectedOptions[0].text : '';
      const cphone = customerId ? (customerPhoneById[customerId] || '') : '';
      if (cphone && !contactPhoneInput.value) { contactPhoneInput.value = cphone; contactPhone = cphone; }
    });

    const discountType = select([
      { value: 'amount', label: 'مبلغ' },
      { value: 'percent', label: 'نسبة %' },
    ], 'amount');
    discountType.setAttribute('aria-label', 'نوع الخصم');
    const discountValue = input('number', '0', { min: 0, step: 0.01, 'aria-label': 'قيمة الخصم' });
    refs.discountType = discountType;
    refs.discountValue = discountValue;
    discountType.addEventListener('change', () => { discount.type = discountType.value; _updateTotals(); _syncAutoPayment(); });
    discountValue.addEventListener('input', () => { discount.value = BeeStore.money.parseDecimal(discountValue.value); _updateTotals(); _syncAutoPayment(); });

    const paymentsDiv = el('div', { id: 'pos-payments', role: 'list', 'aria-label': 'طرق الدفع' });
    const totalsDiv = el('div', { id: 'pos-totals', class: 'pos-totals', role: 'region', 'aria-label': 'إجماليات الفاتورة' });
    refs.paymentsDiv = paymentsDiv;

    const saveBtn = el('button', { 
      class: 'btn btn-primary btn-lg pos-save-btn', 
      onclick: () => _saveInvoice(),
      'aria-label': 'حفظ الفاتورة (Ctrl+Enter)'
    }, 'حفظ الفاتورة (Ctrl+Enter)');
    refs.saveBtn = saveBtn;
    const clearBtn = el('button', { 
      class: 'btn btn-secondary pos-clear-btn', 
      onclick: () => _clearCart(),
      'aria-label': 'مسح الفاتورة'
    }, 'مسح');
    const printBtn = el('button', { 
      class: 'btn btn-info pos-print-btn', 
      id: 'pos-print-btn', 
      style: 'display:none', 
      onclick: () => _printLastInvoice(),
      'aria-label': 'طباعة الفاتورة'
    }, 'طباعة الفاتورة');

    return el('div', { class: 'pos-right' }, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'الزبون والتاريخ'),
        customerSelect,
        el('div', { class: 'form-group', style: 'margin-top: 8px;' }, [
          el('label', { class: 'form-label' }, 'رقم الجوال'),
          contactPhoneInput,
        ]),
        el('div', { class: 'form-group', style: 'margin-top: 8px;' }, [
          el('label', { class: 'form-label' }, 'اسم المحوِّل'),
          payerNameInput,
        ]),
        el('div', { class: 'form-group', style: 'margin-top: 8px;' }, [
          el('label', { class: 'form-label' }, 'التاريخ'),
          dateInput,
          dateNotice,
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'الخصم'),
        el('div', { class: 'form-row', style: 'gap: 8px; flex-wrap: wrap;' }, [
          el('div', { class: 'form-group', style: 'flex: 1; min-width: 120px;' }, [el('label', { class: 'form-label' }, 'النوع'), discountType]),
          el('div', { class: 'form-group', style: 'flex: 1; min-width: 120px;' }, [el('label', { class: 'form-label' }, 'القيمة'), discountValue]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'الدفعات (F4)'),
        paymentsDiv,
        el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _addPayment(paymentsDiv), 'aria-label': 'إضافة دفعة جديدة' }, '+ إضافة دفعة'),
      ]),
      totalsDiv,
      el('div', { class: 'pos-actions', role: 'group', 'aria-label': 'إجراءات الفاتورة' }, [saveBtn, clearBtn, printBtn]),
    ]);
  }

  function _setupKeyboardShortcuts() {
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
    keydownHandler = (e) => {
      if (BeeStore.router.currentRoute !== '/pos') return;
      // While any dialog is open (camera scanner, payment, confirm...) the
      // page shortcuts must not fire: F2/F4 would steal focus and Ctrl+Enter
      // could save an invoice behind the overlay. The scanner handles its own
      // Escape/close keys.
      if (document.querySelector('.dialog-overlay')) return;

      if (e.key === 'F2') {
        e.preventDefault();
        const barcodeInput = document.getElementById('pos-barcode');
        if (barcodeInput) barcodeInput.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        const paymentInput = document.querySelector('.payment-row input');
        if (paymentInput) paymentInput.focus();
        else {
          const paymentsDiv = document.getElementById('pos-payments');
          if (paymentsDiv) _addPayment(paymentsDiv);
        }
      } else if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        _saveInvoice();
      } else if (e.key === 'Escape') {
        const overlay = document.querySelector('.dialog-overlay');
        if (overlay) overlay.remove();
      }
    };
    document.addEventListener('keydown', keydownHandler);
  }

  /**
   * Adds a scanned/typed code to the invoice. Shared by the camera scanner,
   * the USB scanner (Enter in the barcode field) and manual typing.
   *
   * @param {string} query barcode / SKU / product name
   * @returns {Promise<{ok:boolean, label?:string, reason?:string, message?:string}>}
   */
  async function _addScanToCart(query) {
    const code = (query || '').trim();
    if (!code) return { ok: false, reason: 'empty' };
    const res = await _addToCart(code);
    if (res.ok) return res;

    if (res.reason === 'not-found') {
      toast('باركود غير موجود: ' + code, 'error', {
        actionText: 'إضافة صنف',
        duration: 12000,
        onAction: () => _openNewVariant(code),
      });
    } else if (res.message) {
      toast(res.message, 'error');
    }
    return res;
  }

  /** Opens the "new variant" dialog prefilled with the unknown barcode. */
  function _openNewVariant(barcode) {
    // The camera overlay sits above normal dialogs — close it first.
    if (BeeStore.scanner && typeof BeeStore.scanner.closeCurrent === 'function') {
      BeeStore.scanner.closeCurrent();
    }
    const products = BeeStore.pages && BeeStore.pages.products;
    if (products && typeof products.openAddVariant === 'function') {
      products.openAddVariant({
        barcode,
        onSaved: () => toast('تمت إضافة الصنف — امسح الباركود لإضافته للفاتورة'),
      });
    } else {
      BeeStore.router.navigate('/products');
    }
  }

  async function _addToCart(query) {
    if (!query) return { ok: false, reason: 'empty' };
    const variant = await BeeStore.scanning.lookupVariant(BeeStore.api, query);
    if (!variant) {
      return { ok: false, reason: 'not-found', code: query, message: 'باركود غير موجود' };
    }

    let productName = '';
    try {
      const productRes = await BeeStore.api.products.get(variant.productId);
      if (productRes.ok && productRes.data) productName = productRes.data.name;
    } catch (e) { /* keep the line usable without a name */ }

    const res = BeeStore.scanning.addToCart(cart, variant, productName, {
      allowNegative: !!(settings && settings.allowNegativeStock),
    });
    if (!res.ok) return res;

    _renderCart();
    return {
      ok: true,
      item: res.item,
      label: (productName ? productName + ' — ' : '') + variant.size + ' / ' + variant.color,
    };
  }

  /** Cart add used by the search-results list (keeps its inline toast). */
  function _addVariantToCart(variant, productName) {
    const res = BeeStore.scanning.addToCart(cart, variant, productName, {
      allowNegative: !!(settings && settings.allowNegativeStock),
    });
    if (!res.ok) {
      if (res.message) toast(res.message, 'error');
      return false;
    }
    _renderCart();
    return true;
  }

  function _renderCart() {
    const cartDiv = document.getElementById('pos-cart');
    if (!cartDiv) return;
    cartDiv.innerHTML = '';
    if (cart.length === 0) {
      cartDiv.appendChild(el('p', { class: 'empty-state' }, 'أضف منتجات للفاتورة'));
    } else {
      const rows = cart.map((item, i) => {
        const qtyInput = input('number', String(item.qty), { min: 1, style: 'width:70px' });
        qtyInput.addEventListener('change', () => {
          let newQty = BeeStore.money.parseDecimal(qtyInput.value) || 1;
          if (newQty < 1) newQty = 1;
          if (!(settings && settings.allowNegativeStock) && newQty > item.stockQty) {
            toast('الكمية المتاحة: ' + item.stockQty, 'error');
            newQty = item.stockQty;
          }
          item.qty = newQty;
          item.lineTotalMinor = newQty * item.unitPriceMinor - item.lineDiscountMinor;
          _renderCart();
        });

        return el('tr', {}, [
          el('td', {}, item.productName + ' - ' + item.size + ' - ' + item.color),
          el('td', {}, qtyInput),
          el('td', {}, formatMoney(item.unitPriceMinor)),
          el('td', {}, formatMoney(item.lineTotalMinor)),
          el('td', {}, el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: () => { cart.splice(i, 1); _renderCart(); },
          }, 'حذف')),
        ]);
      });
      cartDiv.appendChild(el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'المنتج'), el('th', {}, 'الكمية'),
          el('th', {}, 'السعر'), el('th', {}, 'الإجمالي'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows),
      ]));
    }
    _updateTotals();
    _syncAutoPayment();
  }

  function _computeTotals() {
    const subtotal = cart.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    let discountMinor = 0;
    if (discount.type === 'percent') {
      discountMinor = Math.round(subtotal * discount.value / 100);
    } else {
      discountMinor = Math.round(discount.value * 100);
    }
    if (discountMinor > subtotal) discountMinor = subtotal;
    const taxable = subtotal - discountMinor;
    let taxMinor = 0;
    if (settings && settings.taxEnabled && settings.taxRate > 0) {
      if (settings.taxIncludedInPrices) {
        taxMinor = taxable - Math.round(taxable * 100 / (100 + settings.taxRate));
      } else {
        taxMinor = Math.round(taxable * settings.taxRate / 100);
      }
    }
    const total = taxable + taxMinor;
    const paid = payments.reduce((sum, p) => sum + p.amountMinor, 0);
    const due = total - paid;
    return { subtotal, discountMinor, taxMinor, total, paid, due };
  }

  function _updateTotals() {
    const totalsDiv = document.getElementById('pos-totals');
    if (!totalsDiv) return;
    const t = _computeTotals();

    totalsDiv.innerHTML = '';
    totalsDiv.appendChild(el('div', { class: 'total-row' }, [
      el('span', {}, 'المجموع الفرعي'), el('span', {}, formatMoney(t.subtotal)),
    ]));
    totalsDiv.appendChild(el('div', { class: 'total-row' }, [
      el('span', {}, 'الخصم'), el('span', {}, '-' + formatMoney(t.discountMinor)),
    ]));
    if (settings && settings.taxEnabled && settings.taxRate > 0) {
      totalsDiv.appendChild(el('div', { class: 'total-row' }, [
        el('span', {}, 'الضريبة (' + settings.taxRate + '%)'), el('span', {}, formatMoney(t.taxMinor)),
      ]));
    }
    totalsDiv.appendChild(el('div', { class: 'total-row total-final' }, [
      el('span', {}, 'الإجمالي'), el('span', {}, formatMoney(t.total)),
    ]));
    totalsDiv.appendChild(el('div', { class: 'total-row' }, [
      el('span', {}, 'المدفوع'), el('span', {}, formatMoney(t.paid)),
    ]));
    const dueClass = t.due > 0 ? ' text-danger' : '';
    totalsDiv.appendChild(el('div', { class: 'total-row' + dueClass }, [
      el('span', {}, t.due < 0 ? 'الباقي للزبون' : 'المتبقي'),
      el('span', {}, formatMoney(Math.abs(t.due))),
    ]));
  }

  function _paymentMethods() {
    const methods = settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length
      ? settings.paymentMethods
      : DEFAULT_METHODS;
    return methods.map(m => ({ value: m.id, label: m.name }));
  }

  function _addPayment(container, opts) {
    opts = opts || {};
    const methodSelect = select(_paymentMethods(), 'cash');
    const amountInput = input('number', '', { placeholder: 'المبلغ', min: 0, step: 0.01 });
    const row = el('div', { class: 'payment-row' }, [
      methodSelect,
      amountInput,
      el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: () => { row.remove(); _recalcPayments(); },
      }, 'حذف'),
    ]);
    if (opts.auto) row.setAttribute('data-auto', '1');
    container.appendChild(row);
    // Once the accountant edits the amount, stop auto-filling it.
    amountInput.addEventListener('input', () => {
      amountInput.setAttribute('data-manual', '1');
      _recalcPayments();
    });
    methodSelect.addEventListener('change', _recalcPayments);
    if (!opts.silent) setTimeout(() => amountInput.focus(), 50);
    return row;
  }

  // Auto-fill a primary payment row with the invoice total, based on the
  // selected products. Stays mandatory-but-editable: as soon as the accountant
  // types an amount, that row is left alone.
  function _syncAutoPayment() {
    const div = refs.paymentsDiv;
    if (!div) return;
    if (cart.length === 0) {
      const autoRow = div.querySelector('.payment-row[data-auto="1"]');
      if (autoRow && autoRow.querySelector('input').getAttribute('data-manual') !== '1') autoRow.remove();
      _recalcPayments();
      return;
    }
    let row = div.querySelector('.payment-row[data-auto="1"]');
    if (!row) {
      if (div.querySelector('.payment-row')) return;
      row = _addPayment(div, { auto: true, silent: true });
    }
    const amountInput = row.querySelector('input');
    if (amountInput.getAttribute('data-manual') === '1') return;
    const total = _computeTotals().total;
    amountInput.value = (total / 100).toFixed(2);
    _recalcPayments();
  }

  function _recalcPayments() {
    payments = [];
    document.querySelectorAll('.payment-row').forEach(row => {
      const method = row.querySelector('select').value;
      const amount = BeeStore.money.fromMajor(row.querySelector('input').value);
      if (amount > 0) {
        payments.push({
          method,
          amountMinor: amount,
          accountId: BeeStore.settings.resolvePaymentAccount(settings, method),
        });
      }
    });
    _updateTotals();
  }

  async function _saveInvoice() {
    if (cart.length === 0) { toast('أضف منتجات أولاً', 'error'); return; }
    // v2 §12.1.3: ignore repeated clicks/Enter while the save is in flight.
    if (saving) return;
    saving = true;
    if (refs.saveBtn) refs.saveBtn.disabled = true;
    try {
      _recalcPayments();
      const t = _computeTotals();

      if (t.paid < t.total && !customerId) {
        toast('البيع الآجل يتطلب اختيار زبون', 'error');
        return;
      }

      const data = {
        clientKey: pendingKey,
        date: (refs.dateInput && refs.dateInput.value) || BeeStore.dates.today(),
      lines: cart.map(item => ({
        variantId: item.variantId,
        qty: item.qty,
        unitPriceMinor: item.unitPriceMinor,
        lineDiscountMinor: item.lineDiscountMinor,
      })),
      discount: discount.value > 0 && t.discountMinor > 0 ? discount : null,
      payments: payments.map(p => ({ method: p.method, amountMinor: p.amountMinor, accountId: p.accountId || null })),
      customerId,
      customerName: customerId ? customerName : null,
      contactPhone: (refs.contactPhoneInput && refs.contactPhoneInput.value || contactPhone || '').trim() || null,
      payerName: (refs.payerNameInput && refs.payerNameInput.value || payerName || '').trim() || null,
    };

    const res = await BeeStore.api.sales.create(data);
    if (res.ok) {
      lastSaleId = res.data.id;
      toast(res.data.duplicate ? 'الفاتورة محفوظة مسبقاً (تم تجاهل التكرار)' : 'تم حفظ الفاتورة بنجاح');
      const printBtn = document.getElementById('pos-print-btn');
      if (printBtn) printBtn.style.display = 'inline-block';
      _resetForm();
    } else {
      toast(res.error.message, 'error');
    }
    } finally {
      saving = false;
      if (refs.saveBtn) refs.saveBtn.disabled = false;
    }
  }

  function _resetForm() {
    cart = [];
    payments = [];
    discount = { type: 'amount', value: 0 };
    customerId = null;
    customerName = '';
    contactPhone = '';
    payerName = '';
    _newPendingKey();
    if (refs.dateInput) {
      if (BeeStore.period) BeeStore.period.applyDefaultDate(refs.dateInput, refs.dateNotice);
      else refs.dateInput.value = BeeStore.dates.today();
    }
    if (refs.customerSelect) refs.customerSelect.value = '';
    if (refs.contactPhoneInput) refs.contactPhoneInput.value = '';
    if (refs.payerNameInput) refs.payerNameInput.value = '';
    if (refs.discountType) refs.discountType.value = 'amount';
    if (refs.discountValue) refs.discountValue.value = '0';
    if (refs.paymentsDiv) refs.paymentsDiv.innerHTML = '';
    const resultsDiv = document.getElementById('pos-search-results');
    if (resultsDiv) resultsDiv.innerHTML = '';
    _renderCart();
  }

  function _clearCart() {
    if (cart.length === 0) { toast('الفاتورة فارغة', 'error'); return; }
    confirmDialog('مسح الفاتورة', 'هل تريد مسح جميع العناصر؟', () => {
      _resetForm();
    });
  }

  function _printLastInvoice() {
    if (lastSaleId) {
      BeeStore.print.printInvoice(lastSaleId);
    }
  }

  async function _filterByCategory(categoryId) {
    const res = await BeeStore.api.products.list();
    if (!res.ok) return;
    const filtered = categoryId ? res.data.filter(p => p.categoryId === categoryId) : res.data;
    _showSearchResults(filtered);
  }

  async function _showSearchResults(products) {
    const div = document.getElementById('pos-search-results');
    if (!div) return;
    const token = ++searchToken;
    div.innerHTML = '';
    for (const p of products.slice(0, 5)) {
      const item = el('div', { class: 'search-result-item' });
      item.appendChild(el('div', { class: 'search-result-name' }, p.name));
      item.appendChild(el('div', { class: 'search-result-meta' }, 'اضغط على الحجم لإضافته للفاتورة'));
      div.appendChild(item);

      const vr = await BeeStore.api.products.getWithVariants(p.id);
      if (token !== searchToken) return;
      if (vr.ok && vr.data.variants.length > 0) {
        const vwrap = el('div', { class: 'search-result-variants' });
        for (const v of vr.data.variants) {
          const out = !(settings && settings.allowNegativeStock) && v.quantity <= 0;
          const attrs = {
            class: 'btn btn-sm ' + (out ? 'btn-secondary' : 'btn-primary'),
            onclick: () => {
              if (_addVariantToCart(v, p.name)) {
                div.innerHTML = '';
                const barcodeInput = document.getElementById('pos-barcode');
                if (barcodeInput) barcodeInput.focus();
              }
            },
          };
          if (out) attrs.disabled = 'disabled';
          vwrap.appendChild(el('button', attrs, v.size + ' / ' + v.color + ' — متوفر: ' + v.quantity));
        }
        item.appendChild(vwrap);
      } else {
        item.appendChild(el('div', { class: 'empty-state' }, 'لا توجد أحجام متاحة'));
      }
    }
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.pos = {
    render,
    // Used by the safe-update check: never reload in the middle of an invoice.
    getCartCount: function () { return cart.length; },
    isSaving: function () { return saving; },
    hasUnsavedWork: function () { return saving || cart.length > 0; },
  };
  if (typeof module !== 'undefined') {
    module.exports = {
      render,
      getCartCount: function () { return cart.length; },
      isSaving: function () { return saving; },
      hasUnsavedWork: function () { return saving || cart.length > 0; },
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
