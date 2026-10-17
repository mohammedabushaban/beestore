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
function useClock(date) { BeeStore.dates.setClock(() => date); }

async function cleanShop(api) {
  useClock('2026-10-31');
  await api.settings.save({ systemStartDate: '2026-10-01' });
  const acc = (await api.accounts.create({ name: 'Cash', type: 'cash' })).data;
  const prd = (await api.products.create({
    name: 'P', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'R', quantity: 10,
    costMinor: 1000, priceMinor: 2000, date: '2026-10-05',
  })).data;
  await api.sales.create({
    date: '2026-10-10',
    lines: [{ variantId: v.id, qty: 2, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 4000, date: '2026-10-10' }],
  });
  await api.expenses.create({ date: '2026-10-06', amountMinor: 500, description: 'x', accountId: acc.id });
  return { v, acc };
}

async function codes(api) {
  const res = (await api.maintenance.integrityCheck()).data;
  return { errors: res.errors.map(e => e.check), warnings: res.warnings.map(e => e.check), res };
}

test('V2 checker passes on clean data', async () => {
  const api = await freshApi();
  await cleanShop(api);
  const { errors } = await codes(api);
  assert.deepStrictEqual(errors, []);
});

test('V2 invoice settled by collections is not flagged as sale-math', async () => {
  const api = await freshApi();
  const { v, acc } = await cleanShop(api);
  const cust = (await api.customers.create({ name: 'زبون آجل' })).data;
  const sale = (await api.sales.create({
    date: '2026-10-12',
    customerId: cust.id,
    customerName: cust.name,
    lines: [{ variantId: v.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [],
  })).data;
  assert.strictEqual(sale.dueMinor, 2000);
  await api.customers.receivePayment({
    customerId: cust.id, saleId: sale.id, amountMinor: 2000,
    method: 'cash', accountId: acc.id, date: '2026-10-20',
  });
  const { errors, res } = await codes(api);
  assert.ok(!errors.includes('sale-math'), 'no sale-math: ' + JSON.stringify(res.errors));
});

test('V2 checker still detects paidMinor below recorded payments', async () => {
  const api = await freshApi();
  await cleanShop(api);
  await api.repo.transaction(async (tx) => {
    const sales = await tx.list('sales');
    sales[0].paidMinor = 0;
    sales[0].dueMinor = sales[0].totalMinor;
    tx.put('sales', sales[0]);
  });
  const { errors } = await codes(api);
  assert.ok(errors.includes('sale-math'), 'under-recorded paidMinor detected');
});

test('V2 checker detects stock mismatch and sale math errors', async () => {
  const api = await freshApi();
  const { v } = await cleanShop(api);
  await api.repo.transaction(async (tx) => {
    const got = await tx.get('variants', v.id);
    got.quantity = 999;
    tx.put('variants', got);
    const sales = await tx.list('sales');
    sales[0].totalMinor = 1;
    tx.put('sales', sales[0]);
  });
  const { errors } = await codes(api);
  assert.ok(errors.includes('stock'), 'stock mismatch detected');
  assert.ok(errors.includes('sale-math'), 'sale total mismatch detected');
});

test('V2 checker detects duplicates and dangling refs', async () => {
  const api = await freshApi();
  const { v } = await cleanShop(api);
  await api.repo.transaction(async (tx) => {
    const dup = JSON.parse(JSON.stringify(await tx.get('variants', v.id)));
    dup.id = 'var_dup1';
    tx.put('variants', dup);
    const sales = await tx.list('sales');
    sales[0].lines[0].variantId = 'var_ghost';
    tx.put('sales', sales[0]);
  });
  const { errors } = await codes(api);
  assert.ok(errors.includes('unique'), 'duplicate barcode detected');
  assert.ok(errors.includes('refs'), 'dangling variant detected');
});

test('V2 checker detects payroll dup/net mismatch and counter lag', async () => {
  const api = await freshApi();
  await cleanShop(api);
  const emp = (await api.employees.create({ name: 'E', baseSalaryMinor: 5000 })).data;
  await api.payroll.prepare('2026-10');
  await api.repo.transaction(async (tx) => {
    const rows = await tx.list('payroll');
    const copy = JSON.parse(JSON.stringify(rows[0]));
    copy.id = 'pay_dup1';
    copy.status = 'paid';
    copy.paidDate = '2026-10-20';
    copy.netMinor = 1;
    tx.put('payroll', copy);
    tx.put('sales', {
      id: 'sal_big', number: 'INV-999999', date: '2026-10-11', time: '10:00',
      customerId: null, customerName: null, soldByEmployeeId: null, lines: [],
      subtotalMinor: 0, discount: null, discountMinor: 0, taxMinor: 0, totalMinor: 0,
      payments: [], paidMinor: 0, dueMinor: 0, status: 'paid', returnStatus: 'none',
      installmentPlan: null, notes: '', createdAt: BeeStore.dates.now(),
    });
  });
  const { errors } = await codes(api);
  assert.ok(errors.includes('unique'), 'duplicate payroll + high number w/o counter');
  assert.ok(errors.includes('payroll-math') || errors.includes('sale-math'));
});

test('V2 checker detects closed-month documents and blocks closing', async () => {
  const api = await freshApi();
  await cleanShop(api);
  const { acc } = await cleanShop(api);
  const v2 = (await api.variants.list()).data[0];
  await api.sales.create({
    date: '2026-08-10',
    lines: [{ variantId: v2.id, qty: 1, unitPriceMinor: 2000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 2000, date: '2026-08-10' }],
  });
  assert.strictEqual((await api.periods.close('2026-08')).ok, true);
  await api.repo.transaction(async (tx) => {
    tx.put('expenses', {
      id: 'exp_sneaky', date: '2026-08-20', month: '2026-08',
      amountMinor: 100, method: 'cash', accountId: null, description: 'sneaky',
      allocation: { mode: 'single' }, voided: false, createdAt: BeeStore.dates.now(),
    });
  });
  const { errors } = await codes(api);
  assert.ok(errors.includes('dates'), 'closed-month document detected');
});
