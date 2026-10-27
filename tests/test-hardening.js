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
require('../js/ui/errorLog.js');
require('../js/ui/period.js');
const Router = require('../js/ui/router.js');

async function freshApi() {
  const repo = new MemoryRepository();
  await repo.open();
  return new Api(repo);
}

// v2 §13.1.11: a repeated save with the same clientKey posts exactly once.
test('V2 double-submit with same clientKey creates one invoice', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-11-01',
    })).data;
    await api.stock.adjust(v.id, 10, 'open', '2026-11-01');
    const body = () => ({
      clientKey: 'key_double_click_1',
      date: '2026-11-10',
      lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
      payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000 }],
    });
    const first = await api.sales.create(body());
    const second = await api.sales.create(body());
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.data.id, first.data.id);
    assert.strictEqual(second.data.duplicate, true);
    assert.strictEqual((await api.sales.list()).data.length, 1);
    // Stock moved exactly once (10 − 2).
    const after = await api.stock.movements(v.id);
    const outs = (after.data || []).filter(m => m.qtyChange < 0);
    assert.strictEqual(outs.length, 1);
    assert.strictEqual(outs[0].qtyChange, -2);

    // A different key is a different intent → second invoice posts.
    const third = await api.sales.create({ ...body(), clientKey: 'key_other_2' });
    assert.strictEqual(third.ok, true);
    assert.strictEqual(third.data.duplicate, undefined);
    assert.strictEqual((await api.sales.list()).data.length, 2);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §12.3: error capture stores entries (ids + technical details only).
test('V2 errorLog captures, lists and clears', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  BeeStore.errorLog.repo = repo;
  await BeeStore.errorLog.clear();
  const entry = await BeeStore.errorLog.capture('test', 'boom message', 'stack trace here');
  assert.strictEqual(entry.message, 'boom message');
  assert.ok(entry.id);
  assert.ok(entry.timestamp);
  const rows = await BeeStore.errorLog.list(10);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message, 'boom message');
  assert.strictEqual(rows[0].check, undefined);
  await BeeStore.errorLog.clear();
  assert.strictEqual((await BeeStore.errorLog.list(10)).length, 0);
  BeeStore.errorLog.repo = null;
});

// v2 §3: period travels in the URL hash and wins over stored prefs.
test('V2 router hash carries the period month', async () => {
  global.history = { calls: [], pushState(state, title, url) { this.calls.push(url); } };
  try {
    const router = new Router();
    let rendered = 0;
    router.register('/pos', () => { rendered++; });
    BeeStore.period.init('2026-09');
    router.navigate('/pos?m=2026-10');
    assert.strictEqual(BeeStore.period.get().month, '2026-10');
    assert.strictEqual(rendered, 1);
    assert.ok(global.history.calls[0].includes('/pos?m=2026-10'));
    // Same route + same month → no re-render.
    router.navigate('/pos?m=2026-10');
    assert.strictEqual(rendered, 1);
    // Plain navigation keeps the current month in the URL.
    router.navigate('/reports');
    assert.ok(global.history.calls[1].includes('?m=2026-10'));
    // Year and custom modes travel in the hash too.
    router.navigate('/reports?y=2026');
    assert.deepStrictEqual(BeeStore.period.get(), { mode: 'year', year: '2026' });
    assert.deepStrictEqual(BeeStore.period.getRange(), { from: '2026-01-01', to: '2026-12-31' });
    assert.strictEqual(BeeStore.period.label(), 'سنة 2026');
    router.navigate('/reports?from=2026-10-01&to=2026-11-30');
    assert.deepStrictEqual(BeeStore.period.get(), { mode: 'custom', from: '2026-10-01', to: '2026-11-30' });
    assert.strictEqual(BeeStore.period.label(), '2026-10-01 ← 2026-11-30');
    // Invalid values are ignored (selection unchanged).
    router.navigate('/reports?m=nope');
    assert.strictEqual(BeeStore.period.get().mode, 'custom');
  } finally {
    delete global.history;
  }
});

