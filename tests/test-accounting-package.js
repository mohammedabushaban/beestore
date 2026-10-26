const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
['settings', 'auth', 'clockGuard', 'audit', 'accounts', 'categories', 'products', 'variants', 'stock',
 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers', 'expenses',
 'payroll', 'employees', 'transactions', 'periods', 'dailyClosing', 'reports', 'dashboard',
 'backupFile', 'backup', 'maintenance', 'zip', 'xlsx', 'monthReviewPdf', 'cloudTarget',
 'accountingPackage'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

const MONTH = '2026-11';
const DUMMY_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0x25, 0x45, 0x4F, 0x46]);

function fresh() {
  BeeStore.dates.setClock(() => '2026-11-30');
  const repo = new MemoryRepository();
  return repo.open().then(() => {
    BeeStore.auth = new BeeStore.AuthService(repo);
    BeeStore.clockGuard = new BeeStore.ClockGuardService(repo);
    return new Api(repo);
  });
}

async function unlockOwner(api) {
  await api.security.setPin('owner', '1234');
  await BeeStore.auth.init();
  const res = await api.security.unlock('owner', '1234');
  assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
}

/**
 * A month with tax, a cash sale, a credit sale, a cash return, a customer
 * collection, an unpaid purchase, a cash expense whose description starts
 * with "=" (CSV formula-injection check), a draft salary and two closed days
 * with deliberate shortages.
 */
async function seed(api) {
  const cash = (await api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: 100000,
  })).data;
  const bank = (await api.accounts.create({ name: 'البنك', type: 'bank' })).data;
  await api.settings.save({
    storeNameAr: 'متجر النور',
    systemStartDate: '2026-11-01',
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    taxEnabled: true,
    taxRate: 10,
    taxIncludedInPrices: false,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: cash.id },
      { id: 'card', name: 'بطاقة', accountId: bank.id },
    ],
  });
  const product = (await api.products.create({
    name: 'قميص أطفال', defaultCostMinor: 1000, defaultPriceMinor: 5000,
  })).data;
  const variant = (await api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق',
    quantity: 100, costMinor: 1000, priceMinor: 5000, date: '2026-11-01',
  })).data;
  const customerA = (await api.customers.create({ name: 'زبون أ', phone: '0599000001' })).data;
  const customerB = (await api.customers.create({
    name: 'زبون ب', phone: '0599000002', openingBalanceMinor: 5000,
  })).data;
  const supplier = (await api.suppliers.create({ name: 'مورد النسيج' })).data;

  // Cash sale: 2 × 50.00 + 10% tax = 110.00.
  const cashSale = (await api.sales.create({
    date: '2026-11-05',
    lines: [{ variantId: variant.id, qty: 2, unitPriceMinor: 5000 }],
    payments: [{ method: 'cash', accountId: cash.id, amountMinor: 11000, date: '2026-11-05' }],
  })).data;
  // Credit sale: 3 × 50.00 + tax = 165.00, no payment.
  const creditSale = (await api.sales.create({
    date: '2026-11-20',
    customerId: customerA.id,
    lines: [{ variantId: variant.id, qty: 3, unitPriceMinor: 5000 }],
    payments: [],
  })).data;
  const ret = (await api.returns.create({
    saleId: cashSale.id, date: '2026-11-20',
    lines: [{ saleLineIndex: 0, qty: 1 }],
    refundMode: 'cash_refund', refundMethod: cash.id,
  })).data;
  await api.customers.receivePayment({
    customerId: customerA.id, date: '2026-11-20', amountMinor: 2000,
    method: 'cash', accountId: cash.id,
  });
  await api.purchases.create({
    date: '2026-11-20', supplierId: supplier.id,
    lines: [{ variantId: variant.id, qty: 10, unitCostMinor: 1000 }],
    payments: [],
  });
  await api.expenses.create({
    date: '2026-11-20', categoryName: 'إيجار', amountMinor: 2000,
    method: 'cash', accountId: cash.id, description: '=SUM(A1:A2)',
  });
  const employee = (await api.employees.create({
    name: 'سارة', baseSalaryMinor: 100000,
  })).data;
  await api.payroll.prepare(MONTH);

  // Close two days with known shortages (5.00 and 3.00).
  const preview5 = (await api.dailyClosings.preview('2026-11-05')).data;
  const close5 = (await api.dailyClosings.close({
    date: '2026-11-05', countedCashMinor: preview5.expectedCashMinor - 500,
  })).data;
  const preview20 = (await api.dailyClosings.preview('2026-11-20')).data;
  const close20 = (await api.dailyClosings.close({
    date: '2026-11-20', countedCashMinor: preview20.expectedCashMinor - 300,
  })).data;

  return {
    cash, bank, product, variant, customerA, customerB, supplier, employee,
    cashSale, creditSale, ret, close5, close20,
  };
}

function findEntry(entries, name) {
  return entries.find(e => e.name === name);
}

