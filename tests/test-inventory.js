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
['settings', 'auth', 'accounts', 'expenses', 'periods', 'chartOfAccounts',
 'journal', 'posting', 'categories', 'products', 'variants', 'stock', 'sales',
 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers',
 'payroll', 'employees', 'transactions', 'reports', 'dashboard', 'backup',
 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) {
  BeeStore.dates.setClock(() => date);
}

test.afterEach(() => BeeStore.dates.resetClock());

async function freshApi(settings) {
  useClock((settings && settings.today) || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  await api.settings.save({
    systemStartDate: '2026-10-01',
    blockFutureDates: true,
    ...(settings || {}),
  });
  await BeeStore.chart.ensureSeeded();
  const chart = (await api.chart.list()).data;
  return {
    repo,
    api,
    byCode: code => chart.find(a => a.code === code),
  };
}

async function makeVariant(api, opts) {
  opts = opts || {};
  const product = (await api.products.create({
    name: opts.name || 'P',
    defaultCostMinor: opts.costMinor || 1000,
    defaultPriceMinor: opts.priceMinor || 2000,
  })).data;
  const variant = (await api.variants.create({
    productId: product.id,
    size: opts.size || 'M',
    color: opts.color || 'R',
    costMinor: opts.costMinor || 1000,
    priceMinor: opts.priceMinor || 2000,
  })).data;
  return { product, variant };
}

function balanceOf(tb, code) {
  const row = tb.accounts.find(a => a.code === code);
  return row ? row.balanceMinor : 0;
}

async function inventoryControl(repo) {
  const tb = await BeeStore.journal.trialBalance();
  return balanceOf(tb, '1200');
}

async function subledgerValue(repo) {
  const variants = await repo.list('variants');
  return variants.reduce((sum, v) => sum + (v.valueMinor != null
    ? Math.round(Number(v.valueMinor) || 0)
    : Math.round((Number(v.costMinor) || 0) * (Number(v.quantity) || 0))), 0);
}

async function assertInvariants(repo, label) {
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(tb.balanced, true, (label || '') + ' trial balance must balance');
  const stock = await BeeStore.stock.verifyStock();
  assert.strictEqual(stock.ok, true,
    (label || '') + ' stock verification: ' + JSON.stringify(stock.mismatches));
  const journal = await BeeStore.journal.verify();
  assert.strictEqual(journal.ok, true,
    (label || '') + ' journal verification: ' + JSON.stringify(journal.errors));
  const control = balanceOf(tb, '1200');
  const subledger = await subledgerValue(repo);
  assert.strictEqual(control, subledger,
    (label || '') + ' inventory control must equal Σ variant valueMinor');
  assert.ok(control >= 0 || (await repo.get('meta', 'settings')).allowNegativeStock,
    (label || '') + ' negative inventory only when allowed');
}

// ---------------------------------------------------------------------------
// Allocation and rounding
// ---------------------------------------------------------------------------

test('money.allocate uses largest remainder, line-order ties and exact totals', () => {
  const money = BeeStore.money;
  assert.deepStrictEqual(money.allocate(200, [3400, 3400, 3400]), [67, 67, 66]);
  assert.deepStrictEqual(money.allocate(100, [3333, 3333, 3334]), [33, 33, 34]);
  assert.deepStrictEqual(money.allocate(5, [0, 0, 0]), [2, 2, 1]);
  const negative = money.allocate(-200, [3400, 3400, 3400]);
  assert.deepStrictEqual(negative, [-67, -67, -66]);
  assert.strictEqual(money.sum(negative), -200);
  const weights = [3400, 3400, 3400];
  money.allocate(200, weights);
  assert.deepStrictEqual(weights, [3400, 3400, 3400], 'weights must not be mutated');
});

test('A2 rounding: 3 units for 100.00 sell at 33.33 / 33.34 / 33.33 and end at zero', async () => {
  const { repo, api, byCode } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 3400, priceMinor: 5000 });

  const purchase = (await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
    ],
    discountMinor: 200,
    payments: [],
  })).data;

  assert.strictEqual(purchase.subtotalMinor, 10200);
  assert.strictEqual(purchase.discountMinor, 200);
  assert.strictEqual(purchase.totalMinor, 10000);
  assert.deepStrictEqual(purchase.lines.map(l => l.discountMinor), [67, 67, 66]);
  assert.deepStrictEqual(purchase.lines.map(l => l.inventoryValueMinor), [3333, 3333, 3334]);

  let stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 3);
  assert.strictEqual(stored.valueMinor, 10000);
  assert.strictEqual(stored.costMinor, 3333);
  assert.strictEqual(await inventoryControl(repo), 10000);
  const purchaseEntry = (await api.journal.forSource('PURCHASE', purchase.id)).data;
  assert.strictEqual(purchaseEntry.length, 1);
  assert.strictEqual(balanceOf(await BeeStore.journal.trialBalance(), '2010'), -10000);

  const cogs = [];
  for (let i = 0; i < 3; i++) {
    const sale = (await api.sales.create({
      date: '2026-10-0' + (5 + i),
      lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
      payments: [{ method: 'cash', accountId: cash.id, amountMinor: 5000 }],
    })).data;
    cogs.push(sale.lines[0].cogsMinor);
    stored = (await api.variants.get(variant.id)).data;
    const tb = await BeeStore.journal.trialBalance();
    assert.strictEqual(stored.quantity, 2 - i);
    assert.strictEqual(stored.valueMinor, [6667, 3333, 0][i]);
    assert.strictEqual(balanceOf(tb, '1200'), [6667, 3333, 0][i],
      'journal inventory must equal the sub-ledger after each sale');
    assert.strictEqual(balanceOf(tb, '5010'), [3333, 6667, 10000][i]);
    assert.strictEqual(sale.journalEntryIds.length, 1);
    assert.strictEqual((await api.journal.forSource('SALE', sale.id)).data.length, 1);
  }
  assert.deepStrictEqual(cogs, [3333, 3334, 3333]);
  assert.strictEqual(await inventoryControl(repo), 0);
  await assertInvariants(repo, 'rounding');
});

