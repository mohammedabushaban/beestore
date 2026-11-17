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
  'dashboard', 'backup', 'maintenance', 'settlements', 'zip', 'xlsx', 'monthReviewPdf',
  'accountingPackage'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

test.afterEach(() => BeeStore.dates.resetClock());

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

async function freshApi(clock, options) {
  useClock(clock || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: (options && options.systemStartDate) || '2026-10-01',
    blockFutureDates: true,
  }), 'settings');
  await BeeStore.chart.ensureSeeded();
  return { repo, api };
}

async function moneyAccounts(api, opts) {
  const o = opts || {};
  const cash = ok(await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: o.cash || 0,
  }), 'cash account');
  const bank = ok(await api.accounts.create({
    name: 'البنك', type: 'bank', openingBalanceMinor: o.bank || 0,
  }), 'bank account');
  ok(await api.settings.save({
    systemStartDate: o.systemStartDate || '2026-10-01',
    blockFutureDates: true,
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', accountId: bank.id },
    ],
  }), 'settings with accounts');
  return { cash, bank };
}

async function balances(asOf) {
  const tb = await BeeStore.journal.trialBalance(asOf ? { asOf } : {});
  assert.strictEqual(tb.balanced, true, 'trial balance must balance');
  const out = {};
  for (const a of tb.accounts) out[a.code] = a.balanceMinor;
  return out;
}

async function shop(settingsExtra) {
  const { repo, api } = await freshApi('2026-10-31');
  const acc = await moneyAccounts(api, { cash: 100000 });
  ok(await api.settings.save(Object.assign({
    systemStartDate: '2026-10-01', blockFutureDates: true,
    cashDrawerAccountId: acc.cash.id, defaultBankAccountId: acc.bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', kind: 'cash', accountId: acc.cash.id },
      { id: 'card', name: 'بطاقة', kind: 'clearing', accountId: acc.bank.id },
    ],
  }, settingsExtra || {})), 'settings');
  const customer = ok(await api.customers.create({ name: 'زبون', phone: '0599000000' }), 'customer');
  const product = ok(await api.products.create({ name: 'قميص', defaultCostMinor: 400, defaultPriceMinor: 1000 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'x', quantity: 20, costMinor: 400, priceMinor: 1000, date: '2026-10-01',
  }), 'variant');
  return { repo, api, acc, customer, variant };
}

test('audit #1: change is handed back from the cash drawer, never from a card', async () => {
  const { api, variant } = await shop();
  const sale = ok(await api.sales.create({
    date: '2026-10-10', lines: [{ variantId: variant.id, qty: 12, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 10000 }, { method: 'card', amountMinor: 5000 }],
    overpaymentMode: 'change',
  }), 'mixed sale');
  const [cashPay, cardPay] = sale.payments;
  assert.deepStrictEqual([cashPay.changeMinor, cashPay.appliedMinor], [3000, 7000]);
  assert.deepStrictEqual([cardPay.changeMinor, cardPay.appliedMinor], [0, 5000]);
  const b = await balances();
  assert.strictEqual(b['1010'], 100000 + 7000, 'drawer keeps cash net of change');
  const clearing = Object.keys(b).find(c => c !== '1010' && c.startsWith('10'));
  assert.strictEqual(b[clearing], 5000, 'card clearing holds the full card charge');

  const res = await api.sales.create({
    date: '2026-10-10', lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 200 }, { method: 'card', amountMinor: 2000 }],
    overpaymentMode: 'change',
  });
  assert.strictEqual(res.ok, false, 'change above the cash tendered is refused');
});

test('audit #2: tax-inclusive prices are not charged the tax twice', async () => {
  const { api, variant } = await shop({ taxEnabled: true, taxRate: 16, taxIncludedInPrices: true });
  const sale = ok(await api.sales.create({
    date: '2026-10-10', lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 11600 }],
    payments: [{ method: 'cash', amountMinor: 11600 }],
  }), 'inclusive sale');
  assert.strictEqual(sale.totalMinor, 11600);
  assert.strictEqual(sale.taxMinor, 1600);
  const b = await balances();
  assert.strictEqual(b['4010'], -10000);
  assert.strictEqual(b['2300'], -1600);
});

