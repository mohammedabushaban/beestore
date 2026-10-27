(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast } = BeeStore.ui;
  const { input, formField, openDialog } = BeeStore.dialogs;

  let selectedVariants = [];
  let currentResults = [];
  let searchToken = 0;
  let lastQuery = '';
  let resultsDiv = null;

  async function render(container) {
    container.innerHTML = '';
    selectedVariants = [];
    currentResults = [];
    searchToken = 0;
    lastQuery = '';

    container.appendChild(el('h2', { class: 'page-title' }, 'الباركود والملصقات'));
    container.appendChild(el('p', { class: 'page-subtitle' }, 'ابحث عن الصنف، حدّد عدد النسخ، ثم اطبع الملصقات على ورق A4.'));

    const searchInput = input('text', '', {
      placeholder: 'بحث عن منتج أو باركود...',
      class: 'form-input',
      'aria-label': 'بحث عن منتج أو باركود',
    });
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));

    resultsDiv = el('div', { id: 'labels-results' });
    container.appendChild(resultsDiv);

    const selectedDiv = el('div', { id: 'labels-selected', class: 'card' }, [
      el('h3', {}, 'المحدد للطباعة'),
      el('div', { id: 'labels-selected-list' }, el('p', { class: 'empty-state' }, 'لم يتم تحديد أي صنف')),
    ]);
    container.appendChild(selectedDiv);
    _updateSelectedList();

    const printBtn = el('button', { class: 'btn btn-primary btn-lg', onclick: _printLabels }, 'طباعة الملصقات');
    container.appendChild(printBtn);

    searchInput.addEventListener('input', () => _runSearch(searchInput.value.trim()));
  }

  async function _runSearch(query) {
    lastQuery = query;
    const token = ++searchToken;
    if (query.length < 2) {
      currentResults = [];
      if (resultsDiv) resultsDiv.innerHTML = '';
      return;
    }
    const res = await BeeStore.api.variants.search(query);
    if (token !== searchToken) return;
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    currentResults = res.data.slice(0, 20);
    await _renderResults(resultsDiv, currentResults, token);
  }

  async function _renderResults(container, variants, token) {
    if (!container) return;

    const byProduct = {};
    for (const v of variants) {
      if (!byProduct[v.productId]) byProduct[v.productId] = [];
      byProduct[v.productId].push(v);
    }

    const productIds = Object.keys(byProduct);
    const productEntries = await Promise.all(productIds.map(async (pid) => {
      const pRes = await BeeStore.api.products.get(pid);
      return [pid, pRes.ok && pRes.data ? pRes.data.name : ''];
    }));
    if (token !== undefined && token !== searchToken) return;

    const productNames = {};
    for (const [pid, name] of productEntries) productNames[pid] = name;

    container.innerHTML = '';
    if (variants.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد نتائج مطابقة'));
      return;
    }

    for (const v of variants) {
      const pname = productNames[v.productId] || 'منتج';
      const selected = selectedVariants.find(sv => sv.id === v.id);
      const copiesInput = input('number', String(selected ? selected.copies : 1), {
        min: 1,
        max: 99,
        class: 'label-copies',
        'aria-label': 'عدد نسخ الملصق',
      });
      copiesInput.disabled = !selected;

      const checkbox = el('input', {
        type: 'checkbox',
        class: 'form-checkbox',
        checked: !!selected,
        'aria-label': 'تحديد ' + pname + ' ' + v.size + ' / ' + v.color,
      });

      const row = el('div', {
        class: 'label-item' + (selected ? ' is-selected' : ''),
        'data-variant-id': v.id,
      }, [
        el('label', { class: 'label-item-check' }, checkbox),
        el('div', { class: 'label-item-info' }, [
          el('span', { class: 'label-item-name' }, pname + ' — ' + v.size + ' / ' + v.color),
          el('span', { class: 'label-item-meta' }, [
            el('span', { class: 'label-item-price' }, formatMoney(v.priceMinor)),
            el('span', { class: 'label-item-barcode', dir: 'ltr' }, v.barcode || 'بدون باركود'),
          ]),
        ]),
        copiesInput,
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-secondary',
          onclick: () => _editBarcode(v, pname),
        }, 'تعديل الباركود'),
      ]);

      checkbox.addEventListener('change', () => {
        _setSelected(v, pname, checkbox.checked, Number(copiesInput.value) || 1);
        copiesInput.disabled = !checkbox.checked;
        row.classList.toggle('is-selected', checkbox.checked);
      });

      copiesInput.addEventListener('input', () => {
        const item = selectedVariants.find(sv => sv.id === v.id);
        if (!item) return;
        item.copies = Math.max(1, Math.min(99, Math.floor(Number(copiesInput.value) || 1)));
        _updateSelectedList();
      });

      copiesInput.addEventListener('change', () => {
        const copies = Math.max(1, Math.min(99, Math.floor(Number(copiesInput.value) || 1)));
        copiesInput.value = String(copies);
        const item = selectedVariants.find(sv => sv.id === v.id);
        if (!item) return;
        item.copies = copies;
        _updateSelectedList();
      });

      container.appendChild(row);
    }
  }

  function _setSelected(variant, productName, on, copies) {
    const existing = selectedVariants.find(sv => sv.id === variant.id);
    if (on) {
      if (existing) {
        existing.copies = Math.max(1, Math.min(99, copies || existing.copies));
      } else {
        selectedVariants.push({
          ...variant,
          productName,
          copies: Math.max(1, Math.min(99, copies || 1)),
        });
      }
    } else {
      selectedVariants = selectedVariants.filter(sv => sv.id !== variant.id);
    }
    _updateSelectedList();
  }

  function _removeSelected(variantId) {
    selectedVariants = selectedVariants.filter(sv => sv.id !== variantId);
    _updateSelectedList();

    const row = document.querySelector('.label-item[data-variant-id="' + variantId + '"]');
    if (!row) return;
    const checkbox = row.querySelector('input[type="checkbox"]');
    const copiesInput = row.querySelector('.label-copies');
    if (checkbox) checkbox.checked = false;
    if (copiesInput) copiesInput.disabled = true;
    row.classList.remove('is-selected');
  }

  function _updateSelectedList() {
    const list = document.getElementById('labels-selected-list');
    if (!list) return;
    list.innerHTML = '';
    if (selectedVariants.length === 0) {
      list.appendChild(el('p', { class: 'empty-state' }, 'لم يتم تحديد أي صنف'));
      return;
    }
    for (const v of selectedVariants) {
      list.appendChild(el('div', { class: 'selected-label-item' }, [
        el('div', { class: 'selected-label-info' }, [
          el('span', { class: 'selected-label-name' }, v.productName + ' — ' + v.size + ' / ' + v.color),
          el('span', { class: 'selected-label-meta' }, [
            el('span', {}, formatMoney(v.priceMinor)),
            el('span', { class: 'selected-label-barcode', dir: 'ltr' }, v.barcode || 'بدون باركود'),
          ]),
        ]),
        el('span', { class: 'selected-label-copies' }, '× ' + v.copies),
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-secondary',
          onclick: () => _editBarcode(v),
        }, 'الباركود'),
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: () => _removeSelected(v.id),
        }, 'إزالة'),
      ]));
    }
  }

  function _editBarcode(variant, productName) {
    const barcodeInput = input('text', variant.barcode || '', {
      placeholder: 'مثال: 1001',
      dir: 'ltr',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: 40,
      'aria-label': 'رقم الباركود',
    });

    let saving = false;
    const saveBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      onclick: async () => {
        if (saving) return;
        const barcode = barcodeInput.value.trim();
        if (!barcode) { toast('أدخل رقماً للباركود', 'error'); barcodeInput.focus(); return; }
        if (/\s/.test(barcode)) { toast('لا يمكن أن يحتوي الباركود على مسافات', 'error'); barcodeInput.focus(); return; }

        saving = true;
        saveBtn.disabled = true;
        const res = await BeeStore.api.variants.update(variant.id, { barcode });
        saving = false;
        saveBtn.disabled = false;
        if (!res.ok) { toast(res.error.message, 'error'); return; }

        const updated = res.data || { ...variant, barcode };
        currentResults = currentResults.map(v => v.id === variant.id ? { ...v, ...updated } : v);
        selectedVariants = selectedVariants.map(v => v.id === variant.id ? { ...v, ...updated } : v);
        overlay.remove();
        _updateSelectedList();
        toast('تم تحديث الباركود');
        if (lastQuery.length >= 2) _runSearch(lastQuery);
      },
    }, 'حفظ');

    const generateBtn = el('button', {
      type: 'button',
      class: 'btn btn-secondary',
      onclick: () => {
        barcodeInput.value = BeeStore.ids.nextBarcode();
        barcodeInput.focus();
      },
    }, 'توليد تلقائي');

    const { overlay } = openDialog('باركود الصنف', [
      el('p', { class: 'dialog-subtitle' }, (productName || variant.productName || 'الصنف') + ' — ' + variant.size + ' / ' + variant.color),
      formField('رقم الباركود', barcodeInput, true, 'اكتب الرقم الذي تريده لهذا الصنف، مثل 1001. يجب ألا يكون مستخدماً لصنف آخر.', generateBtn),
      el('div', { class: 'dialog-actions' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => overlay.remove() }, 'إلغاء'),
        saveBtn,
      ]),
    ]);
  }

  async function _printLabels() {
    if (selectedVariants.length === 0) { toast('حدد صنفاً واحداً على الأقل', 'error'); return; }
    const settings = await BeeStore.api.settings.get();
    if (!settings.ok) { toast('فشل في قراءة الإعدادات', 'error'); return; }

    const variantsToPrint = [];
    for (const v of selectedVariants) {
      for (let i = 0; i < (v.copies || 1); i++) {
        variantsToPrint.push(v);
      }
    }

    BeeStore.print.printLabelSheet(variantsToPrint, settings.data);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.labels = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