test('A2 sale returns restock at the original exact COGS including the remainder cent', async () => {
  const { repo, api } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 3400, priceMinor: 5000 });

  await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
      { variantId: variant.id, qty: 1, unitCostMinor: 3400 },
    ],
    discountMinor: 200,
    payments: [],
  });

  const sale = (await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: variant.id, qty: 3, unitPriceMinor: 5000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 15000 }],
  })).data;
  assert.strictEqual(sale.cogsMinor, 10000);
  assert.strictEqual((await api.variants.get(variant.id)).data.valueMinor, 0);

  const restocked = [];
  for (let i = 0; i < 3; i++) {
    const ret = (await api.returns.create({
      saleId: sale.id,
      date: '2026-10-0' + (6 + i),
      lines: [{ saleLineIndex: 0, qty: 1, restock: true }],
      refundMode: 'cash_refund',
      refundMethod: cash.id,
    })).data;
    restocked.push(ret.lines[0].restockCostMinor);
    assert.strictEqual(ret.restockCostMinor, ret.lines[0].restockCostMinor);
    assert.strictEqual(ret.lines[0].returnedCostMinor, restocked[i]);
    assert.strictEqual((await api.journal.forSource('SALE_RETURN', ret.id)).data.length, 1);
  }
  assert.deepStrictEqual(restocked, [3333, 3334, 3333]);

  const stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 3);
  assert.strictEqual(stored.valueMinor, 10000);
  assert.strictEqual(await inventoryControl(repo), 10000);
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '5010'), 0, 'net COGS is zero after a full return');
  assert.strictEqual((await api.sales.get(sale.id)).data.returnStatus, 'full');
  assert.strictEqual((await api.sales.get(sale.id)).data.lines[0].returnedCostMinor, 10000);
  await assertInvariants(repo, 'sale returns');
});

