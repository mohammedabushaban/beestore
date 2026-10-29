(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const DEFAULT_CATEGORIES = [
    'إيجار', 'كهرباء', 'ماء', 'إنترنت وهاتف', 'مواصلات',
    'تسويق وإعلان', 'تغليف وأكياس', 'صيانة', 'ضرائب ورسوم', 'مصاريف أخرى',
  ];

  // v2 §6.4: these names are reserved for their own flows (never expense cats).
  const RESERVED_CATEGORY_NAMES = [
    'رواتب', 'راتب', 'الرواتب', 'مشتريات', 'مخزون', 'المخزون',
    'سلفة', 'سلف', 'السلف', 'رأس مال', 'راس المال', 'مسحوبات', 'سحب شخصي', 'سحب',
  ];

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  class ExpensesService {
    constructor(repo) {
      this.repo = repo;
    }

    // Pure: monthly profit shares of an expense (v2 §6.3). Spread shares sum
    // exactly to the total; the last month absorbs the rounding remainder.
    spreadShares(expense) {
      const alloc = expense.allocation || { mode: 'single' };
      if (alloc.mode !== 'spread') {
        return [{ month: expense.month || String(expense.date).slice(0, 7), amountMinor: expense.amountMinor }];
      }
      const n = alloc.months;
      const out = [];
      const base = Math.floor(expense.amountMinor / n);
      let assigned = 0;
      for (let i = 0; i < n; i++) {
        const month = BeeStore.dates.addMonths(alloc.startMonth, i);
        const amountMinor = i === n - 1 ? expense.amountMinor - assigned : base;
        assigned += amountMinor;
        out.push({ month, amountMinor });
      }
      return out;
    }

    spreadMonths(expense) {
      return this.spreadShares(expense).map(s => s.month);
    }

    /** Prepaid spread remainder as of date (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{total:number,byCategory:Object}>} unallocated future-month shares
     */
    // v2 §8: unallocated remainder of spread expenses paid ≤ date whose
    // months fall after the date's month (a prepaid asset).
    async prepaidAsOf(date) {
      const dm = String(date).slice(0, 7);
      const all = await this.repo.list('expenses',
        e => !e.voided && (e.allocation || {}).mode === 'spread' && e.date <= date);
      let total = 0;
      const byCategory = {};
      for (const e of all) {
        const key = e.categoryName || 'أخرى';
        for (const s of this.spreadShares(e)) {
          if (s.month > dm) {
            total += s.amountMinor;
            byCategory[key] = (byCategory[key] || 0) + s.amountMinor;
          }
        }
      }
      return { total, byCategory };
    }

    /** Lists expense categories.
     * @returns {Promise<Array>} all expense categories
     */
    async getCategories() {
      return this.repo.list('expenseCategories');
    }

    /** Creates an expense category (rejects reserved v2 §6.4 names).
     * @param {Object} data {name, active}
     * @returns {Promise<Object>} created category
     * @throws {BeeError} VALIDATION on empty/reserved name
     */
    async createCategory(data) {
      return this.repo.transaction(async (tx) => {
        const name = String((data && data.name) || '').trim();
        if (!name) throw BeeStore.errors.err('VALIDATION', 'اسم التصنيف مطلوب');
        if (RESERVED_CATEGORY_NAMES.includes(name)) {
          throw BeeStore.errors.err('VALIDATION',
            '«' + name + '» اسم مخصص: سجّل الرواتب من الموظفين والرواتب، والمشتريات من المشتريات، والسلف من سلف الموظفين، ومعاملات المالك من الحسابات');
        }
        const cat = {
          id: BeeStore.ids.randomId('ecat'),
          name,
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expenseCategories', cat);
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          await BeeStore.chart.ensureSeededTx(tx);
          return (await tx.get('expenseCategories', cat.id)) || cat;
        }
        return cat;
      });
    }

    /** Lists expenses newest-first (voided excluded by default).
     * @param {Object} [filters] {from,to,categoryId,includeVoided}
     * @returns {Promise<Array>} matching expenses
     */
    async list(filters) {
      const from = filters && filters.from;
      const to = filters && filters.to;
      let expenses = (from || to)
        ? await this.repo.listRange('expenses', from, to)
        : await this.repo.list('expenses');
      if (filters && filters.categoryId) {
        expenses = expenses.filter(e => e.categoryId === filters.categoryId);
      }
      if (!filters || !filters.includeVoided) expenses = expenses.filter(e => !e.voided);
      expenses.sort((a, b) => b.date.localeCompare(a.date));
      return expenses;
    }

    /** Creates an expense; supports spread allocation over N months (v2 §6.3).
     * @param {Object} data expense fields incl. allocation
     * @returns {Promise<Object>} created expense
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED on bad amount/month or closed period
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const settings = await tx.get('meta', 'settings') || {};
        const categories = await tx.list('expenseCategories');
        const catMap = {};
        for (const c of categories) catMap[c.id] = c.name;
        const method = data.method || 'cash';
        const date = data.date || BeeStore.dates.today();
        const accountId = data.accountId || BeeStore.settings.resolvePaymentAccount(settings, method);
        await BeeStore.periods.assertOpen(tx, date);
        // v3-Lite §4.5: cash expenses are day-locked; non-cash accruals are not.
        await BeeStore.periods.assertCashDayOpen(tx, date, accountId);
        // v2 §6.3 spread: one payment covering N months.
        let allocation = { mode: 'single' };
        let month = date.slice(0, 7);
        if (data.allocation && data.allocation.mode === 'spread') {
          const n = Math.floor(Number(data.allocation.months) || 0);
          const startMonth = data.allocation.startMonth || month;
          if (n < 2) throw BeeStore.errors.err('VALIDATION', 'التوزيع يحتاج شهرين على الأقل');
          if (!MONTH_RE.test(startMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر بداية التوزيع غير صالح');
          allocation = { mode: 'spread', months: n, startMonth };
          month = startMonth;
        }
        const amountMinor = BeeStore.money.roundMinor(data.amountMinor);
        if (amountMinor <= 0) throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');
        const expense = {
          id: BeeStore.ids.randomId('exp'),
          date,
          month,
          categoryId: data.categoryId,
          categoryName: data.categoryName || (data.categoryId ? (catMap[data.categoryId] || '') : '') || 'أخرى',
          amountMinor,
          method,
          accountId,
          description: data.description || '',
          recurringId: data.recurringId || null,
          allocation,
          voided: false,
          voidReason: null,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expenses', expense);
        if (BeeStore.posting) {
          const entries = await BeeStore.posting.expense(tx, expense);
          if (entries.length > 0) {
            BeeStore.posting.linkAll([expense], entries);
            tx.put('expenses', expense);
          }
        }
        return expense;
      });
    }

    /** Updates an expense; spread needs all months open (v2 §6.3).
     * @param {string} id expense id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated expense
     * @throws {BeeError} NOT_FOUND|ALREADY_VOID|PERIOD_CLOSED
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const e = await tx.get('expenses', id);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        if (e.voided) throw BeeStore.errors.err('ALREADY_VOID', 'المصروف ملغي — لا يمكن تعديله');
        await BeeStore.periods.assertOpen(tx, e.date);
        if (patch.date) await BeeStore.periods.assertOpen(tx, patch.date);
        await BeeStore.periods.assertCashDayOpen(tx, e.date, e.accountId);
        if (patch.date || patch.accountId) {
          await BeeStore.periods.assertCashDayOpen(tx, patch.date || e.date,
            patch.accountId !== undefined ? patch.accountId : e.accountId);
        }
        // v2 §6.3: a spread expense can change only while ALL its months open.
        if ((e.allocation || {}).mode === 'spread') {
          await BeeStore.periods.assertMonthsOpen(tx, this.spreadMonths(e));
        }
        if (patch.amountMinor !== undefined && BeeStore.money.roundMinor(patch.amountMinor) <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');
        }
        const updated = { ...e, ...patch, id, updatedAt: BeeStore.dates.now() };
        if (patch.date) updated.month = String(patch.date).slice(0, 7);
        tx.put('expenses', updated);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(tx, 'EXPENSE', id, {
            description: 'تعديل مصروف — عكس القيد السابق',
            reason: 'update',
          }, { allowClosedDay: true });
          if (reversals.length > 0) BeeStore.posting.linkAll([updated], reversals);
          const entries = await BeeStore.posting.expense(tx, updated);
          if (entries.length > 0) BeeStore.posting.linkAll([updated], entries);
          tx.put('expenses', updated);
        }
        return updated;
      });
    }

    /** Voids an expense, no hard deletes; spread needs all months open.
     * @param {string} id expense id
     * @param {string} reason mandatory void reason
     * @returns {Promise<Object>} voided expense
     * @throws {BeeError} NOT_FOUND|ALREADY_VOID|VALIDATION|PERIOD_CLOSED
     */
    async void(id, reason) {
      // No hard deletes (spec §4 rule 6): voiding keeps the record visible
      // but excludes it from all totals. Reason is mandatory.
      const expense = await this.repo.transaction(async (tx) => {
        const e = await tx.get('expenses', id);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        if (e.voided) throw BeeStore.errors.err('ALREADY_VOID', 'المصروف ملغي مسبقاً');
        if (!reason || !String(reason).trim()) {
          throw BeeStore.errors.err('VALIDATION', 'سبب الإلغاء مطلوب');
        }
        await BeeStore.periods.assertOpen(tx, e.date);
        await BeeStore.periods.assertCashDayOpen(tx, e.date, e.accountId);
        if ((e.allocation || {}).mode === 'spread') {
          await BeeStore.periods.assertMonthsOpen(tx, this.spreadMonths(e));
        }
        e.voided = true;
        e.voidReason = String(reason).trim();
        e.updatedAt = BeeStore.dates.now();
        tx.put('expenses', e);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(tx, 'EXPENSE', id, {
            description: 'إلغاء مصروف — ' + e.voidReason,
            reason: e.voidReason,
          }, { allowClosedDay: true });
          if (reversals.length > 0) {
            BeeStore.posting.linkAll([e], reversals);
            tx.put('expenses', e);
          }
        }
        return e;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('void', 'expense', id, 'إلغاء مصروف بمبلغ ' + expense.amountMinor + ' - ' + reason);
      }
      return expense;
    }

    /** Lists recurring expense templates.
     * @returns {Promise<Array>} all recurring templates
     */
    async getRecurring() {
      return this.repo.list('recurringExpenses');
    }

    /** Creates a recurring expense template (v2 §6.2).
     * @param {Object} data template fields
     * @returns {Promise<Object>} created template
     * @throws {BeeError} VALIDATION on bad amount/months
     */
    async createRecurring(data) {
      return this.repo.transaction(async (tx) => {
        const amountMinor = BeeStore.money.roundMinor(data.amountMinor);
        if (amountMinor <= 0) throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');
        const dayOfMonth = data.dayOfMonth === 'last' ? 'last'
          : Math.min(28, Math.max(1, Math.floor(Number(BeeStore.money.normalizeDigits(data.dayOfMonth)) || 1)));
        const startMonth = data.startMonth || null;
        const endMonth = data.endMonth || null;
        if (startMonth && !MONTH_RE.test(startMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر البداية غير صالح');
        if (endMonth && !MONTH_RE.test(endMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر النهاية غير صالح');
        if (startMonth && endMonth && endMonth < startMonth) {
          throw BeeStore.errors.err('VALIDATION', 'شهر النهاية قبل شهر البداية');
        }
        const rec = {
          id: BeeStore.ids.randomId('rec'),
          categoryId: data.categoryId || null,
          amountMinor,
          dayOfMonth,
          description: data.description || '',
          method: data.method || 'cash',
          accountId: data.accountId || null,
          startMonth, endMonth,
          lastGeneratedMonth: null,
          effectiveFrom: null,
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('recurringExpenses', rec);
        return rec;
      });
    }

    /** Updates a recurring template from effectiveFrom; past records untouched (v2 §6.2).
     * @param {string} id template id
     * @param {Object} patch fields to merge
     * @param {string} [effectiveFrom] YYYY-MM start month
     * @returns {Promise<Object>} updated template
     * @throws {BeeError} NOT_FOUND|VALIDATION
     */
    // v2 §6.2: template edits apply from effectiveFrom; past records untouched.
    async updateRecurring(id, patch, effectiveFrom) {
      return this.repo.transaction(async (tx) => {
        const r = await tx.get('recurringExpenses', id);
        if (!r) throw BeeStore.errors.err('NOT_FOUND', 'المصروف المتكرر غير موجود');
        const from = effectiveFrom || BeeStore.dates.monthKey(BeeStore.dates.today());
        if (!MONTH_RE.test(from)) throw BeeStore.errors.err('VALIDATION', 'شهر السريان غير صالح');
        const { lastGeneratedMonth, ...safePatch } = patch || {};
        void lastGeneratedMonth;
        const updated = {
          ...r, ...safePatch, id,
          effectiveFrom: from,
          lastGeneratedMonth: r.lastGeneratedMonth,
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('recurringExpenses', updated);
        return updated;
      });
    }

    _recurringApplies(r, month) {
      if (!month || !MONTH_RE.test(month)) return false;
      const start = r.startMonth || r.effectiveFrom || '0000-00';
      if (month < start) return false;
      if (r.endMonth && month > r.endMonth) return false;
      return true;
    }

    /** Generates recurring expenses for a month, idempotent per (recurringId, month) (v2 §6.2).
     * @param {string} [month] YYYY-MM target month
     * @returns {Promise<Array>} newly created expenses
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED
     */
    async generateRecurring(month) {
      return this.repo.transaction(async (tx) => {
        const ym = month || BeeStore.dates.monthKey(BeeStore.dates.today());
        if (!MONTH_RE.test(ym)) throw BeeStore.errors.err('VALIDATION', 'الشهر غير صالح: ' + ym);
        const recurring = await tx.list('recurringExpenses', r => r.active !== false);
        const created = [];
        // Idempotent on (recurringId, month) — v2 §6.2.
        const existing = await tx.list('expenses',
          e => !e.voided && e.recurringId && (e.month === ym || String(e.date).startsWith(ym)));
        const existingIds = new Set(existing.map(e => e.recurringId));
        const settings = await tx.get('meta', 'settings') || {};
        const categories = await tx.list('expenseCategories');
        const catMap = {};
        for (const c of categories) catMap[c.id] = c.name;
        const dim = BeeStore.dates.daysInMonth(ym);
        for (const r of recurring) {
          if (existingIds.has(r.id)) continue;
          if (!this._recurringApplies(r, ym)) continue;
          const day = r.dayOfMonth === 'last' ? dim : Math.min(Number(r.dayOfMonth) || 1, dim);
          const date = ym + '-' + String(day).padStart(2, '0');
          const method = r.method || 'cash';
          const accountId = r.accountId || BeeStore.settings.resolvePaymentAccount(settings, method);
          await BeeStore.periods.assertOpen(tx, date);
          await BeeStore.periods.assertCashDayOpen(tx, date, accountId);
          const expense = {
            id: BeeStore.ids.randomId('exp'),
            date,
            month: ym,
            categoryId: r.categoryId,
            categoryName: (r.categoryId ? catMap[r.categoryId] : '') || r.description || 'دوري',
            amountMinor: r.amountMinor,
            method,
            accountId,
            description: r.description || '',
            recurringId: r.id,
            allocation: { mode: 'single' },
            voided: false,
            voidReason: null,
            createdAt: BeeStore.dates.now(),
            updatedAt: BeeStore.dates.now(),
          };
          tx.put('expenses', expense);
          if (BeeStore.posting) {
            const entries = await BeeStore.posting.expense(tx, expense);
            if (entries.length > 0) {
              BeeStore.posting.linkAll([expense], entries);
              tx.put('expenses', expense);
            }
          }
          created.push(expense);
          r.lastGeneratedMonth = (!r.lastGeneratedMonth || ym > r.lastGeneratedMonth) ? ym : r.lastGeneratedMonth;
          r.updatedAt = BeeStore.dates.now();
          tx.put('recurringExpenses', r);
        }
        return created;
      });
    }
  }

  BeeStore.expenses = new ExpensesService(null);
  BeeStore.ExpensesService = ExpensesService;
  BeeStore.DEFAULT_EXPENSE_CATEGORIES = DEFAULT_CATEGORIES;
  if (typeof module !== 'undefined') module.exports = ExpensesService;
})(typeof window !== 'undefined' ? window : globalThis);
