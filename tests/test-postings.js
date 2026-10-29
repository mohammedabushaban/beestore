const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors', 'chartSeed']
  .forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
require('../js/storage/migrations.js');
['settings', 'auth', 'audit', 'accounts', 'categories', 'products', 'variants',
 'stock', 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns',
 'suppliers', 'expenses', 'employees', 'payroll', 'transactions', 'periods',
 'chartOfAccounts', 'journal', 'posting', 'dailyClosing', 'reports',
 'dashboard', 'backup', 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

test.afterEach(() => BeeStore.dates.resetClock());

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

async function freshApi(clock) {
  useClock(clock || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: '2026-10-01',
    blockFutureDates: true,
  }), 'settings');
  await BeeStore.chart.ensureSeeded();
  return { repo, api };
}

async function moneyAccounts(api, opts) {
  const o = opts || {};
  const cash = ok(await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: o.cash || 0,
  }), 'cash account');
  const bank = ok(await api.accounts.create({
    name: 'البنك', type: 'bank', openingBalanceMinor: o.bank || 0,
  }), 'bank account');
  const card = ok(await api.accounts.create({
    name: 'البطاقة', type: 'wallet',
  }), 'card account');
  ok(await api.settings.save({
    systemStartDate: '2026-10-01',
    blockFutureDates: true,
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', accountId: bank.id },
      { id: 'card', name: 'بطاقة', accountId: card.id },
    ],
  }), 'settings with drawer');
  return { cash, bank, card };
}

async function makeVariant(api, opts) {
  const o = opts || {};
  const product = ok(await api.products.create({
    name: o.name || 'P',
    defaultCostMinor: o.costMinor || 1000,
    defaultPriceMinor: o.priceMinor || 2000,
  }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id,
    size: o.size || 'M',
    color: o.color || 'R',
    costMinor: o.costMinor || 1000,
    priceMinor: o.priceMinor || 2000,
  }), 'variant');
  return { product, variant };
}

async function trialBalance(api, filters) {
  return ok(await api.journal.trialBalance(filters), 'trial balance');
}

function balance(tb, code) {
  const row = tb.accounts.find(a => String(a.code) === String(code));
  return row ? row.balanceMinor : 0;
}

async function activeEntries(api, sourceType, sourceId) {
  const rows = ok(await api.journal.forSource(sourceType, sourceId), 'source entries');
  const reversed = new Set(rows.filter(e => e.reversalOf).map(e => e.reversalOf));
  return rows.filter(e => !e.reversalOf && !reversed.has(e.id));
}

async function assertHealthy(label) {
  const tb = await BeeStore.journal.trialBalance();
  assert.strictEqual(tb.balanced, true, (label || '') + ' trial balance must balance');
  const journal = await BeeStore.journal.verify();
  assert.strictEqual(journal.ok, true,
    (label || '') + ' journal verification: ' + JSON.stringify(journal.errors));
  const stock = await BeeStore.stock.verifyStock();
  assert.strictEqual(stock.ok, true,
    (label || '') + ' stock verification: ' + JSON.stringify(stock.mismatches));
}

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------

test('A3 opening balances post cash, receivables, payables and stock to 3030', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 10000, bank: 5000 });
  const customer = ok(await api.customers.create({
    name: 'زبون', openingBalanceMinor: 2000,
  }), 'customer');
  const supplier = ok(await api.suppliers.create({
    name: 'مورد', openingBalanceMinor: 1500,
  }), 'supplier');
  const product = ok(await api.products.create({
    name: 'منتج افتتاحي',
    defaultCostMinor: 1000,
    defaultPriceMinor: 2000,
    variants: [{ size: 'M', color: 'R', quantity: 2, costMinor: 1000, priceMinor: 2000 }],
  }), 'product with opening stock');

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 10000, 'cash opening');
  assert.strictEqual(balance(tb, '1020'), 5000, 'bank opening');
  assert.strictEqual(balance(tb, '1100'), 2000, 'customer opening AR');
  assert.strictEqual(balance(tb, '2010'), -1500, 'supplier opening AP');
  assert.strictEqual(balance(tb, '1200'), 2000, 'opening inventory');
  assert.strictEqual(balance(tb, '3030'), -17500, 'opening equity balances everything');

  const entries = ok(await api.journal.list({ sourceType: 'OPENING' }), 'opening entries');
  assert.strictEqual(entries.length, 5);
  assert.ok(entries.every(e => e.sourceType === 'OPENING'));
  assert.ok(customer.openingBalanceMinor === 2000);
  assert.ok(supplier.openingBalanceMinor === 1500);
  assert.ok(product.id);
  await assertHealthy('openings');
});

