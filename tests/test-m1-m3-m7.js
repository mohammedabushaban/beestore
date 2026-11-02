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
[
  'settings', 'audit', 'accounts', 'categories', 'products', 'variants', 'stock',
  'sales', 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers',
  'expenses', 'employees', 'payroll', 'transactions', 'periods',
  'chartOfAccounts', 'journal', 'posting', 'dailyClosing', 'reports',
  'dashboard', 'backup', 'maintenance',
].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

function balance(tb, code) {
  const row = tb.accounts.find(a => String(a.code) === String(code));
  return row ? row.balanceMinor : 0;
}

async function freshApi() {
  BeeStore.dates.setClock(() => '2026-11-20');
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

/** Creates a cash drawer and opening capital, then returns both. */
async function drawerWithCapital(api, amountMinor) {
  const cash = ok(await api.accounts.create({
    name: 'الصندوق', type: 'cash',
  }), 'cash account');
  ok(await api.settings.save({
    systemStartDate: '2026-11-01',
    blockFutureDates: true,
    cashDrawerAccountId: cash.id,
    paymentMethods: [{ id: 'cash', name: 'نقداً', kind: 'cash', accountId: cash.id }],
  }), 'settings with drawer');
  ok(await api.transactions.ownerTransaction({
    date: '2026-11-01', type: 'capital_in',
    amountMinor: amountMinor || 10000, accountId: cash.id,
  }), 'capital');
  return cash;
}

async function quickItem(api, data) {
  const res = ok(await api.products.quickAdd({
    name: 'شاي', costMinor: 500, priceMinor: 1000,
    openingQuantity: 10, date: '2026-11-01',
    ...(data || {}),
  }), 'quick add');
  assert.ok(res.variant, 'quick add creates a default variant');
  return res;
}

test.afterEach(() => BeeStore.dates.resetClock());

/* ------------------------------------------------------------------ M1 ---- */

test('M1: quick add creates a category-free item with a default variant and item code', async () => {
  const { api } = await freshApi();
  const { product, variant } = await quickItem(api, { name: 'قهوة عربية' });

  assert.strictEqual(product.itemCode, '1001');
  assert.strictEqual(product.categoryId, null, 'category is optional');
  assert.strictEqual(product.hasVariants, false);
  assert.strictEqual(product.defaultVariantId, variant.id);
  assert.strictEqual(variant.itemCode, '1001', 'default variant shares the parent code');
  assert.strictEqual(variant.size, '');
  assert.strictEqual(variant.color, '');
  assert.strictEqual(variant.quantity, 10);
  assert.strictEqual(variant.valueMinor, 5000);
  assert.strictEqual(ok(await api.products.nextItemCode()), '1002');

  const movements = ok(await api.stock.movements(variant.id));
  assert.strictEqual(movements.length, 1);
  assert.strictEqual(movements[0].type, 'opening');
  assert.strictEqual(movements[0].qtyChange, 10);

  // Search must find the item by code and by Arabic-normalized name.
  const byCode = ok(await api.products.search('1001'));
  assert.strictEqual(byCode.length, 1);
  assert.strictEqual(byCode[0].id, product.id);
  const variantsByCode = ok(await api.variants.search('1001'));
  assert.strictEqual(variantsByCode.length, 1);
  assert.strictEqual(variantsByCode[0].id, variant.id);
  const byArabic = ok(await api.variants.search('قهوه عربيه'));
  assert.ok(byArabic.some(v => v.id === variant.id), 'Arabic letter variants are matched');

  const tb = ok(await api.journal.trialBalance());
  assert.strictEqual(balance(tb, '1200'), 5000, 'opening stock is tracked');
  assert.strictEqual(balance(tb, '3030'), -5000, 'opening stock posts to opening equity');
});

test('M1: item codes stay unique and explicit numeric codes advance the sequence', async () => {
  const { api } = await freshApi();
  await quickItem(api, { name: 'صنف أول' });

  const duplicate = await api.products.quickAdd({
    name: 'مكرر', itemCode: '1001', costMinor: 500, priceMinor: 1000,
    openingQuantity: 0, date: '2026-11-01',
  });
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.error.code, 'DUPLICATE');

  const explicit = await quickItem(api, {
    name: 'صنف برمز', itemCode: '2000', openingQuantity: 1,
  });
  assert.strictEqual(explicit.product.itemCode, '2000');
  assert.strictEqual(ok(await api.products.nextItemCode()), '2001');

  const auto = await quickItem(api, { name: 'تلقائي', openingQuantity: 0 });
  assert.strictEqual(auto.product.itemCode, '2001');
});

