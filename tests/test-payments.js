const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

require('../js/core/config.js');
require('../js/core/money.js');
require('../js/core/dates.js');
require('../js/core/ids.js');
require('../js/core/validate.js');
require('../js/core/errors.js');
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
require('../js/services/settings.js');
require('../js/services/periods.js');
require('../js/services/customers.js');
require('../js/services/suppliers.js');
require('../js/services/sales.js');

function setup(repo) {
  BeeStore.settings.repo = repo;
  BeeStore.periods.repo = repo;
  BeeStore.customers.repo = repo;
  BeeStore.suppliers.repo = repo;
  BeeStore.sales.repo = repo;
}

async function seedMeta(repo, paymentMethods) {
  await repo.transaction(async (tx) => {
    tx.put('meta', {
      id: 'settings',
      systemStartDate: '2020-01-01',
      ...(paymentMethods ? { paymentMethods } : {}),
    });
  });
}

test('settings: new default methods merged once, deletions respected', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  setup(repo);
  await seedMeta(repo, [
    { id: 'cash', name: 'نقداً', accountId: null },
    { id: 'bank', name: 'تحويل بنكي', accountId: 'acc_x' },
  ]);

  const s1 = await BeeStore.settings.ensureDefaults();
  const ids1 = s1.paymentMethods.map(m => m.id);
  assert.ok(ids1.includes('cash') && ids1.includes('bank'), 'existing methods preserved');
  assert.ok(ids1.includes('wallet') && ids1.includes('jawwal') && ids1.includes('palpay'), 'new defaults added');
  assert.strictEqual(s1.paymentMethodDefaultsMerged, true, 'merge flag set once');
  const cashAcc = s1.paymentMethods.find(m => m.id === 'cash').accountId;
  const jawwalAcc = s1.paymentMethods.find(m => m.id === 'jawwal').accountId;
  assert.ok(cashAcc && jawwalAcc, 'accounts resolved');
  assert.notStrictEqual(cashAcc, jawwalAcc, 'cash and bank accounts differ');

  // idempotent: second run does not duplicate
  const s2 = await BeeStore.settings.ensureDefaults();
  assert.strictEqual(s2.paymentMethods.filter(m => m.id === 'jawwal').length, 1, 'no duplicate on re-run');

  // user deletes Jawwal -> defaults must not resurrect it
  await BeeStore.settings.update({ paymentMethods: s2.paymentMethods.filter(m => m.id !== 'jawwal') });
  const s3 = await BeeStore.settings.ensureDefaults();
  assert.strictEqual(s3.paymentMethods.some(m => m.id === 'jawwal'), false, 'deleted method stays deleted');
});

test('settings: methodOptions and methodLabel', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  setup(repo);
  const s = await BeeStore.settings.ensureDefaults();

  const opts = BeeStore.settings.methodOptions(s);
  assert.ok(Array.isArray(opts) && opts.length >= 6);
  assert.deepStrictEqual(opts.find(o => o.value === 'jawwal').label, 'جوال باي');
  assert.strictEqual(BeeStore.settings.methodLabel(s, 'jawwal'), 'جوال باي');
  assert.strictEqual(BeeStore.settings.methodLabel(s, 'unknown'), 'unknown', 'unknown id falls back to id');

  // fallback when settings missing
  const fb = BeeStore.settings.methodOptions(null);
  assert.ok(fb.some(o => o.value === 'cash'), 'falls back to defaults');
});

test('customer payment stores payer name/phone and settles one invoice', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  setup(repo);
  await seedMeta(repo);
  await BeeStore.settings.ensureDefaults();
  await repo.transaction(async (tx) => {
    tx.put('customers', { id: 'cus_1', name: 'أحمد', phone: '0599000000' });
    tx.put('sales', {
      id: 'sal_1', number: 'INV-000001', date: '2020-06-01', customerId: 'cus_1',
      customerName: 'أحمد', lines: [], subtotalMinor: 100000, discountMinor: 0, taxMinor: 0,
      totalMinor: 100000, payments: [], paidMinor: 0, dueMinor: 100000, status: 'unpaid',
    });
  });

  const pay = await BeeStore.customers.receivePayment({
    customerId: 'cus_1', saleId: 'sal_1', amountMinor: 40000,
    method: 'jawwal', payerName: '  محمد  ', payerPhone: ' 0599111222 ', date: '2020-06-05',
  });
  assert.strictEqual(pay.payerName, 'محمد', 'payer name trimmed');
  assert.strictEqual(pay.payerPhone, '0599111222', 'payer phone trimmed');
  assert.strictEqual(pay.method, 'jawwal');
  assert.ok(pay.accountId, 'account resolved');

  const persisted = await repo.get('customerPayments', pay.id);
  assert.strictEqual(persisted.payerName, 'محمد');

  const sale = await repo.get('sales', 'sal_1');
  assert.strictEqual(sale.dueMinor, 60000);
  assert.strictEqual(sale.paidMinor, 40000);
  assert.strictEqual(sale.status, 'partial');
});

test('supplier payment stores payer name/phone', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  setup(repo);
  await seedMeta(repo);
  await repo.transaction(async (tx) => {
    tx.put('suppliers', { id: 'sup_1', name: 'مورد' });
    tx.put('purchases', {
      id: 'pur_1', number: 'PUR-000001', date: '2020-06-01', supplierId: 'sup_1',
      lines: [], totalMinor: 50000, paidMinor: 0, dueMinor: 50000, status: 'unpaid',
    });
  });

  const pay = await BeeStore.suppliers.pay({
    supplierId: 'sup_1', purchaseId: 'pur_1', amountMinor: 50000,
    method: 'bank', payerName: 'شركة', payerPhone: '022222222', date: '2020-06-05',
  });
  assert.strictEqual(pay.payerName, 'شركة');
  assert.strictEqual(pay.payerPhone, '022222222');
  const purchase = await repo.get('purchases', 'pur_1');
  assert.strictEqual(purchase.dueMinor, 0);
  assert.strictEqual(purchase.status, 'paid');
});

test('printData combines initial sale payments with later collections', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  setup(repo);
  await seedMeta(repo);
  await BeeStore.settings.ensureDefaults();
  await repo.transaction(async (tx) => {
    tx.put('customers', { id: 'cus_1', name: 'أحمد' });
    tx.put('sales', {
      id: 'sal_1', number: 'INV-000001', date: '2020-06-01', customerId: 'cus_1',
      customerName: 'أحمد', lines: [], subtotalMinor: 100000, discountMinor: 0, taxMinor: 0,
      totalMinor: 100000, paidMinor: 30000, dueMinor: 70000, status: 'partial',
      payments: [{ method: 'cash', amountMinor: 30000, date: '2020-06-01' }],
    });
  });

  await BeeStore.customers.receivePayment({
    customerId: 'cus_1', saleId: 'sal_1', amountMinor: 20000,
    method: 'jawwal', payerName: 'أحمد', payerPhone: '0599000000', date: '2020-06-10',
  });

  const data = await BeeStore.sales.printData('sal_1');
  assert.ok(Array.isArray(data.payments));
  assert.strictEqual(data.payments.length, 2, 'initial + collection');
  assert.strictEqual(data.payments[0].method, 'cash');
  const collection = data.payments.find(p => p.method === 'jawwal');
  assert.ok(collection, 'collection present');
  assert.strictEqual(collection.payerName, 'أحمد');
  assert.strictEqual(collection.amountMinor, 20000);
  assert.strictEqual(data.payments[data.payments.length - 1].date, '2020-06-10', 'sorted by date');
});
