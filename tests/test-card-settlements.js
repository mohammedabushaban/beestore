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
  'chartOfAccounts', 'journal', 'posting', 'settlements', 'dailyClosing',
  'reports', 'dashboard', 'backup', 'maintenance']
  .forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

function ok(result, label) {
  assert.strictEqual(result.ok, true,
    (label ? label + ': ' : '') + (result.ok ? '' : result.error.message));
  return result.data;
}

async function freshApi(options) {
  const opts = options || {};
  BeeStore.dates.setClock(() => opts.today || '2026-10-31');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  ok(await api.settings.save({
    systemStartDate: '2026-10-01',
    blockFutureDates: true,
  }));
  const cash = ok(await api.accounts.create({ name: 'الصندوق', type: 'cash' }));
  const bank = ok(await api.accounts.create({ name: 'البنك', type: 'bank' }));
  const provider = ok(await api.accounts.create({ name: 'شركة البطاقات', type: 'wallet' }));
  ok(await api.settings.save({
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', kind: 'cash', accountId: cash.id },
      { id: 'bank', name: 'تحويل بنكي', kind: 'bank_direct', accountId: bank.id },
      {
        id: 'card', name: 'بطاقة', kind: 'clearing', accountId: provider.id,
        feeBasisPoints: opts.feeBasisPoints === undefined ? 200 : opts.feeBasisPoints,
        feeFixedMinor: opts.feeFixedMinor || 0,
        settlementDays: 2,
      },
    ],
  }));
  await BeeStore.chart.ensureSeeded();
  const product = ok(await api.products.create({
    name: 'منتج', defaultCostMinor: 30000, defaultPriceMinor: 100000,
    date: '2026-10-01',
    variants: [{
      size: 'M', color: 'R', quantity: 20,
      costMinor: 30000, priceMinor: 100000,
    }],
  }));
  const variant = ok(await api.variants.list()).find(v => v.productId === product.id);
  return { repo, api, cash, bank, provider, product, variant };
}

test.afterEach(() => BeeStore.dates.resetClock());

async function cardSale(api, variant, amountMinor, date) {
  return ok(await api.sales.create({
    date: date || '2026-10-05',
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: amountMinor }],
    payments: [{ method: 'card', amountMinor }],
  }), 'card sale');
}

async function clearingQuote(api, date) {
  return ok(await api.settlements.quote('card', { date: date || '2026-10-31' }), 'quote');
}

async function accountBalance(api, accountId) {
  const tb = ok(await api.journal.trialBalance(), 'trial balance');
  const row = tb.accounts.find(account => account.accountId === accountId);
  return row ? row.balanceMinor : 0;
}

