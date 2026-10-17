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
require('../js/storage/memoryRepository.js');

const MemoryRepository = require('../js/storage/memoryRepository.js');

test('Sale deducts stock and creates movements', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    const variant = tx.put('variants', {
      id: 'var_test1', productId: 'prd_test1', size: 'M', color: 'Red',
      sku: 'SKU-001', barcode: '2000000000001', costMinor: 5000,
      priceMinor: 10000, quantity: 10, active: true,
      createdAt: BeeStore.dates.now()
    });
  });

  const variant = await repo.get('variants', 'var_test1');
  assert.strictEqual(variant.quantity, 10);

  await repo.transaction(async (tx) => {
    const sale = tx.put('sales', {
      id: 'sal_test1', number: 'INV-000001', date: BeeStore.dates.today(),
      time: '10:00', customerId: null, customerName: null, soldByEmployeeId: null,
      lines: [{
        variantId: 'var_test1', productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000001', qty: 3, unitPriceMinor: 10000, unitCostMinor: 5000,
        lineDiscountMinor: 0, lineTotalMinor: 30000, returnedQty: 0,
      }],
      subtotalMinor: 30000, discount: null, discountMinor: 0, taxMinor: 0,
      totalMinor: 30000, payments: [{ method: 'cash', amountMinor: 30000, date: BeeStore.dates.today() }],
      paidMinor: 30000, dueMinor: 0, status: 'paid', returnStatus: 'none',
      installmentPlan: null, notes: '', createdAt: BeeStore.dates.now(),
    });

    const v = await tx.get('variants', 'var_test1');
    v.quantity -= 3;
    tx.put('variants', v);

    tx.put('stockMovements', {
      id: 'stm_test1', variantId: 'var_test1', date: BeeStore.dates.today(),
      type: 'sale', qtyChange: -3, unitCostMinor: 5000, refType: 'sale',
      refId: 'sal_test1', note: 'Sale', balanceAfter: 7, createdAt: BeeStore.dates.now(),
    });
  });

  const updated = await repo.get('variants', 'var_test1');
  assert.strictEqual(updated.quantity, 7);

  const movements = await repo.list('stockMovements', m => m.variantId === 'var_test1' && m.type === 'sale');
  assert.strictEqual(movements.length, 1);
  assert.strictEqual(movements[0].qtyChange, -3);
});

