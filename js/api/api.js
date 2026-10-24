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
        'settings', 'accounts', 'categories', 'products', 'variants', 'stock',
        'sales', 'returns', 'customers', 'suppliers', 'purchases', 'purchaseReturns',
        'expenses', 'employees', 'payroll', 'transactions', 'periods',
        'reports', 'dashboard', 'backup', 'maintenance', 'audit',
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
        if (key === 'repo') continue;
        const ns = this[key];
        if (!ns || typeof ns !== 'object') continue;
        for (const m of Object.keys(ns)) {
          if (typeof ns[m] !== 'function') continue;
          const fn = ns[m].bind(ns);
          ns[m] = async (...args) => {
            try {
              return await fn(...args);
            } catch (e) {
              const code = (e && e.code) || 'UNKNOWN';
              const message = (e && e.message) || 'حدث خطأ غير معروف';
              return fail(code, message);
            }
          };
        }
    }
  }

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
      dailyClosing: async (data) => ok(await BeeStore.transactions.dailyClosing(data)),
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
