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
  'suppliers', 'expenses', 'employees', 'payroll', 'fixedAssets', 'transactions',
  'periods', 'chartOfAccounts', 'journal', 'posting', 'journalIntegrity', 'yearEnd', 'auditReview', 'dailyClosing', 'reports',
  'dashboard', 'backup', 'maintenance', 'settlements', 'zip', 'xlsx', 'monthReviewPdf',
  'accountingPackage'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function useClock(date) { BeeStore.dates.setClock(() => date); }

test.afterEach(() => BeeStore.dates.resetClock());

function ok(res, label) {
  assert.strictEqual(res.ok, true,
    (label ? label + ': ' : '') + (res.ok ? '' : res.error.message));
  return res.data;
}

async function freshApi(clock, options) {
  useClock(clock || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: (options && options.systemStartDate) || '2026-10-01',
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
  ok(await api.settings.save({
    systemStartDate: o.systemStartDate || '2026-10-01',
    blockFutureDates: true,
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', accountId: bank.id },
    ],
  }), 'settings with accounts');
  return { cash, bank };
}

// ---------------------------------------------------------------------------
// v5 A6: journal integrity checker, invariant (property) tests, performance.
// ---------------------------------------------------------------------------

async function sysAccount(repo, key) {
  return (await repo.list('chartOfAccounts')).find(a => a.systemKey === key);
}

async function journalCheck(repo) {
  return new BeeStore.JournalIntegrityService(repo).check();
}

async function shop(clock) {
  const { repo, api } = await freshApi(clock || '2026-10-31');
  const acc = await moneyAccounts(api, { cash: 500000 });
  ok(await api.settings.save({
    systemStartDate: '2026-10-01', blockFutureDates: true,
    cashDrawerAccountId: acc.cash.id, defaultBankAccountId: acc.bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', kind: 'cash', accountId: acc.cash.id },
      { id: 'card', name: 'بطاقة', kind: 'clearing', accountId: acc.bank.id },
      { id: 'bank', name: 'تحويل بنكي', kind: 'bank_direct', accountId: acc.bank.id },
    ],
  }), 'settings');
  const customer = ok(await api.customers.create({ name: 'زبون', phone: '0599000000', openingBalanceMinor: 3000 }), 'customer');
  const supplier = ok(await api.suppliers.create({ name: 'مورد', openingBalanceMinor: 4000 }), 'supplier');
  const product = ok(await api.products.create({ name: 'قميص', defaultCostMinor: 400, defaultPriceMinor: 1000 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'x', quantity: 200, costMinor: 400, priceMinor: 1000, date: '2026-10-01',
  }), 'variant');
  return { repo, api, acc, customer, supplier, variant };
}

