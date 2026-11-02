(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v4 R1/R3: matching ignores Arabic diacritics and letter variants. M2 will
  // move this into the shared item-search engine; keeping it here now lets
  // item codes and Arabic names be found consistently from every caller.
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

  function searchKeyFor(product, variant) {
    const p = product || {};
    const v = variant || {};
    return normalizeSearch([
      p.name, p.brand, p.itemCode, p.notes, p.unit,
      v.size, v.color, v.itemCode, v.barcode, v.sku,
    ].filter(Boolean).join(' '));
  }

  class ProductsService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all products.
     * @returns {Promise<Array>} all products
     */
    async list() {
      return this.repo.list('products');
    }

    /** Fetches one product by id.
     * @param {string} id product id
     * @returns {Promise<Object|null>} product or null
     */
    async get(id) {
      return this.repo.get('products', id);
    }

    /** Fetches a product with its variants.
     * @param {string} id product id
     * @returns {Promise<Object|null>} product plus variants
     */
    async getWithVariants(id) {
      const product = await this.repo.get('products', id);
      if (!product) return null;
      const variants = await this.repo.list('variants', v => v.productId === id);
      return { ...product, variants };
    }

    /** Creates a product with variants and opening stock movements.
     * @param {Object} data product fields incl. variants
     * @returns {Promise<Object>} created product
     * @throws {BeeError} INVALID|PERIOD_CLOSED on bad price or closed date
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        if (!String(data.name || '').trim()) {
          throw BeeStore.errors.err('INVALID', 'اسم المنتج مطلوب');
        }
        if (data.defaultCostMinor != null && BeeStore.money.roundMinor(data.defaultCostMinor) <= 0) {
          throw BeeStore.errors.err('INVALID', 'سعر التكلفة الافتراضي مطلوب - أدخل قيمة أكبر من صفر');
        }
        if (data.defaultPriceMinor != null && BeeStore.money.roundMinor(data.defaultPriceMinor) <= 0) {
          throw BeeStore.errors.err('INVALID', 'سعر البيع الافتراضي مطلوب - أدخل سعراً أكبر من صفر');
        }

        // v4 R1/R4: every item has a human item code (1001, 1002, ...) that is
        // independent from the optional barcode. Explicit codes are honoured
        // and advance the sequence so future quick adds never collide.
        const requestedCode = String(data.itemCode == null ? '' : data.itemCode).trim();
        let itemCode;
        if (requestedCode) {
          itemCode = await this._assertItemCodeFree(tx, requestedCode, null);
          const numeric = Number(itemCode);
          if (Number.isInteger(numeric) && numeric >= 1001) {
            await tx.setCounter('itemCode', numeric - 1000);
          }
        } else {
          itemCode = String(1000 + await tx.nextCounter('itemCode'));
        }

        const productVariants = Array.isArray(data.variants) ? data.variants : [];
        const hasSizedVariants = productVariants.some(v => (v.size || '').trim() || (v.color || '').trim());
        const hasVariants = data.hasVariants != null
          ? data.hasVariants === true
          : (productVariants.length > 1 || hasSizedVariants);

        const product = {
          id: BeeStore.ids.randomId('prd'),
          name: String(data.name).trim(),
          itemCode,
          categoryId: data.categoryId || null,
          brand: data.brand || '',
          unit: String(data.unit || 'قطعة').trim() || 'قطعة',
          notes: data.notes || '',
          gender: data.gender || 'unisex',
          description: data.description || '',
          defaultCostMinor: BeeStore.money.roundMinor(data.defaultCostMinor || 0),
          defaultPriceMinor: BeeStore.money.roundMinor(data.defaultPriceMinor || 0),
          lowStockThreshold: data.lowStockThreshold != null ? Number(data.lowStockThreshold) : null,
          hasVariants,
          active: data.active !== false,
          imageDataUri: data.imageDataUri || null,
          searchKey: '',
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        product.searchKey = searchKeyFor(product, null);
        tx.put('products', product);

        if (productVariants.length > 0) {
          const openingDate = data.date || BeeStore.dates.today();
          const openingDocs = [];
          let openingValueMinor = 0;
          const seenCodes = new Set();
          for (let index = 0; index < productVariants.length; index++) {
            const v = productVariants[index];
            const size = String(v.size || '').trim();
            const color = String(v.color || '').trim();
            if (hasVariants && !size && !color) {
              throw BeeStore.errors.err('INVALID', 'حدد المقاس أو اللون لكل صنف');
            }
            const costMinor = BeeStore.money.roundMinor(
              v.costMinor != null ? v.costMinor : product.defaultCostMinor);
            let variantCode = String(v.itemCode || '').trim();
            if (!variantCode) {
              variantCode = productVariants.length === 1 && !size && !color
                ? product.itemCode
                : product.itemCode + '-' + (index + 1);
            }
            if (seenCodes.has(variantCode)) {
              throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + variantCode);
            }
            if (variantCode === product.itemCode) {
              const siblingClash = await tx.list('variants', x => x.itemCode === variantCode);
              if (siblingClash.length > 0) {
                throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + variantCode);
              }
            } else {
              await this._assertItemCodeFree(tx, variantCode, null);
            }
            seenCodes.add(variantCode);
            const barcode = String(v.barcode || '').trim() || BeeStore.ids.nextBarcode();
            const barcodeClash = await tx.list('variants', x => x.barcode === barcode);
            if (barcodeClash.length > 0) {
              throw BeeStore.errors.err('DUPLICATE', 'الباركود مستخدم مسبقاً');
            }
            const variant = {
              id: BeeStore.ids.randomId('var'),
              productId: product.id,
              itemCode: variantCode,
              size,
              color,
              unit: product.unit,
              sku: v.sku || variantCode,
              barcode,
              costMinor,
              priceMinor: BeeStore.money.roundMinor(
                v.priceMinor != null ? v.priceMinor : product.defaultPriceMinor),
              quantity: 0,
              valueMinor: 0,
              lowStockThreshold: v.lowStockThreshold != null
                ? Number(v.lowStockThreshold)
                : product.lowStockThreshold,
              searchKey: '',
              active: true,
              journalEntryIds: [],
              createdAt: BeeStore.dates.now(),
              updatedAt: BeeStore.dates.now(),
            };
            variant.searchKey = searchKeyFor(product, variant);
            if (variant.priceMinor <= 0) {
              throw BeeStore.errors.err('INVALID', 'سعر البيع مطلوب - أدخل سعراً أكبر من صفر');
            }
            tx.put('variants', variant);
            const qty = Number(v.quantity) || 0;
            if (qty > 0) {
              variant.quantity = qty;
              variant.valueMinor = qty * costMinor;
              const movement = {
                id: BeeStore.ids.randomId('stm'),
                variantId: variant.id,
                date: openingDate,
                type: 'opening',
                qtyChange: qty,
                unitCostMinor: costMinor,
                valueChangeMinor: variant.valueMinor,
                valueAfterMinor: variant.valueMinor,
                avgCostAfterMinor: costMinor,
                refType: 'opening',
                refId: null,
                note: 'مخزون افتتاحي',
                balanceAfter: qty,
                journalEntryIds: [],
                createdAt: BeeStore.dates.now(),
              };
              tx.put('stockMovements', movement);
              openingDocs.push(variant, movement);
              openingValueMinor += variant.valueMinor;
            }
            tx.put('variants', variant);
          }
          if (BeeStore.posting && openingValueMinor > 0) {
            const entry = await BeeStore.posting.openingStock(tx, {
              date: openingDate,
              sourceId: product.id,
              description: 'مخزون افتتاحي ' + product.name,
              valueMinor: openingValueMinor,
            });
            if (entry) {
              BeeStore.posting.linkAll([product].concat(openingDocs), entry);
              tx.put('products', product);
              for (const doc of openingDocs) {
                tx.put(doc.variantId ? 'stockMovements' : 'variants', doc);
              }
            }
          }
        }
        return product;
      });
    }

    /** Checks that an item code is not used by a product or a variant.
     * @param {object} tx active transaction
     * @param {string} code candidate item code
     * @param {string|null} excludeId current document id
     * @returns {Promise<string>} the trimmed code
     * @throws {BeeError} DUPLICATE
     */
    async _assertItemCodeFree(tx, code, excludeId) {
      const clean = String(code || '').trim();
      if (!clean) throw BeeStore.errors.err('INVALID', 'رمز الصنف مطلوب');
      const products = await tx.list('products', p => p.itemCode === clean && p.id !== excludeId);
      if (products.length > 0) {
        throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + clean);
      }
      // A default variant may share its parent item's code; variants belonging
      // to this product are therefore excluded when validating the parent.
      const variants = await tx.list('variants', v =>
        v.itemCode === clean && v.id !== excludeId &&
        (!excludeId || v.productId !== excludeId));
      if (variants.length > 0) {
        throw BeeStore.errors.err('DUPLICATE', 'رمز الصنف مستخدم مسبقاً: ' + clean);
      }
      return clean;
    }

    /** Returns the next automatic item code (1001, 1002, ...).
     * @returns {Promise<string>} next item code
     */
    async nextItemCode() {
      const meta = await this.repo.get('meta', 'meta') || {};
      const used = Number(meta.counters && meta.counters.itemCode) || 0;
      return String(1000 + used + 1);
    }

    /**
     * v4 R1 Quick Add: one compact form creates an item plus its single
     * default variant (no size/colour) and optional opening stock.
     * @param {object} data {name,itemCode?,barcode?,categoryId?,unit?,costMinor,priceMinor,openingQuantity,notes?}
     * @returns {Promise<{product:object,variant:object|null}>} created pair
     */
    async quickAdd(data) {
      const quantity = data.openingQuantity != null ? data.openingQuantity : data.quantity;
      const product = await this.create({
        name: data.name,
        itemCode: data.itemCode,
        categoryId: data.categoryId || null,
        brand: data.brand || '',
        unit: data.unit || 'قطعة',
        notes: data.notes || '',
        defaultCostMinor: data.costMinor,
        defaultPriceMinor: data.priceMinor,
        lowStockThreshold: data.lowStockThreshold,
        hasVariants: false,
        date: data.date,
        variants: [{
          size: '',
          color: '',
          barcode: data.barcode || '',
          costMinor: data.costMinor,
          priceMinor: data.priceMinor,
          quantity: Number(quantity) || 0,
        }],
      });
      const variants = await this.repo.list('variants', v => v.productId === product.id);
      const variant = variants.length > 0 ? variants[0] : null;
      if (variant) {
        product.defaultVariantId = variant.id;
        await this.repo.transaction(async (tx) => {
          const stored = await tx.get('products', product.id);
          if (stored) {
            stored.defaultVariantId = variant.id;
            tx.put('products', stored);
          }
        });
      }
      return { product, variant };
    }

    /** Expands a size×color grid into variants, then creates the product.
     * @param {Object} data {sizes,colors,grid,...productFields}
     * @returns {Promise<Object>} created product
     * @throws {BeeError} INVALID|PERIOD_CLOSED from create
     */
    async createWithGrid(data) {
      const variants = [];
      const sizes = data.sizes || [];
      const colors = data.colors || [];
      const grid = data.grid || {};
      for (const size of sizes) {
        for (const color of colors) {
          const key = size + '|' + color;
          const cell = grid[key] || {};
          if (cell.selected) {
            variants.push({
              size,
              color,
              quantity: cell.quantity || 0,
              costMinor: cell.costMinor !== undefined ? cell.costMinor : data.defaultCostMinor,
              priceMinor: cell.priceMinor !== undefined ? cell.priceMinor : data.defaultPriceMinor,
              lowStockThreshold: cell.lowStockThreshold || null,
            });
          }
        }
      }
      return this.create({ ...data, variants });
    }

    /** Updates a product.
     * @param {string} id product id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated product
     * @throws {BeeError} NOT_FOUND if missing
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const p = await tx.get('products', id);
        if (!p) throw BeeStore.errors.err('NOT_FOUND', 'المنتج غير موجود');
        const changes = { ...(patch || {}) };
        if (changes.itemCode !== undefined) {
          changes.itemCode = await this._assertItemCodeFree(tx, changes.itemCode, id);
        }
        if (changes.defaultPriceMinor !== undefined &&
          BeeStore.money.roundMinor(changes.defaultPriceMinor) <= 0) {
          throw BeeStore.errors.err('INVALID', 'سعر البيع الافتراضي مطلوب - أدخل سعراً أكبر من صفر');
        }
        const updated = { ...p, ...changes, id, updatedAt: BeeStore.dates.now() };
        updated.searchKey = searchKeyFor(updated, null);
        tx.put('products', updated);
        // Keep variant refinements aligned without touching their accounting
        // fields: a renamed/re-coded parent updates the search key, a default
        // variant follows its parent's code and item-level unit/threshold.
        const variants = await tx.list('variants', v => v.productId === id);
        for (const variant of variants) {
          if (changes.itemCode !== undefined && variant.itemCode === p.itemCode &&
            variants.length === 1 && !variant.size && !variant.color) {
            variant.itemCode = updated.itemCode;
          }
          if (changes.unit !== undefined) variant.unit = updated.unit;
          if (changes.lowStockThreshold !== undefined) {
            variant.lowStockThreshold = updated.lowStockThreshold;
          }
          variant.searchKey = searchKeyFor(updated, variant);
          tx.put('variants', variant);
        }
        return updated;
      });
    }

    /** Soft-deactivates a product (sets active false).
     * @param {string} id product id
     * @returns {Promise<Object>} updated product
     * @throws {BeeError} NOT_FOUND if missing
     */
    async deactivate(id) {
      return this.update(id, { active: false });
    }

    _genSku(product, v) {
      const prefix = (product.name || '').slice(0, 3).toUpperCase();
      const size = (v.size || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      const color = (v.color || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
      return prefix + '-' + size + '-' + color + '-' + rand;
    }

    /** Searches products by name, brand, barcode, or SKU.
     * @param {string} query search text
     * @returns {Promise<Array>} matching products
     */
    async searchProducts(query) {
      const q = normalizeSearch(query);
      if (!q) return this.list();
      const products = await this.repo.list('products');
      const variants = await this.repo.list('variants');
      const matchedProductIds = new Set();
      for (const p of products) {
        const hay = normalizeSearch([
          p.name, p.brand, p.itemCode, p.notes, p.unit, p.searchKey,
        ].filter(Boolean).join(' '));
        if (hay.includes(q)) matchedProductIds.add(p.id);
      }
      for (const v of variants) {
        const hay = normalizeSearch([
          v.barcode, v.sku, v.itemCode, v.searchKey,
        ].filter(Boolean).join(' '));
        if (hay.includes(q)) matchedProductIds.add(v.productId);
      }
      // Exact item/barcode hits first, then name matches.
      return products.filter(p => matchedProductIds.has(p.id)).sort((a, b) => {
        const ae = normalizeSearch(a.itemCode) === q ? 0 : 1;
        const be = normalizeSearch(b.itemCode) === q ? 0 : 1;
        return ae - be || String(a.name).localeCompare(String(b.name));
      });
    }
  }

  BeeStore.products = new ProductsService(null);
  BeeStore.ProductsService = ProductsService;
  if (typeof module !== 'undefined') module.exports = ProductsService;
})(typeof window !== 'undefined' ? window : globalThis);
