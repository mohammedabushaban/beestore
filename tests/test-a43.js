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

async function trialBalance() {
  return BeeStore.journal.trialBalance();
}

function balance(tb, code) {
  const row = tb.accounts.find(a => String(a.code) === String(code));
  return row ? row.balanceMinor : 0;
}

async function activeEntries(sourceType, sourceId) {
  const rows = await BeeStore.journal.forSource(sourceType, sourceId);
  const reversed = new Set(rows.filter(e => e.reversalOf).map(e => e.reversalOf));
  return rows.filter(e => !e.reversalOf && !reversed.has(e.id));
}

async function assertHealthy(label) {
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(tb.balanced, true, (label || '') + ' trial balance must balance');
  const journal = await BeeStore.journal.verify();
  assert.strictEqual(journal.ok, true,
    (label || '') + ' journal verification: ' + JSON.stringify(journal.errors));
  const stock = await BeeStore.stock.verifyStock();
  assert.strictEqual(stock.ok, true,
    (label || '') + ' stock verification: ' + JSON.stringify(stock.mismatches));
}

test('A4.3 payroll components reconcile to the §7.3 example', async () => {
  const { api } = await freshApi('2026-10-31');
  const accounts = await moneyAccounts(api, { cash: 200000, bank: 200000 });
  ok(await api.settings.save({
    payrollComponents: [
      { id: 'withholding', nameAr: 'تأمين الموظف', type: 'employee_withholding', enabled: true, rateBasisPoints: 600 },
      { id: 'employer_cost', nameAr: 'مساهمة صاحب العمل', type: 'employer_cost', enabled: true, rateBasisPoints: 900 },
      { id: 'end_of_service', nameAr: 'مخصص نهاية الخدمة', type: 'end_of_service', enabled: false, rateBasisPoints: 0 },
    ],
  }), 'payroll component settings');
  const employee = ok(await api.employees.create({
    name: 'موظف مكوّنات', baseSalaryMinor: 100000,
  }), 'employee');
  ok(await api.payroll.createAdvance({
    employeeId: employee.id, date: '2026-10-05', amountMinor: 20000,
    method: 'cash', accountId: accounts.cash.id,
  }), 'advance');
  const payroll = ok(await api.payroll.prepare('2026-10'), 'prepare payroll')[0];
  assert.strictEqual(payroll.withholdingMinor, 6000);
  assert.strictEqual(payroll.employerCostMinor, 9000);
  assert.strictEqual(payroll.endOfServiceMinor, 0);
  assert.strictEqual(payroll.netMinor, 94000);

  const edited = ok(await api.payroll.update(payroll.id, {
    bonusMinor: 10000, deductionsMinor: 5000,
  }), 'edit payroll');
  assert.strictEqual(edited.withholdingMinor, 6000);
  assert.strictEqual(edited.netMinor, 99000);

  const paid = ok(await api.payroll.pay(
    payroll.id, 'cash', accounts.cash.id, '', 20000, '2026-10-31'), 'pay payroll');
  assert.strictEqual(paid.netMinor, 79000);
  assert.strictEqual(paid.advanceRepaymentMinor, 20000);

  const entries = await activeEntries('PAYROLL', payroll.id);
  assert.strictEqual(entries.length, 2);
  const accrual = entries.find(e => e.event === 'PAYROLL_ACCRUAL');
  const payment = entries.find(e => e.event === 'PAYROLL_PAYMENT');
  const tb = await trialBalance();
  assert.strictEqual(balance(tb, '6100'), 105000, 'gross salaries');
  assert.strictEqual(balance(tb, '6110'), 9000, 'employer cost');
  assert.strictEqual(balance(tb, '2100'), 0, 'net accrued cleared');
  assert.strictEqual(balance(tb, '2110'), -6000, 'withholding liability');
  assert.strictEqual(balance(tb, '2120'), -9000, 'employer liability');
  assert.strictEqual(balance(tb, '1150'), 0, 'advance repaid');
  assert.strictEqual(balance(tb, '1010'), 101000, 'advance + net salary cash out');
  assert.strictEqual(accrual.lines.length, 5, 'salaries + employer + two liabilities + net accrued');
  assert.strictEqual(payment.lines.length, 3, '2100 / 1150 / cash');

  const liabilities = await BeeStore.payroll.liabilityBalancesAsOf('2026-10-31');
  assert.strictEqual(liabilities.withholding, 6000);
  assert.strictEqual(liabilities.employer, 9000);
  assert.strictEqual(liabilities.total, 15000);

  useClock('2026-11-05');
  ok(await api.payroll.payLiabilities({
    type: 'withholding', amountMinor: 6000, date: '2026-11-05',
    method: 'bank', accountId: accounts.bank.id,
  }), 'pay withholding');
  ok(await api.payroll.payLiabilities({
    type: 'employer', amountMinor: 9000, date: '2026-11-05',
    method: 'bank', accountId: accounts.bank.id,
  }), 'pay employer');
  const tb2 = await trialBalance();
  assert.strictEqual(balance(tb2, '2110'), 0);
  assert.strictEqual(balance(tb2, '2120'), 0);
  assert.strictEqual(balance(tb2, '1020'), 185000, 'bank paid authorities');
  const overpay = await api.payroll.payLiabilities({
    type: 'withholding', amountMinor: 1, date: '2026-11-05',
    method: 'bank', accountId: accounts.bank.id,
  });
  assert.strictEqual(overpay.ok, false, 'overpayment blocked');

  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-11-05',
  }), 'parity');
  assert.deepStrictEqual(parity.failures, []);
  const integrity = ok(await api.maintenance.integrityCheck(), 'integrity');
  assert.deepStrictEqual(
    integrity.errors.filter(e => e.check === 'payroll-math'), [],
    'withholding must be included in the paid-payroll net check');
  await assertHealthy('payroll components');
});