// ---------------------------------------------------------------------------
// Sales and customer collections
// ---------------------------------------------------------------------------

test('A3 cash sale posts revenue, COGS, receipt and turns overpayment into 2030 credit', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api);
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const customer = ok(await api.customers.create({ name: 'زبون' }), 'customer');
  const { variant } = await makeVariant(api, { costMinor: 400, priceMinor: 1000 });

  ok(await api.transactions.ownerTransaction({
    date: '2026-10-02', type: 'capital_in', amountMinor: 10000,
    accountId: accounts.cash.id,
  }), 'capital');
  ok(await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    supplierName: supplier.name,
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 400 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 4000 }],
  }), 'purchase');

  const sale = ok(await api.sales.create({
    date: '2026-10-04',
    customerId: customer.id,
    customerName: customer.name,
    lines: [{ variantId: variant.id, qty: 3, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 4000 }],
  }), 'sale');

  assert.strictEqual(sale.totalMinor, 3000);
  assert.strictEqual(sale.paidMinor, 3000, 'document receipt is capped at the invoice total');
  assert.strictEqual(sale.payments[0].amountMinor, 4000, 'the physical receipt is preserved');

  const entries = ok(await api.journal.forSource('SALE', sale.id), 'sale entries');
  assert.strictEqual(entries.length, 3, 'revenue, COGS and receipt');
  assert.deepStrictEqual(
    entries.map(e => e.event).sort(),
    ['SALE_COST', 'SALE_PAYMENT:0', 'SALE_REVENUE']);
  assert.strictEqual(sale.journalEntryIds.length, 3);

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 10000, 'cash after purchase and overpaid sale');
  assert.strictEqual(balance(tb, '1200'), 2800, 'inventory after COGS');
  assert.strictEqual(balance(tb, '1100'), 0, 'AR cleared by the receipt');
  assert.strictEqual(balance(tb, '2030'), -1000, 'excess receipt is a customer credit');
  assert.strictEqual(balance(tb, '4010'), -3000, 'net revenue');
  assert.strictEqual(balance(tb, '5010'), 1200, 'COGS');
  assert.strictEqual(balance(tb, '3010'), -10000, 'capital');

  assert.strictEqual(ok(await api.customers.balance(customer.id), 'customer balance'), -1000);
  await assertHealthy('cash sale');
});

