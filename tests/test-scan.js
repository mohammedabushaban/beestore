const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
require('../js/ui/scanner.js');
require('../js/services/scan.js');
const BeeStore = global.window.BeeStore;
const scanner = BeeStore.scanner;
const scanning = BeeStore.scanning;

/* ------------------------------------------------------------------ mocks */

function mockApi(opts) {
  opts = opts || {};
  const calls = { byBarcode: [], search: [] };
  return {
    calls,
    variants: {
      byBarcode: async (code) => {
        calls.byBarcode.push(code);
        return { ok: !!opts.byBarcode, data: opts.byBarcode || null };
      },
      search: async (q) => {
        calls.search.push(q);
        return { ok: true, data: opts.search || [] };
      },
    },
    products: {
      get: async () => ({ ok: !!opts.product, data: opts.product || null }),
    },
  };
}

function variant(overrides) {
  return Object.assign({
    id: 'var_1',
    productId: 'prod_1',
    size: 'M',
    color: 'أحمر',
    barcode: '6291000000017',
    priceMinor: 2500,
    costMinor: 1500,
    quantity: 5,
    lowStockThreshold: 2,
  }, overrides || {});
}

/* ------------------------------------------------------- repeat / debounce */

test('repeat filter ignores the same code inside the 1.5s window', () => {
  let t = 0;
  const filter = scanner.createRepeatFilter({ windowMs: 1500, now: () => t });

  assert.strictEqual(filter.accept('6291000000017'), true, 'first read accepted');
  t = 200;
  assert.strictEqual(filter.accept('6291000000017'), false, 'same code at 200ms ignored');
  t = 1400;
  assert.strictEqual(filter.accept(' 6291000000017 '), false, 'normalized same code ignored');
  t = 1500;
  assert.strictEqual(filter.accept('6291000000017'), true, 'accepted again after the window');
});

test('repeat filter lets different codes through immediately', () => {
  let t = 0;
  const filter = scanner.createRepeatFilter({ windowMs: 1500, now: () => t });
  assert.strictEqual(filter.accept('111'), true);
  t = 100;
  assert.strictEqual(filter.accept('222'), true, 'different barcode is not debounced');
  t = 200;
  assert.strictEqual(filter.accept('111'), true, 'first code is no longer the last one');
});

test('mocked decoder frames collapse duplicate reads into one scan', () => {
  let t = 0;
  const filter = scanner.createRepeatFilter({ windowMs: 1500, now: () => t });
  // A decoder sees the same label in several consecutive frames.
  const frames = ['6291000000017', '6291000000017', '6291000000017', '6291000000017'];
  const accepted = [];
  for (const frame of frames) {
    t += 80; // ~12 fps
    if (filter.accept(frame)) accepted.push(frame);
  }
  assert.deepStrictEqual(accepted, ['6291000000017'], 'one add for one physical label');
});

test('repeat filter rejects empty codes and reset() clears the memory', () => {
  let t = 0;
  const filter = scanner.createRepeatFilter({ windowMs: 1500, now: () => t });
  assert.strictEqual(filter.accept(''), false);
  assert.strictEqual(filter.accept('   '), false);
  assert.strictEqual(filter.accept('333'), true);
  filter.reset();
  assert.strictEqual(filter.accept('333'), true, 'after reset the same code is accepted');
});

/* ---------------------------------------------------------------- lookup */

test('lookupVariant returns the exact barcode hit', async () => {
  const v = variant();
  const api = mockApi({ byBarcode: v });
  const found = await scanning.lookupVariant(api, ' 6291000000017 ');
  assert.strictEqual(found, v);
  assert.deepStrictEqual(api.calls.byBarcode, ['6291000000017'], 'code is normalized first');
  assert.strictEqual(api.calls.search.length, 0, 'search is not needed when the barcode hits');
});

