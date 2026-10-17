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
function useClock(date) { BeeStore.dates.setClock(() => date); }

async function buildScenario(api) {
  useClock('2026-10-31');
  await api.settings.save({ systemStartDate: '2026-10-01' });
  const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const cus = (await api.customers.create({ name: 'A' })).data;
  const sup = (await api.suppliers.create({ name: 'S' })).data;
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
  await api.employees.create({ name: 'E1', baseSalaryMinor: 10000 });
  await api.payroll.prepare('2026-10');
  await api.expenses.spread({
    date: '2026-10-03', amountMinor: 120000, description: 'insurance',
    months: 12, startMonth: '2026-10', accountId: acc.id,
  });
  return { acc };
}

// v2 §9.1: KPIs consistent with P&L; cashflow ties to balances.
test('V2 month review is internally consistent', async () => {
  const api = await freshApi();
  await buildScenario(api);
  const r = (await api.reports.monthReview('2026-10')).data;
  assert.strictEqual(r.closed, false);
  assert.strictEqual(r.kpis.netSales, 110000);
  assert.strictEqual(r.kpis.units, 55);
  assert.strictEqual(r.kpis.invoices, 1);
  assert.strictEqual(r.kpis.netProfit, r.pnl.current.netProfit);
  assert.strictEqual(r.cashflow.closeTotal - r.cashflow.openTotal, 330000 - 0);
  assert.deepStrictEqual(r.balances.receivables, [0, 40000]);
  assert.deepStrictEqual(r.balances.prepaid, [0, 110000]);
  assert.strictEqual(r.payroll.length, 1);
  assert.strictEqual(r.customers.newCredit, 40000);
  assert.strictEqual(r.customers.collected, 0);
  await api.periods.close('2026-10');
  const locked = (await api.reports.monthReview('2026-10')).data;
  assert.strictEqual(locked.closed, true);
});

// v2 §9.3 + §13.1.8: reconciliation equals actual cash change.
test('V2 profit-cash reconciliation ties out', async () => {
  const api = await freshApi();
  await buildScenario(api);
  const r = (await api.reports.profitCashReconciliation('2026-10')).data;
  assert.strictEqual(r.matches, true);
  assert.strictEqual(r.cashChange, r.actualCashChange);
  assert.strictEqual(r.actualCashChange, 330000);
});

// v2 §9.4: side-by-side diffs.
test('V2 compare months diffs', async () => {
  const api = await freshApi();
  await buildScenario(api);
  const c = (await api.reports.compareMonths('2026-09', '2026-10')).data;
  assert.strictEqual(c.diff.netSales, 110000);
  assert.strictEqual(c.a.netSales, 0);
  assert.strictEqual(c.b.netSales, 110000);
});

// v2 §9.2: year totals equal month sums; statuses present.
test('V2 year overview totals and statuses', async () => {
  const api = await freshApi();
  await buildScenario(api);
  await api.periods.close('2026-10');
  const y = (await api.reports.yearOverview('2026')).data;
  assert.strictEqual(y.months.length, 12);
  assert.strictEqual(y.totals.netSales, 110000);
  const oct = y.months.find(m => m.month === '2026-10');
  assert.strictEqual(oct.closed, true);
  assert.strictEqual(oct.netProfit, 15000);
  // Nov + Dec carry only the insurance share: 15000 - 10000 - 10000.
  assert.strictEqual(y.totals.netProfit, -5000);
  const sumMonths = y.months.reduce((a, m) => a + m.netProfit, 0);
  assert.strictEqual(y.totals.netProfit, sumMonths);
  assert.ok(y.best && y.worst);
});

// v2 §9.5/§12.1.8: dashboard month KPIs equal the accrual P&L (spread shares,
// salary accrual) — one source of truth, no parallel cash-date computation.
test('V2 dashboard month figures match P&L', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-11-01',
    })).data;
    await api.stock.adjust(v.id, 10, 'open', '2026-11-01');
    await api.sales.create({
      date: '2026-11-10',
      lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
      payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000 }],
    });
    // Spread expense paid in full this month: only one share hits P&L.
    await api.expenses.spread({
      date: '2026-11-03', amountMinor: 120000, description: 'ins',
      months: 12, startMonth: '2026-11', accountId: acc.id,
    });
    // Unpaid salary accrues in P&L even though no cash moved.
    await api.employees.create({ name: 'E1', baseSalaryMinor: 6000 });
    await api.payroll.prepare('2026-11');
    const dash = (await api.dashboard.get()).data;
    const pnl = (await api.reports.profitAndLoss('2026-11-01', '2026-11-15')).data;
    assert.strictEqual(dash.month.revenue, pnl.netSales);
    assert.strictEqual(dash.month.grossProfit, pnl.grossProfit);
    assert.strictEqual(dash.month.expenses, pnl.operatingExpenses);
    assert.strictEqual(dash.month.netProfit, pnl.netProfit);
    assert.strictEqual(dash.month.expenses, 16000, 'insurance share 10000 + salary 6000');
  } finally {
    BeeStore.dates.resetClock();
  }
});