test('M1: variants get parent-prefixed codes and duplicate variant codes are rejected', async () => {
  const { api } = await freshApi();
  const product = ok(await api.products.create({
    name: 'قميص',
    itemCode: '3000',
    defaultCostMinor: 500,
    defaultPriceMinor: 1000,
    hasVariants: true,
    variants: [
      { size: 'M', color: 'أحمر', quantity: 1, costMinor: 500, priceMinor: 1000 },
      { size: 'L', color: 'أزرق', quantity: 1, costMinor: 500, priceMinor: 1000 },
    ],
    date: '2026-11-01',
  }), 'grid item');

  const variants = ok(await api.variants.list());
  const codes = variants
    .filter(v => v.productId === product.id)
    .map(v => v.itemCode)
    .sort();
  assert.deepStrictEqual(codes, ['3000-1', '3000-2']);

  const clash = await api.variants.create({
    productId: product.id,
    size: 'S', color: 'أخضر',
    itemCode: '3000-1',
    costMinor: 500, priceMinor: 1000,
    quantity: 1,
    date: '2026-11-01',
  });
  assert.strictEqual(clash.ok, false);
  assert.strictEqual(clash.error.code, 'DUPLICATE');
});

/* ------------------------------------------------------------------ M3 ---- */

test('M3: line prices snapshot the list price and price variance reports both directions', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const low = ok(await api.sales.create({
    date: '2026-11-02',
    lines: [{ variantId: variant.id, qty: 1, listPriceMinor: 1000, unitPriceMinor: 800 }],
    payments: [{ method: 'cash', amountMinor: 800 }],
  }), 'below-list sale');
  assert.strictEqual(low.lines[0].listPriceMinor, 1000);
  assert.strictEqual(low.lines[0].unitPriceMinor, 800);
  assert.strictEqual(low.lines[0].priceDiffMinor, -200);
  assert.strictEqual(low.totalMinor, 800);

  const high = ok(await api.sales.create({
    date: '2026-11-03',
    lines: [{ variantId: variant.id, qty: 1, listPriceMinor: 1000, unitPriceMinor: 1250 }],
    payments: [{ method: 'cash', amountMinor: 1250 }],
  }), 'above-list sale');
  assert.strictEqual(high.lines[0].priceDiffMinor, 250);

  const report = ok(await api.reports.priceVariance(
    '2026-11-01', '2026-11-30', 'item'));
  assert.strictEqual(report.belowMinor, 200);
  assert.strictEqual(report.aboveMinor, 250);
  assert.strictEqual(report.netMinor, 50);
  assert.strictEqual(report.rows.length, 1);
  assert.strictEqual(report.rows[0].key, 'شاي');
  assert.strictEqual(report.rows[0].lines, 2);
});

test('M3: change mode keeps only the invoice amount in the drawer', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const sale = ok(await api.sales.create({
    date: '2026-11-02',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 1200 }],
  }), 'change sale');

  assert.strictEqual(sale.overpaymentMode, 'change');
  assert.strictEqual(sale.overpaymentMinor, 200);
  assert.strictEqual(sale.changeGivenMinor, 200);
  assert.strictEqual(sale.paidMinor, 1000);
  assert.strictEqual(sale.dueMinor, 0);
  assert.strictEqual(sale.payments[0].amountMinor, 1200);
  assert.strictEqual(sale.payments[0].appliedMinor, 1000);
  assert.strictEqual(sale.payments[0].changeMinor, 200);

  const tb = ok(await api.journal.trialBalance());
  assert.strictEqual(balance(tb, '1010'), 11000, 'drawer keeps the invoice total only');
  assert.strictEqual(balance(tb, '1100'), 0, 'AR is cleared');
  assert.strictEqual(balance(tb, '2030'), 0, 'change is not a customer credit');
  assert.strictEqual(balance(tb, '4100'), 0, 'change is not income');

  const pnl = ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30'));
  assert.strictEqual(pnl.otherIncome, 0);
});