test('lookupVariant falls back to search and prefers the exact barcode match', async () => {
  const loose = variant({ id: 'var_loose', barcode: '999' });
  const exact = variant({ id: 'var_exact' });
  const api = mockApi({ search: [loose, exact] });
  const found = await scanning.lookupVariant(api, '6291000000017');
  assert.strictEqual(found.id, 'var_exact');
  assert.deepStrictEqual(api.calls.search, ['6291000000017']);
});

test('lookupVariant returns null for an unknown code', async () => {
  const api = mockApi({ search: [] });
  assert.strictEqual(await scanning.lookupVariant(api, '0000000000000'), null);
});

test('lookupVariant ignores empty input without touching the api', async () => {
  const api = mockApi({});
  assert.strictEqual(await scanning.lookupVariant(api, '   '), null);
  assert.strictEqual(api.calls.byBarcode.length, 0);
});

test('priceCheck returns variant + product, or not-found', async () => {
  const v = variant();
  const product = { id: 'prod_1', name: 'تيشيرت' };
  const ok = await scanning.priceCheck(mockApi({ byBarcode: v, product }), v.barcode);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.variant.id, v.id);
  assert.strictEqual(ok.product.name, 'تيشيرت');

  const missing = await scanning.priceCheck(mockApi({ search: [] }), '000');
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'not-found');
});

/* ----------------------------------------------------------- add to cart */

test('addToCart appends a new line with the POS cart shape', () => {
  const cart = [];
  const v = variant();
  const res = scanning.addToCart(cart, v, 'تيشيرت', {});

  assert.strictEqual(res.ok, true);
  assert.strictEqual(cart.length, 1);
  const line = cart[0];
  assert.strictEqual(line.variantId, v.id);
  assert.strictEqual(line.productName, 'تيشيرت');
  assert.strictEqual(line.qty, 1);
  assert.strictEqual(line.unitPriceMinor, 2500);
  assert.strictEqual(line.lineTotalMinor, 2500);
  assert.strictEqual(line.lineDiscountMinor, 0);
  assert.strictEqual(line.stockQty, 5);
});

test('scanning the same variant again increments qty (never a duplicate line)', () => {
  const cart = [];
  const v = variant();
  scanning.addToCart(cart, v, 'تيشيرت', {});
  const res = scanning.addToCart(cart, v, 'تيشيرت', {});

  assert.strictEqual(res.ok, true);
  assert.strictEqual(cart.length, 1, 'one line');
  assert.strictEqual(cart[0].qty, 2);
  assert.strictEqual(cart[0].lineTotalMinor, 5000, 'line total follows qty');
});

test('addToCart respects the stock limit', () => {
  const cart = [];
  const v = variant({ quantity: 2 });
  scanning.addToCart(cart, v, 'تيشيرت', {});
  scanning.addToCart(cart, v, 'تيشيرت', {});
  const third = scanning.addToCart(cart, v, 'تيشيرت', {});

  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.reason, 'stock-limit');
  assert.strictEqual(cart[0].qty, 2, 'qty did not grow past stock');
});

test('addToCart rejects an out-of-stock variant unless negative stock is allowed', () => {
  const cart = [];
  const v = variant({ quantity: 0 });

  const rejected = scanning.addToCart(cart, v, 'تيشيرت', {});
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'out-of-stock');
  assert.strictEqual(cart.length, 0);

  const allowed = scanning.addToCart(cart, v, 'تيشيرت', { allowNegative: true });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(cart.length, 1);
  assert.strictEqual(cart[0].qty, 1);
});

test('addToCart rejects invalid input without throwing', () => {
  assert.strictEqual(scanning.addToCart([], null, '', {}).reason, 'invalid');
  assert.strictEqual(scanning.addToCart(null, variant(), '', {}).reason, 'invalid');
});

test('line total keeps an existing manual line discount', () => {
  const cart = [];
  const v = variant({ quantity: 10 });
  scanning.addToCart(cart, v, 'تيشيرت', {});
  cart[0].lineDiscountMinor = 500;
  scanning.addToCart(cart, v, 'تيشيرت', {});
  assert.strictEqual(cart[0].lineTotalMinor, 2 * 2500 - 500);
});