test('A4.3 fixed asset purchase, depreciation and disposal follow §8', async () => {
  const { api } = await freshApi('2026-10-31', { systemStartDate: '2025-12-01' });
  const accounts = await moneyAccounts(api, {
    cash: 500000, systemStartDate: '2025-12-01',
  });
  ok(await api.settings.save({
    systemStartDate: '2025-12-01',
    fixedAssetsEnabled: true,
  }), 'enable fixed assets');

  const asset = ok(await api.fixedAssets.create({
    name: 'رف عرض', purchaseDate: '2025-12-15', costMinor: 120000,
    usefulLifeMonths: 24, salvageValueMinor: 0, paidMinor: 120000,
    method: 'cash', accountId: accounts.cash.id,
  }), 'create asset');
  assert.strictEqual(asset.status, 'active');
  assert.strictEqual((asset.journalEntryIds || []).length, 25,
    'purchase plus 24 scheduled depreciation entries');

  const registerOct = await BeeStore.fixedAssets.registerAsOf('2026-10-31');
  assert.strictEqual(registerOct.costMinor, 120000);
  assert.strictEqual(registerOct.accumulatedMinor, 50000, '10 months × 50.00');
  assert.strictEqual(registerOct.netMinor, 70000);

  const pnlOct = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'),
    'October P&L');
  assert.strictEqual(pnlOct.depreciationExpense, 5000);
  assert.strictEqual(pnlOct.netProfit, -5000);
  const pnlRange = ok(await api.reports.profitAndLoss('2026-01-01', '2026-10-31'),
    'range P&L');
  assert.strictEqual(pnlRange.depreciationExpense, 50000);

  const documentSnap = ok(await api.reports.balanceSnapshot('2026-10-31', {
    legacy: true,
  }), 'document snapshot');
  const journalSnap = ok(await api.reports.balanceSnapshot('2026-10-31', {
    journal: true,
  }), 'journal snapshot');
  assert.strictEqual(documentSnap.assets.fixedAssetsNet, 70000);
  assert.strictEqual(documentSnap.assets.accumulatedDepreciation, 50000);
  assert.strictEqual(journalSnap.assets.fixedAssetsNet, 70000);
  assert.strictEqual(documentSnap.balanced, true);
  assert.strictEqual(journalSnap.balanced, true);

  const disposed = ok(await api.fixedAssets.dispose(asset.id, {
    date: '2026-10-31', proceedsMinor: 60000, method: 'cash',
    accountId: accounts.cash.id,
  }), 'dispose asset');
  assert.strictEqual(disposed.status, 'disposed');
  assert.strictEqual(disposed.bookValueAtDisposalMinor, 70000);
  assert.strictEqual(disposed.gainLossMinor, -10000);

  const tb = await trialBalance();
  assert.strictEqual(balance(tb, '1500'), 0, 'asset cost removed');
  assert.strictEqual(balance(tb, '1590'), 0, 'accumulated depreciation removed');
  assert.strictEqual(balance(tb, '6300'), 50000, 'historical depreciation kept');
  assert.strictEqual(balance(tb, '6350'), 10000, 'disposal loss');
  assert.strictEqual(balance(tb, '4110'), 0, 'no gain');
  assert.strictEqual(balance(tb, '1010'), 440000, 'purchase and proceeds');

  const disposalEntries = await activeEntries('FIXED_ASSET', asset.id);
  assert.strictEqual(disposalEntries.length, 12,
    'purchase + 10 depreciation + disposal (future ones reversed)');
  const schedule = ok(await api.fixedAssets.schedule(asset.id), 'disposal schedule');
  assert.strictEqual(schedule.filter(i => i.status === 'posted').length, 10,
    'ten historical depreciation rows stay posted');
  assert.strictEqual(schedule.filter(i => i.status === 'cancelled').length, 14,
    'future depreciation rows are shown as cancelled, not posted');
  const pnlDisposal = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'),
    'October disposal P&L');
  assert.strictEqual(pnlDisposal.depreciationExpense, 5000);
  assert.strictEqual(pnlDisposal.assetSaleLoss, 10000);
  assert.strictEqual(pnlDisposal.netProfit, -15000);
  const parity = ok(await api.reports.parityReport({
    from: '2026-01-01', to: '2026-10-31',
  }), 'fixed asset parity');
  assert.deepStrictEqual(parity.failures, []);
  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual(replay.counts.fixedAssets.posted, 0, 'fixed asset already posted');
  assert.strictEqual(replay.counts.fixedAssetPayments.posted, 0);
  await assertHealthy('fixed asset disposal');
});