test('A3 credit sale: dated receipt, general collection and journal-report approval gate', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 20000 });
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const customer = ok(await api.customers.create({ name: 'زبون' }), 'customer');
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 1000 });

  ok(await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 1000 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 10000 }],
  }), 'purchase');

  const sale = ok(await api.sales.create({
    date: '2026-10-05',
    customerId: customer.id,
    customerName: customer.name,
    lines: [{ variantId: variant.id, qty: 5, unitPriceMinor: 1000 }],
    payments: [{
      method: 'cash', accountId: accounts.cash.id,
      amountMinor: 2000, date: '2026-10-10',
    }],
  }), 'credit sale');
  assert.strictEqual(sale.dueMinor, 3000);
  assert.strictEqual(sale.status, 'partial');

  const saleEntries = ok(await api.journal.forSource('SALE', sale.id), 'sale entries');
  const receipt = saleEntries.find(e => e.event === 'SALE_PAYMENT:0');
  assert.ok(receipt, 'embedded receipt is posted');
  assert.strictEqual(receipt.date, '2026-10-10', 'receipt keeps its own date');
  assert.strictEqual(receipt.lines[0].debitMinor, 2000);

  ok(await api.customers.receivePayment({
    customerId: customer.id,
    date: '2026-10-15',
    amountMinor: 1000,
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'customer collection');

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 13000, 'cash');
  assert.strictEqual(balance(tb, '1200'), 5000, 'inventory');
  assert.strictEqual(balance(tb, '1100'), 2000, 'remaining AR');
  assert.strictEqual(balance(tb, '4010'), -5000, 'revenue');
  assert.strictEqual(balance(tb, '5010'), 5000, 'COGS');
  assert.strictEqual(ok(await api.customers.balance(customer.id), 'customer balance'), 2000);

  const statusBefore = ok(await api.reports.journalStatus(), 'journal status');
  assert.strictEqual(statusBefore.active, false, 'journal reports are off before approval');

  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-10-31',
  }), 'parity report');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  assert.strictEqual(parity.failures.length, 0);
  assert.strictEqual(parity.months.length, 1);
  assert.strictEqual(parity.snapshots.length, 1);
  assert.strictEqual(parity.customers[0].differenceMinor, 0);
  assert.strictEqual(parity.suppliers[0].differenceMinor, 0);
  assert.strictEqual(parity.inventory.differenceMinor, 0);

  const approval = ok(await api.reports.approveJournal({
    from: '2026-10-01', to: '2026-10-31', approvedBy: 'owner',
  }), 'approve journal');
  assert.strictEqual(approval.status, 'approved');
  assert.strictEqual(ok(await api.reports.journalStatus(), 'journal status').active, true);

  const journalPnl = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'), 'journal P&L');
  assert.strictEqual(journalPnl.source, 'journal');
  assert.strictEqual(journalPnl.netSales, 5000);
  assert.strictEqual(journalPnl.cogs, 5000);
  assert.strictEqual(journalPnl.netProfit, 0);

  const journalSnap = ok(await api.reports.balanceSnapshot('2026-10-31'), 'journal snapshot');
  assert.strictEqual(journalSnap.source, 'journal');
  assert.strictEqual(journalSnap.balanced, true);
  assert.strictEqual(journalSnap.assets.cashBalance, 13000);
  assert.strictEqual(journalSnap.assets.inventoryValue, 5000);
  assert.strictEqual(journalSnap.assets.receivables, 2000);

  ok(await api.reports.revokeJournalApproval('test fallback'), 'revoke approval');
  assert.strictEqual(ok(await api.reports.journalStatus(), 'journal status').active, false);
  const fallback = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'), 'fallback P&L');
  assert.notStrictEqual(fallback.source, 'journal');
  await assertHealthy('credit sale');
});