function decode(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

test('sha256 is the standard SHA-256 (empty, abc, long input)', () => {
  assert.strictEqual(BeeStore.sha256Hex(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(BeeStore.sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(BeeStore.sha256Hex('a'.repeat(1000)),
    '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
});

test('accountant package: contents, checksums, BOM CSV, watermark status and all cross-checks', async () => {
  const api = await fresh();
  try {
    await unlockOwner(api);
    const base = await seed(api);
    const built = await api.accountingPackage.build(MONTH, {
      pdfBytes: DUMMY_PDF,
      generatedAt: '2026-12-01T09:00:00.000Z',
    });
    assert.strictEqual(built.ok, true, built.ok ? '' : built.error.message);
    const pkg = built.data;

    assert.strictEqual(pkg.filename, 'BeeStore-2026-11-Accountant-Package.zip');
    assert.strictEqual(pkg.status, 'open');
    assert.strictEqual(pkg.closed, false);
    assert.ok(pkg.bytes instanceof Uint8Array && pkg.bytes.length > 1000);

    const entries = BeeStore.zip.readEntries(pkg.bytes);
    const names = entries.map(e => e.name);
    assert.ok(names.includes('00-README.txt'));
    assert.ok(names.includes('01-Month-Review.pdf'));
    assert.ok(names.includes('accounting.xlsx'));
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('csv/01-summary-pl.csv'));
    assert.ok(names.includes('csv/18-integrity-check.csv'));

    const readme = decode(findEntry(entries, '00-README.txt').data);
    assert.match(readme, /بي ستور/);
    assert.match(readme, /BeeStore/);
    assert.match(readme, /غير نهائي/);
    assert.match(readme, /الشهر مفتوح/);
    assert.match(readme, /SHA-256/);
    assert.match(readme, /الحزمة للقراءة فقط/);

    // The PDF alone is the owner-safe month review PDF.
    assert.deepStrictEqual(Array.from(findEntry(entries, '01-Month-Review.pdf').data),
      Array.from(DUMMY_PDF));

    // accounting.xlsx is a real ZIP with 18 sheets and inline-string cells.
    const xlsxEntries = BeeStore.zip.readEntries(findEntry(entries, 'accounting.xlsx').data);
    const sheetFiles = xlsxEntries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
    assert.strictEqual(sheetFiles.length, 18, '18 accounting sheets');
    const workbook = decode(findEntry(xlsxEntries, 'xl/workbook.xml').data);
    assert.match(workbook, /Summary-PL/);
    assert.match(workbook, /Sales Journal/);
    assert.match(workbook, /Sales Lines/);
    assert.match(workbook, /Cash Book/);
    assert.match(workbook, /Daily Closings/);
    assert.match(workbook, /Integrity Check/);

    // Every CSV begins with the UTF-8 BOM.
    for (const entry of entries.filter(e => e.name.startsWith('csv/'))) {
      const b = entry.data;
      assert.ok(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF,
        'BOM missing in ' + entry.name);
    }

    // Formula-injection prefix is neutralised, Arabic is intact.
    const expensesCsv = decode(findEntry(entries, 'csv/06-expenses.csv').data);
    assert.ok(expensesCsv.includes("'=SUM(A1:A2)"), 'leading = must be escaped');
    assert.match(expensesCsv, /إيجار/);

    // Manifest lists every file except itself with a valid SHA-256.
    const manifest = JSON.parse(decode(findEntry(entries, 'manifest.json').data));
    assert.strictEqual(manifest.status, 'open');
    assert.match(manifest.statusLabel, /غير نهائي/);
    assert.strictEqual(manifest.month, MONTH);
    assert.strictEqual(manifest.storeName, 'متجر النور');
    assert.strictEqual(manifest.currency.code, 'ILS');
    assert.strictEqual(manifest.schemaVersion, 3);
    assert.strictEqual(manifest.files.length, entries.length - 1);
    for (const file of manifest.files) {
      const entry = findEntry(entries, file.path);
      assert.ok(entry, 'missing manifest file entry ' + file.path);
      assert.strictEqual(entry.data.length, file.bytes, 'size ' + file.path);
      assert.strictEqual(BeeStore.sha256Hex(entry.data), file.sha256, 'checksum ' + file.path);
    }

    // All §8.1 cross-checks pass on cleanly seeded data.
    assert.ok(Array.isArray(manifest.checks));
    assert.ok(manifest.checks.length >= 10);
    for (const check of manifest.checks) {
      assert.strictEqual(check.ok, true,
        check.id + ' failed: expected ' + check.expected + ', actual ' + check.actual);
    }
    const checkIds = manifest.checks.map(c => c.id);
    for (const id of ['pnl_sheet_equals_month_review', 'sales_journal_matches_net_sales',
      'cash_book_closing_matches_cash_balance', 'inventory_valuation_matches_snapshot',
      'daily_closing_differences_match_pnl', 'manifest_checksums_verify']) {
      assert.ok(checkIds.includes(id), 'missing check ' + id);
    }
    assert.strictEqual(manifest.totals.cashDifference, -800);
    assert.strictEqual(manifest.totals.netSales, 20000);

    // The open month is visible in the P&L sheet too.
    const summaryXml = decode(findEntry(xlsxEntries, 'xl/worksheets/sheet1.xml').data);
    assert.match(summaryXml, /غير نهائي/);

    // The PDF alone is available with its own filename.
    const pdf = await api.accountingPackage.pdf(MONTH, { pdfBytes: DUMMY_PDF });
    assert.strictEqual(pdf.ok, true, pdf.ok ? '' : pdf.error.message);
    assert.strictEqual(pdf.data.filename, 'BeeStore-2026-11-Month-Review.pdf');
    assert.strictEqual(pdf.data.status, 'open');
    assert.ok(pdf.data.blob.type.includes('pdf'));

    // Closing the month makes a final package.
    const closed = await api.periods.close(MONTH, 'اختبار الحزمة');
    assert.strictEqual(closed.ok, true, closed.ok ? '' : closed.error.message);
    const finalBuilt = await api.accountingPackage.build(MONTH, {
      pdfBytes: DUMMY_PDF,
      generatedAt: '2026-12-01T10:00:00.000Z',
    });
    assert.strictEqual(finalBuilt.ok, true, finalBuilt.ok ? '' : finalBuilt.error.message);
    const finalPkg = finalBuilt.data;
    assert.strictEqual(finalPkg.status, 'closed');
    const finalEntries = BeeStore.zip.readEntries(finalPkg.bytes);
    const finalManifest = JSON.parse(decode(findEntry(finalEntries, 'manifest.json').data));
    assert.strictEqual(finalManifest.status, 'closed');
    const finalReadme = decode(findEntry(finalEntries, '00-README.txt').data);
    assert.match(finalReadme, /الحالة \/ Status: شهر مُقفل/);
    assert.doesNotMatch(finalReadme, /الحالة \/ Status: غير نهائي/);
    for (const check of finalManifest.checks) {
      assert.strictEqual(check.ok, true, check.id + ' failed after closing');
    }
    const info = await api.accountingPackage.info(MONTH);
    assert.strictEqual(info.ok, true);
    assert.strictEqual(info.data.status, 'closed');
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('accountant package: share sheet, download fallback and cashier denial', async () => {
  const api = await fresh();
  try {
    await unlockOwner(api);
    await seed(api);

    const clicks = [];
    const shareCalls = [];
    const doc = {
      createElement: function () {
        return {
          set href(value) { this._href = value; },
          set download(value) { this._download = value; },
          click: function () { clicks.push(this._download); },
          remove: function () {},
        };
      },
      body: { appendChild: function () {}, removeChild: function () {} },
    };
    const env = {
      navigator: {
        canShare: function () { return false; },
        share: async function () { throw new Error('should not be called'); },
      },
      document: doc,
      URL: { createObjectURL: function () { return 'blob:test'; }, revokeObjectURL: function () {} },
      File: global.File,
    };
    const downloaded = await api.accountingPackage.share(MONTH, { pdfBytes: DUMMY_PDF, env });
    assert.strictEqual(downloaded.ok, true, downloaded.ok ? '' : downloaded.error.message);
    assert.strictEqual(downloaded.data.method, 'download');
    assert.strictEqual(downloaded.data.filename, 'BeeStore-2026-11-Accountant-Package.zip');
    assert.deepStrictEqual(clicks, ['BeeStore-2026-11-Accountant-Package.zip']);

    const shareEnv = {
      navigator: {
        canShare: function () { return true; },
        share: async function (payload) {
          shareCalls.push(payload);
        },
      },
      document: doc,
      URL: { createObjectURL: function () { return 'blob:test'; }, revokeObjectURL: function () {} },
      File: global.File,
    };
    const shared = await api.accountingPackage.sharePdf(MONTH, { pdfBytes: DUMMY_PDF, env: shareEnv });
    assert.strictEqual(shared.ok, true, shared.ok ? '' : shared.error.message);
    assert.strictEqual(shared.data.method, 'share');
    assert.strictEqual(shareCalls.length, 1);
    assert.strictEqual(shareCalls[0].files[0].name, 'BeeStore-2026-11-Month-Review.pdf');
    assert.ok(shareCalls[0].files[0].type.includes('pdf'));

    // Owner-only in the central facade.
    await api.security.setPin('cashier', '5678');
    await BeeStore.auth.init();
    const locked = await api.security.unlock('cashier', '5678');
    assert.strictEqual(locked.ok, true, locked.ok ? '' : locked.error.message);
    const denied = await api.accountingPackage.build(MONTH, { pdfBytes: DUMMY_PDF });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'PERMISSION');
  } finally {
    BeeStore.dates.resetClock();
  }
});
