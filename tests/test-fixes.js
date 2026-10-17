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

// B1: repayment capped at outstanding; net deducts only the applied amount.
test('B1 payroll advance repayment capped at outstanding balance', async () => {
  const api = await freshApi();
  const emp = (await api.employees.create({ name: 'E1', baseSalaryMinor: 500000 })).data;
  await api.payroll.createAdvance({ employeeId: emp.id, amountMinor: 10000 });
  const prep = (await api.payroll.prepare('2026-10')).data;
  const rec = prep.find(p => p.employeeId === emp.id);
  const paid = (await api.payroll.pay(rec.id, 'cash', null, '', 30000)).data;
  assert.strictEqual(paid.netMinor, 490000, 'net must deduct only the applied 10000');
  assert.strictEqual(paid.advanceRepaymentMinor, 10000, 'recorded repayment must equal applied');
  const outstanding = await api.payroll.outstandingAdvances(emp.id);
  assert.strictEqual(outstanding.data, 0, 'advance fully settled');
});

// B1b: full coverage deducts the whole repayment.
test('B1 payroll full advance repayment', async () => {
  const api = await freshApi();
  const emp = (await api.employees.create({ name: 'E2', baseSalaryMinor: 500000 })).data;
  await api.payroll.createAdvance({ employeeId: emp.id, amountMinor: 50000 });
  const prep = (await api.payroll.prepare('2026-10')).data;
  const rec = prep.find(p => p.employeeId === emp.id);
  const paid = (await api.payroll.pay(rec.id, 'cash', null, '', 30000)).data;
  assert.strictEqual(paid.netMinor, 470000);
  assert.strictEqual(paid.advanceRepaymentMinor, 30000);
  const outstanding = await api.payroll.outstandingAdvances(emp.id);
  assert.strictEqual(outstanding.data, 20000);
});

// B2: salary accrues for drafts; advance repayment never reduces salary expense.
test('B2 P&L salary accrues by month, ignores advance repayment', async () => {
  const api = await freshApi();
  const emp = (await api.employees.create({ name: 'E3', baseSalaryMinor: 500000 })).data;
  await api.payroll.prepare('2026-10');
  let pnl = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  assert.strictEqual(pnl.salaryExpense, 500000, 'draft payroll must accrue');
  await api.payroll.createAdvance({ employeeId: emp.id, amountMinor: 100000 });
  const list = (await api.payroll.list({ month: '2026-10' })).data;
  await api.payroll.pay(list[0].id, 'cash', null, '', 100000);
  pnl = (await api.reports.profitAndLoss('2026-10-01', '2026-10-31')).data;
  assert.strictEqual(pnl.salaryExpense, 500000, 'advance repayment must not move P&L salary');
});

// B3: facade failures resolve {ok:false}, never reject.
test('B3 facade returns envelope on service errors', async () => {
  const api = await freshApi();
  const r1 = await api.sales.void('missing-id', 'test');
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.error.code, 'NOT_FOUND');
  const r2 = await api.categories.remove('missing-id');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error.code, 'NOT_FOUND');
  const r3 = await api.expenses.void('missing-id', 'test');
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.error.code, 'NOT_FOUND');
});

// B4: expense void needs a reason; voided excluded from P&L.
test('B4 expense void requires reason and leaves totals', async () => {
  const api = await freshApi();
  const created = (await api.expenses.create({ amountMinor: 10000, description: 't' })).data;
  const noReason = await api.expenses.void(created.id, '');
  assert.strictEqual(noReason.ok, false, 'reason is mandatory');
  assert.strictEqual(noReason.error.code, 'VALIDATION');
  let pnl = (await api.reports.profitAndLoss('2000-01-01', '2099-12-31')).data;
  assert.ok(pnl.operatingExpenses >= 10000, 'expense counted before void');
  const v = await api.expenses.void(created.id, 'خطأ إدخال');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.data.voided, true);
  pnl = (await api.reports.profitAndLoss('2000-01-01', '2099-12-31')).data;
  assert.strictEqual(pnl.operatingExpenses, 0, 'voided expense excluded from P&L');
  const double = await api.expenses.void(created.id, 'again');
  assert.strictEqual(double.ok, false, 'double void rejected');
});

// B4b: category remove is a soft-deactivate; in-use still blocked.
test('B4 category remove deactivates instead of deleting', async () => {
  const api = await freshApi();
  const cat = (await api.categories.create({ name: 'Test Cat' })).data;
  const res = await api.categories.remove(cat.id);
  assert.strictEqual(res.ok, true);
  const stillThere = await api.categories.get(cat.id);
  assert.strictEqual(stillThere.data.active, false, 'record kept with active:false');
  assert.strictEqual(stillThere.data.name, 'Test Cat');
});

// B5/B8: label sheet embeds a Code128 image and escapes user text.
test('B5 label sheet has barcode image, B8 escaping holds', async () => {
  global.document = global.document || { addEventListener() {} };
  require('../js/ui/components.js');
  require('../js/ui/print.js');
  const variants = [{
    productName: 'T-Shirt <img src=x onerror=alert(1)>',
    size: 'M', color: 'Red', priceMinor: 3500, barcode: '2000000000001',
  }];
  const withImg = BeeStore.print.buildLabelSheetHtml(
    variants, { storeNameAr: 'بي ستور' }, () => 'DATAURL-IMG');
  assert.ok(withImg.includes('<img'), 'barcode image embedded');
  assert.ok(withImg.includes('DATAURL-IMG'), 'provider image used');
  assert.ok(!withImg.includes('<img src=x'), 'user HTML escaped');
  assert.ok(withImg.includes('&lt;img'), 'escaped entity present');
  const noImg = BeeStore.print.buildLabelSheetHtml(variants, {}, null);
  assert.ok(!noImg.includes('<img'), 'graceful fallback without provider');
  assert.ok(noImg.includes('2000000000001'), 'barcode text still printed');
});