test('A2 partial returns refund the line discount exactly with no lost cent', async () => {
  const { repo, api } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });
  await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 3, unitCostMinor: 1000 }],
    payments: [],
  });

  const sale = (await api.sales.create({
    date: '2026-10-05',
    lines: [{
      variantId: variant.id, qty: 3, unitPriceMinor: 1000,
      lineDiscountMinor: 100,
    }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 2900 }],
  })).data;
  assert.strictEqual(sale.totalMinor, 2900);

  // The same sale line may not appear twice in one return.
  const duplicate = await api.returns.create({
    saleId: sale.id,
    date: '2026-10-06',
    lines: [
      { saleLineIndex: 0, qty: 1, restock: true },
      { saleLineIndex: 0, qty: 1, restock: true },
    ],
    refundMode: 'cash_refund',
    refundMethod: cash.id,
  });
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.error.code, 'INVALID_LINE');

  const refunds = [];
  for (let i = 0; i < 3; i++) {
    const ret = (await api.returns.create({
      saleId: sale.id,
      date: '2026-10-0' + (6 + i),
      lines: [{ saleLineIndex: 0, qty: 1, restock: true }],
      refundMode: 'cash_refund',
      refundMethod: cash.id,
    })).data;
    refunds.push(ret.refundMinor);
    const stored = (await api.sales.get(sale.id)).data;
    assert.strictEqual(stored.lines[0].returnedDiscountMinor, [33, 67, 100][i]);
  }
  assert.deepStrictEqual(refunds, [967, 966, 967]);
  assert.strictEqual(refunds.reduce((a, b) => a + b, 0), sale.totalMinor,
    'refunds must sum exactly to the invoice total');
  await assertInvariants(repo, 'partial return discounts');
});

// ---------------------------------------------------------------------------
// Purchase returns and voids
// ---------------------------------------------------------------------------

test('A2 purchase return posts the refund / carrying-value difference to 5030', async () => {
  const { repo, api } = await freshApi();
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });

  const first = (await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 1000 }],
    payments: [],
  })).data;
  const second = (await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 2000 }],
    payments: [],
  })).data;
  assert.strictEqual((await api.variants.get(variant.id)).data.valueMinor, 30000);

  // Return 5 units bought at 1,000 while the tracked average is 1,500:
  // refund 5,000, value removed 7,500, loss 2,500 to 5030.
  const loss = (await api.purchaseReturns.create({
    purchaseId: first.id,
    date: '2026-10-04',
    lines: [{ purchaseLineIndex: 0, qty: 5 }],
    mode: 'reduce_payable',
  })).data;
  assert.strictEqual(loss.totalMinor, 5000);
  assert.strictEqual(loss.lines[0].valueMinor, 5000);
  assert.strictEqual(loss.lines[0].removedValueMinor, 7500);
  assert.strictEqual(loss.lines[0].differenceMinor, -2500);
  assert.strictEqual((await api.purchases.get(first.id)).data.dueMinor, 5000);
  let stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 15);
  assert.strictEqual(stored.valueMinor, 22500);
  let tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '5030'), 2500, 'loss is a debit to 5030');
  assert.strictEqual(balanceOf(tb, '1200'), 22500);

  // Return 5 units bought at 2,000 while the average is still 1,500:
  // refund 10,000, value removed 7,500, gain 2,500 credited to 5030.
  const gain = (await api.purchaseReturns.create({
    purchaseId: second.id,
    date: '2026-10-05',
    lines: [{ purchaseLineIndex: 0, qty: 5 }],
    mode: 'reduce_payable',
  })).data;
  assert.strictEqual(gain.totalMinor, 10000);
  assert.strictEqual(gain.lines[0].removedValueMinor, 7500);
  assert.strictEqual(gain.lines[0].differenceMinor, 2500);
  stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 10);
  assert.strictEqual(stored.valueMinor, 15000);
  tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '5030'), 0, 'loss and gain net to zero');
  assert.strictEqual(balanceOf(tb, '1200'), 15000);
  await assertInvariants(repo, 'purchase returns');
});