test('A6: a realistic month passes every journal integrity check', async () => {
  const { repo, api, acc, customer, supplier, variant } = await shop();
  const line = (qty, price) => ({ variantId: variant.id, qty, unitPriceMinor: price || 1000 });
  const cashSale = ok(await api.sales.create({ date: '2026-10-02', lines: [line(3)], payments: [{ method: 'cash', amountMinor: 5000 }], overpaymentMode: 'change' }), 'cash sale');
  ok(await api.sales.create({ date: '2026-10-03', customerId: customer.id, lines: [line(5)], discount: { type: 'percent', value: 10 }, payments: [{ method: 'card', amountMinor: 2000 }] }), 'credit sale');
  const voided = ok(await api.sales.create({ date: '2026-10-04', lines: [line(1)], payments: [{ method: 'cash', amountMinor: 1000 }] }), 'to void');
  ok(await api.sales.void(voided.id, 'خطأ'), 'void sale');
  ok(await api.returns.create({ saleId: cashSale.id, date: '2026-10-05', lines: [{ saleLineIndex: 0, qty: 1 }], refundMode: 'cash_refund', refundMethod: acc.cash.id }), 'cash return');
  ok(await api.customers.receivePayment({ customerId: customer.id, amountMinor: 9000, method: 'cash', date: '2026-10-06' }), 'collection with excess');
  const purchase = ok(await api.purchases.create({ date: '2026-10-07', supplierId: supplier.id, lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 450 }], payments: [{ method: 'cash', amountMinor: 2000 }] }), 'purchase');
  ok(await api.purchaseReturns.create({ purchaseId: purchase.id, date: '2026-10-08', lines: [{ purchaseLineIndex: 0, qty: 2 }], mode: 'reduce_payable' }), 'purchase return');
  ok(await api.suppliers.pay({ supplierId: supplier.id, amountMinor: 1500, method: 'cash', date: '2026-10-09' }), 'supplier payment');
  const unpaid = ok(await api.expenses.create({ date: '2026-10-10', amountMinor: 12000, categoryName: 'صيانة', paymentStatus: 'partial', paidMinor: 5000, method: 'cash' }), 'partial expense');
  ok(await api.expenses.pay(unpaid.id, { date: '2026-10-12', amountMinor: 7000, method: 'cash' }), 'pay expense');
  ok(await api.transactions.transfer({ date: '2026-10-13', fromAccountId: acc.cash.id, toAccountId: acc.bank.id, amountMinor: 10000 }), 'transfer');
  ok(await api.transactions.ownerTransaction({ date: '2026-10-14', type: 'capital_in', amountMinor: 20000, accountId: acc.bank.id }), 'capital');
  ok(await api.settlements.create({ method: 'card', date: '2026-10-15', bankAccountId: acc.bank.id, grossMinor: 2000, feeMinor: 50, netReceivedMinor: 1950 }), 'card settlement');

  const result = await journalCheck(repo);
  assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors, null, 1));
  assert.deepStrictEqual(result.skipped, []);
  assert.ok(result.checked.documents >= 13, 'documents checked: ' + result.checked.documents);
  assert.strictEqual(result.checked.parties, 2);

  const integrity = ok(await api.maintenance.integrityCheck(), 'integrity');
  assert.strictEqual(integrity.checks, 17);
  assert.deepStrictEqual(integrity.errors, [], JSON.stringify(integrity.errors, null, 1));
});

test('A6: the checker detects tampering, orphans, missing parties and negative cash', async () => {
  const { repo, api, acc, customer, variant } = await shop();
  const sale = ok(await api.sales.create({ date: '2026-10-02', customerId: customer.id, lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }] }), 'credit sale');
  const other = ok(await api.sales.create({ date: '2026-10-02', lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }], payments: [{ method: 'cash', amountMinor: 1000 }] }), 'cash sale');
  assert.deepStrictEqual((await journalCheck(repo)).errors, []);

  // A document marked void behind the journal's back keeps live entries.
  const raw = repo.data.sales.get(other.id);
  raw.status = 'void';
  // A deleted document leaves its entries orphaned.
  repo.data.sales.delete(sale.id);
  repo.indexes.sales = {};
  // A receivable with no customer breaks control account = sub-ledger.
  await BeeStore.journal.append({
    date: '2026-10-03', sourceType: 'MANUAL', description: 'ذمة بلا طرف',
    lines: [{ accountId: (await sysAccount(repo, 'ar')).id, debitMinor: 700 },
      { accountId: (await sysAccount(repo, 'other_income')).id, creditMinor: 700 }],
  });
  // Cash paid out beyond the drawer balance.
  await BeeStore.journal.append({
    date: '2026-10-04', sourceType: 'MANUAL', description: 'سحب يتجاوز الرصيد',
    lines: [{ accountId: (await sysAccount(repo, 'drawings')).id, debitMinor: 10000000 },
      { accountId: (await sysAccount(repo, 'cash')).id, creditMinor: 10000000 }],
  });
  const result = await journalCheck(repo);
  const codes = new Set(result.errors.map(e => e.check));
  for (const code of ['document-journal', 'orphan-entry', 'control-subledger', 'negative-cash']) {
    assert.ok(codes.has(code), 'expected ' + code + ' in ' + JSON.stringify([...codes]));
  }
});

test('A6: customer and supplier statements must agree with the journal', async () => {
  const { repo, customer } = await shop();
  assert.deepStrictEqual((await journalCheck(repo)).errors, []);
  // Editing the stored opening balance without posting its correction.
  repo.data.customers.get(customer.id).openingBalanceMinor = 9999;
  const result = await journalCheck(repo);
  assert.ok(result.errors.some(e => e.check === 'customer-subledger'), JSON.stringify(result.errors));
});