test('M3: customer-credit excess becomes a customer credit and a 2030 liability', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);
  const customer = ok(await api.customers.create({ name: 'زبون' }), 'customer');

  const sale = ok(await api.sales.create({
    date: '2026-11-02',
    customerId: customer.id,
    customerName: customer.name,
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 1200 }],
    overpaymentMode: 'customer_credit',
  }), 'credit sale');

  assert.strictEqual(sale.overpaymentMode, 'customer_credit');
  assert.strictEqual(sale.overpaymentMinor, 200);
  assert.strictEqual(sale.changeGivenMinor, 0);
  assert.strictEqual(sale.payments[0].appliedMinor, 1000);
  assert.strictEqual(sale.payments[0].changeMinor, 0);

  const tb = ok(await api.journal.trialBalance());
  assert.strictEqual(balance(tb, '1010'), 11200, 'the full physical receipt stays in cash');
  assert.strictEqual(balance(tb, '2030'), -200, 'excess is a customer-credit liability');
  assert.strictEqual(balance(tb, '1100'), 0);
  assert.strictEqual(ok(await api.customers.balance(customer.id)), -200);

  const snap = ok(await api.reports.balanceSnapshot('2026-11-30'));
  assert.strictEqual(snap.liabilities.customerCredits, 200);

  const parity = ok(await api.reports.parityReport({
    from: '2026-11-01', to: '2026-11-30',
  }), 'parity');
  assert.deepStrictEqual(parity.failures, []);
});

test('M3: other-income excess posts to 4100, appears in P&L and is owner-only', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const sale = ok(await api.sales.create({
    date: '2026-11-02',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 1200 }],
    overpaymentMode: 'other_income',
  }), 'other income sale');
  assert.strictEqual(sale.overpaymentMode, 'other_income');
  assert.strictEqual(sale.overpaymentMinor, 200);

  const tb = ok(await api.journal.trialBalance());
  assert.strictEqual(balance(tb, '1010'), 11200);
  assert.strictEqual(balance(tb, '2030'), 0);
  assert.strictEqual(balance(tb, '4100'), -200, 'rounding/gratuity income');

  const pnl = ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30'));
  assert.strictEqual(pnl.otherIncome, 200);
  assert.strictEqual(pnl.netProfit, pnl.grossProfit + 200 - pnl.operatingExpenses);

  const parity = ok(await api.reports.parityReport({
    from: '2026-11-01', to: '2026-11-30',
  }), 'parity');
  assert.deepStrictEqual(parity.failures, []);

  await assert.rejects(() => BeeStore.sales.create({
    date: '2026-11-03',
    createdByProfile: 'cashier',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 1200 }],
    overpaymentMode: 'other_income',
  }), err => err.code === 'PERMISSION');
});

/* ------------------------------------------------------------------ M7 ---- */

test('M7: invoice-less return needs a reason, restocks at current average cost and is auditable', async () => {
  const { api } = await freshApi();
  const cash = await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const missing = await api.returns.create({
    saleId: null,
    date: '2026-11-05',
    lines: [{ variantId: variant.id, qty: 1 }],
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error.code, 'INVALID');

  const ret = ok(await api.returns.create({
    saleId: null,
    date: '2026-11-05',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000, restock: true }],
    reason: 'زبون أصر على الإرجاع',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  }), 'unlinked return');

  assert.strictEqual(ret.saleId, null);
  assert.strictEqual(ret.mode, 'unlinked');
  assert.deepStrictEqual(ret.flags, ['NO_REFERENCE']);
  assert.strictEqual(ret.refundMinor, 2000);
  assert.strictEqual(ret.lines[0].saleLineIndex, null);
  assert.strictEqual(ret.lines[0].reference, null);
  assert.strictEqual(ret.lines[0].listPriceMinor, 1000);
  assert.strictEqual(ret.lines[0].unitPriceMinor, 1000);
  assert.strictEqual(ret.lines[0].itemCode, '1001');
  assert.strictEqual(ret.lines[0].restockCostMinor, 1000, '2 × current average 500');

  const listed = ok(await api.returns.list({ from: '2026-11-01', to: '2026-11-30' }));
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].saleNumber, '', 'no missing-invoice lookup');
  assert.strictEqual(listed[0].customerName, '');

  const tb = ok(await api.journal.trialBalance());
  assert.strictEqual(balance(tb, '1010'), 8000, 'cash refund leaves the drawer');
  assert.strictEqual(balance(tb, '4020'), 2000, 'sales returns are recorded');
  assert.strictEqual(balance(tb, '1200'), 6000, 'returned units are back in inventory');
  assert.strictEqual(balance(tb, '5010'), -1000, 'COGS is reversed at current average');

  const report = ok(await api.reports.unlinkedReturns(
    '2026-11-01', '2026-11-30'));
  assert.strictEqual(report.count, 1);
  assert.strictEqual(report.totalRefundMinor, 2000);
  assert.strictEqual(report.byProfile.owner, 2000);
  assert.strictEqual(report.byDay['2026-11-05'], 2000);

  // Keep the unused account reference meaningful for future refund routing.
  assert.ok(cash.id);
});