test('A2 purchase void removes the original net value and rejects a negative residual', async () => {
  const { repo, api } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });

  const first = (await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 1000 }],
    payments: [],
  })).data;
  const second = (await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 2000 }],
    payments: [],
  })).data;

  const voided = (await api.purchases.void(first.id, 'خطأ إدخال')).data;
  assert.strictEqual(voided.status, 'void');
  let stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 10);
  assert.strictEqual(stored.valueMinor, 20000,
    'the first purchase removes its original 10,000, not the 15,000 average');
  let tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), 20000);
  assert.strictEqual(balanceOf(tb, '2010'), -20000);
  const reversals = (await api.journal.list({ sourceType: 'PURCHASE' })).data
    .filter(e => e.reversalOf);
  assert.strictEqual(reversals.length, 1);
  assert.strictEqual(reversals[0].date, first.date, 'reversal keeps the original date');
  assert.strictEqual((await api.journal.forSource('PURCHASE', first.id)).data.length, 2);
  assert.strictEqual(voided.journalEntryIds.length, 2);
  const voidMovement = (await api.stock.movements(variant.id)).data
    .find(m => m.type === 'void_purchase' && m.valueChangeMinor === -10000);
  assert.ok(voidMovement);
  assert.strictEqual(voidMovement.journalEntryIds.length, 1);

  await api.purchases.void(second.id, 'إلغاء الثاني');
  stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 0);
  assert.strictEqual(stored.valueMinor, 0);
  assert.strictEqual(await inventoryControl(repo), 0);
  await assertInvariants(repo, 'purchase voids');

  // Sold stock cannot be removed again by voiding its purchase: the residual
  // value would be negative. Nothing is written and no reversal is created.
  const { variant: soldVariant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });
  const soldPurchase = (await api.purchases.create({
    date: '2026-10-06',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: soldVariant.id, qty: 1, unitCostMinor: 1000 }],
    payments: [],
  })).data;
  await api.sales.create({
    date: '2026-10-07',
    lines: [{ variantId: soldVariant.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 2000 }],
  });
  const rejected = await api.purchases.void(soldPurchase.id, 'محاولة');
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.error.code, 'STOCK_NEGATIVE');
  assert.strictEqual((await api.variants.get(soldVariant.id)).data.quantity, 0);
  assert.strictEqual((await api.purchases.get(soldPurchase.id)).data.status, 'unpaid');
  assert.strictEqual((await api.journal.forSource('PURCHASE', soldPurchase.id)).data.length, 1);
  await assertInvariants(repo, 'purchase void rejection');
});

test('A2 sale void restores the exact original COGS after later cost changes', async () => {
  const { repo, api } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });

  await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 1, unitCostMinor: 1000 }],
    payments: [],
  });
  const sale = (await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 2000 }],
  })).data;
  assert.strictEqual(sale.cogsMinor, 1000);
  await api.purchases.create({
    date: '2026-10-06',
    supplierId: supplier.id,
    supplierName: 'S',
    lines: [{ variantId: variant.id, qty: 1, unitCostMinor: 5000 }],
    payments: [],
  });
  assert.strictEqual((await api.variants.get(variant.id)).data.valueMinor, 5000);

  const voided = (await api.sales.void(sale.id, 'إلغاء')).data;
  assert.strictEqual(voided.status, 'void');
  assert.strictEqual(voided.journalEntryIds.length, 2);
  const stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 2);
  assert.strictEqual(stored.valueMinor, 6000,
    'restores the original 1,000, never the current 5,000 average');
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), 6000);
  assert.strictEqual(balanceOf(tb, '5010'), 0, 'reversing entry clears COGS');
  const entries = (await api.journal.forSource('SALE', sale.id)).data;
  assert.strictEqual(entries.length, 2);
  const reversal = entries.find(e => e.reversalOf);
  assert.ok(reversal);
  assert.strictEqual(reversal.date, sale.date, 'void reversal is dated the original sale date');
  const voidMovement = (await api.stock.movements(variant.id)).data
    .find(m => m.type === 'void_sale');
  assert.strictEqual(voidMovement.qtyChange, 1);
  assert.strictEqual(voidMovement.valueChangeMinor, 1000);
  assert.strictEqual(voidMovement.date, sale.date);
  assert.strictEqual(voidMovement.journalEntryIds.length, 1);
  await assertInvariants(repo, 'sale void');
});

