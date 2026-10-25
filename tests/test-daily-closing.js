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
 'payroll', 'employees', 'transactions', 'periods', 'dailyClosing', 'reports', 'dashboard',
 'backup', 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

async function freshApi(clock) {
  if (clock) BeeStore.dates.setClock(() => clock);
  const repo = new MemoryRepository();
  await repo.open();
  return new Api(repo);
}

/**
 * Cash 200.00, bank + card zero, one product with 100 units, and the settings
 * that make the cash account the drawer. `date` is the opening-stock date.
 */
async function seedBase(api, date) {
  const cash = (await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: 20000,
  })).data;
  const bank = (await api.accounts.create({ name: 'البنك', type: 'bank' })).data;
  const card = (await api.accounts.create({ name: 'البطاقة', type: 'wallet' })).data;
  await api.settings.save({
    systemStartDate: '2026-11-01',
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'card', name: 'بطاقة', accountId: card.id },
      { id: 'bank', name: 'تحويل', accountId: bank.id },
    ],
    cashDenominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.1],
  });
  const product = (await api.products.create({
    name: 'منتج', defaultCostMinor: 1000, defaultPriceMinor: 5000,
  })).data;
  const variant = (await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق',
    quantity: 100, costMinor: 1000, priceMinor: 5000, date,
  })).data;
  const customerA = (await api.customers.create({ name: 'زبون أ' })).data;
  const customerB = (await api.customers.create({ name: 'زبون ب' })).data;
  return { cash, bank, card, product, variant, customerA, customerB };
}

async function sell(api, base, date, amountMinor, method, opts) {
  const o = opts || {};
  const qty = Number(o.qty) || Math.round(amountMinor / 5000);
  const payments = method
    ? [{ method, accountId: o.accountId, amountMinor, date }]
    : [];
  const res = await api.sales.create({
    date,
    customerId: o.customerId || null,
    customerName: o.customerName || null,
    lines: [{ variantId: base.variant.id, qty, unitPriceMinor: o.unitPriceMinor || 5000 }],
    payments,
  });
  assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
  return res.data;
}

