const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
require('../js/storage/migrations.js');
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

async function makeCash(api) {
  return (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
}

async function makeStock(api, qty, cost, price) {
  const prd = (await api.products.create({
    name: 'PP', defaultCostMinor: cost, defaultPriceMinor: price,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'R',
    quantity: qty, costMinor: cost, priceMinor: price,
    date: '2026-08-01',
  })).data;
  return v;
}

// v2 §13.1.7: ordered closing — later month blocked while earlier is open.
test('V2 close blocked when earlier month open, then closes in order', async () => {
  const api = await freshApi();
  const v = await makeStock(api, 10, 2000, 3500);
  await api.sales.create({
    date: '2026-08-10',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
    payments: [{ method: 'cash', accountId: (await makeCash(api)).id, amountMinor: 3500 }],
  });
  await api.sales.create({
    date: '2026-09-10',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
    payments: [{ method: 'cash', accountId: (await makeCash(api)).id, amountMinor: 3500 }],
  });
  const bad = await api.periods.close('2026-09');
  assert.strictEqual(bad.ok, false, 'September must wait for August');
  assert.strictEqual(bad.error.code, 'CONFLICT');
  assert.strictEqual((await api.periods.close('2026-08')).ok, true);
  assert.strictEqual((await api.periods.close('2026-09')).ok, true);
  assert.strictEqual(await BeeStore.periods.isClosed('2026-08'), true);
});

// v2 §13.1.7: every document type locked in a closed month.
test('V2 closed month rejects create/edit/void', async () => {
  const api = await freshApi();
  const v = await makeStock(api, 10, 2000, 3500);
  const sale = (await api.sales.create({
    date: '2026-08-10',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
    payments: [{ method: 'cash', accountId: (await makeCash(api)).id, amountMinor: 3500 }],
  })).data;
  assert.strictEqual((await api.periods.close('2026-08')).ok, true);

  const s = await api.sales.create({
    date: '2026-08-11',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
    payments: [{ method: 'cash', accountId: (await makeCash(api)).id, amountMinor: 3500 }],
  });
  assert.strictEqual(s.ok, false); assert.strictEqual(s.error.code, 'PERIOD_CLOSED');

  const e = await api.expenses.create({ date: '2026-08-31', amountMinor: 100 });
  assert.strictEqual(e.ok, false); assert.strictEqual(e.error.code, 'PERIOD_CLOSED');

  const p = await api.purchases.create({
    date: '2026-08-15', supplierId: 'x',
    lines: [{ variantId: v.id, qty: 1, unitCostMinor: 2000 }],
  });
  assert.strictEqual(p.ok, false); assert.strictEqual(p.error.code, 'PERIOD_CLOSED');

  const vd = await api.sales.void(sale.id, 'test');
  assert.strictEqual(vd.ok, false, 'void of closed-month invoice rejected');
  assert.strictEqual(vd.error.code, 'PERIOD_CLOSED');
});

// v2 §7.4: settling old debts today is a current-month cash event (allowed).
test('V2 collecting old invoice payment today is allowed', async () => {
  const api = await freshApi();
  const v = await makeStock(api, 10, 2000, 3500);
  const cus = (await api.customers.create({ name: 'A' })).data;
  const sale = (await api.sales.create({
    date: '2026-08-10', customerId: cus.id, customerName: 'A',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
    payments: [],
  })).data;
  assert.strictEqual((await api.periods.close('2026-08')).ok, true);
  const pay = await api.customers.receivePayment({
    customerId: cus.id, amountMinor: 3500, method: 'cash',
    date: BeeStore.dates.today(),
  });
  assert.strictEqual(pay.ok, true, 'today-dated collection allowed');
  const updated = (await api.sales.get(sale.id)).data;
  assert.strictEqual(updated.dueMinor, 0);
});

// v2 §7.5: reopen only the latest closed month.
test('V2 reopen only latest, sequentially', async () => {
  const api = await freshApi();
  const v = await makeStock(api, 10, 2000, 3500);
  for (const d of ['2026-08-10', '2026-09-10']) {
    await api.sales.create({
      date: d, lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
      payments: [{ method: 'cash', accountId: (await makeCash(api)).id, amountMinor: 3500 }],
    });
  }
  await api.periods.close('2026-08');
  await api.periods.close('2026-09');
  const early = await api.periods.reopen('2026-08', 'test');
  assert.strictEqual(early.ok, false, 'cannot skip to August');
  assert.strictEqual((await api.periods.reopen('2026-09', 'correction')).ok, true);
  assert.strictEqual((await api.periods.reopen('2026-08', 'correction')).ok, true);
  const posting = await api.expenses.create({ date: '2026-08-15', amountMinor: 100 });
  assert.strictEqual(posting.ok, true, 'reopened month accepts postings again');
});

// v2 §13.1.7: stored snapshot equals recomputation.
test('V2 closing snapshot equals recomputation', async () => {
  const api = await freshApi();
  const v = await makeStock(api, 10, 2000, 3500);
  const acc = await makeCash(api);
  await api.sales.create({
    date: '2026-08-10',
    lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 3500 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 7000 }],
  });
  await api.expenses.create({ date: '2026-08-05', amountMinor: 20000, description: 'rent', accountId: acc.id });
  const closed = (await api.periods.close('2026-08')).data;
  const pnl = (await api.reports.profitAndLoss('2026-08-01', '2026-08-31')).data;
  assert.strictEqual(closed.snapshot.netSales, pnl.netSales);
  assert.strictEqual(closed.snapshot.cogs, pnl.cogs);
  assert.strictEqual(closed.snapshot.netProfit, pnl.netProfit);
  assert.strictEqual(closed.snapshot.operatingExpenses, pnl.operatingExpenses);
});

