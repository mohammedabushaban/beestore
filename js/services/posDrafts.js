(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Held POS invoices (v6). A cashier can park an in-progress invoice, serve
   * another customer, then resume the first one. Drafts are device-local
   * working state, not accounting documents: they live in localStorage and
   * never enter IndexedDB, the journal, backups or the materialized summary.
   * They are scoped per profile so the owner and the cashier never see each
   * other's parked invoices.
   */
  const KEY_PREFIX = 'beestore.posDrafts.v1';
  const MAX_DRAFTS = 20;

  function profileId() {
    try {
      if (BeeStore.auth && typeof BeeStore.auth.profile === 'function') {
        return BeeStore.auth.profile() || 'owner';
      }
    } catch (e) { /* fall through to the owner bucket */ }
    return 'owner';
  }

  function storageKey(profile) {
    return KEY_PREFIX + ':' + (profile || profileId());
  }

  function storage() {
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function requireStorage() {
    const store = storage();
    if (!store) {
      throw BeeStore.errors.err('STORAGE',
        'تعذر الوصول إلى التخزين المحلي. تأكد من السماح بالحفظ في المتصفح.');
    }
    return store;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function minor(value) {
    return BeeStore.money.roundMinor(value);
  }

  function normalizeItem(item) {
    if (!item || !item.variantId) return null;
    const qty = Math.max(1, Number(item.qty) || 1);
    const unitPriceMinor = Math.max(0, minor(item.unitPriceMinor));
    const lineDiscountMinor = Math.max(0, minor(item.lineDiscountMinor));
    return {
      variantId: text(item.variantId),
      itemCode: text(item.itemCode),
      productName: text(item.productName),
      size: text(item.size),
      color: text(item.color),
      barcode: text(item.barcode),
      qty,
      listPriceMinor: item.listPriceMinor != null
        ? minor(item.listPriceMinor) : unitPriceMinor,
      unitPriceMinor,
      unitCostMinor: minor(item.unitCostMinor),
      lineDiscountMinor,
      // Recompute instead of trusting a stale snapshot.
      lineTotalMinor: Math.max(0, qty * unitPriceMinor - lineDiscountMinor),
      stockQty: Math.max(0, Number(item.stockQty) || 0),
    };
  }

  function normalizePayment(payment) {
    if (!payment) return null;
    const amountMinor = minor(payment.amountMinor);
    if (amountMinor <= 0) return null;
    return {
      method: text(payment.method) || 'cash',
      amountMinor,
    };
  }

  function normalizeDiscount(discount) {
    const source = discount || {};
    return {
      type: source.type === 'percent' ? 'percent' : 'amount',
      value: Math.max(0, Number(source.value) || 0),
    };
  }

  function totalMinor(cart, discount) {
    const subtotal = cart.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    let discountMinor = discount.type === 'percent'
      ? Math.round(subtotal * discount.value / 100)
      : BeeStore.money.fromMajor(discount.value);
    if (discountMinor > subtotal) discountMinor = subtotal;
    return subtotal - discountMinor;
  }

  function normalizeDraft(draft, previous) {
    const cart = (draft.cart || []).map(normalizeItem).filter(Boolean);
    if (cart.length === 0) {
      throw BeeStore.errors.err('VALIDATION', 'لا يمكن تعليق فاتورة بدون أصناف');
    }
    const discount = normalizeDiscount(draft.discount);
    const now = BeeStore.dates.now();
    return {
      id: text(draft.id) || BeeStore.ids.randomId('draft'),
      clientKey: text(draft.clientKey) || BeeStore.ids.randomId('key'),
      createdAt: (previous && previous.createdAt) || now,
      updatedAt: now,
      date: text(draft.date) || BeeStore.dates.today(),
      customerId: draft.customerId ? text(draft.customerId) : null,
      customerName: text(draft.customerName),
      contactPhone: text(draft.contactPhone),
      payerName: text(draft.payerName),
      discount,
      overpaymentMode: text(draft.overpaymentMode) || 'change',
      payments: (draft.payments || []).map(normalizePayment).filter(Boolean),
      cart,
      itemCount: cart.reduce((sum, item) => sum + item.qty, 0),
      lineCount: cart.length,
      totalMinor: totalMinor(cart, discount),
    };
  }

  function read(profile) {
    const store = storage();
    if (!store) return [];
    try {
      const raw = store.getItem(storageKey(profile));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((draft) => draft && draft.id);
    } catch (e) {
      // Corrupt/unreadable working state must never break the POS.
      return [];
    }
  }

  function write(profile, drafts) {
    const store = requireStorage();
    try {
      store.setItem(storageKey(profile), JSON.stringify(drafts));
    } catch (e) {
      throw BeeStore.errors.err('STORAGE',
        'تعذر حفظ الفاتورة المعلّقة: مساحة التخزين ممتلئة أو غير متاحة');
    }
  }

  /**
   * Lists the current profile's held invoices, newest first.
   * @returns {object[]} sanitized drafts
   */
  function list() {
    const profile = profileId();
    return read(profile)
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  /**
   * Creates or updates a held invoice. Passing the id of an existing draft
   * updates it in place (keeping createdAt); otherwise a new draft is added.
   * @param {object} draft invoice state from the POS page
   * @returns {object} the saved draft
   * @throws {BeeError} VALIDATION|STORAGE
   */
  function save(draft) {
    const profile = profileId();
    const all = read(profile);
    const id = text(draft && draft.id);
    const index = id ? all.findIndex((d) => String(d.id) === id) : -1;
    if (index < 0 && all.length >= MAX_DRAFTS) {
      throw BeeStore.errors.err('VALIDATION',
        'الحد الأقصى ' + MAX_DRAFTS + ' فاتورة معلّقة. استأنف أو احذف فاتورة أولاً.');
    }
    const record = normalizeDraft(draft || {}, index >= 0 ? all[index] : null);
    if (index >= 0) all.splice(index, 1);
    all.unshift(record);
    write(profile, all);
    return record;
  }

  /**
   * Removes one held invoice from the current profile.
   * @param {string} id draft id
   * @returns {boolean} true when a draft was removed
   */
  function remove(id) {
    const profile = profileId();
    const all = read(profile);
    const kept = all.filter((draft) => String(draft.id) !== String(id));
    if (kept.length === all.length) return false;
    write(profile, kept);
    return true;
  }

  /** Removes every held invoice of the current profile. */
  function clear() {
    const profile = profileId();
    const store = storage();
    if (!store) return false;
    try {
      store.removeItem(storageKey(profile));
      return true;
    } catch (e) {
      return false;
    }
  }

  BeeStore.posDrafts = {
    KEY_PREFIX,
    MAX_DRAFTS,
    list,
    save,
    remove,
    clear,
    profile: profileId,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.posDrafts;
})(typeof window !== 'undefined' ? window : globalThis);