test('A3 general customer payment settles an opening receivable before creating 2030 credit', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api);
  const customer = ok(await api.customers.create({
    name: 'زبون افتتاحي', openingBalanceMinor: 5000,
  }), 'customer');

  const first = ok(await api.customers.receivePayment({
    customerId: customer.id,
    date: '2026-10-05',
    amountMinor: 3000,
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'first collection');
  assert.strictEqual(first.appliedMinor, 3000, 'opening AR is settled first');

  const second = ok(await api.customers.receivePayment({
    customerId: customer.id,
    date: '2026-10-06',
    amountMinor: 4000,
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'second collection');
  assert.strictEqual(second.appliedMinor, 2000, 'only the remaining AR is applied');
  const stored = await api.repo.get('customerPayments', second.id);
  assert.strictEqual(stored.appliedMinor, 2000, 'the split is persisted for replay');

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 7000);
  assert.strictEqual(balance(tb, '1100'), 0, 'AR settled');
  assert.strictEqual(balance(tb, '2030'), -2000, 'excess collection is a credit');
  assert.strictEqual(ok(await api.customers.balance(customer.id), 'customer balance'), -2000);
  await assertHealthy('opening collection');
});

// ---------------------------------------------------------------------------
// Sale returns
// ---------------------------------------------------------------------------

test('A3 sale returns post cash refunds, customer credits and exchange revenue', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 20000 });
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const customer = ok(await api.customers.create({ name: 'زبون' }), 'customer');
  const { variant } = await makeVariant(api, { costMinor: 400, priceMinor: 1000 });

  ok(await api.purchases.create({
    date: '2026-10-02',
    supplierId: supplier.id,
    lines: [{ variantId: variant.id, qty: 20, unitCostMinor: 400 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 8000 }],
  }), 'purchase');

  const cashSale = ok(await api.sales.create({
    date: '2026-10-05',
    customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 4, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 4000 }],
  }), 'cash sale');
  const cashReturn = ok(await api.returns.create({
    saleId: cashSale.id,
    date: '2026-10-06',
    lines: [{ saleLineIndex: 0, qty: 1, restock: true }],
    refundMode: 'cash_refund',
    refundMethod: accounts.cash.id,
  }), 'cash return');
  assert.strictEqual(cashReturn.refundMinor, 1000);
  assert.strictEqual(cashReturn.restockCostMinor, 400);
  assert.strictEqual(cashReturn.journalEntryIds.length, 2);

  const creditSale = ok(await api.sales.create({
    date: '2026-10-07',
    customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
  }), 'credit sale');
  const creditReturn = ok(await api.returns.create({
    saleId: creditSale.id,
    date: '2026-10-08',
    lines: [{ saleLineIndex: 0, qty: 1, restock: true }],
    refundMode: 'customer_credit',
  }), 'credit return');
  assert.strictEqual(creditReturn.refundMinor, 1000);

  const exchangeReturn = ok(await api.returns.create({
    saleId: creditSale.id,
    date: '2026-10-09',
    lines: [{ saleLineIndex: 0, qty: 1, restock: true }],
    refundMode: 'exchange',
    exchangeLines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
  }), 'exchange return');
  assert.strictEqual(exchangeReturn.refundMinor, 1000);
  assert.ok(exchangeReturn.exchangeSaleId, 'exchange sale is linked');
  const exchangeSale = ok(await api.sales.get(exchangeReturn.exchangeSaleId), 'exchange sale');
  assert.strictEqual(exchangeSale.totalMinor, 1000);
  assert.ok(exchangeSale.journalEntryIds.length >= 2);

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 15000, 'cash after refund');
  assert.strictEqual(balance(tb, '1200'), 6400, 'inventory after all returns/exchange');
  assert.strictEqual(balance(tb, '1100'), 2000, 'AR from the credit sale and exchange');
  assert.strictEqual(balance(tb, '2030'), -1000, 'customer credit return');
  assert.strictEqual(balance(tb, '4010'), -7000, 'gross sales revenue');
  assert.strictEqual(balance(tb, '4020'), 3000, 'sales returns');
  assert.strictEqual(balance(tb, '5010'), 1600, 'net COGS after restocks');
  assert.strictEqual(ok(await api.customers.balance(customer.id), 'customer balance'), 1000);

  await assertHealthy('sale returns');
});

// ---------------------------------------------------------------------------
// Purchases, supplier payments and both return modes
// ---------------------------------------------------------------------------

test('A3 purchases and purchase returns: AP, cash refund and 5030 value differences', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 50000 });
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const { variant } = await makeVariant(api, { costMinor: 1000, priceMinor: 3000 });

  const purchaseA = ok(await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    supplierName: supplier.name,
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 1000 }],
    discountMinor: 1000,
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 4000 }],
  }), 'purchase A');
  assert.strictEqual(purchaseA.totalMinor, 9000);
  assert.strictEqual(purchaseA.inventoryValueMinor, 9000);
  assert.strictEqual(purchaseA.dueMinor, 5000);

  ok(await api.suppliers.pay({
    supplierId: supplier.id,
    date: '2026-10-04',
    amountMinor: 2000,
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'supplier payment');

  const purchaseB = ok(await api.purchases.create({
    date: '2026-10-05',
    supplierId: supplier.id,
    supplierName: supplier.name,
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 2000 }],
  }), 'purchase B');
  assert.strictEqual(purchaseB.totalMinor, 20000);

  const reduceReturn = ok(await api.purchaseReturns.create({
    purchaseId: purchaseA.id,
    date: '2026-10-06',
    lines: [{ purchaseLineIndex: 0, qty: 1 }],
    mode: 'reduce_payable',
  }), 'reduce-payable return');
  assert.strictEqual(reduceReturn.totalMinor, 900);
  assert.strictEqual(reduceReturn.lines[0].removedValueMinor, 1450);
  assert.strictEqual(reduceReturn.lines[0].differenceMinor, -550);

  const cashReturn = ok(await api.purchaseReturns.create({
    purchaseId: purchaseA.id,
    date: '2026-10-07',
    lines: [{ purchaseLineIndex: 0, qty: 1 }],
    mode: 'cash_refund',
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'cash-refund return');
  assert.strictEqual(cashReturn.totalMinor, 900);

  const purchaseAfter = ok(await api.purchases.get(purchaseA.id), 'purchase after returns');
  assert.strictEqual(purchaseAfter.dueMinor, 2100,
    'only reduce_payable lowers the purchase due');
  assert.strictEqual(purchaseAfter.status, 'partial');

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 44900, 'cash after payments and cash refund');
  assert.strictEqual(balance(tb, '1200'), 26100, 'inventory at tracked average');
  assert.strictEqual(balance(tb, '2010'), -22100, 'AP after both returns');
  assert.strictEqual(balance(tb, '5030'), 1100, 'return differences hit 5030');
  assert.strictEqual(ok(await api.suppliers.balance(supplier.id), 'supplier balance'), 22100);

  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-10-31', replay: false,
  }), 'purchase parity');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  await assertHealthy('purchase returns');
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

