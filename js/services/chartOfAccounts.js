(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  if (!BeeStore.chartSeed && typeof require !== 'undefined') require('../core/chartSeed.js');

  function sortByCode(a, b) {
    const na = Number(a.code), nb = Number(b.code);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.code || '').localeCompare(String(b.code || ''));
  }

  class ChartOfAccountsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * Idempotently seeds the v5 chart and links legacy money/expense records.
     * Safe to call on every startup and before the first posting.
     * @returns {Promise<object>} applied plan
     */
    async ensureSeeded() {
      return this.repo.transaction(tx => this.ensureSeededTx(tx));
    }

    /**
     * Transaction-scoped variant used by posting code and first-run setup.
     * @param {object} tx active repository transaction
     * @param {object} [options] {taxPayable} create 2300 when tax is needed
     * @returns {Promise<object>} applied plan
     */
    async ensureSeededTx(tx, options) {
      options = options || {};
      const chart = await tx.list('chartOfAccounts');
      const accounts = await tx.list('accounts');
      const categories = await tx.list('expenseCategories');
      const settings = await tx.get('meta', 'settings');
      const now = BeeStore.dates.now();
      const taxPayable = options.taxPayable === true ||
        !!(settings && settings.taxEnabled) ||
        chart.some(a => a && (a.systemKey === 'tax_payable' ||
          String(a.code) === BeeStore.chartSeed.TAX_ACCOUNT.code));

      const result = BeeStore.chartSeed.plan({
        chart,
        accounts,
        categories,
        settings,
        fixedAssetsEnabled: !!(settings && settings.fixedAssetsEnabled),
        taxPayable,
        now,
      });

      for (const account of result.accounts) {
        tx.put('chartOfAccounts', account);
      }
      for (const update of result.chartUpdates) {
        const existing = chart.find(a => a.id === update.id);
        if (existing) {
          tx.put('chartOfAccounts', {
            ...existing,
            ...update.patch,
            id: existing.id,
            updatedAt: now,
          });
        }
      }
      const accountsById = new Map(accounts.map(a => [a.id, a]));
      for (const link of result.accountLinks) {
        const account = accountsById.get(link.accountId);
        if (account) {
          tx.put('accounts', { ...account, chartAccountId: link.chartAccountId, updatedAt: now });
        }
      }
      const categoriesById = new Map(categories.map(c => [c.id, c]));
      for (const link of result.categoryLinks) {
        const category = categoriesById.get(link.categoryId);
        if (category) {
          tx.put('expenseCategories', {
            ...category,
            chartAccountId: link.chartAccountId,
            code: link.code,
            updatedAt: now,
          });
        }
      }
      if (result.settingsPatch && settings) {
        tx.put('meta', { ...settings, ...result.settingsPatch, id: 'settings' });
      }
      return result;
    }

    /**
     * @param {object} [options] {activeOnly}
     * @returns {Promise<object[]>} chart sorted by code
     */
    async list(options) {
      let rows = await this.repo.list('chartOfAccounts');
      if (rows.length === 0) {
        await this.ensureSeeded();
        rows = await this.repo.list('chartOfAccounts');
      }
      if (options && options.activeOnly) rows = rows.filter(a => a.active !== false);
      rows.sort(sortByCode);
      return rows;
    }

    /** @param {string} id chart account id */
    async get(id) {
      return this.repo.get('chartOfAccounts', id);
    }

    /** @param {string} code account code such as '1010' */
    async byCode(code) {
      const rows = await this.repo.query('chartOfAccounts', 'code', String(code));
      return rows[0] || null;
    }

    /** @param {string} systemKey stable system account key */
    async bySystemKey(systemKey) {
      const rows = await this.repo.query('chartOfAccounts', 'systemKey', systemKey);
      return rows[0] || null;
    }

    /**
     * Owner-created accounts are expense accounts only (v5 §2). Bank/wallet
     * accounts are created through the legacy money-account flow so their
     * balances and payment methods stay in one place.
     * @param {object} data {nameAr, code?, parentCode?}
     * @returns {Promise<object>} created chart account
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        await this.ensureSeededTx(tx);
        const chart = await tx.list('chartOfAccounts');
        const nameAr = String((data && data.nameAr) || '').trim();
        if (!nameAr) throw BeeStore.errors.err('VALIDATION', 'اسم الحساب مطلوب');
        const type = (data && data.type) || 'expense';
        if (type !== 'expense') {
          throw BeeStore.errors.err('VALIDATION',
            'يمكن إضافة حسابات مصروفات فقط؛ حسابات البنوك والمحافظ تُضاف من شاشة الحسابات');
        }
        if (chart.some(a => a.type === 'expense' && a.active !== false && a.nameAr === nameAr)) {
          throw BeeStore.errors.err('DUPLICATE', 'يوجد حساب مصروف بنفس الاسم');
        }
        let code = data && data.code ? String(data.code) : '';
        const used = new Set(chart.map(a => String(a.code)));
        if (code) {
          if (!/^6\d{3}$/.test(code)) {
            throw BeeStore.errors.err('VALIDATION', 'كود حساب المصروف يجب أن يكون 6xxx');
          }
          if (used.has(code)) {
            throw BeeStore.errors.err('DUPLICATE', 'كود الحساب مستخدم مسبقاً');
          }
        } else {
          code = BeeStore.chartSeed.nextExpenseCode(used);
        }
        const now = BeeStore.dates.now();
        const account = {
          id: BeeStore.ids.randomId('coa'),
          code,
          nameAr,
          type: 'expense',
          normalSide: 'debit',
          system: false,
          active: true,
          parentCode: (data && data.parentCode) || null,
          contra: false,
          createdAt: now,
          updatedAt: now,
        };
        tx.put('chartOfAccounts', account);
        return account;
      });
    }

    /**
     * Renames/deactivates owner-created accounts. System accounts are
     * immutable because posting rules refer to their codes.
     * @param {string} id chart account id
     * @param {object} patch {nameAr?, active?}
     * @returns {Promise<object>} updated account
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const account = await tx.get('chartOfAccounts', id);
        if (!account) throw BeeStore.errors.err('NOT_FOUND', 'الحساب المحاسبي غير موجود');
        if (account.system) {
          throw BeeStore.errors.err('PERMISSION',
            'حساب نظامي — لا يمكن تعديله أو حذفه. أنشئ حساباً فرعياً إن لزم');
        }
        const allowed = ['nameAr', 'active'];
        for (const key of Object.keys(patch || {})) {
          if (allowed.indexOf(key) < 0) {
            throw BeeStore.errors.err('VALIDATION', 'لا يمكن تعديل ' + key + ' في حساب محاسبي');
          }
        }
        const updated = { ...account, ...patch, id, updatedAt: BeeStore.dates.now() };
        if (patch && patch.nameAr !== undefined) {
          const nameAr = String(patch.nameAr || '').trim();
          if (!nameAr) throw BeeStore.errors.err('VALIDATION', 'اسم الحساب مطلوب');
          const others = await tx.list('chartOfAccounts',
            a => a.id !== id && a.type === updated.type && a.active !== false && a.nameAr === nameAr);
          if (others.length) throw BeeStore.errors.err('DUPLICATE', 'يوجد حساب بنفس الاسم');
          updated.nameAr = nameAr;
        }
        if (patch && patch.active !== undefined) updated.active = patch.active !== false;
        tx.put('chartOfAccounts', updated);
        if (account.legacyAccountId && patch && patch.nameAr !== undefined) {
          const legacy = await tx.get('accounts', account.legacyAccountId);
          if (legacy) {
            tx.put('accounts', { ...legacy, name: updated.nameAr, updatedAt: BeeStore.dates.now() });
          }
        }
        return updated;
      });
    }

    /** Non-system accounts can be deactivated but never deleted. */
    async deactivate(id) {
      return this.update(id, { active: false });
    }

    /** Hard deletion is forbidden: journal history must keep its accounts. */
    async remove() {
      throw BeeStore.errors.err('VALIDATION',
        'لا يمكن حذف حساب محاسبي — يمكن تعطيله فقط حفاظاً على دفتر اليومية');
    }
  }

  BeeStore.chart = new ChartOfAccountsService(null);
  BeeStore.ChartOfAccountsService = ChartOfAccountsService;
  if (typeof module !== 'undefined') module.exports = ChartOfAccountsService;
})(typeof window !== 'undefined' ? window : globalThis);
