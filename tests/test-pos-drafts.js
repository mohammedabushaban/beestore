const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors']
  .forEach(f => require('../js/core/' + f + '.js'));

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

global.localStorage = new FakeStorage();

require('../js/services/posDrafts.js');
const Api = require('../js/api/api.js');

function item(overrides) {
  return {
    variantId: 'var_1',
    itemCode: '1001',
    productName: 'قميص',
    size: 'M',
    color: 'أزرق',
    qty: 2,
    listPriceMinor: 2500,
    unitPriceMinor: 2500,
    lineDiscountMinor: 0,
    stockQty: 10,
    ...(overrides || {}),
  };
}

function draft(overrides) {
  return {
    clientKey: 'key_1',
    date: '2026-11-16',
    customerId: 'cus_1',
    customerName: 'أحمد',
    contactPhone: '0599000000',
    payerName: '',
    discount: { type: 'amount', value: 0 },
    overpaymentMode: 'change',
    payments: [{ method: 'cash', amountMinor: 5000 }],
    cart: [item()],
    ...(overrides || {}),
  };
}

beforeEach(() => {
  global.localStorage.clear();
  delete BeeStore.auth;
});

test('held invoice round-trips cart, customer, discount and payments', () => {
  const saved = BeeStore.posDrafts.save(draft({
    discount: { type: 'amount', value: 5 },
    payments: [{ method: 'cash', amountMinor: 4500 }],
  }));
  assert.ok(saved.id.startsWith('draft_'));
  assert.strictEqual(saved.clientKey, 'key_1');
  assert.strictEqual(saved.customerName, 'أحمد');
  assert.strictEqual(saved.itemCount, 2);
  assert.strictEqual(saved.lineCount, 1);
  assert.strictEqual(saved.totalMinor, 4500, '50.00 − 5.00 discount');
  assert.strictEqual(saved.cart[0].lineTotalMinor, 5000);

  const list = BeeStore.posDrafts.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, saved.id);
  assert.strictEqual(list[0].payments[0].amountMinor, 4500);
  assert.strictEqual(list[0].customerId, 'cus_1');
});

test('saving an existing id updates it in place and keeps createdAt', () => {
  const first = BeeStore.posDrafts.save(draft());
  const updated = BeeStore.posDrafts.save(draft({
    id: first.id,
    customerName: 'سارة',
    cart: [item({ qty: 3 })],
  }));
  assert.strictEqual(updated.id, first.id);
  assert.strictEqual(updated.createdAt, first.createdAt);
  assert.strictEqual(updated.customerName, 'سارة');
  assert.strictEqual(updated.totalMinor, 7500);
  assert.strictEqual(BeeStore.posDrafts.list().length, 1);
});

test('remove and clear only touch the current profile bucket', () => {
  const first = BeeStore.posDrafts.save(draft());
  const second = BeeStore.posDrafts.save(draft({ clientKey: 'key_2', cart: [item({ variantId: 'var_2' })] }));
  assert.strictEqual(BeeStore.posDrafts.remove(first.id), true);
  assert.strictEqual(BeeStore.posDrafts.remove('missing'), false);
  assert.deepStrictEqual(BeeStore.posDrafts.list().map(d => d.id), [second.id]);
  assert.strictEqual(BeeStore.posDrafts.clear(), true);
  assert.strictEqual(BeeStore.posDrafts.list().length, 0);
});

test('drafts are isolated per profile', () => {
  const ownerDraft = BeeStore.posDrafts.save(draft());
  BeeStore.auth = { profile: () => 'cashier' };
  assert.strictEqual(BeeStore.posDrafts.list().length, 0, 'cashier starts clean');
  const cashierDraft = BeeStore.posDrafts.save(draft({ customerName: 'زبون الكاشير' }));
  assert.notStrictEqual(cashierDraft.id, ownerDraft.id);
  assert.strictEqual(BeeStore.posDrafts.list().length, 1);
  delete BeeStore.auth;
  assert.deepStrictEqual(BeeStore.posDrafts.list().map(d => d.id), [ownerDraft.id],
    'owner still sees only the owner draft');
});

test('rejects an empty invoice and caps the held list', () => {
  assert.throws(() => BeeStore.posDrafts.save(draft({ cart: [] })),
    (e) => e.code === 'VALIDATION');
  for (let i = 0; i < BeeStore.posDrafts.MAX_DRAFTS; i++) {
    BeeStore.posDrafts.save(draft({
      clientKey: 'key_' + i,
      cart: [item({ variantId: 'var_' + i })],
    }));
  }
  assert.strictEqual(BeeStore.posDrafts.list().length, BeeStore.posDrafts.MAX_DRAFTS);
  assert.throws(() => BeeStore.posDrafts.save(draft({ clientKey: 'key_overflow' })),
    (e) => e.code === 'VALIDATION' && /الحد الأقصى/.test(e.message));
  // Updating an existing draft must still work at the cap.
  const existing = BeeStore.posDrafts.list()[0];
  const updated = BeeStore.posDrafts.save({ ...existing, customerName: 'محدّث' });
  assert.strictEqual(updated.id, existing.id);
  assert.strictEqual(updated.customerName, 'محدّث');
});

test('corrupt working state never breaks the POS', () => {
  global.localStorage.setItem('beestore.posDrafts.v1:owner', '{not-json');
  assert.deepStrictEqual(BeeStore.posDrafts.list(), []);
  const saved = BeeStore.posDrafts.save(draft());
  assert.strictEqual(BeeStore.posDrafts.list().length, 1, 'a new save repairs the bucket');
  assert.strictEqual(BeeStore.posDrafts.list()[0].id, saved.id);
});

test('the facade returns {ok,data} envelopes for held invoices', async () => {
  const api = new Api(null);
  const saved = await api.posDrafts.save(draft());
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.data.customerName, 'أحمد');
  const list = await api.posDrafts.list();
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.data.length, 1);
  const removed = await api.posDrafts.remove(saved.data.id);
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(removed.data, true);
  assert.strictEqual((await api.posDrafts.list()).data.length, 0);
});