test('audit #3: a full return reverses the output tax and refunds what was paid', async () => {
  const { api, acc, variant } = await shop({ taxEnabled: true, taxRate: 10, taxIncludedInPrices: false });
  const sale = ok(await api.sales.create({
    date: '2026-10-10', lines: [{ variantId: variant.id, qty: 3, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 3300 }],
  }), 'taxed sale');
  assert.strictEqual(sale.totalMinor, 3300);
  const r1 = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-11', lines: [{ saleLineIndex: 0, qty: 1 }],
    refundMode: 'cash_refund', refundMethod: acc.cash.id,
  }), 'partial return');
  assert.deepStrictEqual([r1.refundMinor, r1.taxMinor], [1100, 100]);
  const r2 = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-11', lines: [{ saleLineIndex: 0, qty: 2 }],
    refundMode: 'cash_refund', refundMethod: acc.cash.id,
  }), 'final return');
  assert.deepStrictEqual([r2.refundMinor, r2.taxMinor], [2200, 200]);
  const b = await balances();
  assert.strictEqual(b['2300'] || 0, 0, 'no tax left owing on fully returned goods');
  assert.strictEqual(b['1010'], 100000, 'customer got back exactly what they paid');
  assert.strictEqual((b['4010'] || 0) + (b['4020'] || 0), 0, 'net sales zero');
  const pnl = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'), 'pnl');
  assert.strictEqual(pnl.netSales, 0);
});

test('audit #6: returns share the invoice-level discount', async () => {
  const { api, acc, variant } = await shop();
  const sale = ok(await api.sales.create({
    date: '2026-10-10',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 },
      { variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
    discount: { type: 'percent', value: 10 },
    payments: [{ method: 'cash', amountMinor: 2700 }],
  }), 'discounted sale');
  assert.strictEqual(sale.totalMinor, 2700);
  const r1 = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-11', lines: [{ saleLineIndex: 0, qty: 1 }],
    refundMode: 'cash_refund', refundMethod: acc.cash.id,
  }), 'return 1');
  assert.strictEqual(r1.refundMinor, 900);
  const r2 = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-11',
    lines: [{ saleLineIndex: 0, qty: 1 }, { saleLineIndex: 1, qty: 1 }],
    refundMode: 'cash_refund', refundMethod: acc.cash.id,
  }), 'return 2');
  assert.strictEqual(r1.refundMinor + r2.refundMinor, 2700, 'never refunds more than was paid');
  const b = await balances();
  assert.strictEqual(b['1010'], 100000);
});

test('audit #4: profit⇄cash reconciliation includes customer credits and opening balances', async () => {
  useClock('2026-11-30');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({ systemStartDate: '2026-10-01', blockFutureDates: true }), 'settings');
  await BeeStore.chart.ensureSeeded();
  await moneyAccounts(api, { cash: 100000 });
  const customer = ok(await api.customers.create({ name: 'زبون', phone: '0599000001' }), 'customer');
  ok(await api.customers.receivePayment({
    customerId: customer.id, amountMinor: 5000, method: 'cash', date: '2026-11-10',
  }), 'prepayment');
  for (const month of ['2026-10', '2026-11']) {
    const rec = ok(await api.reports.profitCashReconciliation(month), month);
    assert.strictEqual(rec.matches, true, month + ': ' + rec.cashChange + ' vs ' + rec.actualCashChange);
  }
  const nov = ok(await api.reports.profitCashReconciliation('2026-11'), 'nov');
  assert.strictEqual(nov.deltas.customerCredits, 5000);

  // Once the journal drives reports, the direct cash flow by IAS 7 activity
  // agrees with the actual change in cash.
  const parity = ok(await api.reports.parityReport({ from: '2026-10-01', to: '2026-11-30' }), 'parity');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  ok(await api.reports.approveJournal({ from: '2026-10-01', to: '2026-11-30', approvedBy: 'owner' }), 'approve');
  ok(await api.settings.save({ systemStartDate: '2026-10-01', blockFutureDates: true, fixedAssetsEnabled: true }), 'fa on');
  const cash = (ok(await api.accounts.list(), 'accounts')).find(a => a.type === 'cash');
  ok(await api.fixedAssets.create({
    name: 'حاسوب', purchaseDate: '2026-11-15', costMinor: 30000, usefulLifeMonths: 12,
    paidMinor: 30000, method: 'cash', accountId: cash.id,
  }), 'fixed asset');
  const after = ok(await api.reports.profitCashReconciliation('2026-11'), 'nov after');
  assert.ok(after.activities, 'activities available with journal reports');
  assert.strictEqual(after.activities.operating, 5000);
  assert.strictEqual(after.activities.investing, -30000);
  assert.strictEqual(after.activities.total, after.actualCashChange);
  assert.strictEqual(after.matches, true);
});

test('audit #5: money input parsing', () => {
  const m = BeeStore.money;
  assert.strictEqual(m.fromMajor('12,5'), 1250);
  assert.strictEqual(m.fromMajor('12,50'), 1250);
  assert.strictEqual(m.fromMajor('1,250'), 125000);
  assert.strictEqual(m.fromMajor('1,250.75'), 125075);
  assert.strictEqual(m.fromMajor('1.005'), 101);
  assert.strictEqual(m.fromMajor('-1.005'), -101);
  assert.strictEqual(m.fromMajor('١٢٫٥'), 1250);
  assert.strictEqual(m.fromMajor('1,2,3'), 0);
  assert.strictEqual(m.fromMajor(250.5), 25050);
  assert.strictEqual(m.fromMajor('0.1'), 10);
});
