(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'المنتجات والمخزون'));

    const content = el('div', { id: 'products-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('products', content); _setActiveTab(this); } }, 'المنتجات'),
      el('button', { class: 'tab', onclick: function () { _showTab('categories', content); _setActiveTab(this); } }, 'التصنيفات'),
      el('button', { class: 'tab', onclick: function () { _showTab('variants', content); _setActiveTab(this); } }, 'الأصناف'),
      el('button', { class: 'tab', onclick: function () { _showTab('stock', content); _setActiveTab(this); } }, 'المخزون'),
      el('button', { class: 'tab', onclick: function () { _showTab('lowstock', content); _setActiveTab(this); } }, 'منخفض المخزون'),
      el('button', { class: 'tab', onclick: function () { _showTab('csv', content); _setActiveTab(this); } }, 'استيراد CSV'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('products', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'products') _renderProducts(container);
    else if (tab === 'categories') _renderCategories(container);
    else if (tab === 'variants') _renderVariants(container);
    else if (tab === 'stock') _renderStock(container);
    else if (tab === 'lowstock') _renderLowStock(container);
    else if (tab === 'csv') _renderCsvImport(container);
  }

  async function _renderCategories(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addCategory() }, '+ تصنيف جديد');
    container.appendChild(addBtn);

    const res = await BeeStore.api.categories.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const rows = res.data.map(c => [
      c.name,
      c.active ? 'نشط' : 'غير نشط',
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editCategory(c.id, c.name) }, 'تعديل'),
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => _deleteCategory(c.id, c.name) }, 'حذف'),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الاسم'), el('th', {}, 'الحالة'), el('th', {}, ''), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  function _addCategory() {
    const nameInput = input('text', '', { placeholder: 'اسم التصنيف' });
    const { overlay } = BeeStore.dialogs.openDialog('تصنيف جديد', [
      formField('اسم التصنيف', nameInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.categories.create({ name: nameInput.value.trim() });
          if (res.ok) {
            toast('تم إضافة التصنيف');
            overlay.remove();
            render(document.getElementById('page-content'));
          } else {
            toast(res.error.message, 'error');
          }
        },
      }, 'حفظ'),
    ]);
  }

  function _editCategory(id, currentName) {
    const nameInput = input('text', currentName);
    const { overlay } = BeeStore.dialogs.openDialog('تعديل التصنيف', [
      formField('الاسم', nameInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('الاسم مطلوب', 'error'); return; }
          const res = await BeeStore.api.categories.update(id, { name: nameInput.value.trim() });
          if (res.ok) {
            toast('تم التحديث');
            overlay.remove();
            render(document.getElementById('page-content'));
          } else {
            toast(res.error.message, 'error');
          }
        },
      }, 'حفظ'),
    ]);
  }

  function _deleteCategory(id, name) {
    confirmDialog('حذف التصنيف', 'هل أنت متأكد من حذف "' + name + '"؟', async () => {
      const res = await BeeStore.api.categories.remove(id);
      if (res.ok) {
        toast('تم حذف التصنيف');
        render(document.getElementById('page-content'));
      } else {
        toast(res.error.message, 'error');
      }
    });
  }

  async function _renderProducts(container) {
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => _addProduct() }, '+ منتج جديد');
    container.appendChild(addBtn);

    const res = await BeeStore.api.products.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    const rows = res.data.map(p => [
      p.name,
      p.categoryId || '-',
      p.defaultPriceMinor ? formatMoney(p.defaultPriceMinor) : '-',
      p.active ? 'نشط' : 'غير نشط',
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editProduct(p.id) }, 'تعديل'),
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => _deactivateProduct(p.id, p.name) }, 'تعطيل'),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الاسم'), el('th', {}, 'التصنيف'), el('th', {}, 'السعر'),
          el('th', {}, 'الحالة'), el('th', {}, ''), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderVariants(container) {
    container.appendChild(el('button', { class: 'btn btn-primary', onclick: () => _addVariant() }, '+ صنف جديد'));

    const res = await BeeStore.api.variants.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const products = await BeeStore.api.products.list();
    const productMap = {};
    if (products.ok) for (const p of products.data) productMap[p.id] = p;

    if (res.data.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصناف. أضف صنفاً جديداً.'));
      return;
    }

    const rows = res.data.map(v => {
      const p = productMap[v.productId];
      return [
        p ? p.name : '-',
        v.size, v.color,
        v.sku || '-',
        String(v.quantity),
        formatMoney(v.costMinor),
        formatMoney(v.priceMinor),
        el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editVariant(v.id) }, 'تعديل'),
      ];
    });

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'المنتج'), el('th', {}, 'المقاس'), el('th', {}, 'اللون'),
          el('th', {}, 'SKU'), el('th', {}, 'الكمية'), el('th', {}, 'التكلفة'), el('th', {}, 'السعر'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  /**
   * Opens the "new variant" dialog. Exported so other pages (POS, price
   * check) can offer "create it now" after an unknown barcode.
   *
   * @param {{barcode?:string, onSaved?:Function}} [options]
   */
  function openAddVariant(options) {
    return _addVariant(options || {});
  }

  async function _addVariant(options) {
    options = options || {};
    const productsRes = await BeeStore.api.products.list();
    if (!productsRes.ok) { toast(productsRes.error.message, 'error'); return; }
    const activeProducts = productsRes.data.filter(p => p.active !== false);
    if (activeProducts.length === 0) { toast('أضف منتجاً أولاً', 'error'); return; }

    const settingsRes = await BeeStore.api.settings.get();
    const s = settingsRes.ok ? settingsRes.data : {};
    const sizes = s.sizes || [];
    const colors = (s.colors || []).map(c => c.name);

    const productSelect = select(activeProducts.map(p => ({ value: p.id, label: p.name })), activeProducts[0].id);
    const sizeSelect = select(sizes.map(x => ({ value: x, label: x })), sizes[0] || '');
    const colorSelect = select(colors.map(x => ({ value: x, label: x })), colors[0] || '');
    const costInput = input('number', '', { min: 0, step: 0.01 });
    const priceInput = input('number', '', { min: 0, step: 0.01 });
    const qtyInput = input('number', '', { min: 1, step: 1 });
    const barcodeInput = input('text', options.barcode || '', { placeholder: 'اتركه فارغاً للتوليد التلقائي' });
    let overlayRef = null;
    const barcodeScanBtn = BeeStore.scanner.scanButton(async (code) => {
      const check = await _checkBarcodeAvailable(code, null, () => {
        if (overlayRef) overlayRef.remove();
      });
      if (check.ok) barcodeInput.value = code;
    }, { label: 'مسح' });

    const { overlay } = BeeStore.dialogs.openDialog('صنف جديد', [
      formField('المنتج', productSelect, true),
      formField('المقاس', sizeSelect, true),
      formField('اللون', colorSelect, true),
      formField('التكلفة', costInput),
      formField('السعر', priceInput),
      formField('الكمية الافتتاحية', qtyInput, true, 'مطلوبة ويجب أن تكون أكبر من صفر'),
      formField('الباركود', barcodeInput, false, null, barcodeScanBtn),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!productSelect.value) { toast('اختر المنتج', 'error'); return; }
          if (!sizeSelect.value && !colorSelect.value) { toast('حدد المقاس واللون', 'error'); return; }
          const priceMinor = BeeStore.money.fromMajor(priceInput.value);
          if (priceMinor <= 0) { toast('سعر البيع مطلوب - أدخل سعراً أكبر من صفر', 'error'); return; }
          const qty = Math.floor(Number(qtyInput.value));
          if (!qty || qty <= 0) { toast('الكمية الافتتاحية مطلوبة ويجب أن تكون أكبر من صفر', 'error'); return; }
          const barcode = barcodeInput.value.trim();
          if (barcode) {
            const check = await _checkBarcodeAvailable(barcode, null, () => overlay.remove());
            if (!check.ok) return;
          }
          const res = await BeeStore.api.variants.create({
            productId: productSelect.value,
            size: sizeSelect.value,
            color: colorSelect.value,
            costMinor: BeeStore.money.fromMajor(costInput.value),
            priceMinor,
            quantity: qty,
            barcode,
          });
          if (res.ok) {
            toast('تم إضافة الصنف');
            overlay.remove();
            if (typeof options.onSaved === 'function') options.onSaved(res.data);
            else render(document.getElementById('page-content'));
          } else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
    overlayRef = overlay;

    const applyDefaults = () => {
      const p = activeProducts.find(x => x.id === productSelect.value);
      if (!p) return;
      if (!costInput.value && p.defaultCostMinor > 0) costInput.value = (p.defaultCostMinor / 100).toFixed(2);
      if (!priceInput.value && p.defaultPriceMinor > 0) priceInput.value = (p.defaultPriceMinor / 100).toFixed(2);
    };
    productSelect.addEventListener('change', applyDefaults);
    applyDefaults();
  }

  function _editVariant(id) {
    BeeStore.api.variants.get(id).then(res => {
      if (!res.ok || !res.data) return;
      const v = res.data;
      const sizeInput = input('text', v.size || '');
      const colorInput = input('text', v.color || '');
      const costInput = input('number', (v.costMinor / 100).toFixed(2));
      const priceInput = input('number', (v.priceMinor / 100).toFixed(2));
      const thresholdInput = input('number', v.lowStockThreshold != null ? String(v.lowStockThreshold) : '');
      const barcodeInput = input('text', v.barcode || '');
      let overlayRef = null;
      const barcodeScanBtn = BeeStore.scanner.scanButton(async (code) => {
        const check = await _checkBarcodeAvailable(code, id, () => {
          if (overlayRef) overlayRef.remove();
        });
        if (check.ok) barcodeInput.value = code;
      }, { label: 'مسح' });

      const { overlay } = BeeStore.dialogs.openDialog('تعديل الصنف', [
        formField('المقاس', sizeInput),
        formField('اللون', colorInput),
        formField('التكلفة', costInput),
        formField('السعر', priceInput),
        formField('حد التنبيه', thresholdInput),
        formField('الباركود', barcodeInput, false, null, barcodeScanBtn),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const barcode = barcodeInput.value.trim();
            if (barcode) {
              const check = await _checkBarcodeAvailable(barcode, id, () => overlay.remove());
              if (!check.ok) return;
            }
            const res2 = await BeeStore.api.variants.update(id, {
              size: sizeInput.value.trim(),
              color: colorInput.value.trim(),
              costMinor: BeeStore.money.fromMajor(costInput.value),
              priceMinor: BeeStore.money.fromMajor(priceInput.value),
              lowStockThreshold: thresholdInput.value ? Number(thresholdInput.value) : null,
              barcode,
            });
            if (res2.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res2.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
      overlayRef = overlay;
    });
  }

  /**
   * Checks that a barcode is not already used by another variant.
   *
   * @param {string} code barcode to check
   * @param {string|null} excludeVariantId current variant (editing) — its own
   *   barcode is not a duplicate
   * @param {Function} [closeCurrent] closes the dialog the scan started from
   *   before opening the owner variant
   * @returns {Promise<{ok:boolean, message?:string}>}
   */
  async function _checkBarcodeAvailable(code, excludeVariantId, closeCurrent) {
    const clean = (code || '').trim();
    if (!clean) return { ok: true };
    let owner = null;
    try {
      const res = await BeeStore.api.variants.byBarcode(clean);
      if (res.ok) owner = res.data;
    } catch (e) { /* treat as free; the service still guards on save */ }
    if (!owner || owner.id === excludeVariantId) return { ok: true };

    let productName = 'صنف آخر';
    try {
      const p = await BeeStore.api.products.get(owner.productId);
      if (p.ok && p.data) productName = p.data.name;
    } catch (e) { /* keep the generic name */ }

    toast(
      'الباركود مستخدم مسبقاً في: ' + productName + ' — ' + owner.size + ' / ' + owner.color,
      'error',
      {
        actionText: 'فتح الصنف',
        duration: 12000,
        onAction: () => {
          if (typeof closeCurrent === 'function') closeCurrent();
          _editVariant(owner.id);
        },
      }
    );
    return { ok: false, message: 'الباركود مستخدم مسبقاً' };
  }

  async function _renderStock(container) {
    const res = await BeeStore.api.variants.list();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const products = await BeeStore.api.products.list();
    const productMap = {};
    if (products.ok) for (const p of products.data) productMap[p.id] = p;

    const rows = res.data.map(v => {
      const p = productMap[v.productId];
      return [
        p ? p.name : '-',
        v.size + ' / ' + v.color,
        String(v.quantity),
        el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _adjustStock(v.id) }, 'تسوية'),
      ];
    });

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'المنتج'), el('th', {}, 'الصنف'), el('th', {}, 'الكمية'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  async function _renderLowStock(container) {
    const settingsRes = await BeeStore.api.settings.get();
    const threshold = settingsRes.ok && settingsRes.data ? settingsRes.data.defaultLowStockThreshold : 3;
    const res = await BeeStore.api.variants.getLowStock(threshold);
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    if (res.data.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصناف منخفضة'));
      return;
    }

    const rows = res.data.map(v => [
      v.productName,
      v.size + ' / ' + v.color,
      String(v.quantity),
      String(v.lowStockThreshold || threshold),
    ]);

    container.appendChild(el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'المنتج'), el('th', {}, 'الصنف'), el('th', {}, 'الكمية'), el('th', {}, 'الحد'),
        ])),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ])
    ));
  }

  function _addProduct() {
    const nameInput = input('text', '');
    const categorySelect = el('select', { class: 'form-input' });
    categorySelect.appendChild(el('option', { value: '' }, 'بدون تصنيف'));
    BeeStore.api.categories.list().then(res => {
      if (res.ok) for (const c of res.data) categorySelect.appendChild(el('option', { value: c.id }, c.name));
    });
    const costInput = input('number', '', { min: 0, step: 0.01 });
    const priceInput = input('number', '', { min: 0, step: 0.01 });

    const { overlay } = BeeStore.dialogs.openDialog('منتج جديد', [
      formField('اسم المنتج', nameInput, true),
      formField('التصنيف', categorySelect),
      formField('التكلفة الافتراضية', costInput, true),
      formField('السعر الافتراضي', priceInput, true),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('اسم المنتج مطلوب', 'error'); return; }
          const defaultCostMinor = BeeStore.money.fromMajor(costInput.value);
          if (defaultCostMinor <= 0) { toast('سعر التكلفة مطلوب - أدخل قيمة أكبر من صفر', 'error'); return; }
          const defaultPriceMinor = BeeStore.money.fromMajor(priceInput.value);
          if (defaultPriceMinor <= 0) { toast('سعر البيع مطلوب - أدخل سعراً أكبر من صفر', 'error'); return; }
          const res = await BeeStore.api.products.create({
            name: nameInput.value.trim(),
            categoryId: categorySelect.value || null,
            defaultCostMinor,
            defaultPriceMinor,
          });
          if (res.ok) { toast('تم إضافة المنتج'); overlay.remove(); render(document.getElementById('page-content')); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  function _editProduct(id) {
    BeeStore.api.products.get(id).then(res => {
      if (!res.ok) return;
      const p = res.data;
      const nameInput = input('text', p.name);
      const costInput = input('number', (p.defaultCostMinor / 100).toFixed(2));
      const priceInput = input('number', (p.defaultPriceMinor / 100).toFixed(2));

      const { overlay } = BeeStore.dialogs.openDialog('تعديل المنتج', [
        formField('الاسم', nameInput, true),
        formField('التكلفة', costInput),
        formField('السعر', priceInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await BeeStore.api.products.update(id, {
              name: nameInput.value.trim(),
              defaultCostMinor: BeeStore.money.fromMajor(costInput.value),
              defaultPriceMinor: BeeStore.money.fromMajor(priceInput.value),
            });
            if (res.ok) { toast('تم التحديث'); overlay.remove(); render(document.getElementById('page-content')); }
            else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
    });
  }

  function _deactivateProduct(id, name) {
    confirmDialog('تعطيل المنتج', 'هل تريد تعطيل "' + name + '"؟', async () => {
      const res = await BeeStore.api.products.deactivate(id);
      if (res.ok) toast('تم تعطيل المنتج');
      else toast(res.error.message, 'error');
    });
  }

  function _adjustStock(variantId) {
    const qtyInput = input('number', '', { placeholder: 'التغيير (+/-)' });
    const reasonInput = input('text', '', { placeholder: 'السبب' });
    const dateInput = input('date', BeeStore.dates.today());

    const { overlay } = BeeStore.dialogs.openDialog('تسوية مخزون', [
      formField('التاريخ', dateInput, true),
      formField('التغيير في الكمية', qtyInput, true),
      formField('السبب', reasonInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const qty = Number(qtyInput.value);
          if (!qty) { toast('أدخل كمية صحيحة', 'error'); return; }
          const res = await BeeStore.api.stock.adjust(variantId, qty, reasonInput.value.trim(), dateInput.value || BeeStore.dates.today());
          if (res.ok) { toast('تم التسوية'); overlay.remove(); }
          else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ]);
  }

  async function _renderCsvImport(container) {
    container.appendChild(el('h3', {}, 'استيراد منتجات من CSV'));
    container.appendChild(el('p', {}, 'القبول: ملف CSV بالأعمدة: المنتج، المقاس، اللون، التكلفة، السعر، الكمية، الباركود'));

    const templateBtn = el('button', { class: 'btn btn-secondary', onclick: () => {
      const csv = BeeStore.csv.toCsv(['المنتج', 'المقاس', 'اللون', 'التكلفة', 'السعر', 'الكمية', 'الباركود'], [
        ['تيشيرت', 'M', 'أحمر', '15.00', '35.00', '10', ''],
        ['فستان', 'L', 'أزرق', '25.00', '55.00', '5', ''],
      ]);
      BeeStore.csv.downloadCsv(csv, 'products-template.csv');
    }}, 'تحميل قالب CSV');
    container.appendChild(templateBtn);

    const fileInput = el('input', { type: 'file', accept: '.csv', style: 'margin: 10px 0' });
    container.appendChild(fileInput);

    const previewDiv = el('div', { id: 'csv-preview' });
    container.appendChild(previewDiv);

    const importBtn = el('button', { class: 'btn btn-primary', onclick: async () => {
      const file = fileInput.files[0];
      if (!file) { toast('اختر ملفاً', 'error'); return; }
      const text = await file.text();
      const res = await BeeStore.csv.importProducts(text);
      if (res.ok) {
        toast('تم استيراد ' + res.created.length + ' منتج');
        if (res.errors && res.errors.length > 0) {
          toast('أخطاء: ' + res.errors.join(', '), 'error');
        }
      } else {
        toast('فشل الاستيراد: ' + (res.errors || []).join(', '), 'error');
      }
    } }, 'استيراد');
    container.appendChild(importBtn);

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      const { rows, errors } = BeeStore.csv.parseProducts(text);
      previewDiv.innerHTML = '';
      if (errors.length > 0) {
        previewDiv.appendChild(el('div', { class: 'alert alert-warning' }, errors.join('<br>')));
      }
      if (rows.length > 0) {
        const tableRows = rows.slice(0, 10).map(r => el('tr', {}, [
          el('td', {}, r.name),
          el('td', {}, r.size),
          el('td', {}, r.color),
          el('td', {}, formatMoney(r.costMinor)),
          el('td', {}, formatMoney(r.priceMinor)),
          el('td', {}, String(r.quantity)),
        ]));
        previewDiv.appendChild(el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'المنتج'), el('th', {}, 'المقاس'), el('th', {}, 'اللون'),
              el('th', {}, 'التكلفة'), el('th', {}, 'السعر'), el('th', {}, 'الكمية'),
            ])),
            el('tbody', {}, tableRows),
          ])
        ));
        if (rows.length > 10) {
          previewDiv.appendChild(el('p', {}, '... و ' + (rows.length - 10) + ' صف آخر'));
        }
      }
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.products = { render, openAddVariant, editVariant: _editVariant };
  if (typeof module !== 'undefined') module.exports = { render, openAddVariant };
})(typeof window !== 'undefined' ? window : globalThis);