test('A4 card settlement posts exact gross, fee and net and reconciles the sub-ledger', async () => {
  const { api, bank, variant } = await freshApi();
  const sale = await cardSale(api, variant, 100000, '2026-10-05');
  assert.strictEqual(sale.payments[0].methodKind, 'clearing');

  const before = await clearingQuote(api);
  assert.strictEqual(before.unsettledMinor, 100000);
  assert.strictEqual(before.subledgerMinor, 100000);
  assert.strictEqual(before.reconciled, true);
  assert.strictEqual(before.expectedFeeMinor, 2000);
  assert.strictEqual(before.suggestedNetMinor, 98000);
  assert.strictEqual(before.receipts.length, 1);
  assert.strictEqual(before.receipts[0].sourceId, sale.id);
  assert.strictEqual(await accountBalance(api, before.clearingAccountId), 100000);

  const settlement = ok(await api.settlements.create({
    method: 'card', date: '2026-10-07', bankAccountId: bank.id,
    grossMinor: 100000, feeMinor: 2000, netReceivedMinor: 98000,
    reference: 'STATEMENT-1',
  }), 'settlement');
  assert.strictEqual(settlement.expectedFeeMinor, 2000);
  assert.strictEqual(settlement.feeDifferenceMinor, 0);
  assert.strictEqual(settlement.journalEntryIds.length, 1);

  const entries = ok(await api.journal.forSource('CARD_SETTLEMENT', settlement.id));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].lines.reduce((sum, line) => sum + (line.debitMinor || 0), 0), 100000);
  assert.strictEqual(entries[0].lines.reduce((sum, line) => sum + (line.creditMinor || 0), 0), 100000);
  assert.strictEqual(await accountBalance(api, before.clearingAccountId), 0);
  assert.strictEqual(await accountBalance(api, bank.chartAccountId), 98000);
  assert.strictEqual(ok(await api.accounts.balance(bank.id)), 98000);

  const after = await clearingQuote(api);
  assert.strictEqual(after.unsettledMinor, 0);
  assert.strictEqual(after.subledgerMinor, 0);
  assert.strictEqual(after.reconciled, true);
  const overview = ok(await api.settlements.overview('2026-10-31'));
  assert.strictEqual(overview.methods[0].feesMonthMinor, 2000);
  assert.strictEqual(overview.methods[0].effectiveFeeBasisPoints, 200);

  const direct = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31', { legacy: true }));
  const summary = ok(await api.reports.profitAndLoss('2026-10-01', '2026-10-31'));
  const journal = ok(await api.reports.journalProfitAndLoss('2026-10-01', '2026-10-31'));
  assert.strictEqual(direct.cardFees, 2000);
  assert.deepStrictEqual(summary, direct);
  assert.strictEqual(journal.cardFees, 2000);
  assert.strictEqual(journal.netProfit, direct.netProfit);
  const parity = ok(await api.reports.parityReport({ from: '2026-10-01', to: '2026-10-31' }));
  assert.strictEqual(parity.ok, true, JSON.stringify(parity.failures));
});

test('A4 actual fee difference and partial settlements stay visible and exact', async () => {
  const { api, bank, variant } = await freshApi();
  await cardSale(api, variant, 100000, '2026-10-05');
  const quote = ok(await api.settlements.quote('card', {
    date: '2026-10-06', grossMinor: 40000, feeMinor: 950,
  }));
  assert.strictEqual(quote.expectedFeeMinor, 800);
  assert.strictEqual(quote.suggestedNetMinor, 39200);
  assert.strictEqual(quote.feeDifferenceMinor, 150);

  const first = ok(await api.settlements.create({
    method: 'card', date: '2026-10-06', bankAccountId: bank.id,
    grossMinor: 40000, feeMinor: 950, netReceivedMinor: 39050,
  }));
  assert.strictEqual(first.feeDifferenceMinor, 150);
  const partial = await clearingQuote(api);
  assert.strictEqual(partial.unsettledMinor, 60000);
  assert.strictEqual(partial.subledgerMinor, 60000);
  assert.strictEqual(partial.receipts[0].remainingMinor, 60000);

  const second = ok(await api.settlements.create({
    method: 'card', date: '2026-10-07', bankAccountId: bank.id,
    grossMinor: 60000, feeMinor: 1200, netReceivedMinor: 58800,
  }));
  assert.strictEqual(second.feeDifferenceMinor, 0);
  assert.strictEqual((await clearingQuote(api)).unsettledMinor, 0);
  assert.strictEqual(await accountBalance(api, bank.chartAccountId), 97850);

  const overview = ok(await api.settlements.overview('2026-10-31')).methods[0];
  assert.strictEqual(overview.feesMonthMinor, 2150);
  assert.strictEqual(overview.expectedFeesMonthMinor, 2000);
  assert.strictEqual(overview.feeDifferenceMonthMinor, 150);
});

test('A4 same-method refund credits clearing and reduces outstanding receipts before settlement', async () => {
  const { api, variant } = await freshApi();
  const sale = await cardSale(api, variant, 100000, '2026-10-05');
  const ret = ok(await api.returns.create({
    saleId: sale.id, date: '2026-10-06', refundMode: 'cash_refund',
    refundPaymentMethod: 'card',
    lines: [{ saleLineIndex: 0, variantId: variant.id, qty: 1, restock: true }],
  }), 'card refund');
  assert.strictEqual(ret.refundPaymentMethod, 'card');
  assert.strictEqual(ret.refundMethodKind, 'clearing');
  const quote = await clearingQuote(api);
  assert.strictEqual(quote.unsettledMinor, 0);
  assert.strictEqual(quote.subledgerMinor, 0);
  assert.strictEqual(quote.reconciled, true);
  assert.strictEqual(await accountBalance(api, quote.clearingAccountId), 0);
});

