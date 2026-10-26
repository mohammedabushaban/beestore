const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
['settings', 'auth', 'clockGuard', 'audit', 'accounts', 'categories', 'products', 'variants', 'stock',
 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers', 'expenses',
 'payroll', 'employees', 'transactions', 'periods', 'dailyClosing', 'reports', 'dashboard',
 'backupFile', 'backup', 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

const CLOCK = '2026-10-31';

async function freshApi() {
  BeeStore.dates.setClock(() => CLOCK);
  const repo = new MemoryRepository();
  await repo.open();
  return new Api(repo);
}

/**
 * Cash drawer opens at 1,000.00, a 100.00 cash sale closes on 2026-10-20 with
 * a deliberate 5.00 shortage and 20.00 moved to the bank, then a 30.00 cash
 * sale is posted on 2026-10-25 and deliberately left unclosed.
 */
async function seed(api) {
  const cash = (await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: 100000,
  })).data;
  const bank = (await api.accounts.create({ name: 'البنك', type: 'bank' })).data;
  await api.settings.save({
    systemStartDate: '2026-10-01',
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    unclosedDayWarningDays: 3,
    backupWarnDays: 2,
    backupCriticalDays: 7,
    lastBackupAt: '2026-10-01T09:00:00.000Z',
    lastOffDeviceBackupAt: '2026-10-01T09:00:00.000Z',
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'bank', name: 'تحويل', accountId: bank.id },
    ],
  });
  const product = (await api.products.create({
    name: 'قميص', defaultCostMinor: 1000, defaultPriceMinor: 5000,
  })).data;
  const variant = (await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق',
    quantity: 100, costMinor: 1000, priceMinor: 5000, date: '2026-10-01',
  })).data;
  const sale = (await api.sales.create({
    date: '2026-10-20',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 5000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 10000, date: '2026-10-20' }],
  })).data;
  const preview = (await api.dailyClosings.preview('2026-10-20')).data;
  const close = (await api.dailyClosings.close({
    date: '2026-10-20',
    countedCashMinor: preview.expectedCashMinor - 500,
    takenOutMinor: 2000,
    takenOutMode: 'bank_deposit',
    bankAccountId: bank.id,
  })).data;
  const openSale = (await api.sales.create({
    date: '2026-10-25',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 3000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 3000, date: '2026-10-25' }],
  })).data;
  return { cash, bank, product, variant, sale, close, openSale, preview };
}

const L8_CHECKS = new Set([
  'closing-recompute', 'drawer-balance', 'cash-adjustment', 'unclosed-days',
  'backup', 'backup-offsite', 'storage', 'clock', 'drawer',
]);

function l8Errors(res) {
  return res.errors.filter(e => L8_CHECKS.has(e.check));
}