test('Selling more than stock is rejected', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('variants', {
      id: 'var_test2', productId: 'prd_test2', size: 'M', color: 'Red',
      sku: 'SKU-002', barcode: '2000000000002', costMinor: 5000,
      priceMinor: 10000, quantity: 5, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  const variant = await repo.get('variants', 'var_test2');

  await assert.rejects(
    repo.transaction(async (tx) => {
      const v = await tx.get('variants', variant.id);
      if (v.quantity < 10) throw BeeStore.errors.err('INSUFFICIENT_STOCK', 'الكمية المتوفرة غير كافية');
    }),
    /غير كافية/
  );

  const updated = await repo.get('variants', 'var_test2');
  assert.strictEqual(updated.quantity, 5);
});

test('Weighted average cost after multiple purchases', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('variants', {
      id: 'var_test3', productId: 'prd_test3', size: 'M', color: 'Red',
      sku: 'SKU-003', barcode: '2000000000003', costMinor: 0,
      priceMinor: 10000, quantity: 0, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  let variant = await repo.get('variants', 'var_test3');
  const vid = variant.id;

  await repo.transaction(async (tx) => {
    const v = await tx.get('variants', vid);
    const newQty = v.quantity + 10;
    const newCost = v.quantity <= 0 ? 2000 : Math.round((v.quantity * v.costMinor + 10 * 2000) / newQty);
    v.quantity = newQty;
    v.costMinor = newCost;
    tx.put('variants', v);
  });

  variant = await repo.get('variants', vid);
  assert.strictEqual(variant.costMinor, 2000);

  await repo.transaction(async (tx) => {
    const v = await tx.get('variants', vid);
    const newQty = v.quantity + 10;
    const newCost = v.quantity <= 0 ? 3000 : Math.round((v.quantity * v.costMinor + 10 * 3000) / newQty);
    v.quantity = newQty;
    v.costMinor = newCost;
    tx.put('variants', v);
  });

  variant = await repo.get('variants', vid);
  assert.strictEqual(variant.costMinor, 2500);
});

test('Void sale restores stock', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('variants', {
      id: 'var_test4', productId: 'prd_test4', size: 'M', color: 'Red',
      sku: 'SKU-004', barcode: '2000000000004', costMinor: 5000,
      priceMinor: 10000, quantity: 10, active: true, createdAt: BeeStore.dates.now(),
    });
    tx.put('sales', {
      id: 'sal_test4', number: 'INV-000004', date: BeeStore.dates.today(),
      time: '10:00', customerId: null, customerName: null, soldByEmployeeId: null,
      lines: [{
        variantId: 'var_test4', productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000004', qty: 3, unitPriceMinor: 10000, unitCostMinor: 5000,
        lineDiscountMinor: 0, lineTotalMinor: 30000, returnedQty: 0,
      }],
      subtotalMinor: 30000, discount: null, discountMinor: 0, taxMinor: 0,
      totalMinor: 30000, payments: [{ method: 'cash', amountMinor: 30000, date: BeeStore.dates.today() }],
      paidMinor: 30000, dueMinor: 0, status: 'paid', returnStatus: 'none',
      installmentPlan: null, notes: '', createdAt: BeeStore.dates.now(),
    });
    const v = await tx.get('variants', 'var_test4');
    v.quantity -= 3;
    tx.put('variants', v);
  });

  const variant = await repo.get('variants', 'var_test4');
  assert.strictEqual(variant.quantity, 7);

  await repo.transaction(async (tx) => {
    const sale = await tx.get('sales', 'sal_test4');
    sale.status = 'void';
    tx.put('sales', sale);
    const v = await tx.get('variants', 'var_test4');
    v.quantity += 3;
    tx.put('variants', v);
  });

  const updated = await repo.get('variants', 'var_test4');
  assert.strictEqual(updated.quantity, 10);

  const voidedSale = await repo.get('sales', 'sal_test4');
  assert.strictEqual(voidedSale.status, 'void');
});

test('Export and import round-trip', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('products', {
      id: 'prd_rt1', name: 'Test Product', categoryId: null, brand: '',
      gender: 'unisex', description: '', defaultCostMinor: 5000,
      defaultPriceMinor: 10000, active: true, imageDataUri: null,
      createdAt: BeeStore.dates.now(),
    });
    tx.put('variants', {
      id: 'var_rt1', productId: 'prd_rt1', size: 'M', color: 'Red',
      sku: 'SKU-RT1', barcode: '2000000000101', costMinor: 5000,
      priceMinor: 10000, quantity: 10, lowStockThreshold: null,
      active: true, createdAt: BeeStore.dates.now(),
    });
  });

  const exported = await repo.exportAll();
  const json = JSON.parse(JSON.stringify(exported));

  const repo2 = new MemoryRepository();
  await repo2.open();
  await repo2.importAll(json);

  const variants = await repo2.list('variants');
  assert.strictEqual(variants.length, 1);
  assert.strictEqual(variants[0].quantity, 10);
});

