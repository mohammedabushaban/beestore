(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast } = BeeStore.ui;
  const { input } = BeeStore.dialogs;

  let selectedVariants = [];

  async function render(container) {
    container.innerHTML = '';
    selectedVariants = [];
    container.appendChild(el('h2', { class: 'page-title' }, 'الباركود والملصقات'));

    const searchInput = input('text', '', { placeholder: 'بحث عن منتج أو باركود...', class: 'form-input' });
    container.appendChild(el('div', { class: 'filter-row' }, searchInput));

    const resultsDiv = el('div', { id: 'labels-results' });
    container.appendChild(resultsDiv);

    const selectedDiv = el('div', { id: 'labels-selected', class: 'card' }, [
      el('h3', {}, 'المحدد للطباعة'),
      el('div', { id: 'labels-selected-list' }, el('p', { class: 'empty-state' }, 'لم يتم تحديد أي صنف')),
    ]);
    container.appendChild(selectedDiv);
    _updateSelectedList();

    const printBtn = el('button', { class: 'btn btn-primary btn-lg', onclick: _printLabels }, 'طباعة الملصقات');
    container.appendChild(printBtn);

    searchInput.addEventListener('input', async () => {
      const q = searchInput.value.trim();
      if (q.length < 2) { resultsDiv.innerHTML = ''; return; }
      const res = await BeeStore.api.variants.search(q);
      if (!res.ok) return;
      _renderResults(resultsDiv, res.data.slice(0, 20));
    });
  }

  async function _renderResults(container, variants) {
    container.innerHTML = '';
    const products = {};
    for (const v of variants) {
      if (!products[v.productId]) products[v.productId] = [];
      products[v.productId].push(v);
    }
    for (const [pid, vs] of Object.entries(products)) {
      const pRes = await BeeStore.api.products.get(pid);
      const pname = pRes.ok && pRes.data ? pRes.data.name : '';
      for (const v of vs) {
        const isSelected = selectedVariants.some(sv => sv.id === v.id);
        const copiesInput = input('number', '1', { min: 1, max: 99, style: 'width:60px' });
        copiesInput.disabled = !isSelected;
        copiesInput.addEventListener('input', () => {
          const item = selectedVariants.find(sv => sv.id === v.id);
          if (item) item.copies = Number(copiesInput.value) || 1;
          _updateSelectedList();
        });
        container.appendChild(el('div', { class: 'label-item' }, [
          el('span', {}, pname + ' - ' + v.size + ' / ' + v.color),
          el('span', {}, formatMoney(v.priceMinor)),
          el('input', { type: 'checkbox', checked: isSelected, onchange: (e) => {
            if (e.target.checked) {
              selectedVariants.push({ ...v, productName: pname, copies: Number(copiesInput.value) || 1 });
            } else {
              selectedVariants = selectedVariants.filter(sv => sv.id !== v.id);
            }
            copiesInput.disabled = !e.target.checked;
            _updateSelectedList();
          }}),
          copiesInput,
        ]));
      }
    }
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
        el('span', {}, v.productName + ' - ' + v.size + ' / ' + v.color + ' × ' + v.copies),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => {
          selectedVariants = selectedVariants.filter(sv => sv.id !== v.id);
          _updateSelectedList();
        }}, 'إزالة'),
      ]));
    }
  }

  async function _printLabels() {
    if (selectedVariants.length === 0) { toast('حدد صنفاً واحداً على الأقل', 'error'); return; }
    const settings = await BeeStore.api.settings.get();
    if (!settings.ok) { toast('فشل في قراءة الإعدادات', 'error'); return; }
    
    const storeName = (settings.data && settings.data.storeNameAr) || 'Bee Store';
    const labelSize = (settings.data && settings.data.labelSize) || '50x30';
    const [w, h] = labelSize.split('x').map(Number);
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