test('L8: closed day recomputes exactly, drawer balance and freshness are reported', async () => {
  const api = await freshApi();
  try {
    const base = await seed(api);
    const res = (await api.maintenance.integrityCheck()).data;

    assert.deepStrictEqual(l8Errors(res), [], JSON.stringify(res.errors));
    assert.strictEqual(res.checks, 16);

    // 1000.00 + 100.00 − 5.00 shortage = 1095.00 counted; − 20.00 = 1075.00.
    assert.strictEqual(base.close.expectedCashMinor, 110000);
    assert.strictEqual(base.close.differenceMinor, -500);
    assert.strictEqual(base.close.retainedFloatMinor, 107500);
    assert.deepStrictEqual(res.drawer, {
      date: '2026-10-20',
      drawerAccountId: base.cash.id,
      retainedFloatMinor: 107500,
      laterMovementsMinor: 3000,
      expectedMinor: 110500,
      actualMinor: 110500,
    });

    // The deliberately stale active day is a warning, never a blocking error.
    const stale = res.warnings.find(w => w.check === 'unclosed-days');
    assert.ok(stale, 'unclosed day warning');
    assert.match(stale.message, /2026-10-25/);

    assert.ok(res.warnings.some(w => w.check === 'backup'), 'backup age warning');
    assert.ok(res.warnings.some(w => w.check === 'backup-offsite'), 'off-device warning');
    assert.strictEqual(res.storage.supported, false);

    // Tampering with a frozen closing is detected by recomputation.
    await api.repo.transaction(async (tx) => {
      const c = await tx.get('dailyClosings', base.close.id);
      c.expectedCashMinor += 100;
      tx.put('dailyClosings', c);
    });
    const tampered = (await api.maintenance.integrityCheck()).data;
    assert.ok(l8Errors(tampered).some(e => e.check === 'closing-recompute'),
      'expected-cash tamper detected');
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('L8: cash_difference adjustments must match their closing', async () => {
  const api = await freshApi();
  try {
    await seed(api);

    // Voiding the shortage adjustment while the closing still has a −5.00
    // difference must be reported, and the drawer no longer matches.
    await api.repo.transaction(async (tx) => {
      const adjustments = await tx.list('cashAdjustments');
      assert.strictEqual(adjustments.length, 1);
      const adj = adjustments[0];
      adj.voided = true;
      adj.voidReason = 'اختبار';
      tx.put('cashAdjustments', adj);
    });
    const missing = (await api.maintenance.integrityCheck()).data;
    assert.ok(l8Errors(missing).some(e => e.check === 'cash-adjustment'),
      'missing adjustment detected');
    assert.ok(l8Errors(missing).some(e => e.check === 'drawer-balance'),
      'drawer drift detected');

    // Restore it, then tamper only the amount: the adjustment check fires
    // without waiting for a full recomputation.
    await api.repo.transaction(async (tx) => {
      const adjustments = await tx.list('cashAdjustments');
      const adj = adjustments[0];
      adj.voided = false;
      adj.amountMinor = -400;
      tx.put('cashAdjustments', adj);
    });
    const wrong = (await api.maintenance.integrityCheck()).data;
    assert.ok(l8Errors(wrong).some(e => e.check === 'cash-adjustment'),
      'wrong adjustment amount detected');
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('L8: reopen and re-close stays clean, and a clock anomaly is surfaced', async () => {
  const api = await freshApi();
  try {
    const base = await seed(api);

    const reopened = await api.dailyClosings.reopen('2026-10-20', { note: 'اختبار' });
    assert.strictEqual(reopened.ok, true, reopened.ok ? '' : reopened.error.message);
    const afterReopen = (await api.maintenance.integrityCheck()).data;
    assert.deepStrictEqual(l8Errors(afterReopen), [], JSON.stringify(afterReopen.errors));

    const preview = (await api.dailyClosings.preview('2026-10-20')).data;
    const closed = await api.dailyClosings.close({
      date: '2026-10-20',
      countedCashMinor: preview.expectedCashMinor - 500,
      takenOutMinor: 2000,
      takenOutMode: 'bank_deposit',
      bankAccountId: base.bank.id,
    });
    assert.strictEqual(closed.ok, true, closed.ok ? '' : closed.error.message);
    const afterReclose = (await api.maintenance.integrityCheck()).data;
    assert.deepStrictEqual(l8Errors(afterReclose), [], JSON.stringify(afterReclose.errors));
    assert.strictEqual(afterReclose.drawer.retainedFloatMinor, 107500);

    // A phone clock that jumped backwards (latest document is in the future)
    // must be visible in the integrity result. Direct write: a transaction
    // would reset meta.updatedAt to the real current time on commit.
    api.repo.data.meta.get('meta').updatedAt = '2026-11-10T10:00:00.000Z';
    const clocked = (await api.maintenance.integrityCheck()).data;
    assert.ok(clocked.clock && clocked.clock.pending, 'clock anomaly pending');
    assert.ok(clocked.warnings.some(w => w.check === 'clock'), 'clock warning surfaced');
  } finally {
    BeeStore.dates.resetClock();
  }
});
