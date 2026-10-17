(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class CategoriesService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all categories.
     * @returns {Promise<Array>} All category records. */
    async list() {
      return this.repo.list('categories');
    }

    /** Fetches a single category by id.
     * @param {string} id Category id.
     * @returns {Promise<Object|undefined>} Category record or undefined. */
    async get(id) {
      return this.repo.get('categories', id);
    }

    /** Creates a category with defaults.
     * @param {Object} data Category fields (name, active).
     * @returns {Promise<Object>} Created category record. */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const cat = {
          id: BeeStore.ids.randomId('cat'),
          name: data.name,
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('categories', cat);
        return cat;
      });
    }

    /** Updates a category by merging the patch.
     * @param {string} id Category id. @param {Object} patch Fields to update.
     * @returns {Promise<Object>} Updated record. @throws {BeeError} NOT_FOUND if missing. */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const cat = await tx.get('categories', id);
        if (!cat) throw BeeStore.errors.err('NOT_FOUND', 'التصنيف غير موجود');
        const updated = { ...cat, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('categories', updated);
        return updated;
      });
    }

    /** Soft-deactivates a category if no products use it.
     * @param {string} id Category id.
     * @returns {Promise<Object>} Deactivated record. @throws {BeeError} NOT_FOUND/IN_USE on missing/used. */
    async remove(id) {
      // Soft-deactivate only (spec §4 rule 6): the record stays so history
      // never dangles.
      return this.repo.transaction(async (tx) => {
        const cat = await tx.get('categories', id);
        if (!cat) throw BeeStore.errors.err('NOT_FOUND', 'التصنيف غير موجود');
        const products = await tx.list('products', p => p.categoryId === id);
        if (products.length > 0) {
          throw BeeStore.errors.err('IN_USE', 'لا يمكن حذف التصنيف لأنه مستخدم في منتجات');
        }
        cat.active = false;
        cat.updatedAt = BeeStore.dates.now();
        tx.put('categories', cat);
        return cat;
      });
    }
  }

  BeeStore.categories = new CategoriesService(null);
  BeeStore.CategoriesService = CategoriesService;
  if (typeof module !== 'undefined') module.exports = CategoriesService;
})(typeof window !== 'undefined' ? window : globalThis);
