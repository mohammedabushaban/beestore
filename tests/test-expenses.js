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

// v2 §13.1.4: shares sum to total, remainder in the last month.
test('V2 spread shares sum with remainder last', async () => {
  const api = await freshApi();
  const e = (await api.expenses.spread({
    date: '2026-10-03', amountMinor: 1000, description: 'ins',
    months: 3, startMonth: '2026-10',
  })).data;
  const shares = BeeStore.expenses.spreadShares(e);
  assert.deepStrictEqual(shares.map(s => s.month), ['2026-10', '2026-11', '2026-12']);
  assert.deepStrictEqual(shares.map(s => s.amountMinor), [333, 333, 334]);
  assert.strictEqual(shares.reduce((a, s) => a + s.amountMinor, 0), 1000);
});

// v2 §13.1.4: profit gets one share per month; cash leaves on payment date.
test('V2 spread hits P&L monthly, not at payment', async () => {
  const api = await freshApi();
  await api.expenses.spread({
    date: '2026-10-03', amountMinor: 120000, description: 'insurance',
    months: 12, startMonth: '2026-10',
  });
  const oct = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  const nov = (await api.reports.profitAndLoss('2026-11-01', '2026-11-30')).data;
  assert.strictEqual(oct.operatingExpenses, 10000);
  assert.strictEqual(nov.operatingExpenses, 10000);
});

// v2 §6.3: editing/voiding spread blocked when any month closed.
test('V2 spread void blocked when an allocated month closed', async () => {
  const api = await freshApi();
  const cashAcc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const e = (await api.expenses.spread({
    date: '2026-08-15', amountMinor: 30000, months: 3, startMonth: '2026-08',
    accountId: cashAcc.id,
  })).data;
  assert.strictEqual((await api.periods.close('2026-08')).ok, true);
  const v = await api.expenses.void(e.id, 'test');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.error.code, 'PERIOD_CLOSED');
  const u = await api.expenses.update(e.id, { description: 'x' });
  assert.strictEqual(u.ok, false);
  assert.strictEqual(u.error.code, 'PERIOD_CLOSED');
});

// v2 §13.1.3: idempotent generation; endMonth/startMonth respected.
test('V2 recurring generation idempotent and bounded', async () => {
  const api = await freshApi();
  const t = (await api.expenses.createRecurring({
    amountMinor: 20000, dayOfMonth: 5, description: 'rent', startMonth: '2026-09',
  })).data;
  assert.strictEqual((await api.expenses.generateRecurring('2026-08')).data.length, 0);
  assert.strictEqual((await api.expenses.generateRecurring('2026-09')).data.length, 1);
  assert.strictEqual((await api.expenses.generateRecurring('2026-09')).data.length, 0);
  const tpl = (await api.expenses.recurring()).data.find(r => r.id === t.id);
  assert.strictEqual(tpl.lastGeneratedMonth, '2026-09');
  await api.expenses.updateRecurring(t.id, { endMonth: '2026-09' }, '2026-09');
  assert.strictEqual((await api.expenses.generateRecurring('2026-10')).data.length, 0);
});

// v2 §13.1.3: effectiveFrom leaves past months untouched.
test('V2 recurring edit does not change past months', async () => {
  const api = await freshApi();
  const t = (await api.expenses.createRecurring({
    amountMinor: 20000, dayOfMonth: 5, description: 'net',
  })).data;
  await api.expenses.generateRecurring('2026-09');
  await api.expenses.updateRecurring(t.id, { amountMinor: 30000 }, '2026-10');
  await api.expenses.generateRecurring('2026-10');
  const all = (await api.expenses.list({})).data.filter(e => e.recurringId === t.id);
  const sep = all.find(e => e.month === '2026-09' || e.date.startsWith('2026-09'));
  const oct = all.find(e => e.month === '2026-10' || e.date.startsWith('2026-10'));
  assert.strictEqual(sep.amountMinor, 20000);
  assert.strictEqual(oct.amountMinor, 30000);
});

// v2 §6.2 regression: generation targets the requested month, so a
// period-scoped list for that month shows it. The expenses page must pass the
// selected period month (not today's) — otherwise created records land outside
// the scoped view and look "unsaved".
test('V2 recurring generation lands in the requested month', async () => {
  BeeStore.dates.setClock(() => '2026-10-15');
  try {
    const api = await freshApi();
    await api.expenses.createRecurring({ amountMinor: 9000, dayOfMonth: 2, description: 'x' });
    const res = await api.expenses.generateRecurring('2026-09');
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].date, '2026-09-02');
    const sep = (await api.expenses.list({ from: '2026-09-01', to: '2026-09-30' })).data;
    assert.strictEqual(sep.length, 1, 'target month list shows the generated expense');
    const oct = (await api.expenses.list({ from: '2026-10-01', to: '2026-10-31' })).data;
    assert.strictEqual(oct.length, 0, 'today month must not contain it');
    // No argument defaults to today's month.
    const res2 = await api.expenses.generateRecurring();
    assert.strictEqual(res2.data[0].date, '2026-10-02');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// v2 §6.4: reserved category names blocked with a helpful message.
test('V2 reserved expense category names rejected', async () => {
  const api = await freshApi();
  const r = await api.expenses.createCategory({ name: 'رواتب' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'VALIDATION');
  assert.ok(r.error.message.includes('الموظفين'), 'hint points to payroll flow');
  assert.strictEqual((await api.expenses.createCategory({ name: 'قرطاسية' })).ok, true);
});