test('M7: cashier invoice-less returns are blocked by default and capped by list price', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  await assert.rejects(() => BeeStore.returns.create({
    saleId: null,
    date: '2026-11-05',
    createdByProfile: 'cashier',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    reason: 'إرجاع',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  }), err => err.code === 'PERMISSION');

  ok(await api.settings.save({
    systemStartDate: '2026-11-01',
    blockFutureDates: true,
    cashierUnlinkedReturnLimitMinor: 5000,
  }), 'raise cashier limit');

  const allowed = await BeeStore.returns.create({
    saleId: null,
    date: '2026-11-05',
    createdByProfile: 'cashier',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    reason: 'إرجاع',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  });
  assert.strictEqual(allowed.refundMinor, 1000);

  await assert.rejects(() => BeeStore.returns.create({
    saleId: null,
    date: '2026-11-06',
    createdByProfile: 'cashier',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1200 }],
    reason: 'إرجاع بسعر أعلى',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  }), err => err.code === 'PERMISSION');

  // The owner can override the list price; the override is flagged.
  const ownerOverride = ok(await api.returns.create({
    saleId: null,
    date: '2026-11-06',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1200 }],
    reason: 'تسوية مع الزبون',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  }), 'owner override');
  assert.strictEqual(ownerOverride.lines[0].unitPriceMinor, 1200);
  assert.deepStrictEqual(ownerOverride.flags, ['NO_REFERENCE', 'PRICE_OVERRIDE']);
});

test('M7: mixed linked/unlinked returns are flagged and still reverse the linked sale', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const sale = ok(await api.sales.create({
    date: '2026-11-02',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 1000 }],
  }), 'sale');

  const ret = ok(await api.returns.create({
    saleId: sale.id,
    date: '2026-11-04',
    lines: [
      { saleLineIndex: 0, qty: 1 },
      { variantId: variant.id, qty: 1, unitPriceMinor: 1000, restock: true },
    ],
    reason: 'استبدال جزئي',
    refundMode: 'cash_refund',
    refundPaymentMethod: 'cash',
  }), 'mixed return');

  assert.strictEqual(ret.mode, 'mixed');
  assert.deepStrictEqual(ret.flags, ['NO_REFERENCE']);
  assert.strictEqual(ret.refundMinor, 2000);
  assert.strictEqual(ret.lines[0].saleLineIndex, 0);
  assert.strictEqual(ret.lines[1].saleLineIndex, null);

  const updatedSale = ok(await api.sales.get(sale.id));
  assert.strictEqual(updatedSale.returnStatus, 'full');
  assert.strictEqual(updatedSale.lines[0].returnedQty, 1);

  const report = ok(await api.reports.unlinkedReturns(
    '2026-11-01', '2026-11-30'));
  assert.strictEqual(report.count, 1, 'mixed returns appear in the audit report');
});

