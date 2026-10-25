const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
require('../js/storage/summary.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');

function fixture() {
  return {
    accounts: [
      { id: 'acc1', openingBalanceMinor: 1000 },
      { id: 'acc2', openingBalanceMinor: 0 },
    ],
    sales: [{
      id: 's1', number: 'INV-1', status: 'paid', customerId: 'cus1',
      totalMinor: 1000, dueMinor: 700, payments: [{ accountId: 'acc1', amountMinor: 300 }],
      installmentPlan: {
        schedule: [
          { dueDate: '2026-09-01', amountMinor: 700, paidMinor: 0, status: 'pending' },
          { dueDate: '2026-12-01', amountMinor: 800, paidMinor: 0, status: 'pending' },
        ],
      },
    }],
    purchases: [{
      id: 'p1', number: 'PUR-1', status: 'paid', supplierId: 'sup1',
      totalMinor: 700, dueMinor: 500, payments: [{ accountId: 'acc1', amountMinor: 200 }],
    }],
    customerPayments: [{ id: 'cp1', accountId: 'acc1', amountMinor: 100 }],
    supplierPayments: [{ id: 'sp1', accountId: 'acc1', amountMinor: 50 }],
    expenses: [{ id: 'e1', accountId: 'acc1', amountMinor: 30 }],
    employeeAdvances: [{ id: 'adv1', accountId: 'acc1', amountMinor: 20 }],
    ownerTransactions: [{ id: 'ot1', accountId: 'acc1', type: 'capital_in', amountMinor: 500 }],
    transfers: [{ id: 'tr1', fromAccountId: 'acc1', toAccountId: 'acc2', amountMinor: 100 }],
    salesReturns: [{ id: 'sr1', refundMode: 'cash_refund', refundMethod: 'acc1', refundMinor: 40 }],
    purchaseReturns: [{ id: 'pr1', mode: 'cash_refund', accountId: 'acc1', totalMinor: 25 }],
  };
}

test('L2 summary computes all-time totals from documents', () => {
  const s = BeeStore.summary.compute(fixture());
  assert.strictEqual(s.receivablesMinor, 700);
  assert.strictEqual(s.payablesMinor, 500);
  assert.strictEqual(s.accountBalances.acc1, 1485);
  assert.strictEqual(s.accountBalances.acc2, 100);
  assert.strictEqual(s.installments.length, 2);
  assert.ok(s.computedAt, 'computedAt is stamped');
});

test('L2 summary monthly customer/supplier deltas include dated payments', () => {
  const summary = BeeStore.summary.compute({
    sales: [{
      id: 's1', date: '2026-10-10', customerId: 'c1', status: 'partial',
      totalMinor: 1000, dueMinor: 300,
      payments: [{ accountId: 'a1', amountMinor: 700, date: '2026-10-11' }],
    }],
    purchases: [{
      id: 'p1', date: '2026-10-12', supplierId: 'sp1', status: 'partial',
      totalMinor: 500, dueMinor: 200,
      payments: [{ accountId: 'a1', amountMinor: 300, date: '2026-11-02' }],
    }],
    customerPayments: [
      { id: 'cp1', date: '2026-12-01', customerId: 'c1', accountId: 'a1', amountMinor: 100 },
    ],
  });
  assert.strictEqual(summary.months['2026-10'].customers.c1, 300);
  assert.strictEqual(summary.months['2026-12'].customers.c1, -100);
  assert.strictEqual(summary.months['2026-10'].suppliers.sp1, 500);
  assert.strictEqual(summary.months['2026-11'].suppliers.sp1, -300);
  assert.strictEqual(summary.months['2026-10'].accounts.a1, 700);
  assert.strictEqual(summary.months['2026-11'].accounts.a1, -300);
  // Outflows keep the same signed convention as the ledger (negative).
  assert.strictEqual(summary.months['2026-11'].flowTypes.purchase_payment.out, -300);
});

test('L2 summary update equals a full recomputation (old → new)', () => {
  const data = fixture();
  const summary = BeeStore.summary.compute(data);

  const oldSale = data.sales[0];
  const newSale = JSON.parse(JSON.stringify(oldSale));
  newSale.status = 'void';
  newSale.dueMinor = 0;
  newSale.payments = [];
  newSale.installmentPlan = { schedule: [] };

  BeeStore.summary.apply(summary, 'sales', oldSale, newSale);
  const expected = BeeStore.summary.compute({
    ...data,
    sales: [newSale],
  });
  assert.deepStrictEqual(summary.accountBalances, expected.accountBalances);
  assert.strictEqual(summary.receivablesMinor, expected.receivablesMinor);
  assert.strictEqual(summary.payablesMinor, expected.payablesMinor);
  assert.deepStrictEqual(summary.installments, expected.installments);
});

test('L2 summary cleans installment rows when a plan is fully paid', () => {
  const data = fixture();
  const summary = BeeStore.summary.compute(data);
  const oldSale = data.sales[0];
  const newSale = JSON.parse(JSON.stringify(oldSale));
  newSale.installmentPlan.schedule.forEach(i => { i.status = 'paid'; i.paidMinor = i.amountMinor; });

  BeeStore.summary.apply(summary, 'sales', oldSale, newSale);
  assert.deepStrictEqual(summary.installments, []);
  assert.strictEqual(BeeStore.summary.overdue(summary, '2026-10-25').length, 0);
});

test('L2 summary overdue is date-driven and sorted', () => {
  const s = BeeStore.summary.compute(fixture());
  assert.deepStrictEqual(
    BeeStore.summary.overdue(s, '2026-10-25').map(i => i.dueDate),
    ['2026-09-01']
  );
  assert.deepStrictEqual(BeeStore.summary.overdue(s, '2026-08-01'), []);
  assert.strictEqual(BeeStore.summary.overdue(s, '2027-01-01').length, 2);
});

test('L2 MemoryRepository.getSummary matches the documents after updates', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  const data = fixture();
  await repo.transaction(async (tx) => {
    for (const c of BeeStore.summary.COLLECTIONS) {
      for (const doc of (data[c] || [])) tx.put(c, doc);
    }
  });
  const first = await repo.getSummary();
  assert.strictEqual(first.receivablesMinor, 700);
  assert.strictEqual(first.accountBalances.acc1, 1485);

  await repo.transaction(async (tx) => {
    const sale = await tx.get('sales', 's1');
    sale.dueMinor = 200;
    sale.payments.push({ accountId: 'acc1', amountMinor: 500 });
    tx.put('sales', sale);
    tx.put('customerPayments', { id: 'cp2', accountId: 'acc1', amountMinor: 25 });
  });
  const second = await repo.getSummary();
  assert.strictEqual(second.receivablesMinor, 200);
  assert.strictEqual(second.accountBalances.acc1, 2010);
});
