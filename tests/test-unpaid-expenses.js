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
  'suppliers', 'expenses', 'employees', 'payroll', 'transactions', 'periods',
  'chartOfAccounts', 'journal', 'posting', 'settlements', 'dailyClosing',
  'reports', 'dashboard', 'backup', 'maintenance']
  .forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function ok(result, label) {
  assert.strictEqual(result.ok, true,
    (label ? label + ': ' : '') + (result.ok ? '' : result.error.message));
  return result.data;
}

async function freshApi(options) {
  const opts = options || {};
  BeeStore.dates.setClock(() => opts.today || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: '2026-10-01',
    blockFutureDates: true,
  }));
  const cash = ok(await api.accounts.create({ name: 'الصندوق', type: 'cash' }));
  const bank = ok(await api.accounts.create({ name: 'البنك', type: 'bank' }));
  ok(await api.settings.save({
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', kind: 'cash', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', kind: 'bank_direct', accountId: bank.id },
    ],
  }));
  await BeeStore.chart.ensureSeeded();
  ok(await api.transactions.ownerTransaction({
    date: '2026-10-01', type: 'capital_in', amountMinor: 100000,
    accountId: cash.id, note: 'رأس مال افتتاحي',
  }), 'opening cash');
  return { repo, api, cash, bank };
}

test.afterEach(() => BeeStore.dates.resetClock());

async function accountBalance(api, chartAccountId, asOf) {
  const tb = ok(await api.journal.trialBalance(asOf ? { asOf } : {}), 'trial balance');
  const row = tb.accounts.find(account => account.accountId === chartAccountId);
  return row ? row.balanceMinor : 0;
}

async function creditBalance(api, chartAccountId, asOf) {
  return -(await accountBalance(api, chartAccountId, asOf)) || 0;
}

async function liabilityAccount(api) {
  return ok(await api.chart.bySystemKey('accrued_expenses'), '2020 account');
}

test('A4.2 unpaid expense: October P&L, 2020 liability, then November cash-only payment', async () => {
  const { api, cash } = await freshApi({ today: '2026-10-31' });
  const accrued = await liabilityAccount(api);

  const expense = ok(await api.expenses.create({
    date: '2026-10-31',
    amountMinor: 12000,
    categoryName: 'كهرباء',
    description: 'فاتورة كهرباء أكتوبر',
    paymentStatus: 'unpaid',
    payee: 'شركة الكهرباء',
    dueDate: '2026-11-30',
    method: 'cash',
  }), 'unpaid expense');
  assert.strictEqual(expense.paymentStatus, 'unpaid');
  assert.strictEqual(expense.paidMinor, 0);
  assert.strictEqual(expense.initialPaidMinor, 0);
  assert.strictEqual(expense.dueDate, '2026-11-30');

  const octPnl = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31', { legacy: true }));
  assert.strictEqual(octPnl.expensesByCategory['كهرباء'], 12000);
  assert.strictEqual(octPnl.netProfit, -12000);
  const octJournalPnl = ok(await api.reports.journalProfitAndLoss('2026-10-01', '2026-10-31'));
  assert.strictEqual(octJournalPnl.netProfit, octPnl.netProfit);

  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-10-31'), 100000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-10-31'), 12000);
  assert.strictEqual(ok(await api.expenses.unpaidAsOf('2026-10-31')), 12000);

  const docSnapshot = ok(await api.reports.balanceSnapshot('2026-10-31', { legacy: true }));
  const journalSnapshot = ok(await api.reports.balanceSnapshot('2026-10-31', { journal: true }));
  assert.strictEqual(docSnapshot.liabilities.unpaidExpenses, 12000);
  assert.strictEqual(journalSnapshot.liabilities.unpaidExpenses, 12000);
  assert.strictEqual(docSnapshot.assets.cashBalance, 100000);
  assert.strictEqual(journalSnapshot.assets.cashBalance, 100000);
  assert.strictEqual(docSnapshot.balanced, true);
  assert.strictEqual(journalSnapshot.balanced, true);

  const octClosing = ok(await api.dailyClosings.preview('2026-10-31'));
  assert.strictEqual(octClosing.cashExpensesMinor, 0);
  assert.strictEqual(octClosing.expectedCashMinor, 100000);

  // Pay in November: cash out on the payment day, no November P&L expense.
  BeeStore.dates.setClock(() => '2026-11-10');
  const paid = ok(await api.expenses.pay(expense.id, {
    date: '2026-11-10', amountMinor: 12000, method: 'cash', note: 'تحويل كهرباء',
  }), 'expense payment');
  assert.strictEqual(paid.payment.amountMinor, 12000);
  assert.strictEqual(paid.payment.methodKind, 'cash');
  assert.strictEqual(paid.expense.paymentStatus, 'paid');
  assert.strictEqual(paid.expense.paidMinor, 12000);

  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-11-10'), 88000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-11-10'), 0);
  assert.strictEqual(ok(await api.expenses.unpaidAsOf('2026-11-10')), 0);
  const novPnl = ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30', { legacy: true }));
  assert.strictEqual(novPnl.expensesByCategory['كهرباء'] || 0, 0);
  assert.strictEqual(novPnl.netProfit, 0);

  const novClosing = ok(await api.dailyClosings.preview('2026-11-10'));
  assert.strictEqual(novClosing.cashExpensesMinor, 12000);
  assert.strictEqual(novClosing.expectedCashMinor, 88000);

  const aging = ok(await api.expenses.aging('2026-10-31'));
  assert.strictEqual(aging.totalMinor, 12000);
  assert.strictEqual(aging.rows.length, 1);
  assert.strictEqual(aging.rows[0].expenseId, expense.id);
  assert.strictEqual(aging.rows[0].remainingMinor, 12000);
});

