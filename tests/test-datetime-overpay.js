const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors', 'chartSeed']
  .forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
require('../js/storage/migrations.js');
['settings', 'auth', 'audit', 'accounts', 'categories', 'products', 'variants',
  'stock', 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns',
  'suppliers', 'expenses', 'employees', 'payroll', 'fixedAssets', 'transactions',
  'periods', 'chartOfAccounts', 'journal', 'posting', 'dailyClosing', 'reports',
  'dashboard', 'backup', 'maintenance', 'settlements', 'zip', 'xlsx', 'monthReviewPdf',
  'accountingPackage'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

test.afterEach(() => BeeStore.dates.resetClock());

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

async function freshApi(clock, options) {
  useClock(clock || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: (options && options.systemStartDate) || '2026-10-01',
    blockFutureDates: true,
  }), 'settings');
  await BeeStore.chart.ensureSeeded();
  return { repo, api };
}

async function moneyAccounts(api, opts) {
  const o = opts || {};
  const cash = ok(await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: o.cash || 0,
  }), 'cash account');
  const bank = ok(await api.accounts.create({
    name: 'البنك', type: 'bank', openingBalanceMinor: o.bank || 0,
  }), 'bank account');
  ok(await api.settings.save({
    systemStartDate: o.systemStartDate || '2026-10-01',
    blockFutureDates: true,
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', accountId: bank.id },
    ],
  }), 'settings with accounts');
  return { cash, bank };
}

test('R8 time formatting: 12h with ص/م by default, 24h on request', () => {
  const D = BeeStore.dates;
  D.setTimeFormat('12h');
  assert.strictEqual(D.formatTime('00:05'), '12:05 ص');
  assert.strictEqual(D.formatTime('11:59'), '11:59 ص');
  assert.strictEqual(D.formatTime('12:30'), '12:30 م');
  assert.strictEqual(D.formatTime('23:59:10'), '11:59 م');
  assert.strictEqual(D.formatTime(''), '');
  D.setTimeFormat('24h');
  assert.strictEqual(D.formatTime('09:07'), '09:07');
  assert.strictEqual(D.formatDocDateTime({ date: '2026-11-04', time: '14:20' }), '2026-11-04 14:20');
  D.setTimeFormat('12h');
  assert.strictEqual(D.formatDocDateTime({ date: '2026-11-04', time: '14:20' }), '2026-11-04 2:20 م');
});

test('R8 records without time fall back to createdAt only on the same business date', () => {
  const D = BeeStore.dates;
  D.setTimeFormat('24h');
  const created = new Date(2026, 10, 4, 9, 15).toISOString();
  assert.strictEqual(D.formatDocDateTime({ date: '2026-11-04', createdAt: created }), '2026-11-04 09:15');
  // Imported/back-dated row: the import time would be misleading.
  assert.strictEqual(D.formatDocDateTime({ date: '2026-10-01', createdAt: created }), '2026-10-01');
  assert.strictEqual(D.formatDocDateTime({ purchaseDate: '2026-11-04', createdAt: created }, 'purchaseDate'),
    '2026-11-04 09:15');
  D.setTimeFormat('12h');
});

test('R8 new documents store a time; time never moves the business date', async () => {
  const { api } = await freshApi('2026-10-31');
  const { cash, bank } = await moneyAccounts(api, { cash: 500000 });
  const TIME_RE = /^\d{2}:\d{2}/;
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const customer = ok(await api.customers.create({ name: 'زبون', phone: '0599000000' }), 'customer');
  const product = ok(await api.products.create({ name: 'قميص', defaultCostMinor: 1000, defaultPriceMinor: 2500 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق', quantity: 5, costMinor: 1000, priceMinor: 2500, date: '2026-10-01',
  }), 'variant');

  const purchase = ok(await api.purchases.create({
    date: '2026-10-05', supplierId: supplier.id,
    lines: [{ variantId: variant.id, qty: 1, unitCostMinor: 1000 }], payments: [],
  }), 'purchase');
  assert.match(purchase.time, TIME_RE);
  const spay = ok(await api.suppliers.pay({ supplierId: supplier.id, amountMinor: 500, method: 'cash', date: '2026-10-06' }), 'supplier payment');
  assert.match(spay.time, TIME_RE);
  const expense = ok(await api.expenses.create({ date: '2026-10-07', amountMinor: 1000, categoryName: 'ماء', method: 'cash' }), 'expense');
  assert.match(expense.time, TIME_RE);
  const transfer = ok(await api.transactions.transfer({
    date: '2026-10-08', fromAccountId: cash.id, toAccountId: bank.id, amountMinor: 1000,
  }), 'transfer');
  assert.match(transfer.time, TIME_RE);

  const late = ok(await api.sales.create({
    date: '2026-10-30', time: '23:59', customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 2500 }],
    payments: [{ method: 'cash', amountMinor: 2500 }],
  }), 'late sale');
  const early = ok(await api.sales.create({
    date: '2026-10-31', time: '00:01', customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 2500 }],
    payments: [{ method: 'cash', amountMinor: 2500 }],
  }), 'early sale');
  assert.strictEqual(late.date, '2026-10-30');
  assert.strictEqual(early.date, '2026-10-31');
  const cpay = ok(await api.customers.receivePayment({
    customerId: customer.id, amountMinor: 100, method: 'cash', date: '2026-10-31',
  }), 'customer payment');
  assert.match(cpay.time || '', TIME_RE);
});

test('R2 overpayment is stored on the sale for the invoices page', async () => {
  const { api } = await freshApi('2026-10-31');
  await moneyAccounts(api, { cash: 0 });
  const customer = ok(await api.customers.create({ name: 'زبون', phone: '0599000001' }), 'customer');
  const product = ok(await api.products.create({ name: 'حذاء', defaultCostMinor: 1000, defaultPriceMinor: 9500 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: '42', color: 'أسود', quantity: 5, costMinor: 1000, priceMinor: 9500, date: '2026-10-01',
  }), 'variant');
  for (const [mode, expectChange] of [['change', 500], ['customer_credit', 0]]) {
    const sale = ok(await api.sales.create({
      date: '2026-10-31', customerId: customer.id, overpaymentMode: mode,
      lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 9500 }],
      payments: [{ method: 'cash', amountMinor: 10000 }],
    }), mode + ' sale');
    assert.strictEqual(sale.overpaymentMinor, 500, mode);
    assert.strictEqual(sale.overpaymentMode, mode);
    assert.strictEqual(sale.changeGivenMinor, expectChange);
    assert.strictEqual(sale.paidMinor, 9500);
    const listed = ok(await api.sales.list({}), 'list').find(s => s.id === sale.id);
    assert.strictEqual(listed.overpaymentMinor, 500, 'list keeps the overpayment');
  }
});