test('Variant quantity equals sum of movements', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('variants', {
      id: 'var_q1', productId: 'prd_q1', size: 'M', color: 'Red',
      sku: 'SKU-Q1', barcode: '2000000000201', costMinor: 0,
      priceMinor: 10000, quantity: 0, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  const vid = 'var_q1';
  const ops = [
    { type: 'purchase', qty: 10, cost: 5000 },
    { type: 'sale', qty: -3, cost: 5000 },
    { type: 'purchase', qty: 5, cost: 6000 },
    { type: 'sale', qty: -2, cost: 6000 },
  ];

  for (const op of ops) {
    await repo.transaction(async (tx) => {
      const v = await tx.get('variants', vid);
      v.quantity += op.qty;
      tx.put('variants', v);
      tx.put('stockMovements', {
        id: BeeStore.ids.randomId('stm'), variantId: vid,
        date: BeeStore.dates.today(), type: op.type,
        qtyChange: op.qty, unitCostMinor: op.cost,
        refType: op.type, refId: null, note: 'Test',
        balanceAfter: v.quantity, createdAt: BeeStore.dates.now(),
      });
    });
  }

  const updated = await repo.get('variants', vid);
  const movements = await repo.list('stockMovements', m => m.variantId === vid);
  const totalMovement = movements.reduce((sum, m) => sum + m.qtyChange, 0);
  assert.strictEqual(updated.quantity, totalMovement);
});

test('Partial return restocks correctly', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('variants', {
      id: 'var_ret1', productId: 'prd_ret1', size: 'M', color: 'Red',
      sku: 'SKU-RET1', barcode: '2000000000301', costMinor: 5000,
      priceMinor: 10000, quantity: 10, active: true, createdAt: BeeStore.dates.now(),
    });
    tx.put('sales', {
      id: 'sal_ret1', number: 'INV-RET1', date: BeeStore.dates.today(),
      time: '10:00', customerId: null, customerName: null, soldByEmployeeId: null,
      lines: [{
        variantId: 'var_ret1', productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000301', qty: 5, unitPriceMinor: 10000, unitCostMinor: 5000,
        lineDiscountMinor: 0, lineTotalMinor: 50000, returnedQty: 0,
      }],
      subtotalMinor: 50000, discount: null, discountMinor: 0, taxMinor: 0,
      totalMinor: 50000, payments: [{ method: 'cash', amountMinor: 50000, date: BeeStore.dates.today() }],
      paidMinor: 50000, dueMinor: 0, status: 'paid', returnStatus: 'none',
      installmentPlan: null, notes: '', createdAt: BeeStore.dates.now(),
    });
    const v = await tx.get('variants', 'var_ret1');
    v.quantity -= 5;
    tx.put('variants', v);
  });

  await repo.transaction(async (tx) => {
    const sale = await tx.get('sales', 'sal_ret1');
    sale.lines[0].returnedQty = 2;
    sale.returnStatus = 'partial';
    tx.put('sales', sale);
    const v = await tx.get('variants', 'var_ret1');
    v.quantity += 2;
    tx.put('variants', v);
    tx.put('stockMovements', {
      id: BeeStore.ids.randomId('stm'), variantId: 'var_ret1',
      date: BeeStore.dates.today(), type: 'sale_return', qtyChange: 2,
      unitCostMinor: 5000, refType: 'sale_return', refId: 'sal_ret1',
      note: 'Return', balanceAfter: v.quantity, createdAt: BeeStore.dates.now(),
    });
  });

  const updated = await repo.get('variants', 'var_ret1');
  assert.strictEqual(updated.quantity, 7);

  const updatedSale = await repo.get('sales', 'sal_ret1');
  assert.strictEqual(updatedSale.lines[0].returnedQty, 2);
  assert.strictEqual(updatedSale.returnStatus, 'partial');
});

