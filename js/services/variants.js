(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function normalizeSearch(value) {
    return String(value == null ? '' : value)
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .replace(/\u0629/g, '\u0647')
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  class VariantsService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all variants.
     * @returns {Promise<Array>} all variants
     */
    async list() {
      return this.repo.list('variants');
    }

    /** Fetches one variant by id.
     * @param {string} id variant id
     * @returns {Promise<Object|null>} variant or null
     */
    async get(id) {
      return this.repo.get('variants', id);
    }

    /** Searches variants by barcode, SKU, or product name.
     * @param {string} query search text
     * @returns {Promise<Array>} matching variants
     */
    async search(query) {
      const raw = String(query || '').trim();
      if (!raw) return this.list();
      const q = normalizeSearch(raw);
      const variants = await this.repo.list('variants');
      const products = await this.repo.list('products');
      const productMap = {};
      // Normalising the product's text once per product instead of once per
      // variant keeps search near O(variants) with short strings even at the
      // 5,000-variant scale (the V2 budget is < 100 ms).
      const productText = new Map();
      for (const p of products) {
        productMap[p.id] = p;
        productText.set(p.id, {
          hay: p.searchKey || normalizeSearch([
            p.name, p.brand, p.itemCode, p.notes, p.unit,
          ].filter(Boolean).join(' ')),
          name: normalizeSearch(p.name || ''),
        });
      }
      const words = q.split(' ').filter(Boolean);
      const scored = [];
      for (const v of variants) {
        const p = productMap[v.productId];
        if (!p || p.active === false || v.active === false) continue;
        const code = normalizeSearch(v.itemCode || v.sku || '');
        const barcode = normalizeSearch(v.barcode || '');
        let score = -1;
        if (barcode && barcode === q) score = 0;
        else if (code && code === q) score = 1;
        else if (barcode && barcode.endsWith(q) && q.length >= 4) score = 2;
        else if (code && code.startsWith(q)) score = 3;
        else if (words.length > 0) {
          const meta = productText.get(v.productId);
          const own = v.searchKey || normalizeSearch([
            v.size, v.color, v.itemCode, v.barcode, v.sku,
          ].filter(Boolean).join(' '));
          const hay = meta && meta.hay ? own + ' ' + meta.hay : own;
          if (words.every(w => hay.includes(w))) {
            score = meta && meta.name.startsWith(q) ? 4 : 5;
          }
        }
        if (score >= 0) scored.push({ variant: v, score });
      }
      scored.sort((a, b) => a.score - b.score ||
        String(a.variant.itemCode || '').localeCompare(String(b.variant.itemCode || '')));
      return scored.map(x => {
        const p = productMap[x.variant.productId];
        return { ...x.variant, productName: p ? p.name : '', productItemCode: p ? p.itemCode || '' : '' };
      });
    }

    /** Finds a variant by exact barcode via index.
     * @param {string} barcode barcode value
     * @returns {Promise<Object|null>} variant or null
     */
    async byBarcode(barcode) {
      const results = await this.repo.query('variants', 'barcode', barcode);
      return results.length > 0 ? results[0] : null;
    }

    /** Creates a variant with uniqueness checks plus opening movement.
     * @param {Object} data variant fields incl. productId
     * @returns {Promise<Object>} created variant
     * @throws {BeeError} NOT_FOUND|INVALID|DUPLICATE|PERIOD_CLOSED
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const product = await tx.get('products', data.productId);
        if (!product) throw BeeStore.errors.err('NOT_FOUND', 'المنتج غير موجود');
        const size = (data.size || '').trim();
        const color = (data.color || '').trim();
        // v4 R1: a default variant (no size/colour) is valid for an item whose
        // hasVariants switch is off. Legacy products keep the old requirement.
        if (!size && !color && product.hasVariants !== false) {
          throw BeeStore.errors.err('INVALID', 'حدد المقاس واللون');
        }

        const duplicates = await tx.list('variants', v =>
          v.productId === data.productId && v.size === size && v.color === color && v.active !== false
        );
        if (duplicates.length > 0) {
          throw BeeStore.errors.err('DUPLICATE', 'يوجد صنف بنفس المقاس واللون لهذا المنتج');
        }

        let barcode = (data.barcode || '').trim();
        if (barcode) {
          const existing = await tx.list('variants', v => v.barcode === barcode);
          if (existing.length > 0) throw BeeStore.errors.err('DUPLICATE', 'الباركود مستخدم مسبقاً');
        } else {
          barcode = BeeStore.ids.nextBarcode();
        }

        const quantity = Number(data.quantity) || 0;
        if (data.quantity != null && !(Number.isInteger(quantity) && quantity > 0)) {
          throw BeeStore.errors.err('INVALID', 'الكمية الافتتاحية مطلوبة ويجب أن تكون أكبر من صفر');
        }
        let itemCode = String(data.itemCode || '').trim();
        if (!itemCode) {
          const siblings = await tx.list('variants', v => v.productId === data.productId);
          itemCode = (product.itemCode || '') +
            (siblings.length > 0 || size || color ? '-' + (siblings.length + 1) : '');
        }
        if (!itemCode) itemCode = String(1000 + await tx.nextCounter('itemCode'));
        const codeClash = await tx.list('variants', v => v.itemCode === itemCode);
        // The default variant may deliberately reuse its parent item's code.
        const productClash = await tx.list('products', p =>
          p.itemCode === itemCode && p.id !== product.id);
        if (codeClash.length > 0 || productClash.length > 0) {
          throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + itemCode);
        }
        const variant = {
          id: BeeStore.ids.randomId('var'),
          productId: data.productId,
          itemCode,
          size,
          color,
          unit: data.unit || product.unit || 'قطعة',
          sku: data.sku || itemCode,
          barcode,
          costMinor: BeeStore.money.roundMinor(data.costMinor != null ? data.costMinor : (product.defaultCostMinor || 0)),
          priceMinor: BeeStore.money.roundMinor(data.priceMinor != null ? data.priceMinor : (product.defaultPriceMinor || 0)),
          quantity,
          valueMinor: quantity * BeeStore.money.roundMinor(data.costMinor != null ? data.costMinor : (product.defaultCostMinor || 0)),
          lowStockThreshold: data.lowStockThreshold != null
            ? Number(data.lowStockThreshold) : (product.lowStockThreshold || null),
          searchKey: '',
          active: true,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        variant.searchKey = normalizeSearch([
          product.name, product.brand, product.itemCode, product.notes,
          variant.itemCode, variant.barcode, variant.sku, size, color,
        ].filter(Boolean).join(' '));
        if (variant.priceMinor <= 0) {
          throw BeeStore.errors.err('INVALID', 'سعر البيع مطلوب - أدخل سعراً أكبر من صفر');
        }
        tx.put('variants', variant);

        if (quantity !== 0) {
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: variant.id,
            date: data.date || BeeStore.dates.today(),
            type: 'opening',
            qtyChange: quantity,
            unitCostMinor: variant.costMinor,
            valueChangeMinor: variant.valueMinor,
            valueAfterMinor: variant.valueMinor,
            avgCostAfterMinor: variant.costMinor,
            refType: 'opening',
            refId: null,
            note: 'مخزون افتتاحي',
            balanceAfter: quantity,
            journalEntryIds: [],
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          if (BeeStore.posting) {
            const entry = await BeeStore.posting.openingStock(tx, {
              date: movement.date,
              sourceId: variant.id,
              description: 'مخزون افتتاحي ' + (product.name || '') + ' ' + size + ' ' + color,
              valueMinor: variant.valueMinor,
            });
            if (entry) {
              BeeStore.posting.linkAll([variant, movement], entry);
              tx.put('variants', variant);
              tx.put('stockMovements', movement);
            }
          }
        }
        return variant;
      });
    }

    _genSku(product, v) {
      const prefix = (product.name || '').slice(0, 3).toUpperCase();
      const size = (v.size || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      const color = (v.color || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
      return prefix + '-' + size + '-' + color + '-' + rand;
    }

    /** Updates a variant; validates price and barcode uniqueness.
     * @param {string} id variant id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated variant
     * @throws {BeeError} NOT_FOUND|INVALID|DUPLICATE
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const v = await tx.get('variants', id);
        if (!v) throw BeeStore.errors.err('NOT_FOUND', 'الصنف غير موجود');
        const changes = { ...(patch || {}) };
        const revaluationDate = changes.date || BeeStore.dates.today();
        const revaluationReason = changes.revaluationReason || '';
        delete changes.date;
        delete changes.revaluationReason;
        if (changes.priceMinor !== undefined && BeeStore.money.roundMinor(changes.priceMinor) <= 0) {
          throw BeeStore.errors.err('INVALID', 'سعر البيع مطلوب - أدخل سعراً أكبر من صفر');
        }
        if (changes.costMinor !== undefined && BeeStore.money.roundMinor(changes.costMinor) < 0) {
          throw BeeStore.errors.err('INVALID', 'تكلفة الصنف لا يمكن أن تكون سالبة');
        }
        if (changes.barcode !== undefined) {
          const code = String(changes.barcode || '').trim();
          if (code) {
            const clash = await tx.list('variants', o => o.barcode === code && o.id !== id);
            if (clash.length > 0) throw BeeStore.errors.err('DUPLICATE', 'الباركود مستخدم مسبقاً');
          }
        }
        if (changes.itemCode !== undefined) {
          const code = String(changes.itemCode || '').trim();
          if (!code) throw BeeStore.errors.err('INVALID', 'رمز الصنف مطلوب');
          const clash = await tx.list('variants', o => o.itemCode === code && o.id !== id);
          const productClash = await tx.list('products', p =>
            p.itemCode === code && p.id !== v.productId);
          if (clash.length > 0 || productClash.length > 0) {
            throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + code);
          }
          changes.itemCode = code;
        }
        const updated = { ...v, ...changes, id, updatedAt: BeeStore.dates.now() };
        const product = await tx.get('products', v.productId);
        updated.searchKey = normalizeSearch([
          product && product.name, product && product.brand,
          product && product.itemCode, product && product.notes,
          updated.itemCode, updated.barcode, updated.sku,
          updated.size, updated.color,
        ].filter(Boolean).join(' '));
        const newCost = changes.costMinor !== undefined
          ? BeeStore.money.roundMinor(changes.costMinor)
          : Number(v.costMinor) || 0;
        if (changes.costMinor !== undefined && newCost !== (Number(v.costMinor) || 0)) {
          if (BeeStore.periods && BeeStore.periods.assertOpen) {
            await BeeStore.periods.assertOpen(tx, revaluationDate);
          }
          // v4 R1: a manual cost change revalues on-hand stock and posts the
          // difference between 1200 and 5030. Quantity is untouched.
          const change = BeeStore.stock.revalue(updated, newCost);
          updated.costMinor = newCost;
          tx.put('variants', updated);
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: id,
            date: revaluationDate,
            type: 'revaluation',
            qtyChange: 0,
            unitCostMinor: 0,
            valueChangeMinor: change.valueChangeMinor,
            valueAfterMinor: change.valueAfterMinor,
            avgCostAfterMinor: change.avgCostAfterMinor,
            refType: 'revaluation',
            refId: id,
            note: revaluationReason || 'تعديل تكلفة يدوي',
            balanceAfter: updated.quantity,
            journalEntryIds: [],
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          if (BeeStore.posting) {
            const entry = await BeeStore.posting.revaluation(
              tx, movement, change.valueChangeMinor);
            if (entry) {
              BeeStore.posting.linkAll([updated, movement], entry);
              tx.put('stockMovements', movement);
            }
          }
          tx.put('variants', updated);
          return updated;
        }
        tx.put('variants', updated);
        return updated;
      });
    }

    /** Lists active low-stock variants enriched with product names.
     * @param {number} threshold fallback threshold
     * @returns {Promise<Array>} low-stock variants
     */
    async getLowStock(threshold) {
      const variants = await this.repo.list('variants', v => v.active !== false);
      const products = await this.repo.list('products');
      const productMap = {};
      for (const p of products) productMap[p.id] = p;
      return variants.filter(v => {
        const t = v.lowStockThreshold || threshold;
        return v.quantity <= t;
      }).map(v => ({
        ...v,
        productName: productMap[v.productId] ? productMap[v.productId].name : '',
      }));
    }
  }

  BeeStore.variants = new VariantsService(null);
  BeeStore.VariantsService = VariantsService;
  if (typeof module !== 'undefined') module.exports = VariantsService;
})(typeof window !== 'undefined' ? window : globalThis);