// Deterministic PRNG so a failing seed can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1, 7, 42]) {
  test('A6 property: random operations keep every accounting invariant (seed ' + seed + ')', async () => {
    const { repo, api, acc, customer, supplier, variant } = await shop('2026-11-30');
    const rand = rng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const amount = (lo, hi) => lo + Math.floor(rand() * (hi - lo));
    const sales = [];
    const purchases = [];
    let done = 0;
    for (let i = 0; i < 80; i++) {
      const day = String(1 + Math.floor(i / 3)).padStart(2, '0');
      const date = (i < 40 ? '2026-10-' : '2026-11-') + String(1 + (i % 28)).padStart(2, '0');
      void day;
      const op = pick(['sale', 'sale', 'sale', 'credit', 'return', 'collect', 'purchase', 'preturn', 'spay', 'expense', 'void']);
      let res = null;
      if (op === 'sale') {
        const qty = amount(1, 4);
        const price = amount(500, 3000);
        const total = qty * price;
        const tender = rand() < 0.5
          ? [{ method: 'cash', amountMinor: total + amount(0, 2000) }]
          : [{ method: 'cash', amountMinor: Math.floor(total / 2) + amount(0, 1500) }, { method: 'card', amountMinor: total - Math.floor(total / 2) }];
        res = await api.sales.create({
          date, lines: [{ variantId: variant.id, qty, unitPriceMinor: price }],
          discount: rand() < 0.3 ? { type: 'percent', value: amount(1, 20) } : null,
          payments: tender, overpaymentMode: 'change',
        });
        if (res.ok) sales.push(res.data);
      } else if (op === 'credit') {
        res = await api.sales.create({
          date, customerId: customer.id,
          lines: [{ variantId: variant.id, qty: amount(1, 3), unitPriceMinor: amount(500, 2000) }],
          payments: rand() < 0.5 ? [{ method: 'cash', amountMinor: amount(100, 800) }] : [],
        });
        if (res.ok) sales.push(res.data);
      } else if (op === 'return' && sales.length) {
        const s = pick(sales);
        const fresh = ok(await api.sales.get(s.id), 'sale');
        const lineIndex = 0;
        const left = fresh.lines[lineIndex].qty - (fresh.lines[lineIndex].returnedQty || 0);
        if (fresh.status !== 'void' && left > 0 && date >= fresh.date) {
          res = await api.returns.create({
            saleId: s.id, date, lines: [{ saleLineIndex: lineIndex, qty: amount(1, left + 1), restock: rand() < 0.8 }],
            refundMode: s.customerId && rand() < 0.5 ? 'customer_credit' : 'cash_refund',
            refundMethod: acc.cash.id,
          });
        }
      } else if (op === 'collect') {
        res = await api.customers.receivePayment({ customerId: customer.id, amountMinor: amount(100, 3000), method: pick(['cash', 'bank']), date });
      } else if (op === 'purchase') {
        res = await api.purchases.create({
          date, supplierId: supplier.id, lines: [{ variantId: variant.id, qty: amount(1, 10), unitCostMinor: amount(300, 600) }],
          payments: rand() < 0.5 ? [{ method: 'cash', amountMinor: amount(100, 1000) }] : [],
        });
        if (res.ok) purchases.push(res.data);
      } else if (op === 'preturn' && purchases.length) {
        const p = pick(purchases);
        if (date >= p.date) {
          res = await api.purchaseReturns.create({ purchaseId: p.id, date, lines: [{ purchaseLineIndex: 0, qty: 1 }], mode: 'reduce_payable' });
        }
      } else if (op === 'spay') {
        res = await api.suppliers.pay({ supplierId: supplier.id, amountMinor: amount(100, 2000), method: 'cash', date });
      } else if (op === 'expense') {
        res = await api.expenses.create({ date, amountMinor: amount(100, 5000), categoryName: pick(['كهرباء', 'إيجار', 'صيانة']), method: 'cash' });
      } else if (op === 'void' && sales.length) {
        const s = pick(sales);
        res = await api.sales.void(s.id, 'اختبار');
      }
      if (res && res.ok) done++;
    }
    assert.ok(done >= 40, 'enough operations succeeded: ' + done);

    // Invariant 1: every entry, month and the whole journal balance.
    const verify = await BeeStore.journal.verify();
    assert.deepStrictEqual(verify.errors, []);
    // Invariant 2: all A6 checks (sub-ledgers, document links, orphans, cash).
    const result = await journalCheck(repo);
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors, null, 1));
    // Invariant 3: inventory control account = Σ tracked variant value.
    const tb = await BeeStore.journal.trialBalance({ asOf: '2026-11-30' });
    const bal = (code) => (tb.accounts.find(a => a.code === code) || {}).balanceMinor || 0;
    const variants = await repo.list('variants');
    const tracked = variants.reduce((sum, v) => sum + BeeStore.stock.ensureValue(v), 0);
    assert.strictEqual(bal('1200'), tracked, 'inventory 1200 = Σ variant value');
    // Invariant 4: the journal balance sheet balances at each month end and
    // the profit⇄cash reconciliation explains every month's cash change.
    for (const asOf of ['2026-10-31', '2026-11-30']) {
      const snap = await BeeStore.reports._journalBalanceSnapshot(asOf);
      assert.strictEqual(snap.balanced, true, 'balance sheet ' + asOf);
      assert.strictEqual(snap.assets.total, snap.liabilities.total + snap.equity.total);
    }
    // Invariant 5: documents and journal agree (the cut-over parity report).
    const parity = ok(await api.reports.parityReport({ from: '2026-10-01', to: '2026-11-30' }), 'parity');
    assert.deepStrictEqual(parity.failures, [], JSON.stringify(parity.failures, null, 1));
    for (const month of ['2026-10', '2026-11']) {
      const rec = ok(await api.reports.profitCashReconciliation(month), 'recon');
      assert.strictEqual(rec.matches, true, month + ': ' + rec.cashChange + ' vs ' + rec.actualCashChange);
    }
  });
}