test('M7: a customer-credit return without a customer is rejected', async () => {
  const { api } = await freshApi();
  await drawerWithCapital(api, 10000);
  const { variant } = await quickItem(api);

  const res = await api.returns.create({
    saleId: null,
    date: '2026-11-05',
    lines: [{ variantId: variant.id, qty: 1 }],
    reason: 'إرجاع',
    refundMode: 'customer_credit',
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'CUSTOMER_REQUIRED');
});

/* -------------------------------------------------------- migration 9→10 ---- */

test('migration 9→10 preserves old overpayments and backfills item/variant/return fields', async () => {
  const data = {
    schemaVersion: 9,
    settings: { systemStartDate: '2026-01-01' },
    meta: { id: 'meta', schemaVersion: 9, counters: {} },
    collections: {
      products: [
        { id: 'prd_default', name: 'شاي', defaultCostMinor: 500, defaultPriceMinor: 1000 },
        { id: 'prd_sized', name: 'قميص', defaultCostMinor: 500, defaultPriceMinor: 1000 },
        {
          id: 'prd_explicit', name: 'صنف قديم', itemCode: '5000',
          defaultCostMinor: 500, defaultPriceMinor: 1000,
        },
      ],
      variants: [
        {
          id: 'var_default', productId: 'prd_default', size: '', color: '',
          barcode: '111', costMinor: 500, priceMinor: 1000, quantity: 5,
          valueMinor: 2500,
        },
        {
          id: 'var_sized_1', productId: 'prd_sized', size: 'M', color: 'أحمر',
          barcode: '222', costMinor: 500, priceMinor: 1000, quantity: 1,
          valueMinor: 500,
        },
        {
          id: 'var_sized_2', productId: 'prd_sized', size: 'L', color: 'أزرق',
          barcode: '333', costMinor: 500, priceMinor: 1000, quantity: 1,
          valueMinor: 500,
        },
        {
          id: 'var_explicit', productId: 'prd_explicit', size: '', color: '',
          barcode: '444', costMinor: 500, priceMinor: 1000, quantity: 1,
          valueMinor: 500,
        },
      ],
      sales: [{
        id: 'sal_old',
        number: 'INV-000001',
        date: '2026-01-10',
        customerId: 'cus_1',
        status: 'paid',
        totalMinor: 3000,
        payments: [{ method: 'cash', amountMinor: 4000, date: '2026-01-10' }],
        lines: [{
          variantId: 'var_default', productName: 'شاي', qty: 3,
          unitPriceMinor: 1000, unitCostMinor: 500, lineTotalMinor: 3000,
        }],
      }],
      salesReturns: [{
        id: 'ret_old',
        number: 'RET-000001',
        date: '2026-01-12',
        saleId: null,
        refundMinor: 1000,
        lines: [{
          variantId: 'var_default', productName: 'شاي', qty: 1,
          unitPriceMinor: 1000,
        }],
      }],
    },
  };

  const migrated = await BeeStore.migrations.migrate(data, 10);
  assert.strictEqual(migrated.schemaVersion, 10);

  const products = Object.fromEntries(migrated.collections.products.map(p => [p.id, p]));
  // The explicit 5000 advances the sequence first, so auto codes start at
  // 5001 and can never collide with it.
  assert.strictEqual(products.prd_default.itemCode, '5001');
  assert.strictEqual(products.prd_default.hasVariants, false);
  assert.strictEqual(products.prd_default.defaultVariantId, 'var_default');
  assert.strictEqual(products.prd_sized.itemCode, '5002');
  assert.strictEqual(products.prd_sized.hasVariants, true);
  assert.strictEqual(products.prd_explicit.itemCode, '5000');
  assert.ok(products.prd_default.searchKey.includes('شاي'));
  assert.strictEqual(products.prd_default.unit, 'قطعة');

  const variants = Object.fromEntries(migrated.collections.variants.map(v => [v.id, v]));
  assert.strictEqual(variants.var_default.itemCode, '5001');
  assert.strictEqual(variants.var_sized_1.itemCode, '5002-1');
  assert.strictEqual(variants.var_sized_2.itemCode, '5002-2');
  assert.strictEqual(variants.var_explicit.itemCode, '5000');
  assert.strictEqual(migrated.meta.counters.itemCode, 4002);

  const sale = migrated.collections.sales[0];
  assert.strictEqual(sale.overpaymentMinor, 1000);
  assert.strictEqual(sale.overpaymentMode, 'customer_credit',
    'old excess keeps its historical 2030 meaning');
  assert.strictEqual(sale.changeGivenMinor, 0);
  assert.strictEqual(sale.payments[0].appliedMinor, 3000);
  assert.strictEqual(sale.payments[0].changeMinor, 0);
  assert.strictEqual(sale.lines[0].listPriceMinor, 1000);
  assert.strictEqual(sale.lines[0].priceDiffMinor, 0);
  assert.strictEqual(sale.lines[0].itemCode, '5001');

  const ret = migrated.collections.salesReturns[0];
  assert.strictEqual(ret.mode, 'unlinked');
  assert.deepStrictEqual(ret.flags, ['NO_REFERENCE']);
  assert.strictEqual(ret.lines[0].reference, null);
  assert.strictEqual(ret.lines[0].listPriceMinor, 1000);
  assert.strictEqual(ret.lines[0].itemCode, '5001');
  assert.strictEqual(migrated.settings.cashierUnlinkedReturnLimitMinor, 0);

  // Re-running the migration is a no-op and never re-codes documents.
  const again = await BeeStore.migrations.migrate(migrated, 10);
  assert.strictEqual(again.collections.products[0].itemCode, '5001');
  assert.strictEqual(again.collections.sales[0].overpaymentMode, 'customer_credit');
  assert.strictEqual(again.meta.counters.itemCode, 4002);
});