// §12.1 #1 — the exact daily closing scenario, to the cent.
test('L4 closing scenario: expected 515, counted 510, difference -5, retained 110', async () => {
  const api = await freshApi('2026-11-20');
  try {
    const base = await seedBase(api, '2026-11-01');

    // A cash sale + an owner withdrawal before the day leave the opening
    // float at exactly 200.00.
    await sell(api, base, '2026-11-18', 10000, 'cash', { accountId: base.cash.id, qty: 2 });
    await api.transactions.ownerTransaction({
      date: '2026-11-18', type: 'withdrawal', amountMinor: 10000, accountId: base.cash.id,
    });
    // Old cash sale that will be refunded 40.00 on the closing day.
    await sell(api, base, '2026-11-18', 4000, 'cash', {
      accountId: base.cash.id, qty: 1, unitPriceMinor: 4000,
    });
    await api.transactions.ownerTransaction({
      date: '2026-11-18', type: 'withdrawal', amountMinor: 4000, accountId: base.cash.id,
    });
    // Customer B's old credit debt; collecting it is a cash event today.
    await sell(api, base, '2026-11-18', 8000, null, {
      customerId: base.customerB.id, customerName: 'زبون ب', qty: 1, unitPriceMinor: 8000,
    });

    // The setup day must be closed before the scenario day (catch-up rule).
    const setup = await api.dailyClosings.close({ date: '2026-11-18', noCount: true });
    assert.strictEqual(setup.ok, true, setup.ok ? '' : setup.error.message);

    // Today: 300 cash + 100 card + 50 credit = 450 sales.
    await sell(api, base, '2026-11-20', 30000, 'cash', { accountId: base.cash.id, qty: 6 });
    await sell(api, base, '2026-11-20', 10000, 'card', { accountId: base.card.id, qty: 2 });
    await sell(api, base, '2026-11-20', 5000, null, {
      customerId: base.customerA.id, customerName: 'زبون أ', qty: 1,
    });
    const collection = await api.customers.receivePayment({
      customerId: base.customerB.id, date: '2026-11-20', amountMinor: 8000,
      method: 'cash', accountId: base.cash.id,
    });
    assert.strictEqual(collection.ok, true, collection.ok ? '' : collection.error.message);
    const expense = await api.expenses.create({
      date: '2026-11-20', amountMinor: 2500, description: 'مصروف نقدي', accountId: base.cash.id,
    });
    assert.strictEqual(expense.ok, true, expense.ok ? '' : expense.error.message);

    const oldSale = (await api.sales.list({ from: '2026-11-18', to: '2026-11-18' })).data
      .find(s => s.totalMinor === 4000);
    const ret = await api.returns.create({
      saleId: oldSale.id, date: '2026-11-20',
      lines: [{ saleLineIndex: 0, qty: 1 }],
      refundMode: 'cash_refund', refundMethod: base.cash.id,
    });
    assert.strictEqual(ret.ok, true, ret.ok ? '' : ret.error.message);

    const preview = (await api.dailyClosings.preview('2026-11-20')).data;
    assert.strictEqual(preview.status, 'open');
    assert.strictEqual(preview.openingCashMinor, 20000, 'opening float');
    assert.strictEqual(preview.invoicesCount, 3);
    assert.strictEqual(preview.totalSalesMinor, 45000);
    // §4.1: salesByMethod is net of refunds by method (300 − 40 cash refund).
    assert.strictEqual(preview.salesByMethod.cash, 26000);
    assert.strictEqual(preview.salesByMethod.card, 10000);
    assert.strictEqual(preview.cashSalesMinor, 30000, 'gross drawer cash sale');
    assert.strictEqual(preview.returnsCashRefundMinor, 4000);
    assert.strictEqual(preview.customerCollectionsByMethod.cash, 8000);
    assert.strictEqual(preview.cashExpensesMinor, 2500);
    assert.strictEqual(preview.expectedCashMinor, 51500);

    const pnlBefore = (await api.reports.profitAndLoss('2026-11-20', '2026-11-20', { legacy: true })).data;

    const closed = await api.dailyClosings.close({
      date: '2026-11-20',
      countedCashMinor: 51000,
      externalTotals: { card: 10000 },
      takenOutMinor: 40000,
      takenOutMode: 'bank_deposit',
      bankAccountId: base.bank.id,
      note: 'إغلاق تجريبي',
    });
    assert.strictEqual(closed.ok, true, closed.ok ? '' : closed.error.message);
    const rec = closed.data;
    assert.strictEqual(rec.status, 'closed');
    assert.strictEqual(rec.expectedCashMinor, 51500);
    assert.strictEqual(rec.countedCashMinor, 51000);
    assert.strictEqual(rec.differenceMinor, -500);
    assert.strictEqual(rec.takenOutMinor, 40000);
    assert.strictEqual(rec.retainedFloatMinor, 11000);
    assert.strictEqual(rec.cashSalesMinor, 30000, 'gross cash sale kept on the closed record');
    assert.strictEqual(rec.customerCollectionsCashMinor, 8000, 'cash collections kept on the closed record');
    assert.strictEqual(rec.noCount, false);
    assert.deepStrictEqual(rec.externalDifferences, {});
    assert.ok(rec.generatedRecordIds.length >= 2, 'shortage + bank transfer');

    assert.strictEqual((await api.accounts.balanceAsOf(base.cash.id, '2026-11-20')).data, 11000);
    assert.strictEqual((await api.accounts.balanceAsOf(base.bank.id, '2026-11-20')).data, 40000);

    const adjustments = (await api.repo.list('cashAdjustments')).filter(a => !a.voided);
    assert.strictEqual(adjustments.length, 1);
    assert.strictEqual(adjustments[0].amountMinor, -500);
    assert.strictEqual(adjustments[0].sourceType, 'cash_difference');
    assert.strictEqual(adjustments[0].closingId, rec.id);
    const transfers = (await api.repo.list('transfers')).filter(t => !t.voided);
    assert.strictEqual(transfers.length, 1);
    assert.strictEqual(transfers[0].fromAccountId, base.cash.id);
    assert.strictEqual(transfers[0].toAccountId, base.bank.id);
    assert.strictEqual(transfers[0].amountMinor, 40000);

    const pnlAfter = (await api.reports.profitAndLoss('2026-11-20', '2026-11-20', { legacy: true })).data;
    assert.strictEqual(pnlAfter.cashDifference, -500, 'shortage shown as a signed P&L line');
    assert.strictEqual(pnlAfter.netProfit, pnlBefore.netProfit - 500, 'shortage reduces net profit');
    assert.strictEqual(
      pnlAfter.operatingExpenses,
      pnlBefore.operatingExpenses + 500,
      'shortage increases operating expenses'
    );

    const monthPnl = (await api.reports.profitAndLoss('2026-11-01', '2026-11-30')).data;
    assert.strictEqual(monthPnl.cashDifference, -500, 'summary P&L carries the difference');
    const monthCategories = Object.values(monthPnl.expensesByCategory)
      .reduce((sum, v) => sum + v, 0);
    assert.strictEqual(
      monthPnl.operatingExpenses,
      monthCategories + monthPnl.salaryExpense + monthPnl.stockLosses + 500,
      'summary operating expenses include the shortage'
    );

    const tomorrow = (await api.dailyClosings.preview('2026-11-21')).data;
    assert.strictEqual(tomorrow.openingCashMinor, 11000, 'retained float is next opening');

    const snapshot = (await api.reports.balanceSnapshot('2026-11-20')).data;
    assert.strictEqual(snapshot.balanced, true, 'balance snapshot stays balanced');
    assert.strictEqual(snapshot.assets.cashByAccount[base.cash.id], 11000);

    const report = (await api.dailyClosings.report('2026-11-20')).data;
    assert.strictEqual(report.status, 'closed');
    assert.strictEqual(report.cashSalesMinor, 30000, 'closed Day Report keeps cash sales');
    assert.strictEqual(report.customerCollectionsCashMinor, 8000, 'closed Day Report keeps cash collections');
    assert.strictEqual(report.differenceMinor, -500);
    assert.strictEqual(report.externalWarnings.length, 0);

    const month = (await api.dailyClosings.daysInMonth('2026-11')).data;
    const row = month.days.find(d => d.date === '2026-11-20');
    assert.strictEqual(row.status, 'closed');
    assert.strictEqual(row.differenceMinor, -500);
    assert.strictEqual(month.totalDifferenceMinor, -500);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1 #2 — day lock, non-cash exception, order and reopen rules.
test('L4 day lock blocks cash postings, allows unpaid purchase/stock, reopens latest only', async () => {
  const api = await freshApi('2026-11-10');
  try {
    const base = await seedBase(api, '2026-11-01');
    const day = '2026-11-05';
    const sale = await sell(api, base, day, 30000, 'cash', { accountId: base.cash.id, qty: 6 });

    // Noon: close day 5 with an exact count.
    let res = await api.dailyClosings.close({
      date: day, countedCashMinor: 50000,
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
    // Opening 200 + sale 300 = 500.

    // Day lock: new/void sale, cash expense, receipt, transfer, capital.
    assert.strictEqual((await api.sales.create({
      date: day,
      lines: [{ variantId: base.variant.id, qty: 1, unitPriceMinor: 5000 }],
      payments: [{ method: 'cash', accountId: base.cash.id, amountMinor: 5000 }],
    })).error.code, 'DAY_CLOSED');
    const voided = await api.sales.void(sale.id, 'تصحيح');
    assert.strictEqual(voided.ok, false);
    assert.strictEqual(voided.error.code, 'DAY_CLOSED');
    assert.strictEqual((await api.expenses.create({
      date: day, amountMinor: 1000, accountId: base.cash.id,
    })).error.code, 'DAY_CLOSED');
    assert.strictEqual((await api.customers.receivePayment({
      customerId: base.customerA.id, date: day, amountMinor: 1000,
      method: 'cash', accountId: base.cash.id,
    })).error.code, 'DAY_CLOSED');
    assert.strictEqual((await api.transactions.transfer({
      date: day, fromAccountId: base.cash.id, toAccountId: base.bank.id, amountMinor: 1000,
    })).error.code, 'DAY_CLOSED');
    assert.strictEqual((await api.transactions.ownerTransaction({
      date: day, type: 'withdrawal', amountMinor: 1000, accountId: base.cash.id,
    })).error.code, 'DAY_CLOSED');

    // Allowed on a closed day: bank/card expense, unpaid purchase, stock adjust.
    const bankExpense = await api.expenses.create({
      date: day, amountMinor: 2000, method: 'bank', accountId: base.bank.id,
    });
    assert.strictEqual(bankExpense.ok, true, bankExpense.ok ? '' : bankExpense.error.message);
    const supplier = (await api.suppliers.create({ name: 'مورد' })).data;
    const purchase = await api.purchases.create({
      date: day, supplierId: supplier.id, supplierName: 'مورد',
      lines: [{ variantId: base.variant.id, qty: 2, unitCostMinor: 1000 }],
    });
    assert.strictEqual(purchase.ok, true, purchase.ok ? '' : purchase.error.message);
    const adjust = await api.stock.adjust(base.variant.id, -1, 'جرد', day, 'تسوية');
    assert.strictEqual(adjust.ok, true, adjust.ok ? '' : adjust.error.message);

    // A later day with activity closes normally.
    await sell(api, base, '2026-11-06', 10000, 'cash', { accountId: base.cash.id, qty: 2 });
    res = await api.dailyClosings.close({ date: '2026-11-06', countedCashMinor: 59000 });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
    // Opening day 6 = 500.00, sale 100.00, shortage counted 90.00 = 590.00.
    assert.strictEqual(res.data.differenceMinor, -1000);

    // Only the latest closed day can be reopened.
    assert.strictEqual((await api.dailyClosings.reopen(day)).error.code, 'CONFLICT');
    const reopened = await api.dailyClosings.reopen('2026-11-06', { note: 'تصحيح إدخال' });
    assert.strictEqual(reopened.ok, true, reopened.ok ? '' : reopened.error.message);
    assert.strictEqual(reopened.data.voidedCount, 1);
    const voidedAdjustments = (await api.repo.list('cashAdjustments'))
      .filter(a => a.closingId === reopened.data.record.id);
    assert.strictEqual(voidedAdjustments.length, 1);
    assert.strictEqual(voidedAdjustments[0].voided, true);
    const yReport = (await api.dailyClosings.report('2026-11-06')).data;
    assert.strictEqual(yReport.status, 'open');
    assert.strictEqual(yReport.differenceMinor, 0);

    // After reopening, posting to that day is allowed again.
    const afterReopen = await api.sales.create({
      date: '2026-11-06',
      lines: [{ variantId: base.variant.id, qty: 1, unitPriceMinor: 5000 }],
      payments: [{ method: 'cash', accountId: base.cash.id, amountMinor: 5000 }],
    });
    assert.strictEqual(afterReopen.ok, true, afterReopen.ok ? '' : afterReopen.error.message);

    // Re-close the same day: the reopened record is reused, not duplicated.
    const reclose = await api.dailyClosings.close({
      date: '2026-11-06', countedCashMinor: 64000,
    });
    assert.strictEqual(reclose.ok, true, reclose.ok ? '' : reclose.error.message);
    assert.strictEqual(reclose.data.id, reopened.data.record.id);
    assert.strictEqual((await api.repo.list('dailyClosings',
      c => c.date === '2026-11-06')).length, 1);

    // Month lock overrides day reopen.
    const monthClose = await api.periods.close('2026-11');
    assert.strictEqual(monthClose.ok, true, monthClose.ok ? '' : monthClose.error.message);
    const locked = await api.dailyClosings.reopen('2026-11-06');
    assert.strictEqual(locked.ok, false);
    assert.strictEqual(locked.error.code, 'PERIOD_CLOSED');
    assert.strictEqual((await api.dailyClosings.report('2026-11-06')).data.status, 'closed');
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1 #3 — catch-up order and noCount closing.
test('L4 catch-up: later day blocked, earlier noCount close unlocks it', async () => {
  const api = await freshApi('2026-11-10');
  try {
    const base = await seedBase(api, '2026-11-01');
    await sell(api, base, '2026-11-01', 10000, 'cash', { accountId: base.cash.id, qty: 2 });
    await sell(api, base, '2026-11-03', 20000, 'cash', { accountId: base.cash.id, qty: 4 });

    const bad = await api.dailyClosings.close({
      date: '2026-11-03', countedCashMinor: 50000,
    });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error.code, 'CONFLICT');
    assert.match(bad.error.message, /2026-11-01/);

    const first = await api.dailyClosings.close({
      date: '2026-11-01', noCount: true,
    });
    assert.strictEqual(first.ok, true, first.ok ? '' : first.error.message);
    assert.strictEqual(first.data.noCount, true);
    assert.strictEqual(first.data.differenceMinor, 0);
    assert.strictEqual(first.data.countedCashMinor, first.data.expectedCashMinor);

    const report = (await api.dailyClosings.report('2026-11-01')).data;
    assert.strictEqual(report.noCount, true);

    const third = await api.dailyClosings.close({
      date: '2026-11-03', noCount: true,
    });
    assert.strictEqual(third.ok, true, third.ok ? '' : third.error.message);
    const rows = (await api.dailyClosings.daysInMonth('2026-11')).data;
    assert.strictEqual(rows.counts.closed, 2);
    assert.strictEqual(rows.days.find(d => d.date === '2026-11-01').noCount, true);
  } finally {
    BeeStore.dates.resetClock();
  }
});

// §12.1 #4 — external non-cash totals warn but create no ledger entry.
test('L4 external totals only warn and never post to the ledger', async () => {
  const api = await freshApi('2026-11-10');
  try {
    const base = await seedBase(api, '2026-11-01');
    await sell(api, base, '2026-11-02', 10000, 'card', { accountId: base.card.id, qty: 2 });
    await sell(api, base, '2026-11-02', 5000, 'cash', { accountId: base.cash.id, qty: 1 });

    const close = await api.dailyClosings.close({
      date: '2026-11-02',
      countedCashMinor: 25000,
      externalTotals: { card: 12000 },
    });
    assert.strictEqual(close.ok, true, close.ok ? '' : close.error.message);
    assert.deepStrictEqual(close.data.externalTotals, { card: 12000 });
    assert.deepStrictEqual(close.data.externalDifferences, { card: 2000 });
    assert.strictEqual((await api.accounts.balanceAsOf(base.card.id, '2026-11-02')).data, 10000);
    assert.strictEqual((await api.repo.list('cashAdjustments')).length, 0);
    assert.strictEqual((await api.repo.list('transfers')).length, 0);

    const report = (await api.dailyClosings.report('2026-11-02')).data;
    assert.strictEqual(report.externalWarnings.length, 1);
    assert.strictEqual(report.externalWarnings[0].method, 'card');
    assert.strictEqual(report.externalWarnings[0].differenceMinor, 2000);
    assert.strictEqual(report.differenceMinor, 0);
    assert.strictEqual((await api.reports.profitAndLoss('2026-11-02', '2026-11-02', { legacy: true })).data.cashDifference, 0);
  } finally {
    BeeStore.dates.resetClock();
  }
});