test('A4.2 partial expense splits cash and 2020 exactly and later payment clears the rest', async () => {
  const { api, cash } = await freshApi({ today: '2026-10-31' });
  const accrued = await liabilityAccount(api);
  const expense = ok(await api.expenses.create({
    date: '2026-10-05', amountMinor: 12000, categoryName: 'صيانة',
    paymentStatus: 'partial', paidMinor: 5000, method: 'cash',
  }), 'partial expense');
  assert.strictEqual(expense.paymentStatus, 'partial');
  assert.strictEqual(expense.paidMinor, 5000);

  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-10-05'), 95000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-10-05'), 7000);
  const preview = ok(await api.dailyClosings.preview('2026-10-05'));
  assert.strictEqual(preview.cashExpensesMinor, 5000);
  assert.strictEqual(preview.expectedCashMinor, 95000);

  const tooMuch = await api.expenses.pay(expense.id, {
    date: '2026-10-06', amountMinor: 7001, method: 'cash',
  });
  assert.strictEqual(tooMuch.ok, false);
  assert.strictEqual(tooMuch.error.code, 'VALIDATION');

  BeeStore.dates.setClock(() => '2026-11-10');
  const paid = ok(await api.expenses.pay(expense.id, {
    date: '2026-11-10', amountMinor: 7000, method: 'bank',
  }), 'remaining payment');
  assert.strictEqual(paid.expense.paymentStatus, 'paid');
  assert.strictEqual(paid.expense.paidMinor, 12000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-11-10'), 0);
  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-11-10'), 95000);
});

