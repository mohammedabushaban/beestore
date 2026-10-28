(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function ok(data) { return { ok: true, data }; }
  function fail(code, message) { return { ok: false, error: { code, message } }; }

  class Api {
    constructor(repo) {
      this.repo = repo;
      this._bindServices();
      this._wrapAll();
    }

    _bindServices() {
      const services = [
        'settings', 'auth', 'clockGuard', 'accounts', 'categories', 'products', 'variants', 'stock',
        'sales', 'returns', 'customers', 'suppliers', 'purchases', 'purchaseReturns',
        'expenses', 'employees', 'payroll', 'transactions', 'periods',
        'chart', 'journal',
        'dailyClosing', 'reports', 'dashboard', 'backup', 'maintenance', 'audit',
        'accountingPackage',
      ];
      for (const name of services) {
        const svc = BeeStore[name];
        if (svc) {
          svc.repo = this.repo;
        }
      }
    }

    _wrapAll() {
      // Spec §4 rule 11: every facade call resolves to {ok, data|error} and
      // NEVER rejects. Service throws (BeeError with .code) become fail().
      // `repo` is excluded: it is the raw storage interface, not the facade.
      for (const key of Object.keys(this)) {
        if (key === 'repo' || key === 'security') continue;
        const ns = this[key];
        if (!ns || typeof ns !== 'object') continue;
        for (const m of Object.keys(ns)) {
          if (typeof ns[m] !== 'function') continue;
          const fn = ns[m].bind(ns);
          ns[m] = async (...args) => {
            try {
              return await this._dispatch(key, m, fn, args);
            } catch (e) {
              const code = (e && e.code) || 'UNKNOWN';
              const message = (e && e.message) || 'حدث خطأ غير معروف';
              return fail(code, message);
            }
          };
        }
      }
    }

    _utils() {
      // Node regression suites may load the facade without auth.js; the
      // browser always loads it first (index.html script order).
      return BeeStore.authUtils || {
        READ_METHODS: new Set(),
        stripSensitive: (v) => v,
        sanitizeSettings: (v) => v,
      };
    }

    /**
     * v3-Lite §7 central enforcement: permission check + response shaping for
     * every facade call, before a page sees anything. Pages never enforce
     * roles themselves. The namespace functions already return {ok,...}, so
     * this only reshapes the data of successful calls (never double-wraps).
     */
    async _dispatch(ns, method, fn, args) {
      const utils = this._utils();
      const auth = BeeStore.auth;
      if (auth) {
        auth.assertCan(ns + '.' + method);
        if (this._isPostingAction(ns, method) && auth.postingBlocked()) {
          throw BeeStore.errors.err('CLOCK_ANOMALY',
            'تم إيقاف التسجيل مؤقتاً حتى تأكيد تاريخ الهاتف. راجع تحذير الساعة أولاً.');
        }
      }
      let callArgs = args;
      const cashier = !!(auth && auth.isCashier());
      if (cashier && ns === 'dashboard' && method === 'get') {
        // The cashier never receives the owner dashboard (cost, profit,
        // balances, month figures) — not even momentarily.
        return ok(utils.stripSensitive(await BeeStore.dashboard.cashierSummary()));
      }
      if (ns === 'settings') {
        // Never accept PIN records from a page; the security namespace owns
        // them. Screens may read back only pinSet flags (sanitized below).
        callArgs = args.map((arg) => {
          if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg;
          if (method !== 'save' && method !== 'update') return arg;
          const copy = { ...arg };
          delete copy.profiles;
          delete copy.pin;
          return copy;
        });
      }
      if (ns === 'sales' && method === 'create') {
        callArgs = [await this._prepareSale(callArgs[0], cashier)];
      }
      if (ns === 'returns' && method === 'create') {
        callArgs = [await this._prepareReturn(callArgs[0], cashier)];
      }
      if (ns === 'dailyClosings' && method === 'close' && auth) {
        callArgs = [{ ...(callArgs[0] || {}), closedBy: auth.profileName() || 'المالك' }];
      }
      const res = await fn(...callArgs);
      if (!res || res.ok !== true) return res;
      let data = res.data;
      if (ns === 'settings') data = utils.sanitizeSettings(data);
      if (cashier) data = utils.stripSensitive(data);
      return ok(data);
    }

    _isPostingAction(ns, method) {
      const reads = this._utils().READ_METHODS;
      if (reads.has(method)) return false;
      // Safety operations must remain usable while the clock is unconfirmed.
      if (ns === 'backup' || ns === 'security') return false;
      // The accountant package is a read-only export; a clock warning must
      // not stop the owner from taking a package before fixing the date.
      if (ns === 'accountingPackage') return false;
      if (ns === 'maintenance' && method !== 'recalculateStock' && method !== 'resetAll') return false;
      return true;
    }

    async _prepareSale(data, cashier) {
      const sale = { ...(data || {}) };
      const profile = BeeStore.auth && BeeStore.auth.profile ? BeeStore.auth.profile() : null;
      sale.createdByProfile = profile;
      if (!cashier) return sale;
      const settings = await BeeStore.settings.get();
      const limits = {
        maxPercent: Math.max(0, Number(settings.cashierMaxDiscountPercent) || 0),
      };
      let regularSubtotal = 0;
      let actualSubtotal = 0;
      for (const line of (sale.lines || [])) {
        const qty = Number(BeeStore.money.normalizeDigits(line.qty)) || 0;
        const unit = BeeStore.money.roundMinor(line.unitPriceMinor || 0);
        const lineDiscount = BeeStore.money.roundMinor(line.lineDiscountMinor || 0);
        actualSubtotal += Math.max(0, BeeStore.money.mul(unit, qty) - lineDiscount);
        let catalog = unit;
        try {
          const variant = await this.repo.get('variants', line.variantId);
          if (variant) catalog = BeeStore.money.roundMinor(variant.priceMinor);
        } catch (e) { /* service will report a missing variant */ }
        regularSubtotal += BeeStore.money.mul(catalog, qty);
      }
      let invoiceDiscount = 0;
      if (sale.discount && sale.discount.value > 0) {
        if (sale.discount.type === 'percent') {
          invoiceDiscount = Math.round(actualSubtotal * Number(sale.discount.value) / 100);
        } else {
          invoiceDiscount = BeeStore.money.fromMajor(sale.discount.value);
        }
      }
      const effectiveDiscount = Math.max(0, regularSubtotal - actualSubtotal + invoiceDiscount);
      const maxDiscount = Math.round(regularSubtotal * limits.maxPercent / 100);
      if (effectiveDiscount > maxDiscount) {
        throw BeeStore.errors.err('PERMISSION',
          'خصم الكاشير يتجاوز الحد المسموح (' + limits.maxPercent + '٪). ' +
          'اطلب من المالك تطبيق خصم أكبر.');
      }
      return sale;
    }

    async _prepareReturn(data, cashier) {
      const ret = { ...(data || {}) };
      const profile = BeeStore.auth && BeeStore.auth.profile ? BeeStore.auth.profile() : null;
      ret.createdByProfile = profile;
      if (!cashier) return ret;
      const settings = await BeeStore.settings.get();
      const max = Math.max(0, Number(settings.cashierMaxReturnMinor) || 0);
      const sale = await this.repo.get('sales', ret.saleId);
      if (!sale) return ret; // let the service return its Arabic NOT_FOUND
      let refund = 0;
      for (const line of (ret.lines || [])) {
        const saleLine = sale.lines[Number(line.saleLineIndex)];
        if (!saleLine) continue;
        const qty = Number(line.qty) || 0;
        const proportionalDiscount = saleLine.lineDiscountMinor > 0
          ? Math.round(saleLine.lineDiscountMinor * qty / saleLine.qty) : 0;
        refund += BeeStore.money.mul(saleLine.unitPriceMinor, qty) - proportionalDiscount;
      }
      if (refund > max) {
        throw BeeStore.errors.err('PERMISSION',
          'قيمة المرتجع تتجاوز حد الكاشير (' + BeeStore.money.format(max) + '). ' +
          'اطلب من المالك تنفيذ المرتجع.');
      }
      return ret;
    }

    _try(fn) {
      return (async () => {
        try { return ok(await fn()); }
        catch (e) {
          return fail((e && e.code) || 'UNKNOWN', (e && e.message) || 'حدث خطأ غير معروف');
        }
      })();
    }

    security = {
      status: async () => this._try(async () => {
        await BeeStore.auth.profiles();
        return BeeStore.auth.state();
      }),
      profiles: async () => this._try(() => BeeStore.auth.profiles()),
      unlock: async (profile, pin) => this._try(() => BeeStore.auth.unlock(profile, pin)),
      lock: async (reason) => this._try(async () => {
        const state = BeeStore.auth.lock(reason);
        if (BeeStore.appLock && BeeStore.appLock.onLocked) BeeStore.appLock.onLocked();
        return state;
      }),
      setPin: async (profile, pin, options) => this._try(() => BeeStore.auth.setPin(profile, pin, options)),
      removeCashier: async () => this._try(() => BeeStore.auth.removeCashier()),
      update: async (patch, currentPin) => this._try(() => BeeStore.auth.updateSecurity(patch, currentPin)),
      clockStatus: async () => this._try(async () => {
        if (!BeeStore.clockGuard) return { pending: false };
        const state = await BeeStore.clockGuard.check();
        BeeStore.auth.setClockState(state);
        return state;
      }),
      confirmClock: async () => this._try(async () => {
        if (!BeeStore.clockGuard) return { pending: false };
        const state = await BeeStore.clockGuard.confirm();
        BeeStore.auth.setClockState(state);
        return state;
      }),
    };

    settings = {
      get: async () => ok(await BeeStore.settings.get()),
      save: async (data) => ok(await BeeStore.settings.save(data)),
      update: async (patch) => ok(await BeeStore.settings.update(patch)),
    };

    accounts = {
      list: async () => ok(await BeeStore.accounts.list()),
      get: async (id) => ok(await BeeStore.accounts.get(id)),
      create: async (data) => ok(await BeeStore.accounts.create(data)),
      update: async (id, patch) => ok(await BeeStore.accounts.update(id, patch)),
      balance: async (id) => ok(await BeeStore.accounts.balance(id)),
      balanceAsOf: async (id, date) => ok(await BeeStore.accounts.balanceAsOf(id, date)),
      ledger: async (id, range) => ok(await BeeStore.accounts.getLedger(id, range)),
    };

    chart = {
      list: async (options) => ok(await BeeStore.chart.list(options)),
      get: async (id) => ok(await BeeStore.chart.get(id)),
      byCode: async (code) => ok(await BeeStore.chart.byCode(code)),
      bySystemKey: async (key) => ok(await BeeStore.chart.bySystemKey(key)),
      create: async (data) => ok(await BeeStore.chart.create(data)),
      update: async (id, patch) => ok(await BeeStore.chart.update(id, patch)),
      deactivate: async (id) => ok(await BeeStore.chart.deactivate(id)),
    };

    journal = {
      list: async (filters) => ok(await BeeStore.journal.list(filters)),
      get: async (id) => ok(await BeeStore.journal.get(id)),
      byNumber: async (number) => ok(await BeeStore.journal.byNumber(number)),
      forSource: async (sourceType, sourceId) => ok(await BeeStore.journal.forSource(sourceType, sourceId)),
      trialBalance: async (filters) => ok(await BeeStore.journal.trialBalance(filters)),
      verify: async () => ok(await BeeStore.journal.verify()),
    };

    categories = {
      list: async () => ok(await BeeStore.categories.list()),
      get: async (id) => ok(await BeeStore.categories.get(id)),
      create: async (data) => ok(await BeeStore.categories.create(data)),
      update: async (id, patch) => ok(await BeeStore.categories.update(id, patch)),
      remove: async (id) => ok(await BeeStore.categories.remove(id)),
    };

    products = {
      list: async () => ok(await BeeStore.products.list()),
      get: async (id) => ok(await BeeStore.products.get(id)),
      getWithVariants: async (id) => ok(await BeeStore.products.getWithVariants(id)),
      create: async (data) => ok(await BeeStore.products.create(data)),
      createWithGrid: async (data) => ok(await BeeStore.products.createWithGrid(data)),
      update: async (id, patch) => ok(await BeeStore.products.update(id, patch)),
      deactivate: async (id) => ok(await BeeStore.products.deactivate(id)),
      search: async (q) => ok(await BeeStore.products.searchProducts(q)),
    };

    variants = {
      list: async () => ok(await BeeStore.variants.list()),
      get: async (id) => ok(await BeeStore.variants.get(id)),
      search: async (q) => ok(await BeeStore.variants.search(q)),
      byBarcode: async (barcode) => ok(await BeeStore.variants.byBarcode(barcode)),
      create: async (data) => ok(await BeeStore.variants.create(data)),
      update: async (id, patch) => ok(await BeeStore.variants.update(id, patch)),
      getLowStock: async (threshold) => ok(await BeeStore.variants.getLowStock(threshold)),
    };

    stock = {
      movements: async (variantId) => ok(await BeeStore.stock.movements(variantId)),
      valueAsOf: async (date) => ok(await BeeStore.stock.valueAsOf(date)),
      adjust: async (variantId, qtyChange, reason, date, note) => ok(await BeeStore.stock.adjust(variantId, qtyChange, reason, date, note)),
      stocktake: async (items, date) => ok(await BeeStore.stock.stocktake(items, date)),
      recalculate: async () => ok(await BeeStore.stock.recalculateStock()),
      verify: async () => ok(await BeeStore.stock.verifyStock()),
    };

    sales = {
      list: async (filters) => ok(await BeeStore.sales.list(filters)),
      get: async (id) => ok(await BeeStore.sales.get(id)),
      getByNumber: async (number) => ok(await BeeStore.sales.getByNumber(number)),
      searchForReturn: async (query) => ok(await BeeStore.sales.searchForReturn(query)),
      create: async (data) => ok(await BeeStore.sales.create(data)),
      void: async (id, reason) => ok(await BeeStore.sales.void(id, reason)),
      printData: async (id) => ok(await BeeStore.sales.printData(id)),
    };

    returns = {
      list: async (filters) => ok(await BeeStore.returns.list(filters)),
      get: async (id) => ok(await BeeStore.returns.get(id)),
      create: async (data) => ok(await BeeStore.returns.create(data)),
    };

    customers = {
      list: async () => ok(await BeeStore.customers.list()),
      get: async (id) => ok(await BeeStore.customers.get(id)),
      create: async (data) => ok(await BeeStore.customers.create(data)),
      update: async (id, patch) => ok(await BeeStore.customers.update(id, patch)),
      balance: async (id, asOf) => ok(await BeeStore.customers.balance(id, asOf)),
      statement: async (id) => ok(await BeeStore.customers.statement(id)),
      receivePayment: async (data) => ok(await BeeStore.customers.receivePayment(data)),
      overdueInstallments: async () => ok(await BeeStore.customers.getOverdueInstallments()),
    };

    suppliers = {
      list: async () => ok(await BeeStore.suppliers.list()),
      statement: async (id) => ok(await BeeStore.suppliers.statement(id)),
      get: async (id) => ok(await BeeStore.suppliers.get(id)),
      create: async (data) => ok(await BeeStore.suppliers.create(data)),
      update: async (id, patch) => ok(await BeeStore.suppliers.update(id, patch)),
      balance: async (id, asOf) => ok(await BeeStore.suppliers.balance(id, asOf)),
      pay: async (data) => ok(await BeeStore.suppliers.pay(data)),
    };

    purchases = {
      list: async (filters) => ok(await BeeStore.purchases.list(filters)),
      get: async (id) => ok(await BeeStore.purchases.get(id)),
      create: async (data) => ok(await BeeStore.purchases.create(data)),
      void: async (id) => ok(await BeeStore.purchases.void(id)),
    };

    purchaseReturns = {
      list: async (filters) => ok(await BeeStore.purchaseReturns.list(filters)),
      get: async (id) => ok(await BeeStore.purchaseReturns.get(id)),
      create: async (data) => ok(await BeeStore.purchaseReturns.create(data)),
    };

    expenses = {
      list: async (filters) => ok(await BeeStore.expenses.list(filters)),
      create: async (data) => ok(await BeeStore.expenses.create(data)),
      spread: async (data) => ok(await BeeStore.expenses.create({
        ...data,
        allocation: { mode: 'spread', months: data.months, startMonth: data.startMonth },
      })),
      update: async (id, patch) => ok(await BeeStore.expenses.update(id, patch)),
      void: async (id, reason) => ok(await BeeStore.expenses.void(id, reason)),
      categories: async () => ok(await BeeStore.expenses.getCategories()),
      createCategory: async (data) => ok(await BeeStore.expenses.createCategory(data)),
      recurring: async () => ok(await BeeStore.expenses.getRecurring()),
      createRecurring: async (data) => ok(await BeeStore.expenses.createRecurring(data)),
      updateRecurring: async (id, patch, effectiveFrom) => ok(await BeeStore.expenses.updateRecurring(id, patch, effectiveFrom)),
      generateRecurring: async (month) => ok(await BeeStore.expenses.generateRecurring(month)),
    };

    employees = {
      list: async () => ok(await BeeStore.employees.list()),
      get: async (id) => ok(await BeeStore.employees.get(id)),
      create: async (data) => ok(await BeeStore.employees.create(data)),
      update: async (id, patch) => ok(await BeeStore.employees.update(id, patch)),
      deactivate: async (id) => ok(await BeeStore.employees.deactivate(id)),
    };

    payroll = {
      list: async (filters) => ok(await BeeStore.payroll.list(filters)),
      prepare: async (month) => ok(await BeeStore.payroll.prepare(month)),
      update: async (id, patch) => ok(await BeeStore.payroll.update(id, patch)),
      pay: async (id, method, accountId, note, advanceRepaymentMinor, paidDate) => ok(await BeeStore.payroll.pay(id, method, accountId, note, advanceRepaymentMinor, paidDate)),
      advances: async (employeeId) => ok(await BeeStore.payroll.getAdvances(employeeId)),
      createAdvance: async (data) => ok(await BeeStore.payroll.createAdvance(data)),
      outstandingAdvances: async (employeeId) => ok(await BeeStore.payroll.getOutstandingAdvances(employeeId)),
    };

    transactions = {
      ownerTransaction: async (data) => ok(await BeeStore.transactions.ownerTransaction(data)),
      transfer: async (data) => ok(await BeeStore.transactions.transfer(data)),
      // Legacy v1 shape: route through the full L4 closing so old callers
      // cannot create a closing that bypasses the cash reconciliation.
      dailyClosing: async (data) => ok(await BeeStore.dailyClosing.close({
        date: data.date,
        countedCashMinor: data.countedCashMinor,
        noCount: data.noCount,
        note: data.note,
      })),
    };

    dailyClosings = {
      preview: async (date) => ok(await BeeStore.dailyClosing.preview(date)),
      close: async (data) => ok(await BeeStore.dailyClosing.close(data)),
      get: async (date) => ok(await BeeStore.dailyClosing.get(date)),
      list: async (from, to) => ok(await BeeStore.dailyClosing.list(from, to)),
      reopen: async (date, options) => ok(await BeeStore.dailyClosing.reopen(date, options)),
      daysInMonth: async (month) => ok(await BeeStore.dailyClosing.daysInMonth(month)),
      unclosedDays: async (options) => ok(await BeeStore.dailyClosing.unclosedDays(options)),
      status: async () => ok(await BeeStore.dailyClosing.status()),
      report: async (date) => ok(await BeeStore.dailyClosing.report(date)),
      textSummary: async (report) => ok(BeeStore.dailyClosing.buildTextSummary(report)),
    };

    periods = {
      list: async () => ok(await BeeStore.periods.list()),
      monthsWithData: async () => ok(await BeeStore.periods.monthsWithData()),
      get: async (month) => ok(await BeeStore.periods.get(month)),
      checklist: async (month) => ok(await BeeStore.periods.checklist(month)),
      close: async (month, note) => ok(await BeeStore.periods.close(month, note)),
      reopen: async (month, note) => ok(await BeeStore.periods.reopen(month, note)),
    };

    reports = {
      profitAndLoss: async (from, to) => ok(await BeeStore.reports.profitAndLoss(from, to)),
      monthReview: async (month) => ok(await BeeStore.reports.monthReview(month)),
      yearOverview: async (year) => ok(await BeeStore.reports.yearOverview(year)),
      profitCashReconciliation: async (month) => ok(await BeeStore.reports.profitCashReconciliation(month)),
      compareMonths: async (a, b) => ok(await BeeStore.reports.compareMonths(a, b)),
      salesReport: async (from, to, groupBy) => ok(await BeeStore.reports.salesReport(from, to, groupBy)),
      inventoryValuation: async () => ok(await BeeStore.reports.inventoryValuation()),
      receivablesAging: async () => ok(await BeeStore.reports.receivablesAging()),
      payablesAging: async () => ok(await BeeStore.reports.payablesAging()),
      balanceSnapshot: async (asOf) => ok(await BeeStore.reports.balanceSnapshot(asOf)),
      dailyClosing: async (date) => ok(await BeeStore.reports.dailyClosing(date)),
    };

    dashboard = {
      get: async () => ok(await BeeStore.dashboard.get()),
    };

    accountingPackage = {
      info: async (month) => ok(await BeeStore.accountingPackage.info(month)),
      build: async (month, options) => ok(await BeeStore.accountingPackage.build(month, options)),
      pdf: async (month, options) => ok(await BeeStore.accountingPackage.pdf(month, options)),
      share: async (month, options) => ok(await BeeStore.accountingPackage.share(month, options)),
      download: async (month, options) => ok(await BeeStore.accountingPackage.download(month, options)),
      sharePdf: async (month, options) => ok(await BeeStore.accountingPackage.sharePdf(month, options)),
      downloadPdf: async (month, options) => ok(await BeeStore.accountingPackage.downloadPdf(month, options)),
    };

    backup = {
      createNow: async () => ok(await BeeStore.backup.createNow()),
      list: async () => ok(await BeeStore.backup.list()),
      createPayload: async (options) => ok(await BeeStore.backup.createPayload(options)),
      share: async (options) => ok(await BeeStore.backup.share(options)),
      download: async (options) => ok(await BeeStore.backup.download(options)),
      inspect: async (data, options) => ok(await BeeStore.backup.inspect(data, options)),
      restore: async (data, options) => ok(await BeeStore.backup.restore(data, options)),
      restoreFromFile: async (name) => ok(await BeeStore.backup.restoreFromFile(name)),
      status: async () => ok(await BeeStore.backup.status()),
    };

    maintenance = {
      recalculateStock: async () => ok(await BeeStore.maintenance.recalculateStock()),
      integrityCheck: async () => ok(await BeeStore.maintenance.integrityCheck()),
      resetAll: async () => ok(await BeeStore.maintenance.resetAll()),
      isDatabaseEmpty: async () => ok(await BeeStore.maintenance.isDatabaseEmpty()),
    };

    audit = {
      list: async (limit) => ok(await BeeStore.audit.list(limit)),
    };
  }

  BeeStore.Api = Api;
  if (typeof module !== 'undefined') module.exports = Api;
})(typeof window !== 'undefined' ? window : globalThis);