// v5 §13 A6: 50,000-invoice performance test. The default run uses 3,000
// invoices to keep the suite fast; BEESTORE_PERF=50000 runs the full size.
test('A6 performance: invoice posting, verify and integrity scale linearly', { timeout: 30 * 60 * 1000 }, async () => {
  const total = Math.max(1000, Number(process.env.BEESTORE_PERF) || 3000);
  const { repo, api } = await freshApi('2026-12-31');
  await moneyAccounts(api, { cash: 100000 });
  const product = ok(await api.products.create({ name: 'p', defaultCostMinor: 400, defaultPriceMinor: 1000 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'x', quantity: total + 10, costMinor: 400, priceMinor: 1000, date: '2026-10-01',
  }), 'variant');
  const timings = [];
  const half = Math.floor(total / 2);
  let started = Date.now();
  for (let i = 0; i < total; i++) {
    if (i === half) { timings.push(Date.now() - started); started = Date.now(); }
    const month = ['10', '11', '12'][i % 3];
    const res = await api.sales.create({
      date: '2026-' + month + '-' + String(1 + (i % 28)).padStart(2, '0'),
      lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1000 }],
      payments: [{ method: 'cash', amountMinor: 1000 }],
    });
    assert.strictEqual(res.ok, true);
  }
  timings.push(Date.now() - started);
  // The second half must not be dramatically slower than the first: a
  // quadratic store made it ~3× slower at 2,000 invoices.
  assert.ok(timings[1] < timings[0] * 2 + 500,
    'posting slows down with size: first half ' + timings[0] + 'ms, second half ' + timings[1] + 'ms');

  let t = Date.now();
  const verify = await BeeStore.journal.verify();
  const verifyMs = Date.now() - t;
  assert.strictEqual(verify.ok, true);
  assert.strictEqual(verify.checked.entries, total * 3 + 2, 'revenue + receipt + cost per invoice, plus opening cash and stock');
  t = Date.now();
  const result = await journalCheck(repo);
  const checkMs = Date.now() - t;
  assert.deepStrictEqual(result.errors, []);
  t = Date.now();
  const tb = await BeeStore.journal.trialBalance({ asOf: '2026-12-31' });
  const tbMs = Date.now() - t;
  assert.strictEqual(tb.balanced, true);
  // Generous budgets per 1,000 invoices for slow CI machines.
  const per1k = (ms) => ms / (total / 1000);
  assert.ok(per1k(verifyMs) < 200, 'verify ' + verifyMs + 'ms');
  assert.ok(per1k(checkMs) < 500, 'integrity ' + checkMs + 'ms');
  assert.ok(per1k(tbMs) < 200, 'trial balance ' + tbMs + 'ms');
  console.log('# perf ' + total + ' invoices: post ' + (timings[0] + timings[1]) + 'ms, verify ' +
    verifyMs + 'ms, integrity ' + checkMs + 'ms, trial balance ' + tbMs + 'ms');
});