test('A4 over-settlement requires the flag and authenticated owner, and invalid postings roll back', async () => {
  const { repo, api, bank, variant } = await freshApi();
  await cardSale(api, variant, 10000, '2026-10-05');
  const base = {
    method: 'card', date: '2026-10-06', bankAccountId: bank.id,
    grossMinor: 11000, feeMinor: 220, netReceivedMinor: 10780,
  };
  const blocked = await api.settlements.create(base);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error.code, 'OVER_SETTLED');
  assert.strictEqual(await repo.count('cardSettlements'), 0);

  BeeStore.auth._profile = 'cashier';
  const wrongProfile = await BeeStore.settlements.create({
    ...base, overSettlementFlag: 'OVER_SETTLED', createdByProfile: 'owner',
  }).then(() => null, error => error);
  assert.strictEqual(wrongProfile.code, 'OVER_SETTLED');
  BeeStore.auth._profile = 'owner';

  const allowed = ok(await api.settlements.create({
    ...base, overSettlementFlag: 'OVER_SETTLED',
  }), 'owner over-settlement');
  assert.strictEqual(allowed.overSettled, true);
  assert.strictEqual(allowed.createdByProfile, 'owner');

  const documentsBefore = await repo.count('cardSettlements');
  const entriesBefore = await repo.count('journalEntries');
  const unbalanced = await api.settlements.create({
    method: 'card', date: '2026-10-08', bankAccountId: bank.id,
    grossMinor: 1000, feeMinor: 20, netReceivedMinor: 979,
  });
  assert.strictEqual(unbalanced.ok, false);
  assert.strictEqual(unbalanced.error.code, 'UNBALANCED_SETTLEMENT');
  assert.strictEqual(await repo.count('cardSettlements'), documentsBefore);
  assert.strictEqual(await repo.count('journalEntries'), entriesBefore);
});

test('A4 settlement void appends an exact reversal and replay remains idempotent', async () => {
  const { repo, api, bank, variant } = await freshApi();
  await cardSale(api, variant, 100000, '2026-10-05');
  const settlement = ok(await api.settlements.create({
    method: 'card', date: '2026-10-07', bankAccountId: bank.id,
    grossMinor: 100000, feeMinor: 2000, netReceivedMinor: 98000,
  }));
  const original = ok(await api.journal.forSource('CARD_SETTLEMENT', settlement.id))[0];
  const voided = ok(await api.settlements.void(settlement.id, 'كشف مكرر'));
  assert.strictEqual(voided.voided, true);
  const entries = ok(await api.journal.forSource('CARD_SETTLEMENT', settlement.id));
  assert.strictEqual(entries.length, 2);
  const reversal = entries.find(entry => entry.reversalOf === original.id);
  assert.ok(reversal);
  assert.strictEqual(reversal.date, original.date);
  assert.strictEqual(reversal.lines.length, original.lines.length);
  for (let i = 0; i < original.lines.length; i++) {
    assert.strictEqual(reversal.lines[i].accountId, original.lines[i].accountId);
    assert.strictEqual(reversal.lines[i].debitMinor || 0, original.lines[i].creditMinor || 0);
    assert.strictEqual(reversal.lines[i].creditMinor || 0, original.lines[i].debitMinor || 0);
  }
  const quote = await clearingQuote(api);
  assert.strictEqual(quote.unsettledMinor, 100000);
  assert.strictEqual(quote.subledgerMinor, 100000);
  assert.strictEqual(await accountBalance(api, bank.chartAccountId), 0);

  const count = await repo.count('journalEntries');
  const replay = await BeeStore.posting.replayAll();
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.errors));
  assert.strictEqual(await repo.count('journalEntries'), count);
});