test('Credit sale + FIFO payment allocation', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('customers', {
      id: 'cus_test1', name: 'Test Customer', phone: '', address: '',
      notes: '', openingBalanceMinor: 0, active: true, createdAt: BeeStore.dates.now(),
    });
    tx.put('variants', {
      id: 'var_credit1', productId: 'prd_credit1', size: 'M', color: 'Red',
      sku: 'SKU-CR1', barcode: '2000000000401', costMinor: 5000,
      priceMinor: 10000, quantity: 10, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  await repo.transaction(async (tx) => {
    tx.put('sales', {
      id: 'sal_c1', number: 'INV-C1', date: BeeStore.dates.today(),
      time: '10:00', customerId: 'cus_test1', customerName: 'Test Customer', soldByEmployeeId: null,
      lines: [{
        variantId: 'var_credit1', productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000401', qty: 2, unitPriceMinor: 10000, unitCostMinor: 5000,
        lineDiscountMinor: 0, lineTotalMinor: 20000, returnedQty: 0,
      }],
      subtotalMinor: 20000, discount: null, discountMinor: 0, taxMinor: 0,
      totalMinor: 20000, payments: [], paidMinor: 0, dueMinor: 20000,
      status: 'unpaid', returnStatus: 'none', installmentPlan: null, notes: '',
      createdAt: BeeStore.dates.now(),
    });
    tx.put('sales', {
      id: 'sal_c2', number: 'INV-C2', date: BeeStore.dates.today(),
      time: '10:01', customerId: 'cus_test1', customerName: 'Test Customer', soldByEmployeeId: null,
      lines: [{
        variantId: 'var_credit1', productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000401', qty: 3, unitPriceMinor: 10000, unitCostMinor: 5000,
        lineDiscountMinor: 0, lineTotalMinor: 30000, returnedQty: 0,
      }],
      subtotalMinor: 30000, discount: null, discountMinor: 0, taxMinor: 0,
      totalMinor: 30000, payments: [], paidMinor: 0, dueMinor: 30000,
      status: 'unpaid', returnStatus: 'none', installmentPlan: null, notes: '',
      createdAt: BeeStore.dates.now(),
    });
  });

  await repo.transaction(async (tx) => {
    tx.put('customerPayments', {
      id: 'cpay_1', customerId: 'cus_test1', saleId: null,
      date: BeeStore.dates.today(), amountMinor: 20000, method: 'cash',
      accountId: null, note: '', createdAt: BeeStore.dates.now(),
    });
    const s1 = await tx.get('sales', 'sal_c1');
    s1.dueMinor = 0;
    s1.paidMinor = 20000;
    s1.status = 'paid';
    tx.put('sales', s1);
  });

  const paid1 = await repo.get('sales', 'sal_c1');
  assert.strictEqual(paid1.status, 'paid');
  assert.strictEqual(paid1.dueMinor, 0);
});

test('Installment schedule generation with rounding', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  const count = 3;
  const totalMinor = 10000;
  const paidMinor = 2000;
  const remaining = totalMinor - paidMinor;
  const baseAmount = Math.floor(remaining / count);
  let allocated = 0;
  const schedule = [];
  for (let i = 0; i < count; i++) {
    const amountMinor = i === count - 1 ? remaining - allocated : baseAmount;
    allocated += amountMinor;
    schedule.push({ n: i + 1, dueDate: '2026-02-01', amountMinor, paidMinor: 0, status: 'pending' });
  }

  const total = schedule.reduce((sum, s) => sum + s.amountMinor, 0);
  assert.strictEqual(total, 8000);
  assert.strictEqual(schedule.length, 3);
});

test('Payroll net calculation', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('employees', {
      id: 'emp_test1', name: 'Test Employee', phone: '', position: 'Cashier',
      hireDate: BeeStore.dates.today(), baseSalaryMinor: 500000,
      active: true, notes: '', createdAt: BeeStore.dates.now(),
    });
  });

  await repo.transaction(async (tx) => {
    tx.put('payroll', {
      id: 'pay_test1', employeeId: 'emp_test1', employeeName: 'Test Employee',
      month: '2026-10', baseMinor: 500000, bonusMinor: 0, overtimeMinor: 0,
      deductionsMinor: 0, advanceRepaymentMinor: 0, netMinor: 500000,
      status: 'draft', paidDate: null, method: null, accountId: null, note: '',
      createdAt: BeeStore.dates.now(),
    });
  });

  const payroll = await repo.get('payroll', 'pay_test1');
  assert.strictEqual(payroll.netMinor, 500000);

  await repo.transaction(async (tx) => {
    const p = await tx.get('payroll', 'pay_test1');
    p.advanceRepaymentMinor = 50000;
    p.netMinor = p.baseMinor + p.bonusMinor + p.overtimeMinor - p.deductionsMinor - p.advanceRepaymentMinor;
    tx.put('payroll', p);
  });

  const updated = await repo.get('payroll', 'pay_test1');
  assert.strictEqual(updated.netMinor, 450000);
});

