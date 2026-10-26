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
 'backup', 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

async function fresh(clock) {
  BeeStore.dates.setClock(() => clock || '2026-11-20');
  const repo = new MemoryRepository();
  await repo.open();
  // Every test gets a clean auth state (the app itself uses one singleton).
  BeeStore.auth = new BeeStore.AuthService(repo);
  BeeStore.clockGuard = new BeeStore.ClockGuardService(repo);
  const api = new Api(repo);
  await BeeStore.auth.init();
  await api.settings.save({
    systemStartDate: '2026-11-01',
    autoLockMinutes: 5,
    lockoutAfter: 3,
    lockoutSeconds: 10,
    cashierMaxDiscountPercent: 10,
    cashierMaxReturnMinor: 5000,
    cashDenominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.1],
  });
  const cash = (await api.accounts.create({ name: 'الصندوق', type: 'cash' })).data;
  const product = (await api.products.create({
    name: 'منتج', defaultCostMinor: 1000, defaultPriceMinor: 5000,
  })).data;
  const variant = (await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق',
    quantity: 100, costMinor: 1000, priceMinor: 5000, date: '2026-11-01',
  })).data;
  await api.security.setPin('owner', '1234');
  await api.security.setPin('cashier', '5678');
  await BeeStore.auth.init();
  return { repo, api, cash, product, variant };
}

async function unlockCashier(api) {
  const res = await api.security.unlock('cashier', '5678');
  assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
  return res.data;
}

async function unlockOwner(api) {
  const res = await api.security.unlock('owner', '1234');
  assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
  return res.data;
}

function payFull(cash, amount, date) {
  return [{ method: 'cash', accountId: cash.id, amountMinor: amount, date: date || '2026-11-20' }];
}

test('PIN hashes are salted PBKDF2 and never stored in plain text', async () => {
  const utils = BeeStore.authUtils;
  const a = await utils.hashPin('1234');
  const b = await utils.hashPin('1234');
  assert.notStrictEqual(a.salt, b.salt, 'each PIN gets a random salt');
  assert.notStrictEqual(a.hash, b.hash, 'same PIN + different salt = different hash');
  assert.strictEqual(a.iterations, 210000);
  assert.strictEqual(a.algorithm, 'PBKDF2-SHA256');
  assert.strictEqual(JSON.stringify(a).includes('1234'), false);
  assert.strictEqual(await utils.verifyPin('1234', a), true);
  assert.strictEqual(await utils.verifyPin('9999', a), false);
  await assert.rejects(() => utils.hashPin('12'), /4/);
  await assert.rejects(() => utils.hashPin('1234567'), /4/);
});

test('owner and cashier profiles: lock, wrong PIN, lockout delay, switch', async () => {
  const { api } = await fresh();
  let state = BeeStore.auth.state();
  assert.strictEqual(state.configured, true);
  assert.strictEqual(state.locked, true);
  assert.strictEqual(state.profile, null);

  // Owner must unlock before any data call.
  let res = await api.products.list();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'LOCKED');

  // Wrong PIN.
  res = await api.security.unlock('owner', '0000');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'WRONG_PIN');

  // Third wrong attempt triggers the configured delay.
  await api.security.unlock('owner', '0001');
  res = await api.security.unlock('owner', '0002');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'LOCKED');
  assert.match(res.error.message, /ثانية/);

  // The correct PIN is refused while the delay is active.
  res = await api.security.unlock('owner', '1234');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'LOCKED');

  // Simulate the delay elapsing without waiting in the test.
  BeeStore.auth._lockUntil.owner = 0;
  await unlockOwner(api);
  assert.strictEqual(BeeStore.auth.state().profile, 'owner');

  // Manual lock, then switch to the cashier.
  res = await api.security.lock('اختبار');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(BeeStore.auth.state().locked, true);
  state = await unlockCashier(api);
  assert.strictEqual(state.profile, 'cashier');
  assert.strictEqual(BeeStore.auth.isCashier(), true);

  await api.security.lock();
  state = await unlockOwner(api);
  assert.strictEqual(state.profile, 'owner');
});

