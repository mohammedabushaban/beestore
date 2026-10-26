(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v2 §2 + §7: months are views/periods over ONE dataset. Every posting
  // transaction must call assertOpen(tx, date) — never rely on the UI.
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function _monthOf(dateStr) {
    return String(dateStr).slice(0, 7);
  }

  class PeriodsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * The single posting gate (v2 §7.4). Must run inside every posting tx.
     * @param {object} tx active repository transaction
     * @param {string} date business date (YYYY-MM-DD); defaults to today
     * @returns {Promise<true>} resolves when posting is allowed
     * @throws {BeeError} VALIDATION (pre-start/future date) or PERIOD_CLOSED
     */
    async assertOpen(tx, date) {
      const d = String(date || BeeStore.dates.today());
      const settings = (await tx.get('meta', 'settings')) || {};
      if (settings.systemStartDate && d < settings.systemStartDate) {
        throw BeeStore.errors.err('VALIDATION',
          'لا يمكن التسجيل بتاريخ ' + d + ' — قبل تاريخ بدء النظام (' + settings.systemStartDate + ')');
      }
      if (settings.blockFutureDates !== false && d > BeeStore.dates.today()) {
        throw BeeStore.errors.err('VALIDATION',
          'لا يمكن التسجيل بتاريخ مستقبلي (' + d + ')');
      }
      const month = _monthOf(d);
      const closed = await tx.list('periodClosings',
        c => c.month === month && c.status === 'closed');
      if (closed.length > 0) {
        throw BeeStore.errors.err('PERIOD_CLOSED',
          'شهر ' + month + ' مُقفل — سجّل التصحيح في الشهر الحالي أو أعد فتح الشهر');
      }
      return true;
    }

    /**
     * v3-Lite §4.5 day lock. Must run inside every posting transaction that
     * creates a sale, return, receipt/payment, cash expense, transfer,
     * withdrawal or capital movement dated that day.
     * @param {object} tx active repository transaction
     * @param {string} date business date YYYY-MM-DD
     * @returns {Promise<true>}
     * @throws {BeeError} DAY_CLOSED when that day has a closed record
     */
    async assertDayOpen(tx, date) {
      const d = String(date || BeeStore.dates.today());
      const rows = await tx.list('dailyClosings',
        c => c.date === d && c.status === 'closed');
      if (rows.length > 0) {
        throw BeeStore.errors.err('DAY_CLOSED',
          'يوم ' + d + ' مُقفل — أعد فتح اليوم من صفحة الأيام أو سجّل التصحيح بتاريخ اليوم');
      }
      return true;
    }

    /**
     * Resolves the configured cash-drawer account, falling back to the first
     * active cash account for installs created before L4.
     * @param {object} [reader] repo or transaction
     * @returns {Promise<string|null>} account id
     */
    async cashDrawerAccountId(reader) {
      const r = reader || this.repo;
      const settings = (await r.get('meta', 'settings')) || {};
      if (settings.cashDrawerAccountId) return settings.cashDrawerAccountId;
      const accounts = await r.list('accounts');
      const cash = accounts.find(a => a.type === 'cash' && a.active !== false) ||
        accounts.find(a => a.type === 'cash') || accounts[0];
      return cash ? cash.id : null;
    }

    /**
     * Only cash-drawer expenses are blocked by the day lock. Non-cash accrual
     * and bank expenses may still be recorded on a closed day.
     * @param {object} tx active transaction
     * @param {string} date business date
     * @param {string|null} accountId expense account
     * @returns {Promise<true>}
     */
    async assertCashDayOpen(tx, date, accountId) {
      const drawer = await this.cashDrawerAccountId(tx);
      if (drawer && accountId === drawer) return this.assertDayOpen(tx, date);
      return true;
    }

    /**
     * @param {string} date YYYY-MM-DD
     * @returns {Promise<boolean>} true when the day is closed
     */
    async isDayClosed(date) {
      const rows = await this.repo.list('dailyClosings',
        c => c.date === date && c.status === 'closed');
      return rows.length > 0;
    }

    /**
     * @param {string} month YYYY-MM
     * @returns {Promise<boolean>} true when the month is locked
     */
    async isClosed(month) {
      const rows = await this.repo.list('periodClosings',
        c => c.month === month && c.status === 'closed');
      return rows.length > 0;
    }

    /**
     * Closed-only gate (no future/start checks): for spread allocations
     * whose months may legitimately lie in the future (v2 §6.3).
     * @param {object} tx active transaction
     * @param {string[]} months YYYY-MM list that must all be open
     * @returns {Promise<true>}
     * @throws {BeeError} PERIOD_CLOSED naming the locked month
     */
    async assertMonthsOpen(tx, months) {
      for (const m of (months || [])) {
        const closed = await tx.list('periodClosings',
          c => c.month === m && c.status === 'closed');
        if (closed.length > 0) {
          throw BeeStore.errors.err('PERIOD_CLOSED',
            'شهر ' + m + ' مُقفل — لا يمكن تعديل هذا المصروف الموزع');
        }
      }
      return true;
    }

    /**
     * @returns {Promise<object[]>} closing records, newest month first
     */
    async list() {
      const rows = await this.repo.list('periodClosings');
      rows.sort((a, b) => b.month.localeCompare(a.month));
      return rows;
    }

    /**
     * @param {string} month YYYY-MM
     * @returns {Promise<object|null>} closing record or null when open
     */
    async get(month) {
      const rows = await this.repo.list('periodClosings', c => c.month === month);
      return rows.length > 0 ? rows[0] : null;
    }

    // Months that contain dated business documents (for ordered closing).
    async _monthsWithData(tx) {
      const months = new Set();
      const add = (date) => { if (date && /^\d{4}-\d{2}/.test(date)) months.add(_monthOf(date)); };
      for (const coll of ['sales', 'salesReturns', 'purchases', 'purchaseReturns',
        'customerPayments', 'supplierPayments', 'expenses', 'stockMovements',
        'ownerTransactions', 'transfers', 'dailyClosings', 'cashAdjustments',
        'employeeAdvances']) {
        const rows = await tx.list(coll);
        for (const r of rows) add(r.date);
      }
      const pay = await tx.list('payroll');
      for (const p of pay) { if (p.month && MONTH_RE.test(p.month)) months.add(p.month); }
      return Array.from(months).sort();
    }

    /**
     * Public wrapper over the internal month scan (for the period selector).
     * @returns {Promise<string[]>} sorted YYYY-MM months holding documents
     */
    async monthsWithData() {
      return this._monthsWithData({ list: (c, p) => this.repo.list(c, p) });
    }

    /**
     * Closing checklist, computed live (v2 §7.2).
     * @param {string} month YYYY-MM
     * @returns {Promise<{month:string,closed:boolean,items:Array<{level:'blocker'|'warning'|'info',ok:boolean,text:string}>>}>}
     * @throws {BeeError} VALIDATION on malformed month
     */
    async checklist(month) {
      if (!MONTH_RE.test(month)) throw BeeStore.errors.err('VALIDATION', 'شهر غير صالح: ' + month);
      const closings = await this.list();
      const closedSet = new Set(closings.filter(c => c.status === 'closed').map(c => c.month));
      const items = [];
      const push = (level, ok, text) => items.push({ level, ok, text });

      // Blocker 1: earlier months with data must be closed first (in order).
      const months = await this._monthsWithData({ list: (c, p) => this.repo.list(c, p) });
      const earlierOpen = months.filter(m => m < month && !closedSet.has(m));
      push('blocker', earlierOpen.length === 0,
        earlierOpen.length === 0 ? 'كل الشهور السابقة مُقفلة'
          : 'شهور سابقة مفتوحة: ' + earlierOpen.join('، '));

      // Blocker 2: Data Integrity Checker (v2 §12.2) reports no errors.
      let integOk = true, integText = 'فحص سلامة البيانات سليم';
      try {
        const res = await BeeStore.maintenance.integrityCheck();
        integOk = res.errors.length === 0;
        if (!integOk) integText = res.errors.length + ' أخطاء سلامة — راجع فحص سلامة البيانات أولاً';
        else if (res.warnings.length > 0) integText = 'سليم مع ' + res.warnings.length + ' تنبيهات';
      } catch (e) { integOk = false; integText = 'تعذر تشغيل فحص السلامة'; }
      push('blocker', integOk, integText);

      // Warning: recurring templates missing their month record.
      const recurring = await this.repo.list('recurringExpenses', r => r.active !== false);
      const generated = await this.repo.list('expenses',
        e => e.recurringId && _monthOf(e.date) === month);
      const genIds = new Set(generated.map(e => e.recurringId));
      const missing = recurring.filter(r => !genIds.has(r.id)).length;
      push('warning', missing === 0,
        missing === 0 ? 'المصاريف الشهرية مولّدة لهذا الشهر'
          : missing + ' مصاريف شهرية لم تُنشأ بعد');

      // Warning: payroll prepared for all active employees.
      const employees = await this.repo.list('employees', e => e.active !== false);
      const payroll = await this.repo.list('payroll', p => p.month === month);
      const covered = new Set(payroll.map(p => p.employeeId));
      const missingEmp = employees.filter(e => !covered.has(e.id)).length;
      push('warning', missingEmp === 0,
        missingEmp === 0 ? 'الرواتب مجهزة لكل الموظفين'
          : 'رواتب غير مجهزة لـ ' + missingEmp + ' موظف');

      // Warning: negative stock variants.
      const variants = await this.repo.list('variants', v => v.active !== false);
      const neg = variants.filter(v => v.quantity < 0).length;
      push('warning', neg === 0,
        neg === 0 ? 'لا مخزون سالب' : neg + ' صنف بمخزون سالب');

      // Warning: days without a daily closing (only elapsed days count).
      const { from, to } = BeeStore.dates.monthRange(month);
      const today = BeeStore.dates.today();
      const lastCounted = to < today ? to : (from > today ? null : today);
      let missingClosings = 0;
      if (lastCounted) {
        const elapsed = BeeStore.dates.diffDays(from, lastCounted) + 1;
        const done = await this.repo.list('dailyClosings',
          d => d.date >= from && d.date <= lastCounted && d.status === 'closed');
        missingClosings = Math.max(0, elapsed - done.length);
      }
      push('warning', missingClosings === 0,
        missingClosings === 0 ? 'الإغلاق اليومي مكتمل للأيام المنقضية'
          : missingClosings + ' يوم بدون إغلاق يومي');

      // Info: stocktake done during the month.
      const took = await this.repo.list('stockMovements',
        m => m.type === 'stocktake' && _monthOf(m.date) === month);
      push('info', took.length > 0,
        took.length > 0 ? 'تم الجرد خلال الشهر' : 'لم يتم الجرد خلال الشهر');

      // Info: overdue installments.
      let overdueCount = 0;
      try {
        const od = await BeeStore.customers.getOverdueInstallments();
        overdueCount = od.length;
      } catch (e) { /* customers service unavailable in some test setups */ }
      push('info', overdueCount === 0,
        overdueCount === 0 ? 'لا أقساط متأخرة' : overdueCount + ' قسط متأخر');

      return { month, closed: closedSet.has(month), items };
    }

    // Read-only snapshot for the closing record (v2 §7.3).
    async _snapshot(month) {
      const { from, to } = BeeStore.dates.monthRange(month);
      const pnl = await BeeStore.reports.profitAndLoss(from, to);
      const valuation = await BeeStore.reports.inventoryValuation();
      const balance = await BeeStore.reports.balanceSnapshot(to);
      const accounts = await this.repo.list('accounts');
      const accountBalances = {};
      for (const a of accounts) accountBalances[a.id] = await BeeStore.accounts.balance(a.id);
      return {
        month, from, to,
        netSales: pnl.netSales, cogs: pnl.cogs, grossProfit: pnl.grossProfit,
        expensesByCategory: pnl.expensesByCategory, salaryExpense: pnl.salaryExpense,
        stockLosses: pnl.stockLosses, operatingExpenses: pnl.operatingExpenses,
        netProfit: pnl.netProfit,
        accountBalances,
        inventoryCost: valuation.totalCost, inventoryRetail: valuation.totalRetail,
        receivables: balance.assets.receivables,
        payables: balance.liabilities.payables,
        advancesOutstanding: balance.assets.advancesOutstanding,
        customerCredits: balance.liabilities.customerCredits,
        capitalIn: balance.equity.capitalIn, withdrawals: balance.equity.withdrawals,
        balanced: balance.balanced,
      };
    }

    /**
     * Lock the month in one transaction (v2 §7.3). Blockers refuse;
     * warnings are the caller's responsibility. The caller takes a dated
     * backup BEFORE calling (services cannot reach the file system).
     * @param {string} month YYYY-MM
     * @param {string} [note] closing note stored on the record
     * @returns {Promise<object>} the created periodClosings record
     * @throws {BeeError} VALIDATION | CONFLICT (blockers/duplicate/out-of-order)
     */
    async close(month, note) {
      if (!MONTH_RE.test(month)) throw BeeStore.errors.err('VALIDATION', 'شهر غير صالح: ' + month);
      const check = await this.checklist(month);
      const blockers = check.items.filter(i => i.level === 'blocker' && !i.ok);
      if (blockers.length > 0) {
        throw BeeStore.errors.err('CONFLICT',
          'لا يمكن الإقفال: ' + blockers.map(b => b.text).join('؛ '));
      }
      const snapshot = await this._snapshot(month);
      return this.repo.transaction(async (tx) => {
        const dup = await tx.list('periodClosings', c => c.month === month);
        if (dup.length > 0) throw BeeStore.errors.err('CONFLICT', 'الشهر مُقفل مسبقاً');
        const months = await this._monthsWithData(tx);
        const earlierOpen = [];
        for (const m of months) {
          if (m >= month) continue;
          const closed = await tx.list('periodClosings',
            c => c.month === m && c.status === 'closed');
          if (closed.length === 0) earlierOpen.push(m);
        }
        if (earlierOpen.length > 0) {
          throw BeeStore.errors.err('CONFLICT', 'أقفل الشهور السابقة أولاً: ' + earlierOpen.join('، '));
        }
        const rec = {
          id: BeeStore.ids.randomId('per'),
          month, status: 'closed',
          closedAt: BeeStore.dates.now(),
          snapshot, note: note || '',
          reopenHistory: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('periodClosings', rec);
        tx.put('auditLog', BeeStore.audit.build('period_close', 'period', month,
          'إقفال شهر ' + month + (note ? ' - ' + note : '')));
        return rec;
      });
    }

    /**
     * Reopen a locked month (v2 §7.5): only the most recently closed month,
     * sequentially. Discards the snapshot, appends reopenHistory, audits.
     * @param {string} month YYYY-MM (must equal the latest closed month)
     * @param {string} [note] reason for reopening
     * @returns {Promise<true>}
     * @throws {BeeError} CONFLICT when not the latest or nothing closed
     */
    async reopen(month, note) {
      return this.repo.transaction(async (tx) => {
        const all = await tx.list('periodClosings', c => c.status === 'closed');
        if (all.length === 0) throw BeeStore.errors.err('CONFLICT', 'لا يوجد شهر مُقفل');
        const latest = all.map(c => c.month).sort().pop();
        if (month !== latest) {
          throw BeeStore.errors.err('CONFLICT',
            'يمكن إعادة فتح آخر شهر مُقفل فقط (' + latest + ') — أعد الفتح بالترتيب');
        }
        const rec = all.find(c => c.month === month);
        rec.reopenHistory = rec.reopenHistory || [];
        rec.reopenHistory.push({
          reopenedAt: BeeStore.dates.now(), note: note || '',
        });
        tx.remove('periodClosings', rec.id);
        tx.put('auditLog', BeeStore.audit.build('period_reopen', 'period', month,
          'إعادة فتح شهر ' + month + (note ? ' - ' + note : '')));
        return true;
      });
    }
  }

  BeeStore.periods = new PeriodsService(null);
  BeeStore.PeriodsService = PeriodsService;
  if (typeof module !== 'undefined') module.exports = PeriodsService;
})(typeof window !== 'undefined' ? window : globalThis);