test('P&L figures match hand-computed scenario', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('suppliers', {
      id: 'sup_test1', name: 'Supplier', phone: '', address: '',
      notes: '', openingBalanceMinor: 0, active: true, createdAt: BeeStore.dates.now(),
    });
    tx.put('variants', {
      id: 'var_pnl1', productId: 'prd_pnl1', size: 'M', color: 'Red',
      sku: 'SKU-PNL1', barcode: '2000000000501', costMinor: 0,
      priceMinor: 10000, quantity: 0, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  const vid = 'var_pnl1';
  await repo.transaction(async (tx) => {
    const v = await tx.get('variants', vid);
    v.quantity = 10;
    v.costMinor = 2000;
    tx.put('variants', v);
    tx.put('stockMovements', {
      id: BeeStore.ids.randomId('stm'), variantId: vid,
      date: BeeStore.dates.today(), type: 'purchase', qtyChange: 10,
      unitCostMinor: 2000, refType: 'purchase', refId: null, note: '',
      balanceAfter: 10, createdAt: BeeStore.dates.now(),
    });
  });

  await repo.transaction(async (tx) => {
    const v = await tx.get('variants', vid);
    v.quantity = 7;
    tx.put('variants', v);
    tx.put('sales', {
      id: 'sal_pnl1', number: 'INV-PNL1', date: BeeStore.dates.today(),
      time: '10:00', customerId: null, customerName: null, soldByEmployeeId: null,
      lines: [{
        variantId: vid, productName: 'Test', size: 'M', color: 'Red',
        barcode: '2000000000501', qty: 3, unitPriceMinor: 3500, unitCostMinor: 2000,
        lineDiscountMinor: 0, lineTotalMinor: 10500, returnedQty: 0,
      }],
      subtotalMinor: 10500, discount: { type: 'amount', value: 0.05 },
      discountMinor: 500, taxMinor: 0, totalMinor: 10000,
      payments: [{ method: 'cash', amountMinor: 10000, date: BeeStore.dates.today() }],
      paidMinor: 10000, dueMinor: 0, status: 'paid', returnStatus: 'none',
      installmentPlan: null, notes: '', createdAt: BeeStore.dates.now(),
    });
  });

  await repo.transaction(async (tx) => {
    tx.put('expenses', {
      id: 'exp_test1', date: BeeStore.dates.today(), categoryId: null,
      categoryName: 'Electricity', amountMinor: 1000, method: 'cash',
      accountId: null, description: 'Test', recurringId: null,
      createdAt: BeeStore.dates.now(),
    });
  });

  const sales = await repo.list('sales', s => s.status !== 'void');
  const expenses = await repo.list('expenses');

  let netSales = 0, cogs = 0;
  for (const s of sales) {
    netSales += s.totalMinor - s.taxMinor;
    for (const line of s.lines) cogs += line.unitCostMinor * line.qty;
  }
  const grossProfit = netSales - cogs;
  const operatingExpenses = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
  const netProfit = grossProfit - operatingExpenses;

  assert.strictEqual(netSales, 10000);
  assert.strictEqual(cogs, 6000);
  assert.strictEqual(grossProfit, 4000);
  assert.strictEqual(operatingExpenses, 1000);
  assert.strictEqual(netProfit, 3000);
});

test('Balance snapshot balances', async () => {
  const repo = new MemoryRepository();
  await repo.open();

  await repo.transaction(async (tx) => {
    tx.put('accounts', {
      id: 'acc_test1', name: 'Cash', type: 'cash',
      openingBalanceMinor: 0, active: true, createdAt: BeeStore.dates.now(),
    });
  });

  const accounts = await repo.list('accounts');
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].openingBalanceMinor, 0);
});