// ---------------------------------------------------------------------------
// Fiscal year-end closing and retained earnings.
// ---------------------------------------------------------------------------

test('year-end close moves the result to 3040, zeroes P&L and keeps reports intact', async () => {
  useClock('2026-01-15');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({ systemStartDate: '2025-11-01', blockFutureDates: true }), 'settings');
  await BeeStore.chart.ensureSeeded();
  const cash = ok(await api.accounts.create({ name: 'الصندوق', type: 'cash', openingBalanceMinor: 100000 }), 'cash');
  ok(await api.settings.save({
    systemStartDate: '2025-11-01', blockFutureDates: true, cashDrawerAccountId: cash.id,
    paymentMethods: [{ id: 'cash', name: 'نقداً', kind: 'cash', accountId: cash.id }],
  }), 'settings 2');
  const product = ok(await api.products.create({ name: 'p', defaultCostMinor: 400, defaultPriceMinor: 1000 }), 'product');
  const variant = ok(await api.variants.create({
    productId: product.id, size: 'M', color: 'x', quantity: 50, costMinor: 400, priceMinor: 1000, date: '2025-11-01',
  }), 'variant');
  const sell = (date, qty) => api.sales.create({
    date, lines: [{ variantId: variant.id, qty, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: qty * 1000 }],
  });
  ok(await sell('2025-11-10', 3), 'nov sale');
  ok(await sell('2025-12-10', 2), 'dec sale');
  ok(await api.expenses.create({ date: '2025-12-15', amountMinor: 700, categoryName: 'كهرباء', method: 'cash' }), 'expense');
  ok(await sell('2026-01-05', 1), 'jan sale');
  // 2025 result: sales 5,000 − COGS 2,000 − electricity 700 = 2,300.

  const early = ok(await api.yearEnd.preview('2025'), 'preview');
  assert.strictEqual(early.canClose, false, 'months still open');
  assert.strictEqual(early.netProfitMinor, 2300);
  assert.strictEqual((await api.yearEnd.preview('2026')).data.canClose, false, 'year not over');

  ok(await api.periods.close('2025-11'), 'close nov');
  ok(await api.periods.close('2025-12'), 'close dec');
  const entry = ok(await api.yearEnd.close('2025'), 'close year');
  assert.strictEqual(entry.date, '2025-12-31');

  const tb = await BeeStore.journal.trialBalance({ asOf: '2025-12-31' });
  assert.strictEqual(tb.balanced, true);
  for (const a of tb.accounts) {
    if (a.type === 'revenue' || a.type === 'expense') {
      assert.strictEqual(a.balanceMinor, 0, a.code + ' closed to zero');
    }
  }
  assert.strictEqual(tb.accounts.find(a => a.code === '3040').balanceMinor, -2300);

  // Reports still measure the year's performance from the postings.
  const pnl2025 = await BeeStore.reports._journalProfitAndLoss('2025-01-01', '2025-12-31');
  assert.strictEqual(pnl2025.netProfit, 2300);
  const snap = await BeeStore.reports._journalBalanceSnapshot('2026-01-15');
  assert.strictEqual(snap.balanced, true);
  assert.strictEqual(snap.equity.retainedEarnings, 2300);
  assert.strictEqual(snap.equity.currentProfit, 600, 'January: 1,000 − 400');

  // Integrity: closed year is clean; a month inside it cannot be reopened.
  const check = await journalCheck(repo);
  assert.deepStrictEqual(check.errors, [], JSON.stringify(check.errors));
  const reopenMonth = await api.periods.reopen('2025-12');
  assert.strictEqual(reopenMonth.ok, false);
  assert.match(reopenMonth.error.message, /السنة 2025 مقفلة/);
  assert.strictEqual((await api.yearEnd.close('2025')).ok, false, 'no double close');

  // Reopening appends the reversal; P&L balances come back.
  ok(await api.yearEnd.reopen('2025'), 'reopen year');
  const tb2 = await BeeStore.journal.trialBalance({ asOf: '2025-12-31' });
  assert.strictEqual(tb2.accounts.find(a => a.code === '4010').balanceMinor, -5000);
  assert.strictEqual((tb2.accounts.find(a => a.code === '3040') || {}).balanceMinor || 0, 0);
  assert.deepStrictEqual(ok(await api.yearEnd.status(), 'status').map(y => [y.year, y.closed]),
    [['2025', false], ['2026', false]]);
  ok(await api.periods.reopen('2025-12'), 'month reopens once the year is open');
  assert.deepStrictEqual((await BeeStore.journal.verify()).errors, []);
});