// ---------------------------------------------------------------------------
// Adjustments and revaluation
// ---------------------------------------------------------------------------

test('A2 adjustments and stocktakes post gains and losses against 5020', async () => {
  const { repo, api } = await freshApi();
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });

  const gain = (await api.stock.adjust(variant.id, 10, 'رصيد افتتاحي', '2026-10-02')).data;
  assert.strictEqual(gain.valueChangeMinor, 10000);
  assert.strictEqual(gain.valueAfterMinor, 10000);
  assert.strictEqual(gain.journalEntryIds.length, 1);
  let entry = (await api.journal.get(gain.journalEntryIds[0])).data;
  assert.strictEqual(entry.sourceType, 'STOCK_ADJUSTMENT');
  assert.strictEqual(entry.sourceId, gain.id);

  const loss = (await api.stock.adjust(variant.id, -3, 'تالف', '2026-10-03')).data;
  assert.strictEqual(loss.valueChangeMinor, -3000);
  assert.strictEqual(loss.valueAfterMinor, 7000);
  assert.strictEqual(loss.journalEntryIds.length, 1);

  const counted = (await api.stock.stocktake([
    { variantId: variant.id, countedQty: 10 },
  ], '2026-10-04')).data[0];
  assert.strictEqual(counted.movement.type, 'stocktake');
  assert.strictEqual(counted.movement.qtyChange, 3);
  assert.strictEqual(counted.movement.valueChangeMinor, 3000);
  assert.strictEqual(counted.movement.journalEntryIds.length, 1);

  const stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 10);
  assert.strictEqual(stored.valueMinor, 10000);
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), 10000);
  assert.strictEqual(balanceOf(tb, '5020'), -10000, 'net gain is a credit balance on 5020');
  await assertInvariants(repo, 'adjustments');
});

test('A2 cost revaluation posts only the value delta to 5030', async () => {
  const { repo, api } = await freshApi();
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });
  await api.stock.adjust(variant.id, 10, 'رصيد', '2026-10-02');

  const up = (await api.variants.update(variant.id, {
    costMinor: 1200, date: '2026-10-03', revaluationReason: 'ارتفاع',
  })).data;
  assert.strictEqual(up.quantity, 10);
  assert.strictEqual(up.costMinor, 1200);
  assert.strictEqual(up.valueMinor, 12000);
  let tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), 12000);
  assert.strictEqual(balanceOf(tb, '5030'), -2000);
  const moves = (await api.stock.movements(variant.id)).data;
  const upMove = moves.find(m => m.type === 'revaluation' && m.valueChangeMinor === 2000);
  assert.ok(upMove);
  assert.strictEqual(upMove.qtyChange, 0);
  assert.strictEqual(upMove.journalEntryIds.length, 1);
  assert.strictEqual((await api.journal.forSource('REVALUATION', upMove.id)).data.length, 1);

  const down = (await api.variants.update(variant.id, {
    costMinor: 900, date: '2026-10-04',
  })).data;
  assert.strictEqual(down.valueMinor, 9000);
  tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), 9000);
  assert.strictEqual(balanceOf(tb, '5030'), 1000, 'net of +2,000 credit and -3,000 debit');
  await assertInvariants(repo, 'revaluation');
});

// ---------------------------------------------------------------------------
// Negative stock
// ---------------------------------------------------------------------------