test('A3 expenses: prepaid spread schedules, update reversal and void reversal', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 20000 });

  const electricity = ok(await api.expenses.create({
    date: '2026-10-05',
    amountMinor: 1000,
    categoryName: 'كهرباء',
    accountId: accounts.cash.id,
  }), 'electricity expense');
  assert.strictEqual(electricity.journalEntryIds.length, 1);

  const spread = ok(await api.expenses.create({
    date: '2026-10-20',
    amountMinor: 6000,
    categoryName: 'إيجار',
    accountId: accounts.cash.id,
    allocation: { mode: 'spread', months: 3, startMonth: '2026-10' },
  }), 'spread expense');
  assert.strictEqual(spread.journalEntryIds.length, 4, 'payment plus three monthly releases');

  let tb = await trialBalance(api, { to: '2026-10-31' });
  assert.strictEqual(balance(tb, '1010'), 13000, 'cash after expense payment and prepaid');
  assert.strictEqual(balance(tb, '1300'), 4000, 'unreleased prepaid');
  assert.strictEqual(balance(tb, '6020'), 1000, 'electricity expense');
  assert.strictEqual(balance(tb, '6010'), 2000, 'October rent release');

  const scheduled = ok(await api.journal.list({ sourceId: spread.id }), 'spread entries');
  assert.strictEqual(scheduled.length, 4);
  assert.deepStrictEqual(
    scheduled.map(e => e.date).sort(),
    ['2026-10-20', '2026-10-20', '2026-11-01', '2026-12-01']);
  assert.ok(scheduled.filter(e => e.date > '2026-10-31').every(e => e.isScheduled === true),
    'future releases are marked scheduled');

  const updated = ok(await api.expenses.update(spread.id, { amountMinor: 9000 }), 'update spread');
  assert.strictEqual(updated.amountMinor, 9000);
  const allSpread = ok(await api.journal.list({ sourceId: spread.id }), 'spread history');
  assert.strictEqual(allSpread.length, 12,
    'four originals, four reversals and four reposted entries');
  const activeSpread = await activeEntries(api, 'EXPENSE', spread.id);
  assert.strictEqual(activeSpread.length, 4, 'one active entry set after the update');

  tb = await trialBalance(api, { to: '2026-10-31' });
  assert.strictEqual(balance(tb, '1010'), 10000, 'cash reflects the updated spread');
  assert.strictEqual(balance(tb, '1300'), 6000, 'updated prepaid balance');
  assert.strictEqual(balance(tb, '6010'), 3000, 'updated October release');

  const voided = ok(await api.expenses.void(electricity.id, 'إدخال خاطئ'), 'void expense');
  assert.strictEqual(voided.voided, true);
  tb = await trialBalance(api, { to: '2026-10-31' });
  assert.strictEqual(balance(tb, '1010'), 11000, 'void restored the expense cash');
  assert.strictEqual(balance(tb, '6020'), 0, 'voided expense net is zero');
  assert.strictEqual(balance(tb, '6010'), 3000, 'spread expense is unaffected');
  assert.strictEqual((await activeEntries(api, 'EXPENSE', electricity.id)).length, 0);

  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-10-31',
  }), 'expense parity');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  assert.strictEqual(parity.failures.length, 0);
  await assertHealthy('expenses');
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

