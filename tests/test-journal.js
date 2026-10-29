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
['settings', 'auth', 'accounts', 'expenses', 'periods', 'chartOfAccounts', 'journal']
  .forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

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
  const byCode = (code) => chart.find(a => a.code === code);
  return { repo, api, chart, byCode };
}

function balanced(lines, extra) {
  return {
    date: '2026-10-05',
    sourceType: 'MANUAL',
    description: 'قيد اختبار',
    lines,
    ...(extra || {}),
  };
}

async function post(entry) {
  return BeeStore.journal.append(entry);
}

test('A1 chart seeds v5 system and expense accounts idempotently', async () => {
  const { repo, api, chart, byCode } = await freshApi();
  const codes = chart.map(a => a.code);
  for (const code of ['1010', '1100', '1150', '1200', '1300', '2010', '2020',
    '2030', '2100', '2110', '2120', '2200', '3010', '3020', '3030',
    '4010', '4020', '4100', '5010', '5020', '5030', '6100', '6110', '6120',
    '6200', '6400', '6410', '6010', '6095']) {
    assert.ok(codes.includes(code), 'missing chart code ' + code);
  }
  assert.ok(!codes.includes('2300'), 'tax payable must not be seeded');
  assert.ok(!codes.includes('1500'), 'fixed assets disabled by default');
  assert.strictEqual(byCode('1010').system, true);
  assert.strictEqual(byCode('1010').normalSide, 'debit');
  assert.strictEqual(byCode('3020').contra, true);
  assert.strictEqual(byCode('3020').normalSide, 'debit');
  assert.strictEqual(byCode('4020').normalSide, 'debit');

  const before = await repo.count('chartOfAccounts');
  await BeeStore.chart.ensureSeeded();
  await BeeStore.chart.ensureSeeded();
  assert.strictEqual(await repo.count('chartOfAccounts'), before, 'chart seeding must be idempotent');

  const systemRename = await api.chart.update(byCode('1010').id, { nameAr: 'اسم آخر' });
  assert.strictEqual(systemRename.ok, false);
  assert.strictEqual(systemRename.error.code, 'PERMISSION');
  const systemDelete = await api.chart.deactivate(byCode('1010').id);
  assert.strictEqual(systemDelete.ok, false);

  const created = await api.chart.create({ nameAr: 'تأمين' });
  assert.strictEqual(created.ok, true);
  assert.match(created.data.code, /^6\d{3}$/);
  assert.strictEqual(created.data.system, false);
  const duplicate = await api.chart.create({ nameAr: 'تأمين' });
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.error.code, 'DUPLICATE');
});

test('A1 fixed-asset chart accounts exist only when the module is enabled', async () => {
  const enabled = await freshApi({ fixedAssetsEnabled: true });
  const codes = enabled.chart.map(a => a.code);
  for (const code of ['1500', '1590', '4110', '6300', '6350']) {
    assert.ok(codes.includes(code), 'missing fixed asset code ' + code);
  }
  assert.strictEqual(enabled.byCode('1590').type, 'contra');
  assert.strictEqual(enabled.byCode('1590').normalSide, 'credit');
});

test('A1 legacy money accounts and expense categories link to the chart', async () => {
  const { repo, api } = await freshApi();
  const bank = (await api.accounts.create({ name: 'بنك تجاري', type: 'bank' })).data;
  assert.ok(bank.chartAccountId, 'legacy bank must get a chart account');
  const bankChart = await repo.get('chartOfAccounts', bank.chartAccountId);
  assert.ok(bankChart);
  assert.match(bankChart.code, /^102\d$/);
  assert.strictEqual(bankChart.legacyAccountId, bank.id);
  assert.strictEqual(bankChart.nameAr, 'بنك تجاري');

  await api.accounts.update(bank.id, { name: 'البنك الرئيسي' });
  const renamed = await repo.get('chartOfAccounts', bank.chartAccountId);
  assert.strictEqual(renamed.nameAr, 'البنك الرئيسي');

  const category = (await api.expenses.createCategory({ name: 'تأمين صحي' })).data;
  assert.ok(category.chartAccountId, 'expense category must link to a chart account');
  const categoryChart = await repo.get('chartOfAccounts', category.chartAccountId);
  assert.strictEqual(categoryChart.type, 'expense');
  assert.match(categoryChart.code, /^6\d{3}$/);
  assert.strictEqual(categoryChart.expenseCategoryId, category.id);
  assert.strictEqual(category.code, categoryChart.code);

  const cash = (await api.accounts.create({ name: 'الصندوق الرئيسي', type: 'cash' })).data;
  assert.ok(cash.chartAccountId, 'legacy cash account must link to the drawer');
  const cashChart = await repo.get('chartOfAccounts', cash.chartAccountId);
  assert.strictEqual(cashChart.systemKey, 'cash');
  assert.strictEqual(cashChart.code, '1010');
  assert.strictEqual(cashChart.legacyAccountId, cash.id);
});

