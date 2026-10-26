(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, toast, formatMoney } = BeeStore.ui;

  /**
   * "فحص سعر" — scan a label and show name, size, color, price and stock.
   * Built for the shop floor: continuous scanning, big price, no editing.
   */
  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'فحص سعر'));

    const resultDiv = el('div', { id: 'price-check-result' }, [
      el('div', { class: 'price-result-empty' },
        'امسح باركود الصنف أو اكتبه يدوياً لعرض السعر والمخزون'),
    ]);

    async function doLookup(raw) {
      const code = (raw || '').trim();
      if (!code) return { ok: false, message: 'اكتب الباركود أولاً' };
      const res = await BeeStore.scanning.priceCheck(BeeStore.api, code);
      if (!res.ok) {
        _renderNotFound(resultDiv, code, _createVariant);
        return { ok: false, message: 'باركود غير موجود' };
      }
      _renderResult(resultDiv, res.variant, res.product);
      return {
        ok: true,
        label: _summaryLabel(res.variant, res.product),
      };
    }

    function _createVariant(barcode) {
      if (BeeStore.scanner && typeof BeeStore.scanner.closeCurrent === 'function') {
        BeeStore.scanner.closeCurrent();
      }
      const products = BeeStore.pages && BeeStore.pages.products;
      if (products && typeof products.openAddVariant === 'function') {
        products.openAddVariant({
          barcode,
          onSaved: (created) => { doLookup((created && created.barcode) || barcode); },
        });
      } else {
        toast('افتح صفحة المنتجات لإضافة الصنف', 'error');
      }
    }

    const scanBtn = BeeStore.scanner.scanButton(doLookup, {
      label: 'مسح باركود',
      title: 'فحص السعر بالباركود',
      continuous: true,
      className: 'btn-lg',
      hint: 'امسح الباركود لعرض السعر والمخزون — يبقى القارئ مفتوحاً',
    });

    const manualInput = el('input', {
      type: 'text', class: 'form-input', placeholder: 'أو اكتب الباركود هنا',
      'aria-label': 'باركود الصنف', autocomplete: 'off',
    });
    const checkBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, 'فحص');
    const runManual = async () => {
      const code = manualInput.value.trim();
      manualInput.value = '';
      manualInput.focus();
      await doLookup(code);
    };
    checkBtn.addEventListener('click', runManual);
    manualInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      runManual();
    });

    container.appendChild(el('div', { class: 'card price-check-card' }, [
      el('div', { class: 'price-check-hero' }, [
        el('h3', {}, 'اعرف السعر بمسحة واحدة'),
        el('p', {}, 'وجّه الكاميرا نحو الباركود لعرض اسم الصنف والمقاس واللون والسعر والمخزون.'),
        scanBtn,
        el('div', { class: 'price-check-manual' }, [manualInput, checkBtn]),
      ]),
      resultDiv,
    ]));
  }

  function _summaryLabel(variant, product) {
    const name = product && product.name ? product.name : 'صنف';
    return name + ' — ' + formatMoney(variant.priceMinor) +
      ' — متوفر: ' + (Number(variant.quantity) || 0);
  }

  function _renderResult(container, variant, product) {
    const qty = Number(variant.quantity) || 0;
    const threshold = variant.lowStockThreshold != null ? Number(variant.lowStockThreshold) : 0;
    let stockClass = 'price-chip-stock-ok';
    let stockText = 'متوفر: ' + qty;
    if (qty <= 0) {
      stockClass = 'price-chip-stock-out';
      stockText = 'غير متوفر';
    } else if (threshold > 0 && qty <= threshold) {
      stockClass = 'price-chip-stock-low';
      stockText = 'مخزون منخفض: ' + qty;
    }

    container.innerHTML = '';
    container.appendChild(el('div', { class: 'price-result' }, [
      el('div', { class: 'price-result-head' }, [
        el('div', {}, [
          el('div', { class: 'price-result-name' }, product && product.name ? product.name : 'صنف'),
          variant.sku ? el('div', { class: 'price-result-barcode' }, 'SKU: ' + variant.sku) : null,
        ]),
        el('div', { class: 'price-result-price' }, formatMoney(variant.priceMinor)),
      ]),
      el('div', { class: 'price-result-meta' }, [
        variant.size ? el('span', { class: 'price-chip' }, 'المقاس: ' + variant.size) : null,
        variant.color ? el('span', { class: 'price-chip' }, 'اللون: ' + variant.color) : null,
        el('span', { class: 'price-chip ' + stockClass }, stockText),
      ]),
      variant.barcode ? el('div', { class: 'price-result-barcode', dir: 'ltr' }, variant.barcode) : null,
    ]));
  }

  function _renderNotFound(container, code, onCreate) {
    container.innerHTML = '';
    const canCreate = !(BeeStore.auth && BeeStore.auth.isCashier());
    const box = el('div', { class: 'price-result price-result-error' }, [
      el('div', { class: 'price-result-name' }, 'باركود غير موجود'),
      el('p', { style: 'margin: 8px 0 14px;' }, 'لا يوجد صنف مسجّل بالباركود: ' + code),
    ]);
    if (canCreate) {
      box.appendChild(el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => onCreate(code),
      }, 'إضافة صنف بهذا الباركود'));
    }
    container.appendChild(box);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.priceCheck = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