test('A3 payroll accrues gross, applies advances and never double-counts net pay', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 20000 });
  const employee = ok(await api.employees.create({
    name: 'موظف', baseSalaryMinor: 6000,
  }), 'employee');
  ok(await api.payroll.createAdvance({
    employeeId: employee.id,
    date: '2026-10-05',
    amountMinor: 1000,
    method: 'cash',
    accountId: accounts.cash.id,
  }), 'advance');
  const prepared = ok(await api.payroll.prepare('2026-10'), 'prepare payroll');
  assert.strictEqual(prepared.length, 1);
  const payroll = prepared[0];
  assert.strictEqual(payroll.netMinor, 6000);

  const paid = ok(await api.payroll.pay(
    payroll.id, 'cash', accounts.cash.id, '', 1000, '2026-10-31'), 'pay payroll');
  assert.strictEqual(paid.status, 'paid');
  assert.strictEqual(paid.advanceRepaymentMinor, 1000);
  assert.strictEqual(paid.netMinor, 5000);

  const entries = await activeEntries(api, 'PAYROLL', payroll.id);
  assert.strictEqual(entries.length, 2, 'accrual and payment');
  assert.deepStrictEqual(entries.map(e => e.event).sort(),
    ['PAYROLL_ACCRUAL', 'PAYROLL_PAYMENT']);
  const accrual = entries.find(e => e.event === 'PAYROLL_ACCRUAL');
  assert.strictEqual(accrual.date, '2026-10-01');
  const payment = entries.find(e => e.event === 'PAYROLL_PAYMENT');
  assert.strictEqual(payment.date, '2026-10-31');

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 14000, 'advance and net salary cash out');
  assert.strictEqual(balance(tb, '6100'), 6000, 'gross salary expense');
  assert.strictEqual(balance(tb, '2100'), 0, 'accrual cleared');
  assert.strictEqual(balance(tb, '1150'), 0, 'advance repaid');

  const netExpenses = ok(await api.expenses.list(), 'expenses')
    .filter(e => e.categoryName === 'رواتب');
  assert.strictEqual(netExpenses.length, 1);
  assert.strictEqual(netExpenses[0].amountMinor, 5000);
  assert.strictEqual((netExpenses[0].journalEntryIds || []).length, 0,
    'payroll net-pay expense is not posted twice');

  assert.strictEqual((await api.payroll.update(payroll.id, { bonusMinor: 500 })).ok, false);
  const noteOnly = ok(await api.payroll.update(payroll.id, { note: 'تم الدفع' }), 'note update');
  assert.strictEqual(noteOnly.note, 'تم الدفع');

  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual(replay.counts.payroll.posted, 0, 'payroll is already posted');
  assert.strictEqual(replay.counts.expenses.posted, 0, 'net-pay expense is skipped');
  await assertHealthy('payroll');
});

// ---------------------------------------------------------------------------
// Owner, transfers and daily closing reopen
// ---------------------------------------------------------------------------

test('A3 owner, transfer and daily-closing reopen reverse generated entries', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api, { cash: 10000 });

  ok(await api.transactions.ownerTransaction({
    date: '2026-10-04', type: 'capital_in', amountMinor: 5000,
    accountId: accounts.cash.id,
  }), 'capital in');
  ok(await api.transactions.ownerTransaction({
    date: '2026-10-04', type: 'withdrawal', amountMinor: 1000,
    accountId: accounts.cash.id,
  }), 'withdrawal');
  ok(await api.transactions.transfer({
    date: '2026-10-04', fromAccountId: accounts.cash.id,
    toAccountId: accounts.bank.id, amountMinor: 2000,
  }), 'transfer');

  let tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 12000, 'cash after owner and transfer');
  assert.strictEqual(balance(tb, '1020'), 2000, 'bank after transfer');
  assert.strictEqual(balance(tb, '3010'), -5000, 'capital');
  assert.strictEqual(balance(tb, '3020'), 1000, 'drawings');

  const closed = ok(await api.dailyClosings.close({
    date: '2026-10-04', countedCashMinor: 11500,
  }), 'close day');
  assert.strictEqual(closed.differenceMinor, -500);
  assert.strictEqual(closed.generatedRecordIds.length, 1);

  tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 11500, 'shortage adjusted the drawer');
  assert.strictEqual(balance(tb, '6400'), 500, 'cash shortage expense');

  const reopened = ok(await api.dailyClosings.reopen('2026-10-04', {
    note: 'تصحيح إدخال',
  }), 'reopen day');
  assert.strictEqual(reopened.voidedCount, 1);
  const adjustmentId = closed.generatedRecordIds[0];
  const adjustment = await api.repo.get('cashAdjustments', adjustmentId);
  assert.strictEqual(adjustment.voided, true);
  assert.strictEqual((adjustment.journalEntryIds || []).length, 2,
    'original and reversal stay linked to the voided document');

  tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 12000, 'reopen restored the drawer');
  assert.strictEqual(balance(tb, '6400'), 0, 'shortage is reversed');
  assert.strictEqual((await activeEntries(api, 'CASH_ADJUSTMENT', adjustmentId)).length, 0);

  const parity = ok(await api.reports.parityReport({
    from: '2026-10-01', to: '2026-10-31',
  }), 'closing parity');
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
  await assertHealthy('daily closing');
});

