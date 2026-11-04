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

function balance(tb, code) {
  const row = tb.accounts.find(a => String(a.code) === String(code));
  return row ? row.balanceMinor : 0;
}

async function cashChartId(cash) {
  const chart = await BeeStore.chart.list();
  return chart.find(a => a.legacyAccountId === cash.id || a.id === cash.chartAccountId).id;
}

test('A5 general ledger: opening before from, running balance, closing = trial balance', async () => {
  const { api } = await freshApi('2026-10-31');
  const { cash } = await moneyAccounts(api, { cash: 500000 });
  ok(await api.expenses.create({
    date: '2026-10-05', amountMinor: 12000, categoryName: 'كهرباء', method: 'cash',
  }), 'expense 1');
  ok(await api.expenses.create({
    date: '2026-10-20', amountMinor: 8000, categoryName: 'ماء', method: 'cash',
  }), 'expense 2');
  const accountId = await cashChartId(cash);

  const all = ok(await api.journal.generalLedger({ accountId }), 'ledger all');
  assert.strictEqual(all.openingMinor, 0);
  assert.deepStrictEqual(all.rows.map(r => r.balanceMinor), [500000, 488000, 480000]);
  assert.strictEqual(all.closingMinor, 480000);

  const late = ok(await api.journal.generalLedger({ accountId, from: '2026-10-10' }), 'ledger from');
  assert.strictEqual(late.openingMinor, 488000);
  assert.strictEqual(late.rows.length, 1);
  assert.strictEqual(late.rows[0].creditMinor, 8000);
  assert.strictEqual(late.rows[0].balanceMinor, 480000);
  assert.strictEqual(late.closingMinor, 480000);

  const early = ok(await api.journal.generalLedger({ accountId, to: '2026-10-10' }), 'ledger to');
  assert.strictEqual(early.closingMinor, 488000);

  const tb = ok(await api.journal.trialBalance({}), 'tb');
  assert.strictEqual(balance(tb, all.account.code), all.closingMinor);

  const byCode = ok(await api.journal.generalLedger({ code: '6020' }), 'ledger by code');
  assert.strictEqual(byCode.closingMinor, 12000);
  assert.strictEqual(byCode.rows[0].sourceType, 'EXPENSE');

  const bad = await api.journal.generalLedger({ accountId, from: '2026-10-20', to: '2026-10-01' });
  assert.strictEqual(bad.ok, false);
  const missing = await api.journal.generalLedger({ accountId: 'nope' });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error.code, 'NOT_FOUND');
});

test('A5 forDocument returns the posting and its reversal with account names', async () => {
  const { api } = await freshApi('2026-10-31');
  await moneyAccounts(api, { cash: 100000 });
  const expense = ok(await api.expenses.create({
    date: '2026-10-05', amountMinor: 12000, categoryName: 'كهرباء', method: 'cash',
  }), 'expense');

  const posted = ok(await api.journal.forDocument(expense.id), 'entries');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].sourceLabel, 'مصروف');
  assert.strictEqual(posted[0].reversed, false);
  const codes = posted[0].lines.map(l => l.code).sort();
  assert.ok(codes.includes('6020'), 'expense account line');
  assert.ok(posted[0].lines.every(l => l.nameAr), 'every line has an account name');
  const debit = posted[0].lines.reduce((s, l) => s + l.debitMinor, 0);
  const credit = posted[0].lines.reduce((s, l) => s + l.creditMinor, 0);
  assert.strictEqual(debit, 12000);
  assert.strictEqual(credit, 12000);

  ok(await api.expenses.void(expense.id, 'خطأ'), 'void');
  const after = ok(await api.journal.forDocument(expense.id), 'entries after void');
  assert.strictEqual(after.length, 2);
  assert.strictEqual(after[0].reversed, true);
  assert.strictEqual(after[1].reversalOf, after[0].id);

  // Linked ids are merged without duplicates.
  const linked = ok(await api.journal.forDocument(null, [after[0].id, after[0].id]), 'by ids');
  assert.strictEqual(linked.length, 1);
  assert.strictEqual(BeeStore.journal.sourceLabel('SALE'), 'فاتورة بيع');
});

