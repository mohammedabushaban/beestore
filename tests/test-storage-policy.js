const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

test.afterEach(() => BeeStore.dates.resetClock());

test('L2 storage policy: dated collections and their fields', () => {
  const policy = BeeStore.storagePolicy;
  assert.strictEqual(policy.dateFieldFor('sales'), 'date');
  assert.strictEqual(policy.dateFieldFor('purchases'), 'date');
  assert.strictEqual(policy.dateFieldFor('expenses'), 'date');
  assert.strictEqual(policy.dateFieldFor('payroll'), 'month');
  assert.strictEqual(policy.dateFieldFor('auditLog'), 'timestamp');
  assert.strictEqual(policy.dateFieldFor('products'), null);
  assert.strictEqual(policy.dateFieldFor('customers'), null);
  // Every dated collection must be either fully in memory (master) or lazy.
  for (const name of Object.keys(policy.datedCollections)) {
    assert.ok(BeeStore.COLLECTIONS.includes(name), name + ' is not a collection');
    assert.ok(!policy.masterCollections.includes(name), name + ' is both master and lazy');
  }
});

test('L2 storage policy: window is current month plus N previous months', () => {
  useClock('2026-10-25');
  const oct = BeeStore.storagePolicy.windowBounds('2026-10-25', 2);
  assert.deepStrictEqual(oct, { startMonth: '2026-08', startDate: '2026-08-01' });

  const jan = BeeStore.storagePolicy.windowBounds('2026-01-15', 2);
  assert.deepStrictEqual(jan, { startMonth: '2025-11', startDate: '2025-11-01' });

  const zero = BeeStore.storagePolicy.windowBounds('2026-03-31', 0);
  assert.deepStrictEqual(zero, { startMonth: '2026-03', startDate: '2026-03-01' });

  const clamped = BeeStore.storagePolicy.windowBounds('2026-03-31', -4);
  assert.deepStrictEqual(clamped, { startMonth: '2026-03', startDate: '2026-03-01' });

  // Default comes from config (2).
  assert.strictEqual(BeeStore.storagePolicy.memoryWindowMonths(), 2);
  const configValue = BeeStore.config.memoryWindowMonths;
  BeeStore.config.memoryWindowMonths = 12;
  assert.strictEqual(BeeStore.storagePolicy.memoryWindowMonths(), 12);
  BeeStore.config.memoryWindowMonths = configValue;
});

test('L2 storage policy: dates, months and timestamps fall in the window', () => {
  const policy = BeeStore.storagePolicy;
  const bounds = { startMonth: '2026-08', startDate: '2026-08-01' };

  assert.strictEqual(policy.inMemoryWindow({ date: '2026-07-31' }, 'date', bounds), false);
  assert.strictEqual(policy.inMemoryWindow({ date: '2026-08-01' }, 'date', bounds), true);
  assert.strictEqual(policy.inMemoryWindow({ month: '2026-07' }, 'month', bounds), false);
  assert.strictEqual(policy.inMemoryWindow({ month: '2026-08' }, 'month', bounds), true);
  assert.strictEqual(policy.inMemoryWindow({ timestamp: '2026-08-01T00:00:00.000Z' }, 'timestamp', bounds), true);
  assert.strictEqual(policy.inMemoryWindow({ timestamp: '2026-07-31T23:59:59.000Z' }, 'timestamp', bounds), false);
  // Legacy records without a date stay visible instead of disappearing.
  assert.strictEqual(policy.inMemoryWindow({}, 'date', bounds), true);
  assert.strictEqual(policy.inMemoryWindow(null, 'date', bounds), true);
});

test('L2 storage policy: range bounds are inclusive and optional', () => {
  const policy = BeeStore.storagePolicy;
  const doc = { date: '2026-10-15' };
  assert.strictEqual(policy.inRange(doc, 'date', '2026-10-01', '2026-10-31'), true);
  assert.strictEqual(policy.inRange(doc, 'date', '2026-10-15', '2026-10-15'), true);
  assert.strictEqual(policy.inRange(doc, 'date', '2026-10-16', undefined), false);
  assert.strictEqual(policy.inRange(doc, 'date', undefined, '2026-10-14'), false);
  assert.strictEqual(policy.inRange(doc, 'date', undefined, undefined), true);
  assert.strictEqual(policy.inRange({ month: '2026-10' }, 'month', '2026-10', '2026-10'), true);
  assert.strictEqual(policy.inRange({}, 'date', '2026-10-01', '2026-10-31'), true);
});