test('A4 schema 6 backups migrate to settlements without changing historical routing', async () => {
  const dump = {
    schemaVersion: 6,
    meta: { id: 'meta', schemaVersion: 6, counters: {}, revision: 4 },
    settings: { id: 'settings', paymentMethods: [{ id: 'card', name: 'بطاقة' }] },
    collections: {
      sales: [{
        id: 'legacy-sale', date: '2026-09-05', totalMinor: 5000,
        payments: [{ method: 'card', accountId: 'acc_bank', amountMinor: 5000 }],
      }],
    },
  };
  const migrated = await BeeStore.migrations.migrate(dump, BeeStore.schemaVersion);
  assert.strictEqual(migrated.schemaVersion, BeeStore.schemaVersion);
  assert.deepStrictEqual(migrated.collections.cardSettlements, []);
  assert.strictEqual(migrated.collections.sales[0].payments[0].methodKind, undefined,
    'historical receipts keep legacy routing until replayed');
  assert.strictEqual(migrated.collections.sales[0].payments[0].accountId, 'acc_bank');
  const again = await BeeStore.migrations.migrate(migrated, BeeStore.schemaVersion);
  assert.deepStrictEqual(again.collections.cardSettlements, []);
});

test('A4 customer clearing collections join the same-method settlement sub-ledger', async () => {
  const { api, bank, variant } = await freshApi({ feeFixedMinor: 100 });
  const customer = ok(await api.customers.create({ name: 'زبون' }));
  const sale = ok(await api.sales.create({
    date: '2026-10-05', customerId: customer.id, customerName: customer.name,
    lines: [{ variantId: variant.id, qty: 1, unitPriceMinor: 100000 }],
    payments: [],
  }));
  assert.strictEqual(sale.dueMinor, 100000);
  ok(await api.customers.receivePayment({
    customerId: customer.id, date: '2026-10-06', method: 'card', amountMinor: 30000,
  }));
  const quote = await clearingQuote(api);
  assert.strictEqual(quote.unsettledMinor, 30000);
  assert.strictEqual(quote.subledgerMinor, 30000);
  assert.strictEqual(quote.expectedFeeMinor, 700);
  assert.strictEqual(quote.receipts[0].sourceType, 'CUSTOMER_PAYMENT');
  ok(await api.settlements.create({
    method: 'card', date: '2026-10-07', bankAccountId: bank.id,
    grossMinor: 30000, feeMinor: 700, netReceivedMinor: 29300,
  }));
  assert.strictEqual((await clearingQuote(api)).unsettledMinor, 0);
});

test('A4 settlement creation and voiding enforce month and day locks in the service', async () => {
  const { repo, api, bank, variant } = await freshApi();
  await cardSale(api, variant, 100000, '2026-10-05');
  await repo.transaction(async tx => {
    tx.put('dailyClosings', {
      id: 'closed-day', date: '2026-10-07', status: 'closed', createdAt: BeeStore.dates.now(),
    });
  });
  const dayBlocked = await api.settlements.create({
    method: 'card', date: '2026-10-07', bankAccountId: bank.id,
    grossMinor: 1000, feeMinor: 20, netReceivedMinor: 980,
  });
  assert.strictEqual(dayBlocked.ok, false);
  assert.strictEqual(dayBlocked.error.code, 'DAY_CLOSED');

  const settlement = ok(await api.settlements.create({
    method: 'card', date: '2026-10-08', bankAccountId: bank.id,
    grossMinor: 1000, feeMinor: 20, netReceivedMinor: 980,
  }));
  await repo.transaction(async tx => {
    tx.put('periodClosings', {
      id: 'closed-month', month: '2026-10', status: 'closed', createdAt: BeeStore.dates.now(),
    });
  });
  const monthBlocked = await api.settlements.create({
    method: 'card', date: '2026-10-09', bankAccountId: bank.id,
    grossMinor: 1000, feeMinor: 20, netReceivedMinor: 980,
  });
  assert.strictEqual(monthBlocked.ok, false);
  assert.strictEqual(monthBlocked.error.code, 'PERIOD_CLOSED');
  const voidBlocked = await api.settlements.void(settlement.id, 'محاولة بعد الإقفال');
  assert.strictEqual(voidBlocked.ok, false);
  assert.strictEqual(voidBlocked.error.code, 'PERIOD_CLOSED');
});
