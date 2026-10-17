(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

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
        const product = {
          id: BeeStore.ids.randomId('prd'),
          name: data.name,
          categoryId: data.categoryId || null,
          brand: data.brand || '',
          gender: data.gender || 'unisex',
          description: data.description || '',
          defaultCostMinor: BeeStore.money.roundMinor(data.defaultCostMinor || 0),
          defaultPriceMinor: BeeStore.money.roundMinor(data.defaultPriceMinor || 0),
          active: data.active !== false,
          imageDataUri: data.imageDataUri || null,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('products', product);

        if (data.variants && data.variants.length > 0) {
          for (const v of data.variants) {
            const variant = {
              id: BeeStore.ids.randomId('var'),
              productId: product.id,
              size: v.size,
              color: v.color,
              sku: v.sku || this._genSku(product, v),
              barcode: v.barcode || BeeStore.ids.nextBarcode(),
              costMinor: BeeStore.money.roundMinor(v.costMinor || product.defaultCostMinor),
              priceMinor: BeeStore.money.roundMinor(v.priceMinor || product.defaultPriceMinor),
              quantity: 0,
              lowStockThreshold: v.lowStockThreshold || null,
              active: true,
              createdAt: BeeStore.dates.now(),
              updatedAt: BeeStore.dates.now(),
            };
            if (variant.priceMinor <= 0) {
              throw BeeStore.errors.err('INVALID', 'سعر البيع مطلوب - أدخل سعراً أكبر من صفر');
            }
            tx.put('variants', variant);
            if (v.quantity > 0) {
            tx.put('stockMovements', {
              id: BeeStore.ids.randomId('stm'),
              variantId: variant.id,
              date: data.date || BeeStore.dates.today(),
              type: 'opening',
              qtyChange: v.quantity,
              unitCostMinor: variant.costMinor,
              avgCostAfterMinor: variant.costMinor,
              refType: 'opening',
                refId: null,
                note: 'مخزون افتتاحي',
                balanceAfter: v.quantity,
                createdAt: BeeStore.dates.now(),
              });
              variant.quantity = v.quantity;
              tx.put('variants', variant);
            }
          }
        }
        return product;
      });
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
        const updated = { ...p, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('products', updated);
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
      const q = (query || '').toLowerCase().trim();
      if (!q) return this.list();
      const products = await this.repo.list('products');
      const variants = await this.repo.list('variants');
      const matchedProductIds = new Set();
      for (const p of products) {
        if (p.name.toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q)) {
          matchedProductIds.add(p.id);
        }
      }
      for (const v of variants) {
        if (v.barcode === q || (v.sku || '').toLowerCase().includes(q)) {
          matchedProductIds.add(v.productId);
        }
      }
      return products.filter(p => matchedProductIds.has(p.id));
    }
  }

  BeeStore.products = new ProductsService(null);
  BeeStore.ProductsService = ProductsService;
  if (typeof module !== 'undefined') module.exports = ProductsService;
})(typeof window !== 'undefined' ? window : globalThis);