test('A4.2 spread expense keeps the full amount in 1300 and releases monthly even when unpaid', async () => {
  const { api, cash } = await freshApi({ today: '2026-10-31' });
  const accrued = await liabilityAccount(api);
  const prepaid = ok(await api.chart.bySystemKey('prepaid'), '1300 account');
  const expense = ok(await api.expenses.create({
    date: '2026-10-01', amountMinor: 12000, categoryName: 'تأمين',
    paymentStatus: 'unpaid',
    allocation: { mode: 'spread', months: 3, startMonth: '2026-10' },
  }), 'spread expense');
  assert.strictEqual(expense.paymentStatus, 'unpaid');

  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-10-31'), 100000);
  assert.strictEqual(await accountBalance(api, prepaid.id, '2026-10-31'), 8000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-10-31'), 12000);
  const octPnl = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31', { legacy: true }));
  assert.strictEqual(octPnl.expensesByCategory['تأمين'], 4000);
  const novPnl = ok(await api.reports.profitAndLoss('2026-11-01', '2026-11-30', { legacy: true }));
  assert.strictEqual(novPnl.expensesByCategory['تأمين'], 4000);
  const decPnl = ok(await api.reports.profitAndLoss('2026-12-01', '2026-12-31', { legacy: true }));
  assert.strictEqual(decPnl.expensesByCategory['تأمين'], 4000);

  BeeStore.dates.setClock(() => '2026-11-05');
  const paid = ok(await api.expenses.pay(expense.id, {
    date: '2026-11-05', amountMinor: 12000, method: 'cash',
  }), 'spread liability payment');
  assert.strictEqual(paid.expense.paymentStatus, 'paid');
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-11-05'), 0);
  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-11-05'), 88000);
});

test('A4.2 guards: paid expenses freeze, payments cap at the remainder, and voids reverse exactly', async () => {
  const { repo, api, cash } = await freshApi({ today: '2026-10-31' });
  const accrued = await liabilityAccount(api);
  const expense = ok(await api.expenses.create({
    date: '2026-10-10', amountMinor: 10000, categoryName: 'إنترنت وهاتف',
    paymentStatus: 'unpaid',
  }), 'unpaid expense');

  const early = await api.expenses.pay(expense.id, {
    date: '2026-10-09', amountMinor: 1000, method: 'cash',
  });
  assert.strictEqual(early.ok, false);

  const first = ok(await api.expenses.pay(expense.id, {
    date: '2026-10-20', amountMinor: 4000, method: 'cash',
  }), 'first payment');
  const second = ok(await api.expenses.pay(expense.id, {
    date: '2026-10-25', amountMinor: 6000, method: 'cash',
  }), 'second payment');
  assert.strictEqual(second.expense.paymentStatus, 'paid');
  const over = await api.expenses.pay(expense.id, {
    date: '2026-10-26', amountMinor: 1, method: 'cash',
  });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.error.code, 'VALIDATION');
  assert.strictEqual((await api.expenses.update(expense.id, { description: 'x' })).ok, false);
  assert.strictEqual((await api.expenses.void(expense.id, 'خطأ')).ok, false);

  // A cash payment on a closed day cannot be voided until that day reopens.
  await repo.transaction(async tx => {
    tx.put('dailyClosings', {
      id: 'dc-expense-lock', date: '2026-10-25', status: 'closed',
      createdAt: BeeStore.dates.now(),
    });
  });
  const closedDayVoid = await api.expenses.voidPayment(second.payment.id, 'محاولة في يوم مقفل');
  assert.strictEqual(closedDayVoid.ok, false);
  assert.strictEqual(closedDayVoid.error.code, 'DAY_CLOSED');
  await repo.transaction(async tx => tx.remove('dailyClosings', 'dc-expense-lock'));

  BeeStore.dates.setClock(() => '2026-11-10');
  const voided = ok(await api.expenses.voidPayment(first.payment.id, 'دفعة مكررة'), 'void payment');
  assert.strictEqual(voided.expense.paymentStatus, 'partial');
  assert.strictEqual(voided.expense.paidMinor, 6000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-11-10'), 4000);
  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-11-10'), 94000);

  const voidedSecond = ok(await api.expenses.voidPayment(second.payment.id, 'إلغاء الدفعة الثانية'), 'void second payment');
  assert.strictEqual(voidedSecond.expense.paymentStatus, 'unpaid');
  assert.strictEqual(voidedSecond.expense.paidMinor, 0);
  assert.strictEqual(await accountBalance(api, cash.chartAccountId, '2026-11-10'), 100000);
  assert.strictEqual(await creditBalance(api, accrued.id, '2026-11-10'), 10000);

  const voidExpense = ok(await api.expenses.void(expense.id, 'مصروف غير صحيح'), 'void expense');
  assert.strictEqual(voidExpense.voided, true);
  const last = ok(await api.journal.trialBalance(), 'trial balance');
  assert.strictEqual(last.balanced, true);
  assert.strictEqual(await creditBalance(api, accrued.id), 0);
  assert.strictEqual(await accountBalance(api, cash.chartAccountId), 100000);
});

test('A4.2 replay and parity keep unpaid/partial expenses exact', async () => {
  const { api } = await freshApi({ today: '2026-10-31' });
  ok(await api.expenses.create({
    date: '2026-10-03', amountMinor: 9000, categoryName: 'كهرباء',
    paymentStatus: 'partial', paidMinor: 3000, method: 'cash',
  }), 'partial expense');
  ok(await api.expenses.create({
    date: '2026-10-04', amountMinor: 6000, categoryName: 'ماء',
    paymentStatus: 'unpaid',
    allocation: { mode: 'spread', months: 2, startMonth: '2026-10' },
  }), 'spread expense');
  BeeStore.dates.setClock(() => '2026-11-10');
  const list = ok(await api.expenses.unpaid('2026-11-10'));
  for (const row of list) {
    const remaining = row.remainingMinor;
    if (remaining > 0) {
      ok(await api.expenses.pay(row.expenseId, {
        date: '2026-11-10', amountMinor: remaining, method: 'bank',
      }), 'pay ' + row.expenseId);
    }
  }
  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-11-10', replay: true,
  }), 'parity');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  const replay = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-11-10',
  }), 'idempotent parity');
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.failures));
});

test('A4.2 schema 7 backups migrate to expensePayments without changing historical payment state', async () => {
  const data = {
    schemaVersion: 7,
    collections: {
      expenses: [
        { id: 'exp1', date: '2026-10-31', amountMinor: 12000, categoryName: 'كهرباء' },
        { id: 'exp2', date: '2026-10-30', amountMinor: 8000, categoryName: 'ماء', paidMinor: 3000 },
      ],
    },
  };
  const migrated = await BeeStore.migrations.migrate(data);
  assert.strictEqual(migrated.schemaVersion, BeeStore.schemaVersion);
  assert.ok(Array.isArray(migrated.collections.expensePayments));
  assert.strictEqual(migrated.collections.expensePayments.length, 0);
  const first = migrated.collections.expenses.find(e => e.id === 'exp1');
  assert.strictEqual(first.paidMinor, 12000);
  assert.strictEqual(first.initialPaidMinor, 12000);
  assert.strictEqual(first.paymentStatus, 'paid');
  assert.strictEqual(first.payee, '');
  assert.strictEqual(first.dueDate, null);
  const second = migrated.collections.expenses.find(e => e.id === 'exp2');
  assert.strictEqual(second.paidMinor, 3000);
  assert.strictEqual(second.initialPaidMinor, 3000);
  assert.strictEqual(second.paymentStatus, 'partial');
});