test('A2 negative stock flags COST_ESTIMATED and still balances the journal', async () => {
  const { repo, api } = await freshApi({ allowNegativeStock: true });
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });

  const sale = (await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 4000 }],
  })).data;
  assert.strictEqual(sale.cogsMinor, 2000);
  assert.strictEqual(sale.costEstimated, true);
  assert.strictEqual(sale.costFlag, 'COST_ESTIMATED');
  assert.strictEqual(sale.lines[0].costEstimated, true);
  assert.strictEqual(sale.lines[0].costFlag, 'COST_ESTIMATED');
  const movement = (await api.stock.movements(variant.id)).data[0];
  assert.strictEqual(movement.estimated, true);
  assert.strictEqual(movement.costFlag, 'COST_ESTIMATED');
  let stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, -2);
  assert.strictEqual(stored.valueMinor, -2000);
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(balanceOf(tb, '1200'), -2000);
  assert.strictEqual(balanceOf(tb, '5010'), 2000);
  await assertInvariants(repo, 'negative stock');

  // Replenishment adds its own cost only; the flagged estimate is not revisited.
  await api.purchases.create({
    date: '2026-10-06',
    lines: [{ variantId: variant.id, qty: 2, unitCostMinor: 1000 }],
    payments: [],
  });
  stored = (await api.variants.get(variant.id)).data;
  assert.strictEqual(stored.quantity, 0);
  assert.strictEqual(stored.valueMinor, 0);
  await assertInvariants(repo, 'negative stock replenished');
});

test('A2 negative stock stays rejected by default', async () => {
  const { repo, api } = await freshApi();
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 2000 });
  const res = await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 2000 }],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'INSUFFICIENT_STOCK');
  assert.strictEqual((await repo.list('journalEntries')).length, 0);
  assert.strictEqual((await repo.list('stockMovements')).length, 0);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('A2 migration 4->5 backfills tracked value without rewriting legacy gross values', async () => {
  const dump = {
    schemaVersion: 4,
    meta: { id: 'meta', schemaVersion: 4, counters: {}, revision: 1 },
    settings: { id: 'settings', systemStartDate: '2026-10-01' },
    collections: {
      variants: [
        { id: 'v1', productId: 'p1', quantity: 8, costMinor: 1000, size: 'M', color: 'R' },
      ],
      stockMovements: [
        { id: 'm1', variantId: 'v1', date: '2026-10-01', type: 'purchase',
          qtyChange: 10, unitCostMinor: 1000, createdAt: '2026-10-01T10:00:00.000Z' },
        { id: 'm2', variantId: 'v1', date: '2026-10-02', type: 'sale',
          qtyChange: -2, unitCostMinor: 1000, createdAt: '2026-10-02T10:00:00.000Z' },
      ],
      sales: [{ id: 's1', date: '2026-10-02', journalEntryIds: ['je_legacy'],
        lines: [{ variantId: 'v1', qty: 2, unitCostMinor: 1000, returnedQty: 1 }] }],
      purchases: [{ id: 'p1', date: '2026-10-01',
        lines: [{ variantId: 'v1', qty: 10, unitCostMinor: 1000 }] }],
      purchaseReturns: [{ id: 'pr1', date: '2026-10-03',
        lines: [{ variantId: 'v1', qty: 1, unitCostMinor: 1000, lineTotalMinor: 1000 }] }],
    },
  };

  const out = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
  assert.strictEqual(out.schemaVersion, 5);
  assert.strictEqual(out.meta.schemaVersion, 5);
  assert.deepStrictEqual(out.collections.journalEntries, [], 'migration never invents journal entries');

  const variant = out.collections.variants[0];
  assert.strictEqual(variant.valueMinor, 8000);
  assert.strictEqual(variant.costMinor, 1000);
  assert.deepStrictEqual(variant.journalEntryIds, []);

  const [m1, m2] = out.collections.stockMovements;
  assert.strictEqual(m1.valueChangeMinor, 10000);
  assert.strictEqual(m1.valueAfterMinor, 10000);
  assert.strictEqual(m1.avgCostAfterMinor, 1000);
  assert.strictEqual(m2.valueChangeMinor, -2000);
  assert.strictEqual(m2.valueAfterMinor, 8000);
  assert.strictEqual(m2.avgCostAfterMinor, 1000);
  assert.deepStrictEqual(m1.journalEntryIds, []);

  const sale = out.collections.sales[0];
  assert.strictEqual(sale.cogsMinor, 2000);
  assert.strictEqual(sale.costEstimated, false);
  assert.strictEqual(sale.costFlag, null);
  assert.strictEqual(sale.lines[0].cogsMinor, 2000);
  assert.strictEqual(sale.lines[0].returnedCostMinor, 1000);
  assert.strictEqual(sale.lines[0].returnedDiscountMinor, 0);
  assert.deepStrictEqual(sale.journalEntryIds, ['je_legacy'], 'existing links survive');

  const purchase = out.collections.purchases[0];
  assert.strictEqual(purchase.inventoryValueMinor, 10000);
  assert.strictEqual(purchase.lines[0].grossMinor, 10000);
  assert.strictEqual(purchase.lines[0].discountMinor, 0);
  assert.strictEqual(purchase.lines[0].inventoryValueMinor, 10000);
  assert.strictEqual(purchase.lines[0].netUnitCostMinor, 1000);

  const pret = out.collections.purchaseReturns[0];
  assert.strictEqual(pret.totalMinor, 1000);
  assert.strictEqual(pret.lines[0].valueMinor, 1000);
  assert.strictEqual(pret.lines[0].removedValueMinor, 1000);
  assert.strictEqual(pret.lines[0].differenceMinor, 0);

  // Idempotence: a dump already at the current version is returned intact.
  const again = await BeeStore.migrations.migrate(out, BeeStore.schemaVersion);
  assert.strictEqual(again.schemaVersion, 5);
  assert.strictEqual(again.collections.stockMovements[1].valueAfterMinor, 8000);
  assert.strictEqual(again.collections.variants[0].valueMinor, 8000);
});