test('facade permission table: cashier cannot leave the allow-list', async () => {
  const { api, repo } = await fresh();
  await unlockCashier(api);

  const denied = [
    ['reports.profitAndLoss', () => api.reports.profitAndLoss('2026-11-01', '2026-11-30')],
    ['expenses.list', () => api.expenses.list()],
    ['purchases.list', () => api.purchases.list()],
    ['payroll.list', () => api.payroll.list()],
    ['accounts.list', () => api.accounts.list()],
    ['settings.update', () => api.settings.update({ storeName: 'x' })],
    ['backup.createNow', () => api.backup.createNow()],
    ['products.create', () => api.products.create({ name: 'x' })],
    ['variants.update', () => api.variants.update('x', { priceMinor: 1 })],
    ['stock.adjust', () => api.stock.adjust('x', 1, 'test')],
    ['sales.void', () => api.sales.void('x', 'test')],
    ['periods.close', () => api.periods.close('2026-11')],
    ['dailyClosings.close', () => api.dailyClosings.close({ date: '2026-11-20', noCount: true })],
    ['maintenance.resetAll', () => api.maintenance.resetAll()],
    ['audit.list', () => api.audit.list()],
  ];
  for (const [name, call] of denied) {
    const res = await call();
    assert.strictEqual(res.ok, false, name + ' must be denied');
    assert.strictEqual(res.error.code, 'PERMISSION', name);
  }
  // The denial did not write anything.
  assert.strictEqual((await repo.list('expenses')).length, 0);
});

test('cashier responses strip every cost/profit field, settings keep only pinSet', async () => {
  const { api, product, variant, cash } = await fresh();
  // Create a sale as owner so printData has cost lines to strip.
  await unlockOwner(api);
  const sale = (await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
    payments: payFull(cash, 5000),
  })).data;

  await api.security.lock();
  await unlockCashier(api);

  const products = await api.products.list();
  assert.strictEqual(products.ok, true);
  const p = products.data.find(x => x.id === product.id);
  assert.ok(p);
  assert.strictEqual(p.defaultCostMinor, undefined);
  assert.strictEqual(JSON.stringify(products.data).includes('CostMinor'), false);

  const variants = await api.variants.list();
  const v = variants.data.find(x => x.id === variant.id);
  assert.ok(v);
  assert.strictEqual(v.costMinor, undefined);
  assert.strictEqual(v.priceMinor, 5000);
  assert.strictEqual(v.quantity, 99);

  const withVariants = await api.products.getWithVariants(product.id);
  assert.strictEqual(withVariants.ok, true);
  assert.strictEqual(JSON.stringify(withVariants.data).includes('CostMinor'), false);

  const printData = await api.sales.printData(sale.id);
  assert.strictEqual(printData.ok, true);
  assert.strictEqual(JSON.stringify(printData.data).includes('unitCostMinor'), false);

  const settings = await api.settings.get();
  assert.strictEqual(settings.ok, true);
  assert.strictEqual(settings.data.profiles.owner.pinSet, true);
  assert.strictEqual(settings.data.profiles.cashier.pinSet, true);
  assert.strictEqual(settings.data.profiles.owner.pin, undefined);
  assert.strictEqual(JSON.stringify(settings.data).includes('"salt"'), false);
  assert.strictEqual(JSON.stringify(settings.data).includes('PBKDF2'), false);

  const dash = await api.dashboard.get();
  assert.strictEqual(dash.ok, true);
  assert.strictEqual(dash.data.cashier, true);
  assert.ok(dash.data.today);
  assert.strictEqual(dash.data.month, undefined);
  assert.strictEqual(dash.data.inventory, undefined);
  assert.strictEqual(JSON.stringify(dash.data).toLowerCase().includes('profit'), false);
});

test('cashier discount and return limits are enforced inside the facade', async () => {
  const { api, cash, variant } = await fresh();
  await unlockCashier(api);

  const overDiscount = await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000, lineDiscountMinor: 501 }],
    payments: payFull(cash, 4499),
  });
  assert.strictEqual(overDiscount.ok, false);
  assert.strictEqual(overDiscount.error.code, 'PERMISSION');
  assert.match(overDiscount.error.message, /خصم/);

  const exactDiscount = await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000, lineDiscountMinor: 500 }],
    payments: payFull(cash, 4500),
  });
  assert.strictEqual(exactDiscount.ok, true, exactDiscount.ok ? '' : exactDiscount.error.message);
  assert.strictEqual(exactDiscount.data.discountMinor, 0);
  assert.strictEqual(exactDiscount.data.totalMinor, 4500);
  assert.strictEqual(exactDiscount.data.createdByProfile, 'cashier');

  const sale = (await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 5000 }],
    payments: payFull(cash, 10000),
  })).data;

  const tooBig = await api.returns.create({
    saleId: sale.id,
    date: '2026-11-20',
    lines: [{ saleLineIndex: 0, qty: 2 }],
    refundMode: 'cash_refund',
    refundMethod: cash.id,
  });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.error.code, 'PERMISSION');
  assert.match(tooBig.error.message, /مرتجع/);

  const atLimit = await api.returns.create({
    saleId: sale.id,
    date: '2026-11-20',
    lines: [{ saleLineIndex: 0, qty: 1 }],
    refundMode: 'cash_refund',
    refundMethod: cash.id,
  });
  assert.strictEqual(atLimit.ok, true, atLimit.ok ? '' : atLimit.error.message);
  assert.strictEqual(atLimit.data.refundMinor, 5000);
  assert.strictEqual(atLimit.data.createdByProfile, 'cashier');

  // Audit entries made while acting as the cashier carry that profile.
  await new Promise(resolve => setImmediate(resolve));
  await api.security.lock();
  await unlockOwner(api);
  const audit = await api.audit.list();
  const entry = audit.data.find(a => a.action === 'return');
  assert.ok(entry, 'a return audit entry exists');
  assert.strictEqual(entry.profile, 'cashier');
  assert.strictEqual(entry.profileName, 'الكاشير');
});

