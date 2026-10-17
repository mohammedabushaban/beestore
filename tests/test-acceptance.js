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

// v2 §13.2 acceptance scenario — must pass exactly, to the cent.
// Setup: systemStartDate 2026-10-01, no opening balances, capital 5,000.00.
test('V2 §13.2 acceptance scenario (October + November)', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);

  await api.settings.save({ systemStartDate: '2026-10-01' });
  const cash = (await api.accounts.create({ name: 'الصندوق', type: 'cash' })).data;
  const sup = (await api.suppliers.create({ name: 'S' })).data;
  const cusA = (await api.customers.create({ name: 'A' })).data;
  const p1 = (await api.products.create({ name: 'V1', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
  const p2 = (await api.products.create({ name: 'V2', defaultCostMinor: 1250, defaultPriceMinor: 2000 })).data;
  const v1 = (await api.variants.create({
    productId: p1.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-10-01',
  })).data;
  const v2 = (await api.variants.create({
    productId: p2.id, size: 'L', color: 'B', priceMinor: 2000, date: '2026-10-01',
  })).data;

  // Capital in 5,000.00 on Oct 1.
  await api.transactions.ownerTransaction({
    date: '2026-10-01', type: 'capital_in', amountMinor: 500000, accountId: cash.id,
  });

  // 1. Oct 1: buy 1,000.00 inventory, paid cash.
  const pur = (await api.purchases.create({
    date: '2026-10-01', supplierId: sup.id, supplierName: 'S',
    lines: [
      { variantId: v1.id, qty: 50, unitCostMinor: 1000 },
      { variantId: v2.id, qty: 40, unitCostMinor: 1250 },
    ],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 100000, date: '2026-10-01' }],
  })).data;
  assert.strictEqual(pur.status, 'paid');

  // 2. Oct 10: sell 1,000.00 (700 cash + 300 credit to A), COGS 550.00.
  await api.sales.create({
    date: '2026-10-10', customerId: cusA.id, customerName: 'A',
    lines: [{ variantId: v1.id, qty: 30, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 50000, date: '2026-10-10' }],
  });
  await api.sales.create({
    date: '2026-10-10', customerId: cusA.id, customerName: 'A',
    lines: [{ variantId: v2.id, qty: 20, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 20000, date: '2026-10-10' }],
  });

  // 3. Oct 5 rent 200.00; Oct 15 electricity 30.00.
  await api.expenses.create({ date: '2026-10-05', amountMinor: 20000, description: 'rent', accountId: cash.id });
  await api.expenses.create({ date: '2026-10-15', amountMinor: 3000, description: 'elec', accountId: cash.id });

  // 4. October payroll: 100.00 total, unpaid at Oct 31.
  await api.employees.create({ name: 'E1', baseSalaryMinor: 6000 });
  await api.employees.create({ name: 'E2', baseSalaryMinor: 4000 });
  await api.payroll.prepare('2026-10');

  // 5. Oct 3: annual insurance 1,200.00 cash, spread over 12 months.
  await api.expenses.spread({
    date: '2026-10-03', amountMinor: 120000, description: 'insurance',
    months: 12, startMonth: '2026-10', accountId: cash.id,
  });

  // ---- Expected October ----
  const pnl = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  assert.strictEqual(pnl.netSales, 100000);
  assert.strictEqual(pnl.cogs, 55000);
  assert.strictEqual(pnl.grossProfit, 45000);
  assert.strictEqual(pnl.salaryExpense, 10000);
  assert.strictEqual(pnl.operatingExpenses, 43000);
  assert.strictEqual(pnl.netProfit, 2000);

  const rec = (await api.reports.profitCashReconciliation('2026-10')).data;
  assert.strictEqual(rec.cashFromOperations, -173000);
  assert.strictEqual(rec.matches, true);
  assert.strictEqual(rec.actualCashChange, 327000);

  const snap = (await api.reports.balanceSnapshot('2026-10-31')).data;
  assert.strictEqual(snap.assets.cashBalance, 327000);
  assert.strictEqual(snap.assets.inventoryValue, 45000);
  assert.strictEqual(snap.assets.receivables, 30000);
  assert.strictEqual(snap.assets.prepaid, 110000);
  assert.strictEqual(snap.liabilities.accruedSalaries, 10000);
  assert.strictEqual(snap.assets.total, 512000);
  assert.strictEqual(snap.liabilities.total + snap.equity.total, 512000);
  assert.strictEqual(snap.balanced, true);
  assert.strictEqual(
    snap.equity.openingEquity + snap.equity.capitalIn - snap.equity.withdrawals + snap.equity.cumulativeProfit,
    502000);

  // Close October → locked.
  assert.strictEqual((await api.periods.close('2026-10')).ok, true);
  const locked = await api.expenses.create({ date: '2026-10-31', amountMinor: 100, accountId: cash.id });
  assert.strictEqual(locked.ok, false);
  assert.strictEqual(locked.error.code, 'PERIOD_CLOSED');

  // ---- November ----
  // 6. Nov 2: pay October payroll in cash.
  const octPay = (await api.payroll.list({ month: '2026-10' })).data;
  for (const p of octPay) {
    assert.strictEqual((await api.payroll.pay(p.id, 'cash', cash.id, '', 0, '2026-11-02')).ok, true);
  }
  // 7. Nov 12: customer A pays 300.00.
  assert.strictEqual((await api.customers.receivePayment({
    customerId: cusA.id, amountMinor: 30000, method: 'cash',
    accountId: cash.id, date: '2026-11-12',
  })).ok, true);

  const nov = (await api.reports.profitAndLoss('2026-11-01', '2026-11-30')).data;
  assert.strictEqual(nov.netSales, 0);
  assert.strictEqual(nov.operatingExpenses, 10000, 'insurance share only');
  assert.strictEqual(nov.netProfit, -10000);

  const novRec = (await api.reports.profitCashReconciliation('2026-11')).data;
  assert.strictEqual(novRec.matches, true);
  assert.strictEqual(novRec.actualCashChange, 20000);

  const novSnap = (await api.reports.balanceSnapshot('2026-11-30')).data;
  assert.strictEqual(novSnap.assets.receivables, 0);
  assert.strictEqual(novSnap.liabilities.accruedSalaries, 0);
  assert.strictEqual(novSnap.assets.prepaid, 100000);
  assert.strictEqual(novSnap.balanced, true);

  // October figures untouched by November cash events.
  const pnlOctAgain = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  assert.strictEqual(pnlOctAgain.netProfit, 2000);
  assert.strictEqual(pnlOctAgain.salaryExpense, 10000);
});
