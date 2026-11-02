(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    // v3-Lite §7: the cashier gets a read-only catalog (price + stock only).
    if (BeeStore.auth && BeeStore.auth.isCashier()) {
      await _renderCashierCatalog(container);
      return;
    }
    container.appendChild(el('h2', { class: 'page-title' }, 'الأصناف والمخزون'));

    const content = el('div', { id: 'products-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('products', content); _setActiveTab(this); } }, 'الأصناف'),
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

  async function _renderCashierCatalog(container) {
    container.appendChild(el('h2', { class: 'page-title' }, 'الأصناف والأسعار'));
    container.appendChild(el('p', { class: 'alert alert-info' },
      'عرض للقراءة فقط: السعر والكمية المتوفرة. تعديل المنتجات والأسعار والتكلفة متاح للمالك فقط.'));

    const [productsRes, variantsRes] = await Promise.all([
      BeeStore.api.products.list(),
      BeeStore.api.variants.list(),
    ]);
    if (!productsRes.ok) { toast(productsRes.error.message, 'error'); return; }
    if (!variantsRes.ok) { toast(variantsRes.error.message, 'error'); return; }
    const productMap = {};
    for (const p of productsRes.data) productMap[p.id] = p;
    const activeVariants = variantsRes.data.filter(v => {
      const p = productMap[v.productId];
      return (!p || p.active !== false) && v.active !== false;
    });

    const searchInput = input('text', '', { placeholder: 'ابحث بالاسم أو الباركود أو المقاس...' });
    const listDiv = el('div');
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));
    container.appendChild(listDiv);

    function draw() {
      const q = (searchInput.value || '').trim().toLowerCase();
      const rows = activeVariants.filter(v => {
        const p = productMap[v.productId];
        const hay = [p ? p.name : '', v.size, v.color, v.sku, v.barcode].join(' ').toLowerCase();
        return !q || hay.indexOf(q) !== -1;
      }).map(v => {
        const p = productMap[v.productId];
        const low = v.quantity <= (v.lowStockThreshold || 0);
        return el('tr', {}, [
          el('td', {}, p ? p.name : '—'),
          el('td', { style: 'direction:ltr;text-align:start;' }, v.itemCode || v.sku || '—'),
          el('td', {}, v.size || '—'),
          el('td', {}, v.color || '—'),
          el('td', { style: 'direction:ltr;text-align:start;' }, v.barcode || v.sku || '—'),
          el('td', {}, formatMoney(v.priceMinor)),
          el('td', { class: low ? 'text-danger' : '' }, String(v.quantity)),
        ]);
      });
      listDiv.innerHTML = '';
      if (rows.length === 0) {
        listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصناف مطابقة.'));
        return;
      }
      listDiv.appendChild(el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الصنف'), el('th', {}, 'الرمز'), el('th', {}, 'المقاس'),
          el('th', {}, 'اللون'), el('th', {}, 'الباركود'), el('th', {}, 'السعر'),
          el('th', {}, 'المتوفر'),
        ])),
        el('tbody', {}, rows),
      ])));
    }
    searchInput.addEventListener('input', draw);
    draw();
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

  function _normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .replace(/\u0629/g, '\u0647')
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .toLowerCase()
      .trim();
  }

  /** Builds the optional category picker shared by the item dialogs. */
  async function _categoryPicker(value) {
    const picker = select([{ value: '', label: 'بدون تصنيف' }], value || '');
    const res = await BeeStore.api.categories.list();
    if (res.ok) {
      for (const c of res.data) {
        if (c.active === false) continue;
        picker.appendChild(el('option', { value: c.id }, c.name));
      }
      picker.value = value || '';
    }
    return picker;
  }

  async function _renderProducts(container) {
    const quickBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => _quickAddProduct(),
    }, '+ إضافة سريعة');
    const fullBtn = el('button', {
      class: 'btn btn-secondary',
      onclick: () => _addProduct(),
    }, '+ صنف كامل');
    container.appendChild(el('div', { class: 'filter-row' }, [quickBtn, fullBtn]));

    const searchInput = input('text', '', {
      placeholder: 'ابحث بالاسم أو الرمز أو الباركود...',
      class: 'form-input',
    });
    const listDiv = el('div');
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));
    container.appendChild(listDiv);

    const [productsRes, categoriesRes, variantsRes] = await Promise.all([
      BeeStore.api.products.list(),
      BeeStore.api.categories.list(),
      BeeStore.api.variants.list(),
    ]);
    if (!productsRes.ok) { toast(productsRes.error.message, 'error'); return; }
    const categories = {};
    if (categoriesRes.ok) {
      for (const c of categoriesRes.data) categories[c.id] = c.name;
    }
    const variantsByProduct = {};
    if (variantsRes.ok) {
      for (const v of variantsRes.data) {
        if (!variantsByProduct[v.productId]) variantsByProduct[v.productId] = [];
        variantsByProduct[v.productId].push(v);
      }
    }

    function draw() {
      const q = _normalizeText(searchInput.value);
      const products = productsRes.data.filter(p => {
        if (!q) return true;
        const variants = variantsByProduct[p.id] || [];
        const hay = _normalizeText([
          p.name, p.itemCode, p.brand, p.notes, p.unit,
          variants.map(v => [v.itemCode, v.barcode, v.sku, v.size, v.color].join(' ')).join(' '),
        ].filter(Boolean).join(' '));
        return hay.indexOf(q) !== -1;
      });
      listDiv.innerHTML = '';
      if (products.length === 0) {
        listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصناف مطابقة.'));
        return;
      }
      const rows = products.map(p => {
        const variants = (variantsByProduct[p.id] || []).filter(v => v.active !== false);
        const quantity = variants.reduce((sum, v) => sum + (Number(v.quantity) || 0), 0);
        const prices = variants.map(v => Number(v.priceMinor) || 0)
          .filter(v => v > 0).sort((a, b) => a - b);
        const priceText = prices.length === 0
          ? (p.defaultPriceMinor ? formatMoney(p.defaultPriceMinor) : '—')
          : (prices[0] === prices[prices.length - 1]
            ? formatMoney(prices[0])
            : formatMoney(prices[0]) + ' — ' + formatMoney(prices[prices.length - 1]));
        const actions = [
          el('button', { class: 'btn btn-sm btn-secondary', onclick: () => _editProduct(p.id) }, 'تعديل'),
        ];
        if (variants.length === 1) {
          actions.push(el('button', {
            class: 'btn btn-sm btn-secondary',
            onclick: () => _editQuantity(variants[0]),
          }, 'تعديل الكمية'));
        } else if (variants.length > 1) {
          actions.push(el('button', {
            class: 'btn btn-sm btn-secondary',
            onclick: () => _openVariantList(p),
          }, 'الأصناف (' + variants.length + ')'));
        }
        actions.push(el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => _deactivateProduct(p.id, p.name),
        }, 'تعطيل'));
        return [
          el('td', { style: 'direction:ltr;text-align:start;' }, p.itemCode || '—'),
          p.name,
          p.categoryId ? (categories[p.categoryId] || 'بدون تصنيف') : 'بدون تصنيف',
          priceText,
          String(quantity),
          p.active !== false ? 'نشط' : 'غير نشط',
          el('div', { class: 'row-actions' }, actions),
        ];
      });
      listDiv.appendChild(el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'الرمز'), el('th', {}, 'الاسم'), el('th', {}, 'التصنيف'),
            el('th', {}, 'السعر'), el('th', {}, 'المتوفر'), el('th', {}, 'الحالة'),
            el('th', {}, 'إجراءات'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ));
    }
    searchInput.addEventListener('input', draw);
    draw();
  }

  /**
   * v4 R1 Quick Add: compact item form used by the Items page, POS, purchases,
   * stocktake, returns and price check. One default variant is created.
   * @param {{barcode?:string, onSaved?:Function, title?:string}} [options]
   */
  async function _quickAddProduct(options) {
    options = options || {};
    const categories = await _categoryPicker('');
    let nextCode = '';
    try {
      const codeRes = await BeeStore.api.products.nextItemCode();
      if (codeRes.ok) nextCode = codeRes.data;
    } catch (e) { /* the service still auto-generates on save */ }
    const nameInput = input('text', '', { placeholder: 'اسم الصنف' });
    const codeInput = input('text', nextCode, { placeholder: 'يتولد تلقائياً' });
    const barcodeInput = input('text', options.barcode || '', {
      placeholder: 'اختياري — يتولد تلقائياً',
    });
    const unitInput = input('text', 'قطعة');
    const costInput = input('number', '', { min: 0, step: 0.01 });
    const priceInput = input('number', '', { min: 0, step: 0.01 });
    const qtyInput = input('number', '0', { min: 0, step: 1 });
    let overlayRef = null;
    const barcodeScanBtn = BeeStore.scanner.scanButton(async (code) => {
      const check = await _checkBarcodeAvailable(code, null, () => {
        if (overlayRef) overlayRef.remove();
      });
      if (check.ok) barcodeInput.value = code;
    }, { label: 'مسح' });

    const { overlay } = BeeStore.dialogs.openDialog(options.title || 'إضافة سريعة', [
      formField('اسم الصنف', nameInput, true),
      formField('رمز الصنف', codeInput, true, 'يتولد تلقائياً ويمكن تعديله'),
      formField('الباركود', barcodeInput, false, null, barcodeScanBtn),
      formField('التصنيف (اختياري)', categories),
      formField('الوحدة', unitInput),
      formField('التكلفة', costInput, true),
      formField('سعر البيع', priceInput, true),
      formField('الكمية الافتتاحية', qtyInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('اسم الصنف مطلوب', 'error'); return; }
          const costMinor = BeeStore.money.fromMajor(costInput.value);
          if (costMinor <= 0) {
            toast('سعر التكلفة مطلوب - أدخل قيمة أكبر من صفر', 'error');
            return;
          }
          const priceMinor = BeeStore.money.fromMajor(priceInput.value);
          if (priceMinor <= 0) {
            toast('سعر البيع مطلوب - أدخل سعراً أكبر من صفر', 'error');
            return;
          }
          const barcode = barcodeInput.value.trim();
          if (barcode) {
            const check = await _checkBarcodeAvailable(barcode, null, () => overlay.remove());
            if (!check.ok) return;
          }
          const res = await BeeStore.api.products.quickAdd({
            name: nameInput.value.trim(),
            itemCode: codeInput.value.trim(),
            barcode,
            categoryId: categories.value || null,
            unit: unitInput.value.trim() || 'قطعة',
            costMinor,
            priceMinor,
            openingQuantity: Math.max(0, Math.floor(Number(qtyInput.value) || 0)),
          });
          if (!res.ok) { toast(res.error.message, 'error'); return; }
          toast('تم إضافة الصنف');
          overlay.remove();
          if (typeof options.onSaved === 'function') {
            options.onSaved(res.data);
            return;
          }
          const page = document.getElementById('page-content');
          if (page) render(page);
        },
      }, 'حفظ'),
    ], null, { large: true });
    overlayRef = overlay;
    setTimeout(() => nameInput.focus(), 80);
  }

  function _openVariantList(product) {
    BeeStore.api.variants.list().then(res => {
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const variants = res.data.filter(v => v.productId === product.id);
      const rows = variants.map(v => el('div', {
        class: 'filter-row',
        style: 'justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding: 6px 0;',
      }, [
        el('span', {}, [v.itemCode || '—', ' · ', v.size || '—', ' / ', v.color || '—',
          ' · ', String(v.quantity), ' · ', formatMoney(v.priceMinor)].join('')),
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: () => { overlay.remove(); _editVariant(v.id); },
        }, 'تعديل'),
      ]));
      const { overlay } = BeeStore.dialogs.openDialog('أصناف: ' + product.name,
        rows.length > 0 ? rows : [el('p', { class: 'empty-state' }, 'لا توجد أصناف.')],
        null, { large: true });
    });
  }

  async function _editQuantity(variant) {
    const qtyInput = input('number', String(variant.quantity || 0), { min: -1000000, step: 1 });
    const reasonSelect = select([
      { value: 'تالف', label: 'تالف' },
      { value: 'فقد', label: 'فقد' },
      { value: 'زيادة', label: 'زيادة' },
      { value: 'جرد', label: 'جرد' },
      { value: 'تصحيح', label: 'تصحيح' },
    ], 'تصحيح');
    const dateInput = input('date', BeeStore.dates.today());
    const noteInput = input('text', '', { placeholder: 'ملاحظة اختيارية' });
    const { overlay } = BeeStore.dialogs.openDialog(
      'تعديل الكمية: ' + [variant.itemCode, variant.size, variant.color].filter(Boolean).join(' '),
      [
        formField('الكمية الفعلية الجديدة', qtyInput, true,
          'الكمية الحالية: ' + String(variant.quantity || 0) +
          ' — سيُنشأ حركة تسوية بالفرق'),
        formField('سبب التسوية', reasonSelect, true),
        formField('التاريخ', dateInput, true),
        formField('ملاحظة', noteInput),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const target = Number(qtyInput.value);
            if (!Number.isInteger(target) || target < 0) {
              toast('أدخل كمية صحيحة غير سالبة', 'error');
              return;
            }
            const diff = target - (Number(variant.quantity) || 0);
            if (diff === 0) { toast('الكمية لم تتغير'); overlay.remove(); return; }
            const res = await BeeStore.api.stock.adjust(
              variant.id, diff, reasonSelect.value,
              dateInput.value || BeeStore.dates.today(),
              noteInput.value.trim() || reasonSelect.value);
            if (res.ok) {
              toast('تم تعديل الكمية');
              overlay.remove();
              const page = document.getElementById('page-content');
              if (page) render(page);
            } else toast(res.error.message, 'error');
          },
        }, 'حفظ'),
      ]);
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
      const codeInput = input('text', v.itemCode || '');
      const costInput = input('number', (v.costMinor / 100).toFixed(2));
      const priceInput = input('number', (v.priceMinor / 100).toFixed(2));
      const thresholdInput = input('number', v.lowStockThreshold != null ? String(v.lowStockThreshold) : '');
      const barcodeInput = input('text', v.barcode || '');
      const reasonInput = input('text', '', {
        placeholder: 'سبب تعديل التكلفة (مطلوب عند تغييرها)',
      });
      let overlayRef = null;
      const barcodeScanBtn = BeeStore.scanner.scanButton(async (code) => {
        const check = await _checkBarcodeAvailable(code, id, () => {
          if (overlayRef) overlayRef.remove();
        });
        if (check.ok) barcodeInput.value = code;
      }, { label: 'مسح' });

      const { overlay } = BeeStore.dialogs.openDialog('تعديل الصنف', [
        formField('رمز الصنف', codeInput, true),
        formField('المقاس', sizeInput),
        formField('اللون', colorInput),
        formField('التكلفة', costInput),
        formField('سبب تعديل التكلفة', reasonInput, false,
          'مطلوب عند تغيير التكلفة — يُنشئ حركة إعادة تقييم للمخزون'),
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
            const newCost = BeeStore.money.fromMajor(costInput.value);
            const costChanged = newCost !== (Number(v.costMinor) || 0);
            if (costChanged && !reasonInput.value.trim()) {
              toast('سبب تعديل التكلفة مطلوب', 'error');
              return;
            }
            const patch = {
              itemCode: codeInput.value.trim(),
              size: sizeInput.value.trim(),
              color: colorInput.value.trim(),
              costMinor: newCost,
              priceMinor: BeeStore.money.fromMajor(priceInput.value),
              lowStockThreshold: thresholdInput.value ? Number(thresholdInput.value) : null,
              barcode,
            };
            if (costChanged) patch.revaluationReason = reasonInput.value.trim();
            const res2 = await BeeStore.api.variants.update(id, patch);
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

  async function _addProduct() {
    const categories = await _categoryPicker('');
    let nextCode = '';
    try {
      const codeRes = await BeeStore.api.products.nextItemCode();
      if (codeRes.ok) nextCode = codeRes.data;
    } catch (e) { /* auto-generation remains available */ }

    const nameInput = input('text', '');
    const codeInput = input('text', nextCode);
    const brandInput = input('text', '');
    const unitInput = input('text', 'قطعة');
    const thresholdInput = input('number', '', { min: 0, step: 1 });
    const notesInput = input('text', '');
    const costInput = input('number', '', { min: 0, step: 0.01 });
    const priceInput = input('number', '', { min: 0, step: 0.01 });
    const qtyInput = input('number', '0', { min: 0, step: 1 });
    const barcodeInput = input('text', '', { placeholder: 'اختياري — يتولد تلقائياً' });
    const hasVariantsCheck = BeeStore.dialogs.checkbox('له مقاسات/ألوان', false);
    const variantToggle = hasVariantsCheck.querySelector('input');
    const variantsBox = el('div');
    const variantRows = [];

    function addVariantRow() {
      const sizeInput = input('text', '', { placeholder: 'المقاس' });
      const colorInput = input('text', '', { placeholder: 'اللون' });
      const vQty = input('number', '0', { min: 0, step: 1 });
      const vCost = input('number', '', { min: 0, step: 0.01, placeholder: 'افتراضي' });
      const vPrice = input('number', '', { min: 0, step: 0.01, placeholder: 'افتراضي' });
      const vBarcode = input('text', '', { placeholder: 'اختياري' });
      const row = el('div', {
        class: 'variant-row',
        style: 'display:grid;grid-template-columns:1fr 1fr 80px 100px 100px 1fr auto;gap:6px;margin-bottom:6px;align-items:center;',
      }, [
        sizeInput, colorInput, vQty, vCost, vPrice, vBarcode,
        el('button', {
          class: 'btn btn-sm btn-danger',
          type: 'button',
          onclick: () => {
            const index = variantRows.indexOf(entry);
            if (index >= 0) variantRows.splice(index, 1);
            row.remove();
          },
        }, '×'),
      ]);
      const entry = { sizeInput, colorInput, vQty, vCost, vPrice, vBarcode, row };
      variantRows.push(entry);
      variantsBox.appendChild(row);
    }

    variantToggle.addEventListener('change', () => {
      variantsBox.innerHTML = '';
      variantRows.length = 0;
      if (variantToggle.checked) {
        addVariantRow();
        addVariantRow();
      }
    });

    const { overlay } = BeeStore.dialogs.openDialog('صنف جديد', [
      formField('اسم الصنف', nameInput, true),
      formField('رمز الصنف', codeInput, true, 'يتولد تلقائياً ويمكن تعديله'),
      formField('التصنيف (اختياري)', categories),
      formField('الماركة', brandInput),
      formField('الوحدة', unitInput),
      formField('التكلفة الافتراضية', costInput, true),
      formField('سعر البيع الافتراضي', priceInput, true),
      formField('الباركود (للصنف الافتراضي)', barcodeInput),
      formField('حد تنبيه المخزون', thresholdInput),
      formField('ملاحظات', notesInput),
      hasVariantsCheck,
      el('div', { class: 'form-group' }, [
        el('p', { class: 'form-hint' }, 'عند تفعيل المقاسات/الألوان أضف صفاً لكل صنف. اترك التكلفة/السعر فارغين لاستخدام الافتراضي.'),
        variantsBox,
        el('button', {
          class: 'btn btn-sm btn-secondary',
          type: 'button',
          onclick: addVariantRow,
        }, '+ صنف'),
      ]),
      formField('الكمية الافتتاحية (للصنف الافتراضي)', qtyInput, false,
        'تُستخدم فقط عندما لا توجد مقاسات/ألوان'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('اسم الصنف مطلوب', 'error'); return; }
          const defaultCostMinor = BeeStore.money.fromMajor(costInput.value);
          if (defaultCostMinor <= 0) {
            toast('سعر التكلفة مطلوب - أدخل قيمة أكبر من صفر', 'error');
            return;
          }
          const defaultPriceMinor = BeeStore.money.fromMajor(priceInput.value);
          if (defaultPriceMinor <= 0) {
            toast('سعر البيع مطلوب - أدخل سعراً أكبر من صفر', 'error');
            return;
          }
          const hasVariants = !!variantToggle.checked;
          const variants = [];
          if (hasVariants) {
            for (const entry of variantRows) {
              const size = entry.sizeInput.value.trim();
              const color = entry.colorInput.value.trim();
              if (!size && !color) {
                toast('كل صف يحتاج مقاساً أو لوناً', 'error');
                return;
              }
              variants.push({
                size,
                color,
                quantity: Math.max(0, Math.floor(Number(entry.vQty.value) || 0)),
                costMinor: entry.vCost.value
                  ? BeeStore.money.fromMajor(entry.vCost.value) : defaultCostMinor,
                priceMinor: entry.vPrice.value
                  ? BeeStore.money.fromMajor(entry.vPrice.value) : defaultPriceMinor,
                barcode: entry.vBarcode.value.trim(),
              });
            }
            if (variants.length === 0) {
              toast('أضف صنفاً واحداً على الأقل', 'error');
              return;
            }
          } else {
            const barcode = barcodeInput.value.trim();
            if (barcode) {
              const check = await _checkBarcodeAvailable(barcode, null, () => overlay.remove());
              if (!check.ok) return;
            }
            variants.push({
              size: '',
              color: '',
              barcode,
              quantity: Math.max(0, Math.floor(Number(qtyInput.value) || 0)),
              costMinor: defaultCostMinor,
              priceMinor: defaultPriceMinor,
            });
          }
          const res = await BeeStore.api.products.create({
            name: nameInput.value.trim(),
            itemCode: codeInput.value.trim(),
            categoryId: categories.value || null,
            brand: brandInput.value.trim(),
            unit: unitInput.value.trim() || 'قطعة',
            notes: notesInput.value.trim(),
            defaultCostMinor,
            defaultPriceMinor,
            lowStockThreshold: thresholdInput.value ? Number(thresholdInput.value) : null,
            hasVariants,
            variants,
          });
          if (res.ok) {
            toast('تم إضافة الصنف');
            overlay.remove();
            render(document.getElementById('page-content'));
          } else toast(res.error.message, 'error');
        },
      }, 'حفظ'),
    ], null, { large: true });
  }

  async function _editProduct(id) {
    const res = await BeeStore.api.products.getWithVariants(id);
    if (!res.ok || !res.data) return;
    const p = res.data;
    const variants = p.variants || [];
    const defaultVariant = variants.length === 1 ? variants[0] : null;
    const categories = await _categoryPicker(p.categoryId || '');
    const nameInput = input('text', p.name);
    const codeInput = input('text', p.itemCode || '');
    const brandInput = input('text', p.brand || '');
    const unitInput = input('text', p.unit || 'قطعة');
    const thresholdInput = input('number',
      p.lowStockThreshold != null ? String(p.lowStockThreshold) : '');
    const notesInput = input('text', p.notes || '');
    const priceValue = defaultVariant
      ? defaultVariant.priceMinor : p.defaultPriceMinor;
    const priceInput = input('number', ((Number(priceValue) || 0) / 100).toFixed(2));
    const costInput = input('number',
      ((Number(defaultVariant ? defaultVariant.costMinor : p.defaultCostMinor) || 0) / 100).toFixed(2));
    const reasonInput = input('text', '', {
      placeholder: 'سبب تعديل التكلفة (مطلوب عند تغييرها)',
    });
    const activeCheck = BeeStore.dialogs.checkbox('نشط', p.active !== false);
    const activeToggle = activeCheck.querySelector('input');
    const stockHint = p.hasVariants
      ? el('p', { class: 'form-hint' },
        'هذا الصنف له مقاسات/ألوان. عدّل تكلفة وسعر كل صنف من تبويب «الأصناف».')
      : null;

    const { overlay } = BeeStore.dialogs.openDialog('تعديل الصنف', [
      formField('الاسم', nameInput, true),
      formField('رمز الصنف', codeInput, true),
      formField('التصنيف (اختياري)', categories),
      formField('الماركة', brandInput),
      formField('الوحدة', unitInput),
      stockHint || formField('التكلفة', costInput),
      stockHint || formField('السعر', priceInput),
      stockHint || formField('سبب تعديل التكلفة', reasonInput,
        false, 'مطلوب فقط عند تغيير التكلفة — يُنشئ حركة إعادة تقييم'),
      formField('حد تنبيه المخزون', thresholdInput),
      formField('ملاحظات', notesInput),
      activeCheck,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!nameInput.value.trim()) { toast('اسم الصنف مطلوب', 'error'); return; }
          if (!codeInput.value.trim()) { toast('رمز الصنف مطلوب', 'error'); return; }
          const patch = {
            name: nameInput.value.trim(),
            itemCode: codeInput.value.trim(),
            categoryId: categories.value || null,
            brand: brandInput.value.trim(),
            unit: unitInput.value.trim() || 'قطعة',
            lowStockThreshold: thresholdInput.value ? Number(thresholdInput.value) : null,
            notes: notesInput.value.trim(),
            active: activeToggle.checked,
          };
          let newCost = null;
          let newPrice = null;
          if (defaultVariant) {
            newCost = BeeStore.money.fromMajor(costInput.value);
            newPrice = BeeStore.money.fromMajor(priceInput.value);
            if (newPrice <= 0) {
              toast('سعر البيع مطلوب - أدخل سعراً أكبر من صفر', 'error');
              return;
            }
            if (newCost !== (Number(defaultVariant.costMinor) || 0) &&
              !reasonInput.value.trim()) {
              toast('سبب تعديل التكلفة مطلوب', 'error');
              return;
            }
            patch.defaultCostMinor = newCost;
            patch.defaultPriceMinor = newPrice;
          }
          const updated = await BeeStore.api.products.update(id, patch);
          if (!updated.ok) { toast(updated.error.message, 'error'); return; }
          if (defaultVariant && (newCost !== (Number(defaultVariant.costMinor) || 0) ||
            newPrice !== (Number(defaultVariant.priceMinor) || 0))) {
            const variantPatch = { priceMinor: newPrice };
            if (newCost !== (Number(defaultVariant.costMinor) || 0)) {
              variantPatch.costMinor = newCost;
              variantPatch.revaluationReason = reasonInput.value.trim();
            }
            const variantRes = await BeeStore.api.variants.update(defaultVariant.id, variantPatch);
            if (!variantRes.ok) { toast(variantRes.error.message, 'error'); return; }
          }
          toast('تم التحديث');
          overlay.remove();
          render(document.getElementById('page-content'));
        },
      }, 'حفظ'),
    ], null, { large: true });
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
  BeeStore.pages.products = {
    render,
    openAddVariant,
    editVariant: _editVariant,
    quickAdd: _quickAddProduct,
  };
  if (typeof module !== 'undefined') module.exports = { render, openAddVariant, quickAdd: _quickAddProduct };
})(typeof window !== 'undefined' ? window : globalThis);
