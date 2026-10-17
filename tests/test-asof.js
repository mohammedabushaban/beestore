const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
['settings', 'audit', 'accounts', 'categories', 'products', 'variants', 'stock',
 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers', 'expenses',
 'payroll', 'employees', 'transactions', 'periods', 'reports', 'dashboard', 'backup',
 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

async function freshApi() {
  const repo = new MemoryRepository();
  await repo.open();
  return new Api(repo);
}

// Fixed clock per test: fixtures are October 2026, so "today" is pinned
// (future-date blocking stays deterministic no matter when tests run).
function useClock(date) { BeeStore.dates.setClock(() => date); }

// Shared mini-ledger: Oct 2026 flows with known values.
async function buildScenario(api) {
  await api.settings.save({ systemStartDate: '2026-10-01' });
  const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const sup = (await api.suppliers.create({ name: 'S' })).data;
  const cus = (await api.customers.create({ name: 'A' })).data;
  const prd = (await api.products.create({
    name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-10-01',
  })).data;
  await api.transactions.ownerTransaction({
    date: '2026-10-01', type: 'capital_in', amountMinor: 500000, accountId: acc.id,
  });
  await api.purchases.create({
    date: '2026-10-01', supplierId: sup.id, supplierName: 'S',
    lines: [{ variantId: v.id, qty: 100, unitCostMinor: 1000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 100000, date: '2026-10-01' }],
  });
  await api.sales.create({
    date: '2026-10-10', customerId: cus.id, customerName: 'A',
    lines: [{ variantId: v.id, qty: 55, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 70000, date: '2026-10-10' }],
  });
  await api.expenses.create({ date: '2026-10-05', amountMinor: 20000, description: 'rent', accountId: acc.id });
  await api.expenses.create({ date: '2026-10-15', amountMinor: 3000, description: 'elec', accountId: acc.id });
  const e1 = (await api.employees.create({ name: 'E1', baseSalaryMinor: 6000 })).data;
  const e2 = (await api.employees.create({ name: 'E2', baseSalaryMinor: 4000 })).data;
  await api.payroll.prepare('2026-10');
  await api.expenses.spread({
    date: '2026-10-03', amountMinor: 120000, description: 'insurance',
    months: 12, startMonth: '2026-10', accountId: acc.id,
  });
  return { acc, sup, cus, v, e1, e2 };
}

test('V2 inventory value as of dates', async () => {
  useClock('2026-10-31');
  const api = await freshApi();
  await buildScenario(api);
  const d1 = (await api.stock.valueAsOf('2026-10-01')).data;
  assert.strictEqual(d1.totalCost, 100000);
  const d5 = (await api.stock.valueAsOf('2026-10-05')).data;
  assert.strictEqual(d5.totalCost, 100000, 'no sale yet');
  const d31 = (await api.stock.valueAsOf('2026-10-31')).data;
  assert.strictEqual(d31.totalCost, 45000, '100000 - 55*1000');
  const d0 = (await api.stock.valueAsOf('2026-09-30')).data;
  assert.strictEqual(d0.totalCost, 0);
});

test('V2 account balance as of dates', async () => {
  useClock('2026-10-31');
  const api = await freshApi();
  const { acc } = await buildScenario(api);
  assert.strictEqual((await api.accounts.balanceAsOf(acc.id, '2026-10-01')).data, 400000);
  assert.strictEqual((await api.accounts.balanceAsOf(acc.id, '2026-10-31')).data, 327000);
});

test('V2 customer/supplier balances as of dates', async () => {
  useClock('2026-10-31');
  const api = await freshApi();
  const { cus, sup } = await buildScenario(api);
  assert.strictEqual((await api.customers.balance(cus.id, '2026-10-09')).data, 0);
  assert.strictEqual((await api.customers.balance(cus.id, '2026-10-31')).data, 40000);
  assert.strictEqual((await api.suppliers.balance(sup.id, '2026-10-31')).data, 0);
});

test('V2 prepaid and accrued as of dates', async () => {
  useClock('2026-10-31');
  const api = await freshApi();
  await buildScenario(api);
  const pre0 = await BeeStore.expenses.prepaidAsOf('2026-10-02');
  assert.strictEqual(pre0.total, 0, 'not paid yet');
  const pre31 = await BeeStore.expenses.prepaidAsOf('2026-10-31');
  assert.strictEqual(pre31.total, 110000, '11 shares remain');
  const acc31 = await BeeStore.payroll.accruedAsOf('2026-10-31');
  assert.strictEqual(acc31.total, 10000, 'October payroll unpaid');
});

test('V2 paying October payroll in November clears accrual, keeps October P&L', async () => {
  useClock('2026-11-15');
  const api = await freshApi();
  await buildScenario(api);
  const list = (await api.payroll.list({ month: '2026-10' })).data;
  for (const p of list) await api.payroll.pay(p.id, 'cash', null, '', 0, '2026-11-02');
  const accOct = await BeeStore.payroll.accruedAsOf('2026-10-31');
  assert.strictEqual(accOct.total, 10000, 'still owed at Oct 31 (paid later)');
  const accNov = await BeeStore.payroll.accruedAsOf('2026-11-30');
  assert.strictEqual(accNov.total, 0, 'settled in November');
  const pnlOct = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  assert.strictEqual(pnlOct.salaryExpense, 10000, 'October expense unchanged by November payment');
  const pnlNov = (await api.reports.profitAndLoss('2026-11-01', '2026-11-30')).data;
  assert.strictEqual(pnlNov.salaryExpense, 0, 'no November salary expense');
});

test('V2 balance snapshot balances with v2 equation', async () => {
  useClock('2026-10-31');
  const api = await freshApi();
  await buildScenario(api);
  const s = (await api.reports.balanceSnapshot('2026-10-31')).data;
  assert.strictEqual(s.assets.cashBalance, 327000);
  assert.strictEqual(s.assets.inventoryValue, 45000);
  assert.strictEqual(s.assets.receivables, 40000);
  assert.strictEqual(s.assets.prepaid, 110000);
  assert.strictEqual(s.liabilities.accruedSalaries, 10000);
  assert.strictEqual(s.equity.openingEquity, 0);
  assert.strictEqual(s.equity.capitalIn, 500000);
  assert.strictEqual(s.balanced, true, 'Assets must equal Liabilities + Equity');
  assert.strictEqual(s.assets.total, s.liabilities.total + s.equity.total);
});