// ---------------------------------------------------------------------------
// v4 M4: bad-debt write-off, applying customer credit; review reports.
// ---------------------------------------------------------------------------

test('M4: writing off a receivable posts 6410 and keeps documents and journal in step', async () => {
  const { repo, api, customer, variant } = await shop();
  const sale = ok(await api.sales.create({
    date: '2026-10-05', customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
  }), 'credit sale');
  const tooMuch = await api.customers.writeOff({ customerId: customer.id, saleId: sale.id, amountMinor: 2500, reason: 'x' });
  assert.strictEqual(tooMuch.ok, false, 'cannot write off more than the invoice due');
  assert.strictEqual((await api.customers.writeOff({ customerId: customer.id, saleId: sale.id })).ok, false, 'reason required');
  const w = ok(await api.customers.writeOff({ customerId: customer.id, saleId: sale.id, date: '2026-10-20', reason: 'زبون مفلس' }), 'write-off');
  assert.strictEqual(w.amountMinor, 2000);
  assert.strictEqual(w.accountId, null);
  const after = ok(await api.sales.get(sale.id), 'sale');
  assert.deepStrictEqual([after.dueMinor, after.status], [0, 'paid']);
  const tb = await BeeStore.journal.trialBalance({ asOf: '2026-10-31' });
  assert.strictEqual(tb.accounts.find(a => a.code === '6410').balanceMinor, 2000);
  // Customer balance: opening 3,000 + 2,000 invoice − 2,000 written off.
  assert.strictEqual(ok(await api.customers.balance(customer.id), 'balance'), 3000);
  const pnl = await BeeStore.reports._documentProfitAndLoss('2026-10-01', '2026-10-31', { legacy: true });
  assert.strictEqual(pnl.expensesByCategory['ديون معدومة'], 2000);
  const parity = ok(await api.reports.parityReport({ from: '2026-10-01', to: '2026-10-31' }), 'parity');
  assert.deepStrictEqual(parity.failures, [], JSON.stringify(parity.failures, null, 1));
  assert.deepStrictEqual((await journalCheck(repo)).errors, []);
});

