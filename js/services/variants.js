(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

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
      const q = (query || '').toLowerCase().trim();
      if (!q) return this.list();
      const variants = await this.repo.list('variants');
      const products = await this.repo.list('products');
      const productMap = {};
      for (const p of products) productMap[p.id] = p;
      return variants.filter(v => {
        const p = productMap[v.productId];
        return v.barcode === q ||
          (v.sku || '').toLowerCase().includes(q) ||
          (p && p.name.toLowerCase().includes(q));
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
        if (!size && !color) throw BeeStore.errors.err('INVALID', 'حدد المقاس واللون');

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
        const variant = {
          id: BeeStore.ids.randomId('var'),
          productId: data.productId,
          size,
          color,
          sku: data.sku || this._genSku(product, { size, color }),
          barcode,
          costMinor: BeeStore.money.roundMinor(data.costMinor != null ? data.costMinor : (product.defaultCostMinor || 0)),
          priceMinor: BeeStore.money.roundMinor(data.priceMinor != null ? data.priceMinor : (product.defaultPriceMinor || 0)),
          quantity,
          valueMinor: quantity * BeeStore.money.roundMinor(data.costMinor != null ? data.costMinor : (product.defaultCostMinor || 0)),
          lowStockThreshold: data.lowStockThreshold || null,
          active: true,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
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
        const updated = { ...v, ...changes, id, updatedAt: BeeStore.dates.now() };
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