// B8: invoice HTML escapes all user-supplied strings.
test('B8 invoice HTML escapes user text', async () => {
  const sale = {
    number: 'INV-000001', date: '2026-10-10',
    lines: [{
      productName: 'Dress <script>alert(1)</script>',
      size: 'S', color: 'Blue', qty: 1,
      unitPriceMinor: 5000, lineTotalMinor: 5000,
    }],
    subtotalMinor: 5000, discountMinor: 0, taxMinor: 0,
    totalMinor: 5000, paidMinor: 5000, dueMinor: 0,
    installmentPlan: null,
  };
  const html = BeeStore.print.buildInvoiceHtml(
    sale,
    { storeNameAr: 'Store <b>bold</b>', invoiceFooter: 'Thanks <i>x</i>' },
    { name: 'Cust <svg onload=alert(2)>', phone: '050' },
    'A4');
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(!html.includes('<svg'), 'no raw svg tag');
  assert.ok(html.includes('&lt;script&gt;'), 'product name escaped');
  assert.ok(html.includes('&lt;svg'), 'customer name escaped');
});

// B6: barcode uniqueness enforced on variant update.
test('B6 variant update rejects duplicate barcode', async () => {
  const api = await freshApi();
  const prd = (await api.products.create({
    name: 'P6', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  })).data;
  const v1 = (await api.variants.create({
    productId: prd.id, size: 'S', color: 'Red', priceMinor: 2000,
  })).data;
  const v2 = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'Red', priceMinor: 2000,
  })).data;
  const clash = await api.variants.update(v2.id, { barcode: v1.barcode });
  assert.strictEqual(clash.ok, false);
  assert.strictEqual(clash.error.code, 'DUPLICATE');
  const okChange = await api.variants.update(v2.id, { barcode: '2999999999999' });
  assert.strictEqual(okChange.ok, true, 'unique barcode accepted');
});

// M1: purchase return reduces stock + payable; over-cap rejected; void blocked.
test('M1 purchase return reduce_payable flow', async () => {
  const api = await freshApi();
  const sup = (await api.suppliers.create({ name: 'S1' })).data;
  const prd = (await api.products.create({
    name: 'PM1', defaultCostMinor: 2000, defaultPriceMinor: 3500,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'M', color: 'Blue', costMinor: 2000, priceMinor: 3500,
  })).data;
  const pur = (await api.purchases.create({
    supplierId: sup.id, supplierName: 'S1',
    lines: [{ variantId: v.id, qty: 10, unitCostMinor: 2000 }],
    payments: [],
  })).data;
  assert.strictEqual(pur.dueMinor, 20000);
  assert.strictEqual(pur.status, 'unpaid');
  let got = (await api.variants.get(v.id)).data;
  assert.strictEqual(got.quantity, 10);

  const ret = (await api.purchaseReturns.create({
    purchaseId: pur.id,
    lines: [{ purchaseLineIndex: 0, qty: 3 }],
    mode: 'reduce_payable',
    reason: 'تالف',
  })).data;
  assert.strictEqual(ret.totalMinor, 6000);
  got = (await api.variants.get(v.id)).data;
  assert.strictEqual(got.quantity, 7, 'stock decreased');
  const pur2 = (await api.purchases.get(pur.id)).data;
  assert.strictEqual(pur2.dueMinor, 14000, 'payable reduced');
  assert.strictEqual(pur2.lines[0].returnedQty, 3);

  const over = await api.purchaseReturns.create({
    purchaseId: pur.id, lines: [{ purchaseLineIndex: 0, qty: 8 }],
    mode: 'reduce_payable',
  });
  assert.strictEqual(over.ok, false, 'cannot return more than remaining');

  const voidBlocked = await api.purchases.void(pur.id);
  assert.strictEqual(voidBlocked.ok, false, 'void blocked while returns exist');
  assert.strictEqual(voidBlocked.error.code, 'HAS_RETURNS');
});

// M1b: cash_refund returns cash to the account.
test('M1 purchase return cash_refund restores cash', async () => {
  const api = await freshApi();
  const acc = (await api.accounts.create({ name: 'CashT', type: 'cash' })).data;
  const sup = (await api.suppliers.create({ name: 'S2' })).data;
  const prd = (await api.products.create({
    name: 'PM2', defaultCostMinor: 1000, defaultPriceMinor: 2000,
  })).data;
  const v = (await api.variants.create({
    productId: prd.id, size: 'L', color: 'W', costMinor: 1000, priceMinor: 2000,
  })).data;
  const pur = (await api.purchases.create({
    supplierId: sup.id, supplierName: 'S2',
    lines: [{ variantId: v.id, qty: 5, unitCostMinor: 1000 }],
    payments: [{ method: 'cash', accountId: acc.id, amountMinor: 5000 }],
  })).data;
  assert.strictEqual(pur.status, 'paid');
  const ret = (await api.purchaseReturns.create({
    purchaseId: pur.id,
    lines: [{ purchaseLineIndex: 0, qty: 2 }],
    mode: 'cash_refund', method: 'cash', accountId: acc.id,
  })).data;
  assert.strictEqual(ret.totalMinor, 2000);
  const bal = (await api.accounts.balance(acc.id)).data;
  assert.strictEqual(bal, -3000, 'paid 5000 out, 2000 refunded back');
  const ledger = (await api.accounts.ledger(acc.id)).data;
  assert.ok(ledger.some(m => m.type === 'purchase_return_refund' && m.amountMinor === 2000));
});
