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

// v2 §5: flow lists accept { from, to } for period scoping.
test('V2 flow lists filter by period range', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const sup = (await api.suppliers.create({ name: 'S' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-10-01',
    })).data;
    await api.stock.adjust(v.id, 100, 'open', '2026-10-01');
    for (const date of ['2026-10-05', '2026-11-06']) {
      await api.purchases.create({
        date, supplierId: sup.id, supplierName: 'S',
        lines: [{ variantId: v.id, qty: 5, unitCostMinor: 1000 }],
        payments: [{ method: 'cash', accountId: acc.id, amountMinor: 5000, date }],
      });
      await api.sales.create({
        date, lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 2000 }],
        payments: [{ method: 'cash', accountId: acc.id, amountMinor: 2000, date }],
      });
      await api.expenses.create({ date, amountMinor: 100, description: 'x', accountId: acc.id });
    }
    const oct = { from: '2026-10-01', to: '2026-10-31' };
    assert.strictEqual((await api.purchases.list(oct)).data.length, 1);
    assert.strictEqual((await api.sales.list(oct)).data.length, 1);
    assert.strictEqual((await api.expenses.list(oct)).data.length, 1);
    assert.strictEqual((await api.purchases.list()).data.length, 2);

    // Returns carry the return date's month (v2 §4), filterable too.
    const sale = (await api.sales.list(oct)).data[0];
    assert.strictEqual((await api.returns.create({ saleId: sale.id, date: '2026-11-10', lines: [{ saleLineIndex: 0, qty: 1 }], refundMode: 'cash_refund', accountId: acc.id })).ok, true);
    assert.strictEqual((await api.returns.list(oct)).data.length, 0);
    assert.strictEqual((await api.returns.list({ from: '2026-11-01', to: '2026-11-30' })).data.length, 1);

    const pur = (await api.purchases.list(oct)).data[0];
    assert.strictEqual((await api.purchaseReturns.create({ purchaseId: pur.id, date: '2026-11-11', lines: [{ purchaseLineIndex: 0, qty: 1 }], mode: 'cash_refund', accountId: acc.id })).ok, true);
    assert.strictEqual((await api.purchaseReturns.list(oct)).data.length, 0);
    assert.strictEqual((await api.purchaseReturns.list({ from: '2026-11-01', to: '2026-11-30' })).data.length, 1);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §5: supplier statement exists; opening + period moves = closing.
test('V2 supplier statement with opening/closing identity', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const sup = (await api.suppliers.create({ name: 'S' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-10-01',
    })).data;
    await api.stock.adjust(v.id, 100, 'open', '2026-10-01');
    await api.purchases.create({
      date: '2026-10-05', supplierId: sup.id, supplierName: 'S',
      lines: [{ variantId: v.id, qty: 10, unitCostMinor: 1000 }],
      payments: [],
    });
    await api.suppliers.pay({ supplierId: sup.id, amountMinor: 4000, method: 'cash', accountId: acc.id, date: '2026-11-06' });
    const st = (await api.suppliers.statement(sup.id)).data;
    assert.strictEqual(st.purchases.length, 1);
    assert.strictEqual(st.payments.length, 1);
    assert.strictEqual(st.balance, 6000);
    const opening = (await api.suppliers.balance(sup.id, '2026-10-31')).data;
    const closing = (await api.suppliers.balance(sup.id, '2026-11-30')).data;
    assert.strictEqual(opening, 10000);
    assert.strictEqual(closing, opening - 4000);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §13.1.2: month boundaries — Oct 31 belongs to October, Nov 1 to November.
// (Business dates are day strings; there is no time-of-day component.)
test('V2 month-boundary documents attribute to the right month', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    await api.expenses.create({ date: '2026-10-31', amountMinor: 3100, description: 'oct', accountId: acc.id });
    await api.expenses.create({ date: '2026-11-01', amountMinor: 1100, description: 'nov', accountId: acc.id });
    const oct = await api.reports.profitAndLoss('2026-10-01', '2026-10-31');
    const nov = await api.reports.profitAndLoss('2026-11-01', '2026-11-30');
    assert.strictEqual(oct.data.operatingExpenses, 3100);
    assert.strictEqual(nov.data.operatingExpenses, 1100);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §13.1.5: a November return of an October sale hits November P&L only.
test('V2 November return reduces November net sales, not October', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-10-01',
    })).data;
    await api.stock.adjust(v.id, 10, 'open', '2026-10-01');
    const sale = (await api.sales.create({
      date: '2026-10-10',
      lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
      payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000 }],
    })).data;
    const octBefore = await api.reports.profitAndLoss('2026-10-01', '2026-10-31');
    assert.strictEqual(octBefore.data.netSales, 4000);
    assert.strictEqual((await api.returns.create({
      saleId: sale.id, date: '2026-11-10', lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    })).ok, true);
    const octAfter = await api.reports.profitAndLoss('2026-10-01', '2026-10-31');
    const nov = await api.reports.profitAndLoss('2026-11-01', '2026-11-30');
    assert.strictEqual(octAfter.data.netSales, 4000, 'October untouched');
    assert.strictEqual(octAfter.data.cogs, 2000, 'October COGS untouched');
    assert.strictEqual(nov.data.netSales, -2000, 'November absorbs the return');
    assert.strictEqual(nov.data.cogs, -1000, 'November COGS reduced');
  } finally {
    BeeStore.dates.resetClock();
  }
});
