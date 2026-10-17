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

// Seed stock (cost 1000) and a 2-unit sale @2000 on `saleDate`, paid in cash.
async function seedSale(api, saleDate) {
  const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const sup = (await api.suppliers.create({ name: 'S' })).data;
  const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: saleDate,
  })).data;
  await api.transactions.ownerTransaction({
    date: saleDate, type: 'capital_in', amountMinor: 100000, accountId: acc.id,
  });
  await api.purchases.create({
    date: saleDate, supplierId: sup.id, supplierName: 'S',
    lines: [{ variantId: v.id, qty: 10, unitCostMinor: 1000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 10000, date: saleDate }],
  });
  const sale = (await api.sales.create({
    date: saleDate, lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000, date: saleDate }],
  })).data;
  return { acc, sale };
}

// §12.1: the invoice print/view payload must expose the sale's returns.
test('printData exposes the sale returns so the invoice can show refunds', async () => {
  BeeStore.dates.setClock(() => '2026-11-20');
  try {
    const api = await freshApi();
    const { acc, sale } = await seedSale(api, '2026-11-05');
    assert.strictEqual((await api.returns.create({
      saleId: sale.id, date: '2026-11-20',
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    })).ok, true);

    const data = (await api.sales.printData(sale.id)).data;
    assert.ok(Array.isArray(data.returns), 'returns should be an array');
    assert.strictEqual(data.returns.length, 1);
    assert.strictEqual(data.returns[0].saleId, sale.id);
    assert.strictEqual(data.returns[0].refundMinor, 2000);
    assert.strictEqual(data.returns[0].refundMode, 'cash_refund');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1: sale return status is persisted and reflected on the sale.
test('a sale return marks the invoice returnStatus partial then full', async () => {
  BeeStore.dates.setClock(() => '2026-11-20');
  try {
    const api = await freshApi();
    const { acc, sale } = await seedSale(api, '2026-11-05');
    await api.returns.create({
      saleId: sale.id, date: '2026-11-10',
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    });
    let inv = (await api.sales.get(sale.id)).data;
    assert.strictEqual(inv.returnStatus, 'partial');
    assert.strictEqual(inv.lines[0].returnedQty, 1);

    await api.returns.create({
      saleId: sale.id, date: '2026-11-20',
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    });
    inv = (await api.sales.get(sale.id)).data;
    assert.strictEqual(inv.returnStatus, 'full');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1: the sales report nets returns (returns attributed to the return date
// for the day grouping, to the original customer/payment for those groupings).
test('salesReport reports returns and net per group', async () => {
  BeeStore.dates.setClock(() => '2026-11-20');
  try {
    const api = await freshApi();
    const { acc, sale } = await seedSale(api, '2026-11-05');
    await api.returns.create({
      saleId: sale.id, date: '2026-11-20',
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    });

    const byDay = (await api.reports.salesReport('2026-11-01', '2026-11-30', 'day')).data;
    assert.deepStrictEqual(day(byDay, '2026-11-05'), { count: 1, total: 4000, returns: 0, net: 4000 });
    assert.deepStrictEqual(day(byDay, '2026-11-20'), { count: 0, total: 0, returns: 2000, net: -2000 });

    const byPayment = (await api.reports.salesReport('2026-11-01', '2026-11-30', 'payment')).data;
    assert.strictEqual(byPayment.cash.total, 4000);
    assert.strictEqual(byPayment.cash.returns, 2000);
    assert.strictEqual(byPayment.cash.net, 2000);

    function day(report, key) {
      const g = report[key];
      return { count: g.count, total: g.total, returns: g.returns, net: g.net };
    }
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1: dashboard "today" and the 30-day chart are net of returns.
test('dashboard today KPIs are net of today returns', async () => {
  const today = BeeStore.dates.today();
  BeeStore.dates.setClock(() => today);
  try {
    const api = await freshApi();
    const { acc, sale } = await seedSale(api, today);
    await api.returns.create({
      saleId: sale.id, date: today,
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    });

    const dash = (await api.dashboard.get()).data;
    assert.strictEqual(dash.today.revenue, 2000, 'today revenue = 4000 gross - 2000 refund');
    assert.strictEqual(dash.today.returns, 2000);
    assert.strictEqual(dash.today.profit, 1000, 'revenue 2000 - net COGS 1000');
    assert.strictEqual(dash.salesByDay[today], 2000, 'chart day is net of returns');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1: daily closing keeps gross sales, exposes the refund, and nets the drawer.
test('daily closing nets cash refunds against expected cash', async () => {
  const today = BeeStore.dates.today();
  BeeStore.dates.setClock(() => today);
  try {
    const api = await freshApi();
    const { acc, sale } = await seedSale(api, today);
    await api.returns.create({
      saleId: sale.id, date: today,
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', accountId: acc.id,
    });

    const d = (await api.reports.dailyClosing(today)).data;
    assert.strictEqual(d.totalSales, 4000, 'gross sales retained');
    assert.strictEqual(d.refundMinor, 2000);
    assert.strictEqual(d.salesByMethod.cash, 2000, 'cash net of refund');
    assert.strictEqual(d.expectedCashMinor, 2000);
  } finally {
    BeeStore.dates.resetClock();
  }
});