// v2 §2: future dates and pre-start dates rejected.
test('V2 future and pre-start dates rejected', async () => {
  const api = await freshApi();
  await makeStock(api, 10, 2000, 3500);
  const fut = await api.expenses.create({ date: '2099-01-01', amountMinor: 100 });
  assert.strictEqual(fut.ok, false);
  assert.strictEqual(fut.error.code, 'VALIDATION');
  await api.settings.save({ systemStartDate: '2026-09-01' });
  const early = await api.expenses.create({ date: '2026-08-15', amountMinor: 100 });
  assert.strictEqual(early.ok, false);
  const okAfter = await api.expenses.create({ date: '2026-09-15', amountMinor: 100 });
  assert.strictEqual(okAfter.ok, true);
});

// v2 §13.1.10: migration backfills v2 fields and systemStartDate.
test('V2 migration v2->v3 backfills fields', async () => {
  const dump = {
    schemaVersion: 2,
    meta: { id: 'meta', schemaVersion: 2, counters: {}, revision: 1 },
    settings: { id: 'settings' },
    collections: {
      expenses: [{ id: 'e1', date: '2026-08-05', amountMinor: 100 }],
      recurringExpenses: [{ id: 'r1' }],
      purchases: [{ id: 'p1', lines: [{ qty: 2 }] }],
      sales: [], purchases2: [],
    },
  };
  const out = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
  assert.strictEqual(out.schemaVersion, 6);
  assert.strictEqual(out.meta.schemaVersion, 6);
  assert.strictEqual(out.collections.expenses[0].month, '2026-08');
  assert.strictEqual(out.collections.expenses[0].voided, false);
  assert.deepStrictEqual(out.collections.expenses[0].allocation, { mode: 'single' });
  assert.strictEqual(out.collections.purchases[0].lines[0].returnedQty, 0);
  assert.strictEqual(out.settings.systemStartDate, '2026-08-01');
  // A1 chart seed travels with the migration and never creates tax account 2300.
  const codes = out.collections.chartOfAccounts.map(a => a.code);
  assert.ok(codes.includes('1010'));
  assert.ok(codes.includes('4010'));
  assert.ok(codes.includes('6010'));
  assert.ok(!codes.includes('2300'));
  assert.deepStrictEqual(out.collections.journalEntries, []);
  assert.strictEqual(out.meta.counters.journal, 0);
});

test('V2 monthsWithData lists months with docs, sorted', async () => {
  const api = await freshApi();
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const v = await makeStock(api, 10, 2000, 3500);
    const acc = await makeCash(api);
    await api.sales.create({
      date: '2026-09-10',
      lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 3500 }],
      payments: [{ method: 'cash', accountId: acc.id, amountMinor: 3500 }],
    });
    await api.expenses.create({ date: '2026-08-05', amountMinor: 100, accountId: acc.id });
    const months = (await api.periods.monthsWithData()).data;
    assert.deepStrictEqual(months, ['2026-08', '2026-09']);
    const check = (await api.periods.checklist('2026-09')).data;
    const levels = check.items.map(i => i.level);
    assert.ok(levels.includes('blocker'), 'has blockers');
    assert.ok(levels.includes('warning'), 'has warnings');
    assert.ok(levels.includes('info'), 'has info rows (§7.2 stocktake/overdue/daily)');
  } finally {
    BeeStore.dates.resetClock();
  }
});