// v2 §13.1.12: performance at 5,000 variants / 50,000 invoices.
test('V2 performance at scale (5000 variants, 50000 invoices)', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  BeeStore.dates.setClock(() => '2026-12-15');
  try {
    await api.accounts.create({ name: 'Cash', type: 'cash' });
    // Raw seed through real transactions (bypasses services only):
    // 500 products x 10 variants, then 50,000 one-line sales over 2026.
    const NV = 5000, NS = 50000;
    await repo.transaction(async (tx) => {
      for (let p = 0; p < 500; p++) {
        tx.put('products', { id: 'prd_p' + p, name: 'منتج ' + p, defaultCostMinor: 1000, defaultPriceMinor: 2000 });
      }
      for (let i = 0; i < NV; i++) {
        tx.put('variants', {
          id: 'var_s' + i, productId: 'prd_p' + (i % 500),
          size: 'M' + (i % 10), color: 'C' + (i % 5),
          barcode: '200000' + String(100000 + i), sku: 'SKU-' + i,
          quantity: 100, costMinor: 1000, priceMinor: 2000, active: true,
        });
      }
    });
    for (let batch = 0; batch < 5; batch++) {
      await repo.transaction(async (tx) => {
        for (let k = 0; k < NS / 5; k++) {
          const i = batch * (NS / 5) + k;
          const m = String((i % 12) + 1).padStart(2, '0');
          const d = String((i % 28) + 1).padStart(2, '0');
          const vi = i % NV;
          tx.put('sales', {
            id: 'sal_s' + i, number: 'INV-' + i, status: 'paid',
            date: '2026-' + m + '-' + d, taxMinor: 0, totalMinor: 2000,
            dueMinor: 0, paidMinor: 2000,
            lines: [{ variantId: 'var_s' + vi, qty: 1, unitCostMinor: 1000, lineTotalMinor: 2000, productName: 'P', size: 'M', color: 'C' }],
            payments: [{ method: 'cash', amountMinor: 2000, date: '2026-' + m + '-' + d }],
          });
        }
      });
    }
    let t0 = Date.now();
    const review = await api.reports.monthReview('2026-06');
    const reportMs = Date.now() - t0;
    assert.strictEqual(review.ok, true);
    assert.ok(review.data.kpis.invoices > 4000, 'June has its share of invoices');

    t0 = Date.now();
    const found = await BeeStore.variants.search('SKU-4999');
    const searchMs = Date.now() - t0;
    assert.strictEqual(found.length, 1);

    console.log('    perf: monthReview ' + reportMs + 'ms, search ' + searchMs + 'ms');
    assert.ok(reportMs < 1000, 'month report < 1s (got ' + reportMs + 'ms)');
    assert.ok(searchMs < 100, 'search < 100ms (got ' + searchMs + 'ms)');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §12.1.3: truly concurrent same-key creates still post exactly once.
test('V2 concurrent same-key creates serialize to one invoice', async () => {
  BeeStore.dates.setClock(() => '2026-11-15');
  try {
    const api = await freshApi();
    const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
    const prd = (await api.products.create({ name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000 })).data;
    const v = (await api.variants.create({
      productId: prd.id, size: 'M', color: 'R', priceMinor: 2000, date: '2026-11-01',
    })).data;
    await api.stock.adjust(v.id, 10, 'open', '2026-11-01');
    const body = () => ({
      clientKey: 'key_race_1',
      date: '2026-11-10',
      lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 2000 }],
      payments: [{ method: 'cash', accountId: acc.id, amountMinor: 2000 }],
    });
    const [a, b] = await Promise.all([api.sales.create(body()), api.sales.create(body())]);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(a.data.id, b.data.id);
    assert.strictEqual((await api.sales.list()).data.length, 1);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §12.1.5: Arabic-Indic digits parse at every numeric entry.
test('V2 eastern arabic digits normalize in money parsing', async () => {
  assert.strictEqual(BeeStore.money.fromMajor('٢٥٠٫٥'), 25050);
  assert.strictEqual(BeeStore.money.fromMajor('١٬٠٠٠'), 100000);
  assert.strictEqual(BeeStore.money.parseDecimal('٣'), 3);
  assert.strictEqual(BeeStore.money.parseDecimal(''), 0);
});

// v2 §12.1.7: CSV export neutralizes formula cells.
test('V2 csv export prefixes formula cells', async () => {
  const CsvService = require('../js/services/csv.js');
  const repo = new MemoryRepository();
  await repo.open();
  const csv = new CsvService(repo);
  const out = csv.toCsv(['name'], [['=1+1'], ['+2+2'], ['-3'], ['@x'], ['plain'], ['a,b']]);
  assert.ok(out.includes("'=1+1"), 'equals prefixed');
  assert.ok(out.includes("'+2+2"), 'plus prefixed');
  assert.ok(out.includes("'-3"), 'minus prefixed');
  assert.ok(out.includes("'@x"), 'at prefixed');
  assert.ok(out.includes('plain'), 'plain untouched');
  assert.ok(out.includes('"a,b"'), 'comma still quoted');
});

// v2 §12.1.13: print builders emit sized RTL pages that wrap long names.
test('V2 print builders produce sized RTL output', async () => {
  require('../js/ui/components.js');
  const print = require('../js/ui/print.js');
  const sale = {
    number: 'INV-1', date: '2026-10-10', subtotalMinor: 2000,
    discountMinor: 0, taxMinor: 0, totalMinor: 2000, paidMinor: 2000, dueMinor: 0,
    lines: [{
      productName: 'فستان أطفال صيفي طويل جداً جداً جداً لا ينتهي',
      size: 'M', color: 'R', qty: 1, unitPriceMinor: 2000, lineTotalMinor: 2000,
    }],
  };
  const a4 = print.buildInvoiceHtml(sale, { storeNameAr: 'متجر <b>X</b>' }, null, 'A4');
  assert.ok(a4.includes('dir="rtl"'), 'RTL document');
  assert.ok(a4.includes('size: 210mm'), 'A4 page size');
  assert.ok(a4.includes('overflow-wrap: anywhere'), 'long names wrap');
  assert.ok(!a4.includes('<b>X</b>'), 'store name escaped');
  const t80 = print.buildInvoiceHtml(sale, {}, null, '80mm');
  assert.ok(t80.includes('size: 80mm'), '80mm page size');
  const labels = print.buildLabelSheetHtml(
    [{ productName: 'P', size: 'S', color: 'C', priceMinor: 1500, barcode: '200000000001' }],
    { labelSize: '50x30' }, () => null);
  assert.ok(labels.includes('size: A4 portrait'), 'A4 label sheet');
  assert.ok(labels.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'), 'four labels side-by-side');
  assert.ok(labels.includes('gap: 2mm'), 'small gap between labels');
  assert.ok(labels.includes('200000000001'), 'barcode text present');
  assert.ok(!/\.product-name[^}]*max-height/.test(labels), 'product name not height-clipped');
  assert.ok(!/\.product-name[^}]*overflow:\s*hidden/.test(labels), 'product name not overflow-clipped');
  assert.ok(labels.includes('class="price"'), 'price always rendered');
  assert.ok(!/\.label\s*\{[^}]*page-break-after/.test(labels), 'no page break per label');

  const many = [];
  for (let i = 0; i < 10; i++) {
    many.push({ productName: 'منتج طويل الاسم بعض الشيء', size: 'M', color: 'أزرق', priceMinor: 3500, barcode: '20000000000' + i });
  }
  const manyHtml = print.buildLabelSheetHtml(many, { labelSize: '50x30' }, () => null);
  assert.strictEqual((manyHtml.match(/<div class="label">/g) || []).length, 10, 'all labels rendered');
  assert.strictEqual((manyHtml.match(/<div class="sheet">/g) || []).length, 1, 'ten 50x30 labels fit one A4 page');

  const twoPages = many.concat(many, many, many);
  const twoPagesHtml = print.buildLabelSheetHtml(twoPages, { labelSize: '50x30' }, () => null);
  assert.strictEqual((twoPagesHtml.match(/<div class="sheet">/g) || []).length, 2, '40 labels split into two A4 pages');
});
