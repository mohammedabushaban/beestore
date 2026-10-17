(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const COLLECTIONS = [
    'accounts', 'categories', 'products', 'variants', 'stockMovements',
    'customers', 'sales', 'salesReturns', 'customerPayments',
    'suppliers', 'purchases', 'purchaseReturns', 'supplierPayments',
    'expenseCategories', 'expenses', 'recurringExpenses',
    'employees', 'payroll', 'employeeAdvances',
    'ownerTransactions', 'transfers', 'dailyClosings', 'auditLog', 'meta',
    'periodClosings', 'errorLog',
  ];

  class RepositoryInterface {
    async open() { throw new Error('not implemented'); }
    async get(collection, id) { throw new Error('not implemented'); }
    async list(collection, predicate) { throw new Error('not implemented'); }
    async query(collection, indexName, valueOrRange) { throw new Error('not implemented'); }
    async transaction(fn) { throw new Error('not implemented'); }
    async exportAll() { throw new Error('not implemented'); }
    async importAll(json) { throw new Error('not implemented'); }
    async clearAll() { throw new Error('not implemented'); }
  }

  BeeStore.RepositoryInterface = RepositoryInterface;
  BeeStore.COLLECTIONS = COLLECTIONS;
  if (typeof module !== 'undefined') module.exports = { RepositoryInterface, COLLECTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