test('A2 migration reconstructs discounts already refunded by legacy returns', async () => {
  const dump = {
    schemaVersion: 4,
    meta: { id: 'meta', schemaVersion: 4, counters: {}, revision: 1 },
    collections: {
      sales: [{
        id: 's1', date: '2026-10-02',
        lines: [{
          variantId: 'v1', qty: 3, unitPriceMinor: 1000,
          lineDiscountMinor: 100, lineTotalMinor: 2900, returnedQty: 2,
        }],
      }],
      salesReturns: [
        { id: 'r1', saleId: 's1', date: '2026-10-03',
          lines: [{ saleLineIndex: 0, qty: 1, unitPriceMinor: 1000, lineRefundMinor: 967 }] },
        { id: 'r2', saleId: 's1', date: '2026-10-04',
          lines: [{ saleLineIndex: 0, qty: 1, unitPriceMinor: 1000, lineRefundMinor: 967 }] },
      ],
    },
  };
  const out = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
  assert.strictEqual(out.schemaVersion, 5);
  assert.strictEqual(out.collections.sales[0].lines[0].returnedDiscountMinor, 66,
    'legacy refunds already granted 33 + 33 of the 100 discount');
});

// ---------------------------------------------------------------------------
// Randomized invariants
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('A2 randomized documents keep trial balance, journal and inventory control exact', async () => {
  const { repo, api } = await freshApi({ allowNegativeStock: true });
  const cash = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const supplier = (await api.suppliers.create({ name: 'S' })).data;
  const a = (await makeVariant(api, { name: 'A', costMinor: 1000, priceMinor: 2500 })).variant;
  const b = (await makeVariant(api, { name: 'B', costMinor: 1700, priceMinor: 3000 })).variant;
  const variants = [a, b];
  const random = rng(20261031);
  const pick = list => list[Math.floor(random() * list.length)];
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  let day = 1;

  const nextDate = () => {
    day = Math.min(28, day + (random() < 0.35 ? 1 : 0));
    return '2026-10-' + String(day).padStart(2, '0');
  };

  // Every operation must either commit fully or roll back; expected domain
  // rejections are allowed, unexpected errors are not.
  const allowed = new Set([
    'STOCK_NEGATIVE', 'INSUFFICIENT_STOCK', 'HAS_RETURNS', 'EXCEEDS_SOLD',
    'EXCEEDS_PURCHASED', 'PURCHASE_VOID', 'SALE_VOID', 'ALREADY_VOID',
    'VALIDATION', 'NOT_FOUND', 'PERIOD_CLOSED', 'INVALID_LINE', 'INVALID',
  ]);
  const run = async (label, promise) => {
    const res = await promise;
    if (res && res.ok === false) {
      assert.ok(allowed.has(res.error.code),
        label + ' unexpected error ' + res.error.code + ': ' + res.error.message);
      return null;
    }
    return res.data;
  };

  for (let step = 0; step < 45; step++) {
    const date = nextDate();
    const op = int(1, 8);
    if (op === 1) {
      const variant = pick(variants);
      await run('purchase', api.purchases.create({
        date,
        supplierId: supplier.id,
        supplierName: 'S',
        lines: [{ variantId: variant.id, qty: int(1, 6), unitCostMinor: int(500, 2500) }],
        payments: [],
      }));
    } else if (op === 2) {
      const variant = pick(variants);
      await run('sale', api.sales.create({
        date,
        lines: [{ variantId: variant.id, qty: int(1, 5), unitPriceMinor: int(2000, 4000) }],
        payments: [{ method: 'cash', accountId: cash.id, amountMinor: 200000 }],
      }));
    } else if (op === 3) {
      const sales = (await repo.list('sales', s => s.status !== 'void' && s.returnStatus !== 'full'));
      if (sales.length) {
        const sale = pick(sales);
        const lineIndex = sale.lines.findIndex(l => (l.returnedQty || 0) < l.qty);
        if (lineIndex >= 0) {
          const line = sale.lines[lineIndex];
          const qty = int(1, line.qty - (line.returnedQty || 0));
          await run('return', api.returns.create({
            saleId: sale.id,
            date,
            lines: [{ saleLineIndex: lineIndex, qty, restock: random() < 0.8 }],
            refundMode: 'cash_refund',
            refundMethod: cash.id,
          }));
        }
      }
    } else if (op === 4) {
      const purchases = (await repo.list('purchases', p => p.status !== 'void'));
      const eligible = [];
      for (const purchase of purchases) {
        for (let i = 0; i < purchase.lines.length; i++) {
          const line = purchase.lines[i];
          if ((line.returnedQty || 0) < line.qty) eligible.push({ purchase, i, line });
        }
      }
      if (eligible.length) {
        const item = pick(eligible);
        const qty = int(1, item.line.qty - (item.line.returnedQty || 0));
        await run('purchase return', api.purchaseReturns.create({
          purchaseId: item.purchase.id,
          date,
          lines: [{ purchaseLineIndex: item.i, qty }],
          mode: 'reduce_payable',
        }));
      }
    } else if (op === 5) {
      const variant = pick(variants);
      await run('adjust', api.stock.adjust(variant.id, int(-3, 4), 'test', date));
    } else if (op === 6) {
      const variant = pick(variants);
      await run('revalue', api.variants.update(variant.id, {
        costMinor: int(300, 3000), date, revaluationReason: 'test',
      }));
    } else if (op === 7) {
      const sales = (await repo.list('sales', s =>
        s.status !== 'void' && s.returnStatus === 'none'));
      if (sales.length) {
        await run('void sale', api.sales.void(pick(sales).id, 'test'));
      }
    } else {
      const purchases = (await repo.list('purchases', p => p.status !== 'void'));
      if (purchases.length) {
        await run('void purchase', api.purchases.void(pick(purchases).id, 'test'));
      }
    }
    await assertInvariants(repo, 'step ' + step + ' op ' + op);
  }

  const tb = await BeeStore.journal.trialBalance();
  assert.ok(tb.entryCount > 10, 'randomized run must actually post entries');
  assert.strictEqual(balanceOf(tb, '1200'), await subledgerValue(repo));
});