test('cashier day summary only counts invoices created by the cashier', async () => {
  const { api, cash, variant } = await fresh();
  await unlockOwner(api);
  await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
    payments: payFull(cash, 5000),
  });
  await api.security.lock();
  await unlockCashier(api);
  await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 5000 }],
    payments: payFull(cash, 10000),
  });
  const dash = await api.dashboard.get();
  assert.strictEqual(dash.ok, true);
  assert.strictEqual(dash.data.today.invoiceCount, 1);
  assert.strictEqual(dash.data.today.revenue, 10000);
  assert.strictEqual(dash.data.recentInvoices.length, 1);
});

test('clock guard blocks posting until the owner confirms the date', async () => {
  BeeStore.dates.setClock(() => '2026-12-01');
  const repo = new MemoryRepository();
  await repo.open();
  BeeStore.auth = new BeeStore.AuthService(repo);
  BeeStore.clockGuard = new BeeStore.ClockGuardService(repo);
  const api = new Api(repo);
  await BeeStore.auth.init();
  await api.settings.save({ systemStartDate: '2026-11-01' });
  const cash = (await api.accounts.create({ name: 'الصندوق', type: 'cash' })).data;
  const product = (await api.products.create({ name: 'منتج', defaultPriceMinor: 5000 })).data;
  const variant = (await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق',
    quantity: 10, costMinor: 1000, priceMinor: 5000, date: '2026-12-01',
  })).data;
  // A committed write at 2026-12-01 leaves meta.updatedAt in the future.
  await api.sales.create({
    date: '2026-12-01',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
    payments: payFull(cash, 5000, '2026-12-01'),
  });
  // The memory repo stamps real time; set the committed timestamp explicitly
  // so the test represents a phone that wrote on 2026-12-01 and then rolled back.
  repo.data.meta.get('meta').updatedAt = '2026-12-01T12:00:00.000Z';

  // Roll the phone clock back by eleven days.
  BeeStore.dates.setClock(() => '2026-11-20');
  let state = await BeeStore.clockGuard.check();
  assert.strictEqual(state.pending, true);
  assert.ok(state.backwardDays >= 10);
  BeeStore.auth.setClockState(state);

  let blocked = await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
    payments: payFull(cash, 5000),
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error.code, 'CLOCK_ANOMALY');

  const confirmed = await api.security.confirmClock();
  assert.strictEqual(confirmed.ok, true);
  assert.strictEqual(confirmed.data.pending, false);

  const allowed = await api.sales.create({
    date: '2026-11-20',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 5000 }],
    payments: payFull(cash, 5000),
  });
  assert.strictEqual(allowed.ok, true, allowed.ok ? '' : allowed.error.message);

  // A large forward jump is also flagged.
  BeeStore.dates.setClock(() => '2027-01-20');
  state = await BeeStore.clockGuard.check();
  assert.strictEqual(state.pending, true);
  assert.ok(state.forwardDays >= 31);
  assert.match(state.reasons.join(' '), /الأمام/);
});

test('security update validates limits and requires the owner PIN', async () => {
  const { api } = await fresh();
  await unlockCashier(api);
  let res = await api.security.update({ autoLockMinutes: 10 }, '5678');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'PERMISSION');

  await api.security.lock();
  await unlockOwner(api);

  res = await api.security.update({ autoLockMinutes: 10 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');

  res = await api.security.update({ autoLockMinutes: 99 }, '1234');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');

  res = await api.security.update({ autoLockMinutes: 12, largeFont: true }, '1234');
  assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
  assert.strictEqual(res.data.autoLockMinutes, 12);
  assert.strictEqual(res.data.largeFont, true);
  assert.strictEqual(res.data.profiles.owner.pinSet, true);
  assert.strictEqual(res.data.profiles.owner.pin, undefined);

  const stored = await BeeStore.settings.get();
  assert.strictEqual(stored.autoLockMinutes, 12);
  assert.ok(stored.profiles.owner.pin.salt);
  assert.ok(stored.profiles.owner.pin.hash);
});