test('A1 journal appends balanced entries with gapless numbers and rolls back failures', async () => {
  const { repo, byCode } = await freshApi();
  const cash = byCode('1010');
  const revenue = byCode('4010');

  const first = await post(balanced([
    { accountId: cash.id, debitMinor: 1250 },
    { accountId: revenue.id, creditMinor: 1250 },
  ]));
  const second = await post(balanced([
    { accountId: cash.id, debitMinor: 500 },
    { accountId: revenue.id, creditMinor: 500 },
  ], { date: '2026-10-06' }));
  assert.strictEqual(first.number, 'JE-000001');
  assert.strictEqual(second.number, 'JE-000002');
  assert.strictEqual((await repo.count('journalEntries')), 2);

  await assert.rejects(
    post(balanced([
      { accountId: cash.id, debitMinor: 100 },
      { accountId: revenue.id, creditMinor: 99 },
    ])),
    e => e.code === 'VALIDATION' && /متوازن/.test(e.message));

  const third = await post(balanced([
    { accountId: cash.id, debitMinor: 700 },
    { accountId: revenue.id, creditMinor: 700 },
  ], { date: '2026-10-07' }));
  assert.strictEqual(third.number, 'JE-000003', 'failed post must not consume a number');

  const invalid = [
    [{ accountId: cash.id, debitMinor: 0 }, { accountId: revenue.id, creditMinor: 0 }],
    [{ accountId: cash.id, debitMinor: -5 }, { accountId: revenue.id, creditMinor: -5 }],
    [{ accountId: cash.id, debitMinor: 1.5 }, { accountId: revenue.id, creditMinor: 1.5 }],
    [{ accountId: cash.id, debitMinor: 5, creditMinor: 5 }, { accountId: revenue.id, creditMinor: 0 }],
    [{ accountId: 'missing', debitMinor: 5 }, { accountId: revenue.id, creditMinor: 5 }],
  ];
  for (const lines of invalid) {
    await assert.rejects(post(balanced(lines)), e => e.code === 'VALIDATION');
  }

  await assert.rejects(
    post(balanced([{ accountId: cash.id, debitMinor: 1 }, { accountId: revenue.id, creditMinor: 1 }],
      { description: '' })),
    e => e.code === 'VALIDATION');
  await assert.rejects(
    post(balanced([{ accountId: cash.id, debitMinor: 1 }, { accountId: revenue.id, creditMinor: 1 }],
      { sourceType: 'SALE', sourceId: null })),
    e => e.code === 'VALIDATION');
});

test('A1 journalEntries cannot be updated or deleted through the repository', async () => {
  const { repo, byCode } = await freshApi();
  const entry = await post(balanced([
    { accountId: byCode('1010').id, debitMinor: 100 },
    { accountId: byCode('4010').id, creditMinor: 100 },
  ]));

  await assert.rejects(
    repo.transaction(async (tx) => { tx.put('journalEntries', { ...entry, description: 'tamper' }); }),
    e => e.code === 'APPEND_ONLY');
  await assert.rejects(
    repo.transaction(async (tx) => { tx.put('journalEntries', { id: 'je_new' }); }),
    e => e.code === 'APPEND_ONLY');
  await assert.rejects(
    repo.transaction(async (tx) => { tx.remove('journalEntries', entry.id); }),
    e => e.code === 'APPEND_ONLY');
  await assert.rejects(
    repo.transaction(async (tx) => { await tx.append('journalEntries', { ...entry }); }),
    e => e.code === 'DUPLICATE');

  const stored = await repo.get('journalEntries', entry.id);
  assert.strictEqual(stored.description, entry.description);
});