// ---------------------------------------------------------------------------
// Historical replay and voids
// ---------------------------------------------------------------------------

test('A3 replay rebuilds legacy documents once and reproduces customer credits', async () => {
  const { api } = await freshApi();
  const savedPosting = BeeStore.posting;
  let reopened = false;
  try {
    const accounts = await moneyAccounts(api, { cash: 10000 });
    const customer = ok(await api.customers.create({
      name: 'زبون قديم', openingBalanceMinor: 3000,
    }), 'customer');
    const supplier = ok(await api.suppliers.create({
      name: 'مورد قديم', openingBalanceMinor: 1000,
    }), 'supplier');
    const { variant } = await makeVariant(api, { costMinor: 500, priceMinor: 1000 });

    // Simulate pre-A3 data: documents exist but no journal entries.
    BeeStore.posting = null;
    reopened = true;

    ok(await api.purchases.create({
      date: '2026-10-04',
      supplierId: supplier.id,
      lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 500 }],
    }), 'legacy purchase');
    const sale = ok(await api.sales.create({
      date: '2026-10-05',
      customerId: customer.id,
      lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
      payments: [{
        method: 'cash', accountId: accounts.cash.id,
        amountMinor: 500, date: '2026-10-06',
      }],
    }), 'legacy sale');
    const payment = ok(await api.customers.receivePayment({
      customerId: customer.id,
      date: '2026-10-07',
      amountMinor: 4000,
      method: 'cash',
      accountId: accounts.cash.id,
    }), 'legacy collection');
    assert.strictEqual(payment.appliedMinor, 4000);
    ok(await api.expenses.create({
      date: '2026-10-08',
      amountMinor: 700,
      categoryName: 'مصاريف أخرى',
      accountId: accounts.cash.id,
    }), 'legacy expense');
    ok(await api.transactions.ownerTransaction({
      date: '2026-10-09', type: 'capital_in', amountMinor: 2000,
      accountId: accounts.cash.id,
    }), 'legacy capital');
    ok(await api.transactions.transfer({
      date: '2026-10-10', fromAccountId: accounts.cash.id,
      toAccountId: accounts.bank.id, amountMinor: 500,
    }), 'legacy transfer');
    ok(await api.stock.adjust(variant.id, -1, 'جرد', '2026-10-11', 'تسوية'), 'legacy adjustment');

    // The migration backfills appliedMinor for archives that predate A3.
    const dump = await api.repo.exportAll();
    const legacyDump = JSON.parse(JSON.stringify(dump));
    legacyDump.schemaVersion = 5;
    legacyDump.meta.schemaVersion = 5;
    for (const row of legacyDump.collections.customerPayments) delete row.appliedMinor;
    const migrated = await BeeStore.migrations.migrate(legacyDump, 6);
    const migratedPayment = migrated.collections.customerPayments
      .find(p => p.id === payment.id);
    assert.strictEqual(migratedPayment.appliedMinor, 4000,
      'migration reconstructs the AR/credit split');

    BeeStore.posting = savedPosting;
    savedPosting.repo = api.repo;

    const before = (await api.repo.list('journalEntries')).length;
    const replay = await BeeStore.posting.replayAll();
    assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
    assert.ok(replay.counts.sales.posted >= 1);
    assert.ok(replay.counts.purchases.posted >= 1);
    assert.ok(replay.counts.stockMovements.posted >= 1);
    const after = (await api.repo.list('journalEntries')).length;
    assert.ok(after > before, 'replay appended the missing entries');

    const meta = await api.repo.get('meta', 'meta');
    assert.strictEqual(meta.journalReplay.needed, false);
    assert.strictEqual(meta.journalReplay.ok, true);

    const again = await BeeStore.posting.replayAll();
    assert.strictEqual(again.ok, true, JSON.stringify(again.errors));
    assert.strictEqual((await api.repo.list('journalEntries')).length, after,
      'second replay is a no-op');

    const tb = await trialBalance(api);
    assert.strictEqual(balance(tb, '1010'), 15300, 'replayed cash');
    assert.strictEqual(balance(tb, '1020'), 500, 'replayed bank');
    assert.strictEqual(balance(tb, '1200'), 3500, 'replayed inventory');
    assert.strictEqual(balance(tb, '1100'), 500, 'remaining customer AR');
    assert.strictEqual(balance(tb, '2010'), -6000, 'supplier opening plus purchase');
    assert.strictEqual(balance(tb, '4010'), -2000);
    assert.strictEqual(balance(tb, '5010'), 1000);
    assert.strictEqual(balance(tb, '5020'), 500);
    assert.strictEqual(balance(tb, '3030'), -12000);
    assert.strictEqual(ok(await api.customers.balance(customer.id), 'customer balance'), 500);

    const parity = ok(await api.reports.parityReport({
      from: '2026-10-01', to: '2026-10-31',
    }), 'replayed parity');
    assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
    assert.strictEqual(parity.replayOk, true);
    await assertHealthy('replay');
  } finally {
    if (reopened) BeeStore.posting = savedPosting;
    savedPosting.repo = api.repo;
  }
});

