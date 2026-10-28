(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const COLLECTIONS = [
    'accounts', 'categories', 'products', 'variants', 'stockMovements',
    'customers', 'sales', 'salesReturns', 'customerPayments',
    'suppliers', 'purchases', 'purchaseReturns', 'supplierPayments',
    'expenseCategories', 'expenses', 'recurringExpenses',
    'employees', 'payroll', 'employeeAdvances',
    'ownerTransactions', 'transfers', 'dailyClosings', 'cashAdjustments',
    'chartOfAccounts', 'journalEntries',
    'auditLog', 'meta', 'periodClosings', 'errorLog',
  ];

  // v5 §5: journal entries are append-only. importAll()/restore bypasses the
  // transaction API on purpose so legacy backups can still be loaded.
  const APPEND_ONLY_COLLECTIONS = ['journalEntries'];

  function isAppendOnly(collection) {
    return APPEND_ONLY_COLLECTIONS.indexOf(collection) >= 0;
  }

  // v3-Lite §5: only master data plus recent documents stay in memory. Every
  // other dated document is read from IndexedDB on demand. Keeping the policy
  // here (not inside IdbRepository) makes it testable and keeps the memory
  // repository's behaviour transparent to services.
  const MASTER_COLLECTIONS = [
    'accounts', 'categories', 'products', 'variants', 'customers', 'suppliers',
    'expenseCategories', 'recurringExpenses', 'employees', 'periodClosings',
    'chartOfAccounts', 'meta', 'errorLog',
  ];
  const DATED_COLLECTIONS = {
    stockMovements: 'date',
    sales: 'date',
    salesReturns: 'date',
    customerPayments: 'date',
    purchases: 'date',
    purchaseReturns: 'date',
    supplierPayments: 'date',
    expenses: 'date',
    payroll: 'month',
    employeeAdvances: 'date',
    ownerTransactions: 'date',
    transfers: 'date',
    dailyClosings: 'date',
    cashAdjustments: 'date',
    journalEntries: 'date',
    auditLog: 'timestamp',
  };

  // Indexes are created once by the IndexedDB upgrade. They let range reads
  // (old months) avoid a full collection scan. IndexedDB indexes are safe to
  // add without changing the document schema.
  const INDEXES = {
    sales: [['date', 'date'], ['number', 'number'], ['clientKey', 'clientKey'], ['customerId', 'customerId']],
    salesReturns: [['date', 'date'], ['customerId', 'customerId'], ['saleId', 'saleId']],
    customerPayments: [['date', 'date'], ['customerId', 'customerId'], ['saleId', 'saleId'], ['accountId', 'accountId']],
    purchases: [['date', 'date'], ['number', 'number'], ['supplierId', 'supplierId']],
    purchaseReturns: [['date', 'date'], ['purchaseId', 'purchaseId'], ['supplierId', 'supplierId'], ['accountId', 'accountId']],
    supplierPayments: [['date', 'date'], ['supplierId', 'supplierId'], ['purchaseId', 'purchaseId'], ['accountId', 'accountId']],
    expenses: [['date', 'date'], ['month', 'month'], ['accountId', 'accountId'], ['recurringId', 'recurringId']],
    stockMovements: [
      ['date', 'date'], ['variantId', 'variantId'], ['variantDate', ['variantId', 'date']],
      ['refId', 'refId'], ['type', 'type'],
    ],
    payroll: [['month', 'month'], ['employeeId', 'employeeId'], ['status', 'status']],
    employeeAdvances: [['date', 'date'], ['employeeId', 'employeeId'], ['accountId', 'accountId']],
    ownerTransactions: [['date', 'date'], ['accountId', 'accountId']],
    transfers: [['date', 'date'], ['fromAccountId', 'fromAccountId'], ['toAccountId', 'toAccountId']],
    dailyClosings: [['date', 'date'], ['status', 'status']],
    cashAdjustments: [['date', 'date'], ['accountId', 'accountId'], ['closingId', 'closingId']],
    auditLog: [['timestamp', 'timestamp']],
    chartOfAccounts: [['code', 'code'], ['type', 'type'], ['systemKey', 'systemKey'], ['legacyAccountId', 'legacyAccountId'], ['paymentMethodId', 'paymentMethodId']],
    journalEntries: [['date', 'date'], ['number', 'number'], ['sourceId', 'sourceId'], ['sourceType', 'sourceType'], ['reversalOf', 'reversalOf']],
    variants: [['barcode', 'barcode'], ['productId', 'productId']],
    products: [['categoryId', 'categoryId']],
  };

  function dateFieldFor(collection) {
    return DATED_COLLECTIONS[collection] || null;
  }

  function memoryWindowMonths() {
    const configured = BeeStore.config && BeeStore.config.memoryWindowMonths;
    const months = Number(configured);
    return Number.isFinite(months) && months >= 0 ? Math.floor(months) : 2;
  }

  /** Pure window calculation: current month + N previous months. */
  function windowBounds(now, months) {
    const today = String(now || BeeStore.dates.today()).slice(0, 10);
    const month = today.slice(0, 7);
    const count = Number.isFinite(Number(months)) ? Math.max(0, Math.floor(Number(months))) : memoryWindowMonths();
    const startMonth = BeeStore.dates.addMonths(month, -count);
    return { startMonth: startMonth, startDate: BeeStore.dates.monthRange(startMonth).from };
  }

  function inMemoryWindow(doc, field, bounds) {
    if (!doc || !field) return true;
    const value = doc[field];
    // Keep undated legacy records in memory rather than hiding them.
    if (value === undefined || value === null || value === '') return true;
    return String(value) >= (field === 'month' ? bounds.startMonth : bounds.startDate);
  }

  function inRange(doc, field, from, to) {
    if (!doc || !field) return true;
    const value = doc[field];
    if (value === undefined || value === null || value === '') return true;
    if (from !== undefined && from !== null && from !== '' && String(value) < String(from)) return false;
    if (to !== undefined && to !== null && to !== '' && String(value) > String(to)) return false;
    return true;
  }

  class RepositoryInterface {
    async open() { throw new Error('not implemented'); }
    async get(collection, id) { throw new Error('not implemented'); }
    async list(collection, predicate) { throw new Error('not implemented'); }
    async listRange(collection, from, to, predicate) { throw new Error('not implemented'); }
    async latest(collection, limit) { throw new Error('not implemented'); }
    async count(collection) { throw new Error('not implemented'); }
    async query(collection, indexName, valueOrRange) { throw new Error('not implemented'); }
    async transaction(fn) { throw new Error('not implemented'); }
    async getSummary() { throw new Error('not implemented'); }
    async lastManyByIndex(collection, indexName, keyField, keys, dateField, toDate) { throw new Error('not implemented'); }
    async exportAll() { throw new Error('not implemented'); }
    async exportAllStreamed() { throw new Error('not implemented'); }
    async importAll(json) { throw new Error('not implemented'); }
    async clearAll() { throw new Error('not implemented'); }
  }

  BeeStore.RepositoryInterface = RepositoryInterface;
  BeeStore.COLLECTIONS = COLLECTIONS;
  BeeStore.APPEND_ONLY_COLLECTIONS = APPEND_ONLY_COLLECTIONS;
  BeeStore.isAppendOnly = isAppendOnly;
  BeeStore.storagePolicy = {
    masterCollections: MASTER_COLLECTIONS,
    datedCollections: DATED_COLLECTIONS,
    indexes: INDEXES,
    appendOnlyCollections: APPEND_ONLY_COLLECTIONS,
    dateFieldFor: dateFieldFor,
    memoryWindowMonths: memoryWindowMonths,
    windowBounds: windowBounds,
    inMemoryWindow: inMemoryWindow,
    inRange: inRange,
  };
  if (typeof module !== 'undefined') module.exports = {
    RepositoryInterface, COLLECTIONS, MASTER_COLLECTIONS, DATED_COLLECTIONS,
    INDEXES, APPEND_ONLY_COLLECTIONS, isAppendOnly, dateFieldFor, windowBounds,
    inMemoryWindow, inRange,
  };
})(typeof window !== 'undefined' ? window : globalThis);
