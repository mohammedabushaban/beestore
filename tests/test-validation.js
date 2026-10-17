const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
['settings', 'accounts', 'categories', 'products', 'variants', 'stock',
 'sales', 'customers', 'returns', 'purchases', 'suppliers', 'periods',
 'payroll', 'employees'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

async function freshApi() {
  BeeStore.dates.setClock(() => '2026-10-15');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  await api.settings.save({ systemStartDate: '2026-10-01' });
  const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const prd = (await api.products.create({
    name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'R', quantity: 10,
    costMinor: 1000, priceMinor: 2000, date: '2026-10-01',
  })).data;
  return { api, acc, v, prd };
}

test('sale rejects empty line list', async () => {
  const { api } = await freshApi();
  const res = await api.sales.create({ date: '2026-10-05', lines: [], payments: [] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');
});

test('sale rejects zero and negative quantities', async () => {
  const { api, v } = await freshApi();
  for (const qty of [0, -1]) {
    const res = await api.sales.create({
      date: '2026-10-05', lines: [{ variantId: v.id, qty, unitPriceMinor: 2000 }], payments: [],
    });
    assert.strictEqual(res.ok, false, 'qty=' + qty);
    assert.strictEqual(res.error.code, 'VALIDATION');
  }
});

test('sale rejects negative unit price', async () => {
  const { api, v } = await freshApi();
  const res = await api.sales.create({
    date: '2026-10-05', lines: [{ variantId: v.id, qty: 1, unitPriceMinor: -500 }], payments: [],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');
});

test('sale rejects a line discount above the line value', async () => {
  const { api, v } = await freshApi();
  const res = await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 2000, lineDiscountMinor: 3000 }],
    payments: [],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');
});

test('sale rejects a negative payment amount', async () => {
  const { api, v, acc } = await freshApi();
  const res = await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: -100 }],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');
});

test('purchase rejects zero/negative quantity and negative cost', async () => {
  const { api, v } = await freshApi();
  const bad = [
    { variantId: v.id, qty: 0, unitCostMinor: 1000 },
    { variantId: v.id, qty: -2, unitCostMinor: 1000 },
    { variantId: v.id, qty: 2, unitCostMinor: -1000 },
  ];
  for (const line of bad) {
    const res = await api.purchases.create({ date: '2026-10-05', lines: [line], payments: [] });
    assert.strictEqual(res.ok, false, JSON.stringify(line));
    assert.strictEqual(res.error.code, 'VALIDATION');
  }
});

test('purchase rejects a discount above the subtotal', async () => {
  const { api, v } = await freshApi();
  const res = await api.purchases.create({
    date: '2026-10-05', lines: [{ variantId: v.id, qty: 1, unitCostMinor: 1000 }],
    discountMinor: 5000, payments: [],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'VALIDATION');
});

test('valid sale with a positive quantity still posts', async () => {
  const { api, v, acc } = await freshApi();
  const res = await api.sales.create({
    date: '2026-10-05',
    lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000 }],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.totalMinor, 4000);
  assert.strictEqual(res.data.status, 'paid');
});