test('applying a customer credit pays open invoices without changing the net balance', async () => {
  const { repo, api, acc, customer, variant } = await shop();
  // Credit from an invoice-linked return kept as customer credit.
  const first = ok(await api.sales.create({
    date: '2026-10-02', customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
    payments: [{ method: 'cash', amountMinor: 2000 }],
  }), 'paid sale');
  ok(await api.returns.create({
    saleId: first.id, date: '2026-10-03', lines: [{ saleLineIndex: 0, qty: 1 }], refundMode: 'customer_credit',
  }), 'credit return');
  const open = ok(await api.sales.create({
    date: '2026-10-04', customerId: customer.id,
    lines: [{ variantId: variant.id, qty: 3, unitPriceMinor: 1000 }],
  }), 'open invoice');
  assert.strictEqual(ok(await api.customers.availableCredit(customer.id), 'credit'), 1000);
  const before = ok(await api.customers.balance(customer.id), 'balance before');
  const res = ok(await api.customers.applyCredit(customer.id, '2026-10-05'), 'apply');
  assert.strictEqual(res.appliedMinor, 1000);
  const sale = ok(await api.sales.get(open.id), 'sale');
  assert.deepStrictEqual([sale.dueMinor, sale.status, sale.creditAppliedMinor], [2000, 'partial', 1000]);
  assert.strictEqual(ok(await api.customers.balance(customer.id), 'balance after'), before);
  assert.strictEqual(ok(await api.customers.availableCredit(customer.id), 'credit after'), 0);
  assert.strictEqual((await api.customers.applyCredit(customer.id, '2026-10-05')).ok, false, 'nothing left');
  assert.deepStrictEqual((await journalCheck(repo)).errors, []);
  // Voiding the invoice gives the credit back.
  ok(await api.sales.void(open.id, 'خطأ'), 'void');
  assert.strictEqual(ok(await api.customers.availableCredit(customer.id), 'credit restored'), 1000);
  assert.deepStrictEqual((await journalCheck(repo)).errors, []);
  void acc;
});

test('historical review quantifies over-refunds, misattributed change and unreversed legacy tax', async () => {
  const { repo, api, variant } = await shop();
  // Simulate data recorded before the fixes: strip the new return fields
  // and move change onto the card payment, as the old code stored them.
  const sale = ok(await api.sales.create({
    date: '2026-10-02', lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 1000 }],
    discount: { type: 'percent', value: 10 }, payments: [{ method: 'cash', amountMinor: 1800 }],
  }), 'discounted sale');
  const ret = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-03', lines: [{ saleLineIndex: 0, qty: 1 }], refundMode: 'cash_refund',
  }), 'return');
  const rawRet = repo.data.salesReturns.get(ret.id);
  for (const l of rawRet.lines) { delete l.invoiceDiscountMinor; delete l.taxMinor; }
  const mixed = ok(await api.sales.create({
    date: '2026-10-04', lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 1200 }],
    payments: [{ method: 'cash', amountMinor: 1000 }, { method: 'card', amountMinor: 500 }], overpaymentMode: 'change',
  }), 'mixed');
  const rawMixed = repo.data.sales.get(mixed.id);
  rawMixed.payments[0].changeMinor = 0;
  rawMixed.payments[1].changeMinor = 300;

  const review = ok(await api.auditReview.historicalErrors(), 'review');
  assert.strictEqual(review.discountReturns.length, 1);
  assert.strictEqual(review.discountReturns[0].overRefundMinor, 100);
  assert.strictEqual(review.mixedChange.length, 1);
  assert.strictEqual(review.mixedChange[0].changeMinor, 300);
  assert.strictEqual(review.totals.findings, 2);
});

test('anomaly report flags duplicates, large discounts, sales below cost and negative stock', async () => {
  const { repo, api, variant } = await shop();
  const mk = (time, price, discount) => api.sales.create({
    date: '2026-10-10', time, lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: price }],
    discount, payments: [{ method: 'cash', amountMinor: 5000 }], overpaymentMode: 'change',
  });
  ok(await mk('10:00', 1000), 'a');
  ok(await mk('10:03', 1000), 'duplicate');
  ok(await mk('12:00', 1000, { type: 'percent', value: 50 }), 'big discount');
  ok(await mk('13:00', 300), 'below cost (cost 400)');
  repo.data.variants.get(variant.id).quantity = -2;
  const a = ok(await api.auditReview.anomalies({ from: '2026-10-01', to: '2026-10-31' }), 'anomalies');
  assert.strictEqual(a.counts.duplicates, 1);
  assert.ok(a.largeDiscounts.some(d => d.discountPercent >= 50));
  assert.strictEqual(a.belowCost.length, 1, 'only the 3.00 sale is below its 4.00 cost');
  assert.strictEqual(a.belowCost[0].lossMinor, 100);
  assert.strictEqual(a.counts.negativeStock, 1);
});