test('L2 MemoryRepository.listRange filters by the collection date field', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  await repo.transaction(async (tx) => {
    tx.put('sales', { id: 's_old', date: '2026-07-31', totalMinor: 100 });
    tx.put('sales', { id: 's_aug1', date: '2026-08-01', totalMinor: 200 });
    tx.put('sales', { id: 's_oct', date: '2026-10-15', totalMinor: 300 });
    tx.put('payroll', { id: 'p_aug', month: '2026-08', baseMinor: 1000 });
    tx.put('payroll', { id: 'p_oct', month: '2026-10', baseMinor: 2000 });
    tx.put('auditLog', { id: 'a_old', timestamp: '2026-07-01T10:00:00.000Z' });
    tx.put('auditLog', { id: 'a_new', timestamp: '2026-10-01T10:00:00.000Z' });
  });

  const month = await repo.listRange('sales', '2026-10-01', '2026-10-31');
  assert.deepStrictEqual(month.map(d => d.id), ['s_oct']);

  const window = await repo.listRange('sales', '2026-08-01', '2026-10-31');
  assert.deepStrictEqual(window.map(d => d.id).sort(), ['s_aug1', 's_oct']);

  const payroll = await repo.listRange('payroll', '2026-08', '2026-08');
  assert.deepStrictEqual(payroll.map(d => d.id), ['p_aug']);

  const audit = await repo.listRange('auditLog', '2026-09-01', '2026-10-31');
  assert.deepStrictEqual(audit.map(d => d.id), ['a_new']);

  const paid = await repo.listRange('sales', '2026-08-01', '2026-10-31', s => s.totalMinor >= 300);
  assert.deepStrictEqual(paid.map(d => d.id), ['s_oct']);

  // Master collections ignore date bounds but still honour the predicate.
  const products = await repo.listRange('products', '2026-10-01', '2026-10-31', p => p.active === true);
  assert.deepStrictEqual(products, []);
});

test('L2 MemoryRepository.lastManyByIndex returns the latest doc per key', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  await repo.transaction(async (tx) => {
    tx.put('stockMovements', { id: 'm1', variantId: 'v1', date: '2026-07-10', balanceAfter: 4, createdAt: '2026-07-10T09:00:00.000Z' });
    tx.put('stockMovements', { id: 'm2', variantId: 'v1', date: '2026-09-10', balanceAfter: 6, createdAt: '2026-09-10T09:00:00.000Z' });
    tx.put('stockMovements', { id: 'm3', variantId: 'v1', date: '2026-09-10', balanceAfter: 7, createdAt: '2026-09-10T10:00:00.000Z' });
    tx.put('stockMovements', { id: 'm4', variantId: 'v2', date: '2026-09-01', balanceAfter: 2, createdAt: '2026-09-01T09:00:00.000Z' });
  });
  const sep = await repo.lastManyByIndex('stockMovements', 'variantDate', 'variantId',
    ['v1', 'v2'], 'date', '2026-09-30');
  assert.strictEqual(sep.v1.id, 'm3', 'same-day tie-break uses createdAt');
  assert.strictEqual(sep.v2.id, 'm4');
  const jul = await repo.lastManyByIndex('stockMovements', 'variantDate', 'variantId',
    ['v1'], 'date', '2026-07-31');
  assert.strictEqual(jul.v1.id, 'm1');
  assert.deepStrictEqual(Object.keys(await repo.lastManyByIndex(
    'stockMovements', 'variantDate', 'variantId', [], 'date', '2026-09-30')), []);
});

test('L2 MemoryRepository transaction sees staged docs in listRange', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  await repo.transaction(async (tx) => {
    tx.put('sales', { id: 's_sep', date: '2026-09-10', totalMinor: 100 });
  });
  await repo.transaction(async (tx) => {
    tx.put('sales', { id: 's_oct', date: '2026-10-10', totalMinor: 200 });
    tx.remove('sales', 's_sep');
    const rows = await tx.listRange('sales', '2026-09-01', '2026-10-31');
    assert.deepStrictEqual(rows.map(d => d.id), ['s_oct']);
  });
});