test('A1 day, month and future-date locks are enforced inside the journal service', async () => {
  const { repo, byCode } = await freshApi();
  const lines = [
    { accountId: byCode('1010').id, debitMinor: 100 },
    { accountId: byCode('4010').id, creditMinor: 100 },
  ];

  await repo.transaction(async (tx) => {
    tx.put('dailyClosings', { id: 'dc_1', date: '2026-10-05', status: 'closed' });
  });
  await assert.rejects(
    post(balanced(lines, { date: '2026-10-05' })),
    e => e.code === 'DAY_CLOSED');

  await assert.rejects(
    post(balanced(lines, { date: '2026-11-01' })),
    e => e.code === 'VALIDATION');
  const scheduled = await post(balanced(lines, { date: '2026-11-01', isScheduled: true }));
  assert.strictEqual(scheduled.isScheduled, true);
  assert.strictEqual(scheduled.number, 'JE-000001');

  const closed = await freshApi();
  await closed.repo.transaction(async (tx) => {
    tx.put('periodClosings', { id: 'pc_1', month: '2026-10', status: 'closed' });
  });
  const closedLines = [
    { accountId: closed.byCode('1010').id, debitMinor: 100 },
    { accountId: closed.byCode('4010').id, creditMinor: 100 },
  ];
  await assert.rejects(
    post(balanced(closedLines, { date: '2026-10-09' })),
    e => e.code === 'PERIOD_CLOSED');
  await assert.rejects(
    post(balanced(closedLines, { date: '2026-10-09', isScheduled: true })),
    e => e.code === 'PERIOD_CLOSED');
});

test('A1 trial balance reads the journal exactly and balances by date range', async () => {
  const { api, byCode } = await freshApi();
  const cash = byCode('1010');
  const revenue = byCode('4010');
  const expense = byCode('6010');

  await post(balanced([
    { accountId: cash.id, debitMinor: 5000 },
    { accountId: revenue.id, creditMinor: 5000 },
  ], { date: '2026-10-05' }));
  await post(balanced([
    { accountId: expense.id, debitMinor: 2000 },
    { accountId: cash.id, creditMinor: 2000 },
  ], { date: '2026-10-20' }));

  const asOf = (await api.journal.trialBalance({ asOf: '2026-10-10' })).data;
  assert.strictEqual(asOf.entryCount, 1);
  assert.strictEqual(asOf.totalDebitMinor, 5000);
  assert.strictEqual(asOf.totalCreditMinor, 5000);
  assert.strictEqual(asOf.differenceMinor, 0);
  const asOfCash = asOf.accounts.find(r => r.accountId === cash.id);
  assert.strictEqual(asOfCash.debitMinor, 5000);
  assert.strictEqual(asOfCash.creditMinor, 0);
  assert.strictEqual(asOfCash.balanceMinor, 5000);

  const ranged = (await api.journal.trialBalance({ from: '2026-10-20', to: '2026-10-31' })).data;
  assert.strictEqual(ranged.entryCount, 1);
  assert.strictEqual(ranged.totalDebitMinor, 2000);
  const rangedCash = ranged.accounts.find(r => r.accountId === cash.id);
  assert.strictEqual(rangedCash.creditMinor, 2000);
  assert.strictEqual(rangedCash.balanceMinor, -2000);

  const all = (await api.journal.trialBalance()).data;
  assert.strictEqual(all.entryCount, 2);
  assert.strictEqual(all.totalDebitMinor, 7000);
  assert.strictEqual(all.totalCreditMinor, 7000);
  assert.strictEqual(all.balanced, true);
  const allCash = all.accounts.find(r => r.accountId === cash.id);
  assert.strictEqual(allCash.balanceMinor, 3000);
});

