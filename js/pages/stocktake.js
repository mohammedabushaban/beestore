(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, toast } = BeeStore.ui;
  const { input, select } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'جرد المخزون'));

    const catSelect = select([{ value: '', label: 'كل التصنيفات' }], '');
    const catRes = await BeeStore.api.categories.list();
    if (catRes.ok) {
      for (const c of catRes.data) {
        catSelect.appendChild(el('option', { value: c.id }, c.name));
      }
    }

    const filterRow = el('div', { class: 'filter-row' }, [
      catSelect,
      el('button', { class: 'btn btn-secondary', onclick: () => _loadVariants() }, 'عرض'),
    ]);
    container.appendChild(filterRow);

    const listDiv = el('div', { id: 'stocktake-list' });
    container.appendChild(listDiv);

    const dateInput = input('date', BeeStore.dates.today());
    const actionRow = el('div', { class: 'dialog-actions' }, [
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label' }, 'تاريخ الجرد'), dateInput]),
      el('button', { class: 'btn btn-primary', onclick: () => _applyStocktake(listDiv, dateInput.value || BeeStore.dates.today()) }, 'تطبيق الجرد'),
      el('button', { class: 'btn btn-secondary', onclick: () => _printCountSheet(listDiv) }, 'طباعة ورقة الجرد'),
    ]);
    container.appendChild(actionRow);

    async function _loadVariants() {
      const res = await BeeStore.api.variants.list();
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      let variants = res.data;
      if (catSelect.value) {
        const productsRes = await BeeStore.api.products.list();
        if (productsRes.ok) {
          const catProductIds = new Set(productsRes.data.filter(p => p.categoryId === catSelect.value).map(p => p.id));
          variants = variants.filter(v => catProductIds.has(v.productId));
        }
      }
      _renderList(listDiv, variants);
    }

    await _loadVariants();
  }

  function _renderList(container, variants) {
    container.innerHTML = '';
    if (variants.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد أصناف'));
      return;
    }

    const productsRes = BeeStore.api.products.list();
    productsRes.then(res => {
      const productMap = {};
      if (res.ok) for (const p of res.data) productMap[p.id] = p;

      const rows = variants.map(v => {
        const p = productMap[v.productId];
        const countedInput = input('number', String(v.quantity), { min: 0, style: 'width:80px' });
        countedInput.dataset.variantId = v.id;
        countedInput.dataset.currentQty = String(v.quantity);

        const diff = el('span', { class: 'stocktake-diff' }, '0');
        countedInput.addEventListener('input', () => {
          const counted = Number(countedInput.value) || 0;
          const current = Number(countedInput.dataset.currentQty);
          const d = counted - current;
          diff.textContent = d === 0 ? '' : (d > 0 ? '+' : '') + d;
          diff.className = 'stocktake-diff ' + (d === 0 ? '' : d > 0 ? 'text-success' : 'text-danger');
        });

        return el('tr', {}, [
          el('td', {}, p ? p.name : '-'),
          el('td', {}, v.size + ' / ' + v.color),
          el('td', {}, String(v.quantity)),
          el('td', {}, countedInput),
          el('td', {}, diff),
        ]);
      });

      container.appendChild(el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'المنتج'), el('th', {}, 'الصنف'), el('th', {}, 'النظام'), el('th', {}, 'المعدود'), el('th', {}, 'الفرق'),
          ])),
          el('tbody', {}, rows),
        ])
      ));
    });
  }

  async function _applyStocktake(listDiv, date) {
    const items = [];
    listDiv.querySelectorAll('input[type=number]').forEach(input => {
      const variantId = input.dataset.variantId;
      const countedQty = Number(input.value) || 0;
      const currentQty = Number(input.dataset.currentQty);
      if (countedQty !== currentQty) {
        items.push({ variantId, countedQty });
      }
    });

    if (items.length === 0) { toast('لا توجد فروقات', 'error'); return; }

    const res = await BeeStore.api.stock.stocktake(items, date);
    if (res.ok) {
      toast('تم تطبيق الجرد: ' + res.data.length + ' تعديل');
      render(document.getElementById('page-content'));
    } else {
      toast(res.error.message, 'error');
    }
  }

  function _printCountSheet(listDiv) {
    const rows = listDiv.querySelectorAll('tbody tr');
    let html = '<html dir="rtl"><head><meta charset="UTF-8"><title>ورقة جرد</title>';
    html += '<style>body{font-family:"Cairo",Arial,sans-serif;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:right}th{background:#f5f5f5}h2{text-align:center}</style>';
    html += '</head><body><h2>ورقة جرد المخزون</h2><table><thead><tr><th>المنتج</th><th>الصنف</th><th>كمية النظام</th><th>الكمية المعدودة</th><th>ملاحظات</th></tr></thead><tbody>';
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      html += '<tr><td>' + cells[0].textContent + '</td><td>' + cells[1].textContent + '</td><td>' + cells[2].textContent + '</td><td>' + cells[3].querySelector('input').value + '</td><td></td></tr>';
    });
    html += '</tbody></table></body></html>';
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.stocktake = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