test('A3 voiding a sale appends full reversals and leaves no active journal effect', async () => {
  const { api } = await freshApi();
  const accounts = await moneyAccounts(api);
  const supplier = ok(await api.suppliers.create({ name: 'مورد' }), 'supplier');
  const { variant } = await makeVariant(api, { costMinor: 400, priceMinor: 1000 });

  ok(await api.transactions.ownerTransaction({
    date: '2026-10-02', type: 'capital_in', amountMinor: 10000,
    accountId: accounts.cash.id,
  }), 'capital');
  ok(await api.purchases.create({
    date: '2026-10-03',
    supplierId: supplier.id,
    lines: [{ variantId: variant.id, qty: 5, unitCostMinor: 400 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 2000 }],
  }), 'purchase');
  const sale = ok(await api.sales.create({
    date: '2026-10-04',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', accountId: accounts.cash.id, amountMinor: 2000 }],
  }), 'sale');
  const originals = await activeEntries(api, 'SALE', sale.id);
  assert.strictEqual(originals.length, 3);

  const voided = ok(await api.sales.void(sale.id, 'إدخال خاطئ'), 'void sale');
  assert.strictEqual(voided.status, 'void');
  const all = ok(await api.journal.forSource('SALE', sale.id), 'sale history');
  assert.strictEqual(all.length, 6, 'three originals plus three reversals');
  const reversals = all.filter(e => e.reversalOf);
  assert.strictEqual(reversals.length, 3);
  for (const reversal of reversals) {
    const original = all.find(e => e.id === reversal.reversalOf);
    assert.ok(original, 'reversal points to the original');
    assert.strictEqual(reversal.date, original.date, 'reversal keeps the original date');
  }
  assert.strictEqual((await activeEntries(api, 'SALE', sale.id)).length, 0);
  assert.strictEqual((voided.journalEntryIds || []).length, 6);

  const tb = await trialBalance(api);
  assert.strictEqual(balance(tb, '1010'), 8000, 'cash is restored to the post-purchase balance');
  assert.strictEqual(balance(tb, '1200'), 2000, 'stock is restored');
  assert.strictEqual(balance(tb, '4010'), 0, 'revenue is reversed');
  assert.strictEqual(balance(tb, '5010'), 0, 'COGS is reversed');

  const before = (await api.repo.list('journalEntries')).length;
  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual((await api.repo.list('journalEntries')).length, before,
    'a voided sale is not re-posted');
  await assertHealthy('void sale');
});
