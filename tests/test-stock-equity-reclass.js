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
  'dashboard', 'backup', 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }
test.afterEach(() => BeeStore.dates.resetClock());

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

async function freshApi(clock) {
  useClock(clock || '2026-11-30');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: '2026-11-01',
    blockFutureDates: true,
  }), 'settings');
  await BeeStore.chart.ensureSeeded();
  return { repo, api };
}

/**
 * Opening stock 100 @ 10.00, a normal count gain (+10), two «تصحيح»
 * corrections (+5 and −2) and a sale of 10 @ 20.00.
 * Before reclassification: stockLosses = −130.00, netProfit = 230.00.
 * After: only the normal count gain remains, netProfit = 200.00.
 */
async function scenario(api, repo) {
  const cash = ok(await api.accounts.create({
    name: 'الصندوق', type: 'cash',
  }), 'cash account');
  const product = ok(await api.products.create({
    name: 'بجامة اختبار', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id,
    size: 'M', color: 'أزرق',
    costMinor: 1000, priceMinor: 2000,
    quantity: 100,
    date: '2026-11-01',
  }), 'variant');
  ok(await api.stock.adjust(variant.id, 10, 'جرد', '2026-11-05'), 'normal count gain');
  ok(await api.stock.adjust(variant.id, 5, 'تصحيح', '2026-11-06'), 'positive correction');
  ok(await api.stock.adjust(variant.id, -2, 'تصحيح', '2026-11-07'), 'negative correction');
  ok(await api.sales.create({
    date: '2026-11-10',
    lines: [{ variantId: variant.id, qty: 10, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 20000, date: '2026-11-10' }],
  }), 'sale');
  const movements = await repo.list('stockMovements');
  const corrections = movements.filter(m => m.note === 'تصحيح');
  assert.strictEqual(corrections.length, 2);
  return { cash, product, variant, corrections };
}

function pnlKeys(pnl) {
  return {
    netSales: pnl.netSales,
    cogs: pnl.cogs,
    grossProfit: pnl.grossProfit,
    stockLosses: pnl.stockLosses,
    expensesBeforeGains: pnl.expensesBeforeGains,
    gains: pnl.gains,
    salesProfit: pnl.salesProfit,
    operatingExpenses: pnl.operatingExpenses,
    netProfit: pnl.netProfit,
  };
}

async function allRoutes(api) {
  return {
    summary: ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30'), 'summary P&L'),
    document: ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30', {
      legacy: true,
    }), 'document P&L'),
    journal: ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30', {
      journal: true,
    }), 'journal P&L'),
  };
}

test('initial-stock corrections move from stock P&L to opening equity on all routes', async () => {
  const { repo, api } = await freshApi();
  await scenario(api, repo);

  const before = await allRoutes(api);
  assert.deepStrictEqual(pnlKeys(before.summary), pnlKeys(before.document));
  assert.deepStrictEqual(pnlKeys(before.summary), pnlKeys(before.journal));
  assert.strictEqual(before.summary.stockLosses, -13000);
  assert.strictEqual(before.summary.gains, 13000);
  assert.strictEqual(before.summary.salesProfit, 10000);
  assert.strictEqual(before.summary.netProfit, 23000);

  const preview = ok(await api.maintenance.previewStockEquityReclassification(), 'preview');
  assert.strictEqual(preview.count, 2);
  assert.strictEqual(preview.totalMinor, 3000);
  assert.strictEqual(preview.alreadyCount, 0);
  assert.ok(preview.candidates.every(c => c.journalState === 'posted'));

  const applied = ok(await api.maintenance.reclassifyStockEquity(), 'apply');
  assert.strictEqual(applied.count, 2);
  assert.strictEqual(applied.totalMinor, 3000);

  const movements = await repo.list('stockMovements');
  const flagged = movements.filter(m => m.pnlTreatment === 'equity');
  assert.strictEqual(flagged.length, 2);
  assert.ok(flagged.every(m => m.equityReclassEntryId));

  const after = await allRoutes(api);
  assert.deepStrictEqual(pnlKeys(after.summary), pnlKeys(after.document));
  assert.deepStrictEqual(pnlKeys(after.summary), pnlKeys(after.journal));
  assert.strictEqual(after.summary.stockLosses, -10000, 'normal count gain remains in P&L');
  assert.strictEqual(after.summary.gains, 10000);
  assert.strictEqual(after.summary.salesProfit, 10000);
  assert.strictEqual(after.summary.netProfit, 20000);
  assert.strictEqual(after.summary.netProfit,
    after.summary.salesProfit + after.summary.gains);

  const journalRows = await repo.list('journalEntries');
  const reclassRows = journalRows.filter(e => e.event === 'STOCK_EQUITY_RECLASS');
  assert.strictEqual(reclassRows.length, 2);
  const positive = reclassRows.find(e =>
    e.lines.some(l => l.debitMinor === 5000));
  const negative = reclassRows.find(e =>
    e.lines.some(l => l.debitMinor === 2000 && l.creditMinor === 0));
  assert.ok(positive, 'positive correction reclassification exists');
  assert.ok(negative, 'negative correction reclassification exists');
  const chart = await repo.list('chartOfAccounts');
  const code = (id) => {
    const account = chart.find(a => a.id === id);
    return account ? String(account.code) : '';
  };
  assert.ok(positive.lines.some(l => code(l.accountId) === '5020' && l.debitMinor === 5000));
  assert.ok(positive.lines.some(l => code(l.accountId) === '3030' && l.creditMinor === 5000));
  assert.ok(negative.lines.some(l => code(l.accountId) === '3030' && l.debitMinor === 2000));
  assert.ok(negative.lines.some(l => code(l.accountId) === '5020' && l.creditMinor === 2000));

  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(tb.balanced, true);
  assert.strictEqual(tb.accounts.find(a => String(a.code) === '5020').balanceMinor, -10000);
  assert.strictEqual(tb.accounts.find(a => String(a.code) === '3030').balanceMinor, -103000);
  const verify = await BeeStore.journal.verify();
  assert.strictEqual(verify.ok, true, JSON.stringify(verify.errors));

  const docSnap = ok(await api.reports.balanceSnapshot('2026-11-30', {
    legacy: true,
  }), 'document snapshot');
  const summarySnap = ok(await api.reports.balanceSnapshot('2026-11-30'), 'summary snapshot');
  const journalSnap = ok(await api.reports.balanceSnapshot('2026-11-30', {
    journal: true,
  }), 'journal snapshot');
  for (const snap of [docSnap, summarySnap, journalSnap]) {
    assert.strictEqual(snap.balanced, true);
    assert.strictEqual(snap.assets.inventoryValue, 103000);
    assert.strictEqual(snap.equity.openingEquity, 103000);
    assert.strictEqual(snap.equity.cumulativeProfit, 20000);
  }

  const afterPreview = ok(await api.maintenance.previewStockEquityReclassification(),
    'preview after');
  assert.strictEqual(afterPreview.count, 0);
  assert.strictEqual(afterPreview.alreadyCount, 2);
  assert.strictEqual(afterPreview.alreadyMinor, 3000);
});

