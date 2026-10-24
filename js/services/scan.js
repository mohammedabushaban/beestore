(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Scan → cart helpers shared by the POS, purchases, stocktake and the
   * price-check page. Pure enough to unit-test with a mocked `api`:
   * no DOM, no camera.
   */

  function normalizeCode(raw) {
    if (BeeStore.scanner && typeof BeeStore.scanner.normalizeCode === 'function') {
      return BeeStore.scanner.normalizeCode(raw);
    }
    if (raw === null || raw === undefined) return '';
    return String(raw).replace(/\s+/g, ' ').trim();
  }

  /**
   * Finds the variant for a scanned code.
   *
   * Exact barcode first (`variants.byBarcode`), then the regular variant
   * search so the phone scanner can also read an SKU or a product name.
   *
   * @param {Object} api BeeStore.api (or a mock with `variants`)
   * @param {string} raw scanned code
   * @returns {Promise<Object|null>} variant or null
   */
  async function lookupVariant(api, raw) {
    const code = normalizeCode(raw);
    if (!code || !api || !api.variants) return null;

    try {
      const byBarcode = await api.variants.byBarcode(code);
      if (byBarcode && byBarcode.ok && byBarcode.data) return byBarcode.data;
    } catch (e) { /* fall through to search */ }

    try {
      const search = await api.variants.search(code);
      if (search && search.ok && Array.isArray(search.data) && search.data.length > 0) {
        const exact = search.data.find((v) => v.barcode === code);
        return exact || search.data[0];
      }
    } catch (e) { /* not found */ }

    return null;
  }

  /**
   * Adds one scanned unit to a POS cart (pure mutation of the passed array).
   *
   * Mirrors the manual "add to cart" behavior: same variant → qty + 1, and
   * stock limits apply unless `allowNegative` is on.
   *
   * @param {Array} cart POS cart array
   * @param {Object} variant variant object
   * @param {string} productName
   * @param {{allowNegative?:boolean}} [options]
   * @returns {{ok:boolean, item?:Object, reason?:string, message?:string}}
   */
  function addToCart(cart, variant, productName, options) {
    options = options || {};
    if (!Array.isArray(cart) || !variant || !variant.id) {
      return { ok: false, reason: 'invalid', message: 'صنف غير صالح' };
    }
    const allowNegative = !!options.allowNegative;
    const existing = cart.find((line) => line.variantId === variant.id);

    if (existing) {
      if (!allowNegative && existing.qty >= variant.quantity) {
        return { ok: false, reason: 'stock-limit', message: 'لا يمكن إضافة المزيد - المخزون محدود' };
      }
      existing.qty += 1;
      existing.stockQty = variant.quantity;
      existing.lineTotalMinor = existing.qty * existing.unitPriceMinor - existing.lineDiscountMinor;
      return { ok: true, item: existing };
    }

    if (!allowNegative && variant.quantity <= 0) {
      return {
        ok: false,
        reason: 'out-of-stock',
        message: 'المخزون غير متوفر: ' + (variant.size || '') + ' / ' + (variant.color || ''),
      };
    }

    const item = {
      variantId: variant.id,
      productName: productName || '',
      size: variant.size,
      color: variant.color,
      barcode: variant.barcode || '',
      qty: 1,
      unitPriceMinor: variant.priceMinor,
      unitCostMinor: variant.costMinor,
      lineDiscountMinor: 0,
      lineTotalMinor: variant.priceMinor,
      stockQty: variant.quantity,
    };
    cart.push(item);
    return { ok: true, item };
  }

  /**
   * Reads the product/variant pair for the price-check page.
   *
   * @param {Object} api
   * @param {string} raw scanned code
   * @returns {Promise<{ok:boolean, variant?:Object, product?:Object, reason?:string}>}
   */
  async function priceCheck(api, raw) {
    const code = normalizeCode(raw);
    if (!code) return { ok: false, reason: 'empty' };
    const variant = await lookupVariant(api, code);
    if (!variant) return { ok: false, reason: 'not-found' };
    let product = null;
    try {
      const res = await api.products.get(variant.productId);
      if (res && res.ok) product = res.data;
    } catch (e) { /* show what we have */ }
    return { ok: true, variant, product };
  }

  BeeStore.scanning = { lookupVariant, addToCart, priceCheck, normalizeCode };
  if (typeof module !== 'undefined') module.exports = BeeStore.scanning;
})(typeof window !== 'undefined' ? window : globalThis);