test('A5 journal reports are owner-only', async () => {
  useClock('2026-11-01');
  const repo = new MemoryRepository();
  await repo.open();
  BeeStore.auth = new BeeStore.AuthService(repo);
  const api = new Api(repo);
  await BeeStore.auth.init();
  ok(await api.settings.save({ systemStartDate: '2026-11-01' }), 'settings');
  await BeeStore.chart.ensureSeeded();
  ok(await api.security.setPin('owner', '1234'), 'owner pin');
  ok(await api.security.setPin('cashier', '5678'), 'cashier pin');
  await BeeStore.auth.init();

  ok(await api.security.unlock('cashier', '5678'), 'cashier unlock');
  for (const call of [
    () => api.journal.generalLedger({ code: '1010' }),
    () => api.journal.forDocument('x'),
    () => api.journal.trialBalance({}),
  ]) {
    const res = await call();
    assert.strictEqual(res.ok, false, 'cashier must not read the journal');
  }
  ok(await api.security.unlock('owner', '1234'), 'owner unlock');
  ok(await api.journal.generalLedger({ code: '1010' }), 'owner ledger');
});

test('A5 accountant package adds balanced journal sheets that reconcile', async () => {
  const { api } = await freshApi('2026-10-31');
  const { cash } = await moneyAccounts(api, { cash: 500000 });
  const product = ok(await api.products.create({
    name: 'قميص', defaultCostMinor: 1000, defaultPriceMinor: 2500,
  }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق', quantity: 10,
    costMinor: 1000, priceMinor: 2500, date: '2026-10-01',
  }), 'variant');
  ok(await api.sales.create({
    date: '2026-10-10',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 2500 }],
    payments: [{ method: 'cash', amountMinor: 5000 }],
  }), 'sale');
  ok(await api.expenses.create({
    date: '2026-10-31', amountMinor: 12000, categoryName: 'كهرباء', paymentStatus: 'unpaid',
    payee: 'شركة الكهرباء',
  }), 'unpaid expense');

  const built = ok(await api.accountingPackage.build('2026-10', {
    pdfBytes: new Uint8Array([37, 80, 68, 70]), generatedAt: '2026-11-01T09:00:00.000Z',
  }), 'package');
  const entries = BeeStore.zip.readEntries(built.bytes);
  const csv = (name) => {
    const e = entries.find(x => x.name === name);
    assert.ok(e, name + ' missing');
    return new TextDecoder('utf-8').decode(e.data).replace(/^﻿/, '');
  };
  for (const name of ['csv/19-chart-of-accounts.csv', 'csv/20-trial-balance.csv',
    'csv/21-general-ledger.csv', 'csv/22-journal.csv', 'csv/23-reconciliations.csv',
    'csv/24-card-settlements.csv', 'csv/25-unpaid-expenses.csv']) csv(name);
  const xlsx = BeeStore.zip.readEntries(entries.find(e => e.name === 'accounting.xlsx').data);
  assert.strictEqual(xlsx.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).length, 25);

  assert.match(csv('csv/19-chart-of-accounts.csv'), /1010/);
  assert.match(csv('csv/20-trial-balance.csv'), /متوازن \/ Balanced/);
  assert.doesNotMatch(csv('csv/20-trial-balance.csv'), /NOT balanced/);
  assert.match(csv('csv/22-journal.csv'), /JE-000001/);
  assert.match(csv('csv/25-unpaid-expenses.csv'), /شركة الكهرباء/);
  assert.doesNotMatch(csv('csv/23-reconciliations.csv'), /"فرق \/ Difference"/);
  assert.match(csv('csv/23-reconciliations.csv'), /"مطابق \/ OK"/);

  const checks = built.manifest.checks;
  for (const id of ['trial_balance_is_balanced', 'subledgers_match_journal']) {
    const check = checks.find(c => c.id === id);
    assert.ok(check, id + ' missing');
    assert.strictEqual(check.ok, true, id + ' failed: ' + JSON.stringify(check));
  }
  // The cash line of the general ledger closes at the trial-balance balance.
  const tb = ok(await api.journal.trialBalance({ asOf: '2026-10-31' }), 'tb');
  const ledger = ok(await api.journal.generalLedger({
    accountId: (await BeeStore.chart.list()).find(a => a.legacyAccountId === cash.id).id,
    to: '2026-10-31',
  }), 'cash ledger');
  assert.strictEqual(balance(tb, ledger.account.code), ledger.closingMinor);
  assert.strictEqual(ledger.closingMinor, 505000);
});