test('stock equity reclassification is idempotent and replay-safe', async () => {
  const { repo, api } = await freshApi();
  await scenario(api, repo);

  const beforeEntries = await repo.count('journalEntries');
  const first = ok(await api.maintenance.reclassifyStockEquity(), 'first apply');
  assert.strictEqual(first.count, 2);
  const afterFirst = await repo.count('journalEntries');
  assert.strictEqual(afterFirst, beforeEntries + 2, 'one reclassification entry per movement');

  const second = ok(await api.maintenance.reclassifyStockEquity(), 'second apply');
  assert.strictEqual(second.count, 0);
  assert.strictEqual(second.skipped.length, 2);
  assert.ok(second.skipped.every(s => s.reason === 'already'));
  assert.strictEqual(await repo.count('journalEntries'), afterFirst,
    'second apply must not append entries');

  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual(replay.counts.stockMovements.posted, 0,
    'replay must not repost reclassified movements');
  assert.strictEqual(await repo.count('journalEntries'), afterFirst,
    'replay must not duplicate the reclassification');
  const verify = await BeeStore.journal.verify();
  assert.strictEqual(verify.ok, true, JSON.stringify(verify.errors));
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(tb.balanced, true);
});

test('explicit movement ids can reclassify a correction with a custom note', async () => {
  const { api } = await freshApi();
  const product = ok(await api.products.create({
    name: 'صنف تصحيح مخصص', defaultCostMinor: 500, defaultPriceMinor: 1000,
  }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'L', color: 'أحمر',
    costMinor: 500, priceMinor: 1000, quantity: 20, date: '2026-11-01',
  }), 'variant');
  const movement = ok(await api.stock.adjust(variant.id, 4, 'رصيد افتتاحي',
    '2026-11-03'), 'custom-note adjustment');
  assert.strictEqual(movement.note, 'رصيد افتتاحي');

  const preview = ok(await api.maintenance.previewStockEquityReclassification(),
    'default preview');
  assert.strictEqual(preview.count, 0, 'custom note is not auto-selected');

  const targeted = ok(await api.maintenance.previewStockEquityReclassification({
    movementIds: [movement.id],
  }), 'targeted preview');
  assert.strictEqual(targeted.count, 1);
  assert.strictEqual(targeted.totalMinor, 2000);

  const applied = ok(await api.maintenance.reclassifyStockEquity({
    movementIds: [movement.id],
  }), 'targeted apply');
  assert.strictEqual(applied.count, 1);
  assert.strictEqual(applied.totalMinor, 2000);

  const pnl = ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30', {
    journal: true,
  }), 'journal P&L');
  assert.strictEqual(pnl.stockLosses, 0);
  assert.strictEqual(pnl.gains, 0);
  assert.strictEqual(pnl.salesProfit, 0);
  assert.strictEqual(pnl.netProfit, 0);
  const snap = ok(await api.reports.balanceSnapshot('2026-11-30', {
    journal: true,
  }), 'journal snapshot');
  assert.strictEqual(snap.balanced, true);
  assert.strictEqual(snap.assets.inventoryValue, 12000);
  assert.strictEqual(snap.equity.openingEquity, 12000);
});