test('A1 reversal mirrors the original on its date and cannot be repeated', async () => {
  const { repo, api, byCode } = await freshApi();
  const cash = byCode('1010');
  const revenue = byCode('4010');
  const original = await post(balanced([
    { accountId: cash.id, debitMinor: 3000, memo: 'بيع' },
    { accountId: revenue.id, creditMinor: 3000, memo: 'بيع' },
  ], { sourceType: 'SALE', sourceId: 'sale_1' }));

  const reversals = await repo.transaction(tx =>
    BeeStore.journal.reverseEntries(tx, [original], { reason: 'إلغاء الفاتورة' }));
  assert.strictEqual(reversals.length, 1);
  const reversal = reversals[0];
  assert.strictEqual(reversal.number, 'JE-000002');
  assert.strictEqual(reversal.reversalOf, original.id);
  assert.strictEqual(reversal.date, original.date);
  assert.strictEqual(reversal.sourceType, 'SALE');
  assert.strictEqual(reversal.sourceId, 'sale_1');
  assert.deepStrictEqual(
    reversal.lines.map(l => [l.accountId, l.debitMinor, l.creditMinor]),
    [[cash.id, 0, 3000], [revenue.id, 3000, 0]]);

  const tb = (await api.journal.trialBalance()).data;
  assert.strictEqual(tb.balanced, true);
  assert.strictEqual(tb.accounts.find(r => r.accountId === cash.id).balanceMinor, 0);
  assert.strictEqual(tb.accounts.find(r => r.accountId === revenue.id).balanceMinor, 0);

  await assert.rejects(
    repo.transaction(tx => BeeStore.journal.reverseEntries(tx, [original], { reason: 'مرة ثانية' })),
    e => e.code === 'ALREADY_REVERSED');

  const verify = (await api.journal.verify()).data;
  assert.strictEqual(verify.ok, true, JSON.stringify(verify.errors));
});

test('A1 reversal can post to an inactive historical expense account', async () => {
  const { repo, api, byCode } = await freshApi();
  const cash = byCode('1010');
  const account = (await api.chart.create({ nameAr: 'مصروف نادر' })).data;
  const original = await post(balanced([
    { accountId: account.id, debitMinor: 450 },
    { accountId: cash.id, creditMinor: 450 },
  ], { date: '2026-10-08' }));
  await api.chart.deactivate(account.id);
  const [reversal] = await repo.transaction(tx =>
    BeeStore.journal.reverseEntries(tx, [original], { reason: 'تصحيح' }));
  assert.strictEqual(reversal.lines.find(l => l.accountId === account.id).creditMinor, 450);
  assert.strictEqual((await api.journal.verify()).data.ok, true);
});

test('A1 source lookup, numbering lookup and list filters read the journal', async () => {
  const { api, byCode } = await freshApi();
  const cash = byCode('1010');
  const revenue = byCode('4010');
  const entry = await post(balanced([
    { accountId: cash.id, debitMinor: 900 },
    { accountId: revenue.id, creditMinor: 900 },
  ], { sourceType: 'SALE', sourceId: 'sale_x', description: 'فاتورة اختبار' }));

  const byNumber = (await api.journal.byNumber(entry.number)).data;
  assert.strictEqual(byNumber.id, entry.id);
  const forSource = (await api.journal.forSource('SALE', 'sale_x')).data;
  assert.strictEqual(forSource.length, 1);
  const filtered = (await api.journal.list({ sourceType: 'SALE', accountId: cash.id, search: 'اختبار' })).data;
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual((await api.journal.list({ sourceType: 'NOPE' })).data.length, 0);
});

test('A1 randomized balanced postings preserve trial balance and invariants', async () => {
  const { repo, api, byCode } = await freshApi();
  const accounts = ['1010', '1100', '1200', '2010', '3010', '4010', '5010', '6010']
    .map(code => byCode(code));
  let seed = 20261028;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const posted = [];
  for (let i = 0; i < 30; i++) {
    const date = '2026-10-' + String(2 + (i % 27)).padStart(2, '0');
    const debit = accounts[Math.floor(random() * accounts.length)];
    let credit = accounts[Math.floor(random() * accounts.length)];
    if (credit.id === debit.id) credit = accounts[(accounts.indexOf(credit) + 1) % accounts.length];
    const amount = 1 + Math.floor(random() * 10000);
    posted.push(await post(balanced([
      { accountId: debit.id, debitMinor: amount },
      { accountId: credit.id, creditMinor: amount },
    ], { date, description: 'قيد عشوائي ' + i })));
  }
  // Reverse a deterministic subset; every reversal is itself balanced.
  for (let i = 0; i < posted.length; i += 7) {
    await repo.transaction(tx =>
      BeeStore.journal.reverseEntries(tx, [posted[i]], { reason: 'اختبار ثوابت' }));
  }
  const tb = (await api.journal.trialBalance()).data;
  assert.strictEqual(tb.balanced, true);
  assert.strictEqual(tb.differenceMinor, 0);
  assert.strictEqual(tb.totalDebitMinor, tb.totalCreditMinor);
  const verify = (await api.journal.verify()).data;
  assert.strictEqual(verify.ok, true, JSON.stringify(verify.errors));
  assert.strictEqual(verify.checked.entries, 30 + 5);
});