test('A4.3 unpaid fixed assets use 2020 and later payments settle them', async () => {
  const { api } = await freshApi('2026-10-31');
  const accounts = await moneyAccounts(api, { cash: 500000 });
  ok(await api.settings.save({ fixedAssetsEnabled: true }), 'enable fixed assets');
  const asset = ok(await api.fixedAssets.create({
    name: 'ماكينة', purchaseDate: '2026-10-15', costMinor: 100000,
    usefulLifeMonths: 30, salvageValueMinor: 0, paidMinor: 20000,
    method: 'cash', accountId: accounts.cash.id,
  }), 'create unpaid asset');
  assert.strictEqual(await BeeStore.fixedAssets.unpaidAsOf('2026-10-31'), 80000);

  let tb = await trialBalance();
  assert.strictEqual(balance(tb, '2020'), -80000, 'unpaid fixed asset in 2020');
  let snap = ok(await api.reports.balanceSnapshot('2026-10-31', { legacy: true }),
    'snapshot');
  assert.strictEqual(snap.liabilities.unpaidFixedAssets, 80000);
  assert.strictEqual(snap.liabilities.unpaidExpenses, 0);
  assert.strictEqual(snap.assets.fixedAssetsNet, 100000);
  assert.strictEqual(snap.balanced, true);

  const payment = ok(await api.fixedAssets.pay(asset.id, {
    date: '2026-10-20', amountMinor: 50000, method: 'cash',
    accountId: accounts.cash.id,
  }), 'pay asset');
  assert.strictEqual(payment.amountMinor, 50000);
  assert.strictEqual(await BeeStore.fixedAssets.unpaidAsOf('2026-10-31'), 30000);
  tb = await trialBalance();
  assert.strictEqual(balance(tb, '2020'), -30000);
  assert.strictEqual(balance(tb, '1010'), 430000);
  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-10-31',
  }), 'unpaid asset parity');
  assert.deepStrictEqual(parity.failures, []);
  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual(replay.counts.fixedAssetPayments.posted, 0);
  await assertHealthy('unpaid fixed asset');
});

test('A4.3 capitalization warning and schema migration are safe', async () => {
  const defaultSettings = { fixedAssetsEnabled: false, capitalizationWarnThresholdMinor: 50000 };
  assert.strictEqual(BeeStore.settings.capitalizationWarningNeeded(defaultSettings, 50000), true);
  assert.strictEqual(BeeStore.settings.capitalizationWarningNeeded(defaultSettings, 49999), false);
  assert.strictEqual(BeeStore.settings.capitalizationWarningNeeded({
    fixedAssetsEnabled: true, capitalizationWarnThresholdMinor: 50000,
  }, 999999), false);

  const migrated = await BeeStore.migrations.migrate({
    schemaVersion: 8,
    collections: {
      payroll: [{ id: 'pay_old', baseMinor: 10000, netMinor: 10000 }],
      expenses: [],
    },
    meta: { id: 'settings', systemStartDate: '2026-01-01' },
  }, 9);
  assert.strictEqual(migrated.schemaVersion, BeeStore.schemaVersion);
  assert.deepStrictEqual(migrated.collections.payrollLiabilityPayments, []);
  assert.deepStrictEqual(migrated.collections.fixedAssets, []);
  assert.deepStrictEqual(migrated.collections.fixedAssetPayments, []);
  assert.strictEqual(migrated.collections.payroll[0].withholdingMinor, 0);
  assert.strictEqual(migrated.collections.payroll[0].employerCostMinor, 0);
  assert.strictEqual(migrated.collections.payroll[0].endOfServiceMinor, 0);
  assert.strictEqual(migrated.meta.fixedAssetsEnabled, false);
  assert.strictEqual(migrated.meta.capitalizationWarnThresholdMinor, 50000);
  assert.strictEqual(migrated.meta.payrollComponents.length, 3);
});