test('A1 verify detects tampered balances and numbering gaps without fixing them', async () => {
  const { repo, api, byCode } = await freshApi();
  const cash = byCode('1010');
  const revenue = byCode('4010');
  const first = await post(balanced([
    { accountId: cash.id, debitMinor: 100 },
    { accountId: revenue.id, creditMinor: 100 },
  ]));
  const second = await post(balanced([
    { accountId: cash.id, debitMinor: 200 },
    { accountId: revenue.id, creditMinor: 200 },
  ], { date: '2026-10-06' }));

  assert.strictEqual((await api.journal.verify()).data.ok, true);

  repo.data.journalEntries.get(first.id).lines[0].debitMinor += 1;
  let verify = (await api.journal.verify()).data;
  assert.strictEqual(verify.ok, false);
  assert.ok(verify.errors.some(e => e.code === 'entry-balance'));
  assert.strictEqual(verify.checked.differenceMinor, 1);
  assert.strictEqual(repo.data.journalEntries.get(first.id).lines[0].debitMinor, 101,
    'verify must not repair data');

  repo.data.journalEntries.get(second.id).number = 'JE-000003';
  verify = (await api.journal.verify()).data;
  assert.ok(verify.errors.some(e => e.code === 'entry-number-gap'));
});

test('A1 migration v3->v4 seeds the chart and preserves old records and links', async () => {
  const dump = {
    schemaVersion: 3,
    meta: { id: 'meta', schemaVersion: 3, counters: {}, revision: 9 },
    settings: {
      id: 'settings', systemStartDate: '2026-09-01',
      cashDrawerAccountId: 'acc_cash', defaultBankAccountId: 'acc_bank',
      paymentMethods: [
        { id: 'cash', name: 'نقداً', accountId: 'acc_cash' },
        { id: 'card', name: 'بطاقة', accountId: 'acc_bank' },
        { id: 'bank', name: 'تحويل بنكي', accountId: 'acc_bank' },
        { id: 'wallet', name: 'محفظة', accountId: 'acc_wallet' },
      ],
    },
    collections: {
      accounts: [
        { id: 'acc_cash', name: 'الصندوق', type: 'cash', openingBalanceMinor: 5000 },
        { id: 'acc_bank', name: 'البنك', type: 'bank', openingBalanceMinor: 10000 },
        { id: 'acc_wallet', name: 'محفظة إلكترونية', type: 'wallet', openingBalanceMinor: 2000 },
      ],
      expenseCategories: [
        { id: 'ecat_rent', name: 'إيجار', active: true },
        { id: 'ecat_custom', name: 'تأمين', active: true },
      ],
      sales: [{ id: 'sale_old', date: '2026-09-10', totalMinor: 7000, status: 'paid' }],
      expenses: [{ id: 'exp_old', date: '2026-09-12', amountMinor: 500, categoryId: 'ecat_rent' }],
    },
  };
  const out = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
  assert.strictEqual(out.schemaVersion, 6);
  assert.strictEqual(out.meta.schemaVersion, 6);
  assert.strictEqual(out.collections.sales[0].id, 'sale_old');
  assert.strictEqual(out.collections.expenses[0].amountMinor, 500);
  assert.deepStrictEqual(out.collections.journalEntries, []);
  assert.strictEqual(out.meta.counters.journal, 0);

  const chart = out.collections.chartOfAccounts;
  const byCode = c => chart.find(a => a.code === c);
  const cashChart = byCode('1010');
  assert.strictEqual(cashChart.legacyAccountId, 'acc_cash');
  assert.strictEqual(out.collections.accounts.find(a => a.id === 'acc_cash').chartAccountId, cashChart.id);
  const bank = out.collections.accounts.find(a => a.id === 'acc_bank');
  const bankChart = chart.find(a => a.id === bank.chartAccountId);
  assert.match(bankChart.code, /^102\d$/);
  const wallet = out.collections.accounts.find(a => a.id === 'acc_wallet');
  const walletChart = chart.find(a => a.id === wallet.chartAccountId);
  assert.match(walletChart.code, /^105\d$/);
  assert.strictEqual(walletChart.legacyAccountId, 'acc_wallet');

  const rent = out.collections.expenseCategories.find(c => c.id === 'ecat_rent');
  assert.strictEqual(chart.find(a => a.id === rent.chartAccountId).code, '6010');
  const custom = out.collections.expenseCategories.find(c => c.id === 'ecat_custom');
  assert.ok(custom.chartAccountId);
  assert.match(chart.find(a => a.id === custom.chartAccountId).code, /^6\d{3}$/);

  const methods = out.settings.paymentMethods;
  assert.strictEqual(methods.find(m => m.id === 'cash').chartAccountId, cashChart.id);
  assert.strictEqual(methods.find(m => m.id === 'card').kind, 'clearing');
  assert.ok(methods.find(m => m.id === 'card').chartAccountId);
  assert.strictEqual(methods.find(m => m.id === 'bank').kind, 'bank_direct');
  assert.strictEqual(methods.find(m => m.id === 'bank').chartAccountId, bankChart.id);
  assert.ok(!chart.some(a => a.code === '2300'));
  assert.ok(!chart.some(a => a.code === '1500'), 'fixed assets stay off by default');
});

test('A1 migration handles a v1 backup and repairs the JE counter from entries', async () => {
  const v1 = await BeeStore.migrations.migrate({
    schemaVersion: 1,
    meta: { id: 'meta', counters: {}, revision: 1 },
    collections: {},
  }, BeeStore.schemaVersion);
  assert.strictEqual(v1.schemaVersion, 6);
  assert.ok(v1.collections.chartOfAccounts.some(a => a.code === '1010'));

  const preview = {
    schemaVersion: 3,
    meta: { id: 'meta', schemaVersion: 3, counters: {}, revision: 2 },
    settings: { id: 'settings' },
    collections: {
      journalEntries: [
        { id: 'je_7', number: 'JE-000007', date: '2026-09-30', lines: [] },
      ],
    },
  };
  const repaired = await BeeStore.migrations.migrate(preview, BeeStore.schemaVersion);
  assert.strictEqual(repaired.meta.counters.journal, 7);
});

test('A1 backup export/import preserves chart, entries and append-only behavior', async () => {
  const { repo, byCode } = await freshApi();
  const entry = await post(balanced([
    { accountId: byCode('1010').id, debitMinor: 2500 },
    { accountId: byCode('4010').id, creditMinor: 2500 },
  ]));
  const dump = await repo.exportAll();
  assert.strictEqual(dump.schemaVersion, 6);
  assert.strictEqual(dump.collections.chartOfAccounts.length > 0, true);
  assert.strictEqual(dump.collections.journalEntries.length, 1);

  const restored = new MemoryRepository();
  await restored.open();
  await restored.importAll(JSON.parse(JSON.stringify(dump)));
  const restoredApi = new Api(restored);
  const entries = (await restoredApi.journal.list()).data;
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].number, entry.number);
  const chart = (await restoredApi.chart.list()).data;
  assert.ok(chart.some(a => a.code === '1010'));
  assert.strictEqual((await restoredApi.journal.verify()).data.ok, true);

  const next = await restored.transaction(tx => BeeStore.journal.post(tx, balanced([
    { accountId: chart.find(a => a.code === '1010').id, debitMinor: 1 },
    { accountId: chart.find(a => a.code === '4010').id, creditMinor: 1 },
  ])));
  assert.strictEqual(next.number, 'JE-000002');
  await assert.rejects(
    restored.transaction(async (tx) => { tx.remove('journalEntries', entries[0].id); }),
    e => e.code === 'APPEND_ONLY');
});

test('A1 posting to an inactive account is rejected for new entries', async () => {
  const { api, byCode } = await freshApi();
  const account = (await api.chart.create({ nameAr: 'حساب معطل' })).data;
  await api.chart.deactivate(account.id);
  await assert.rejects(
    post(balanced([
      { accountId: account.id, debitMinor: 10 },
      { accountId: byCode('1010').id, creditMinor: 10 },
    ])),
    e => e.code === 'VALIDATION' && /معطّل/.test(e.message));
});
