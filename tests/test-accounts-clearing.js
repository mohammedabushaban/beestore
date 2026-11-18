const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors', 'chartSeed']
  .forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
['settings', 'audit', 'accounts', 'categories', 'products', 'variants', 'stock',
 'sales', 'customers', 'returns', 'purchases', 'purchaseReturns', 'suppliers', 'expenses',
 'payroll', 'employees', 'transactions', 'periods', 'chartOfAccounts', 'journal',
 'posting', 'settlements', 'reports', 'dashboard', 'backup',
 'maintenance'].forEach(f => require('../js/services/' + f + '.js'));
const Api = require('../js/api/api.js');

async function freshApi(today) {
  BeeStore.dates.setClock(() => today || '2026-11-20');
  const repo = new MemoryRepository();
  await repo.open();
  const api = new Api(repo);
  await api.settings.save({ systemStartDate: '2026-11-01', blockFutureDates: true });
  const settings = (await api.settings.get()).data;
  return { api, repo, settings };
}

/**
 * Seeds a cash drawer, a wallet money account and a clearing payment method
 * pointed at that wallet. That is the shape that lost its balance before:
 * the receipt waits with the provider, keyed by method id.
 */
async function seed(api) {
  const settings = (await api.settings.get()).data;
  const cash = (await api.accounts.create({ name: 'الصندوق', type: 'cash' })).data;
  const bank = (await api.accounts.create({ name: 'البنك', type: 'bank' })).data;
  const wallet = (await api.accounts.create({ name: 'جوال بي تاجر', type: 'wallet' })).data;
  const methods = [
    { id: 'cash', name: 'نقداً', kind: 'cash', accountId: cash.id },
    { id: 'bank', name: 'تحويل بنكي', kind: 'bank_direct', accountId: bank.id },
    { id: 'jawwal', name: 'جوال باي', kind: 'clearing', accountId: wallet.id },
  ];
  const saved = (await api.settings.update({
    paymentMethods: methods,
    cashDrawerAccountId: cash.id,
    defaultBankAccountId: bank.id,
  })).data;
  const product = (await api.products.quickAdd({
    name: 'بجامة',
    barcode: '6281000000099',
    costMinor: 1000,
    priceMinor: 3000,
    openingQuantity: 10,
    date: '2026-11-01',
  })).data;
  return { cash, bank, wallet, product, settings: saved, variantId: product.variant.id };
}

async function sell(api, base, date, amountMinor, method, accountId, qty) {
  qty = qty || 1;
  const sale = (await api.sales.create({
    date,
    lines: [{ variantId: base.variantId, qty, unitPriceMinor: Math.round(amountMinor / qty) }],
    payments: [{ method, accountId, amountMinor, date }],
  }));
  assert.strictEqual(sale.ok, true, sale.ok ? '' : sale.error.message);
  return sale.data;
}

test('a wallet receipt shows in the accounts page and the ledger', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    await sell(api, base, '2026-11-02', 10000, 'jawwal', base.wallet.id, 1);

    // Before the fix the clearing balance never reached summary.accountBalances,
    // so the wallet account read 0.00 while the invoice was paid.
    assert.strictEqual((await api.accounts.balance(base.wallet.id)).data, 10000);
    const summary = await api.repo.getSummary();
    assert.strictEqual(summary.methodBalances.jawwal, 10000);

    const balances = (await api.accounts.balances()).data;
    assert.strictEqual(balances[base.wallet.id], 10000);
    assert.strictEqual(balances[base.cash.id], 0);
    assert.strictEqual(balances[base.bank.id], 0);

    const ledger = (await api.accounts.ledger(base.wallet.id, {
      from: '2026-11-01', to: '2026-11-30',
    })).data;
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].amountMinor, 10000);
    assert.strictEqual(ledger[0].balanceAfter, 10000);
    assert.ok(ledger[0].description.includes('جوال باي'));

    // The balance sheet still reports the same money, but as a separate
    // cash-equivalent asset, so nothing is double counted.
    const snapshot = (await api.reports.balanceSnapshot('2026-11-20')).data;
    assert.strictEqual(snapshot.assets.cashBalance, 10000);
    assert.strictEqual(snapshot.assets.clearingOutstanding, 10000);
    assert.strictEqual(snapshot.balanced, true);

    const dashboard = (await api.dashboard.get()).data;
    assert.strictEqual(dashboard.balances['جوال بي تاجر'], 10000);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('a settlement moves the wallet money to the bank exactly once', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    await sell(api, base, '2026-11-02', 10000, 'jawwal', base.wallet.id, 1);
    const settlement = await api.settlements.create({
      method: 'jawwal', date: '2026-11-05',
      grossMinor: 10000, feeMinor: 0, netReceivedMinor: 10000,
      bankAccountId: base.bank.id,
    });
    assert.strictEqual(settlement.ok, true, settlement.ok ? '' : settlement.error.message);

    assert.strictEqual((await api.accounts.balance(base.wallet.id)).data, 0);
    assert.strictEqual((await api.accounts.balance(base.bank.id)).data, 10000);
    const overview = (await api.settlements.overview('2026-11-05')).data;
    const row = overview.methods.find(m => m.method === 'jawwal');
    assert.strictEqual(row.unsettledMinor, 0);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('deleting a payment method that moved money is refused', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    await sell(api, base, '2026-11-02', 10000, 'jawwal', base.wallet.id, 1);
    const current = (await api.settings.get()).data;
    const withoutWallet = current.paymentMethods.filter(m => m.id !== 'jawwal');
    const res = await api.settings.update({ paymentMethods: withoutWallet });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'VALIDATION');
    assert.ok(res.error.message.includes('جوال باي'));

    // The method is still there so its balance and reports stay readable.
    const after = (await api.settings.get()).data;
    assert.ok(after.paymentMethods.some(m => m.id === 'jawwal'));
    assert.strictEqual((await api.accounts.balance(base.wallet.id)).data, 10000);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('an unused method can still be deleted', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    const current = (await api.settings.get()).data;
    const res = await api.settings.update({
      paymentMethods: current.paymentMethods.filter(m => m.id !== 'bank'),
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
    const after = (await api.settings.get()).data;
    assert.ok(!after.paymentMethods.some(m => m.id === 'bank'));
    assert.ok(base);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('deactivating a method keeps its money visible but hides it from POS', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    await sell(api, base, '2026-11-02', 10000, 'jawwal', base.wallet.id, 1);
    const current = (await api.settings.get()).data;
    const res = await api.settings.update({
      paymentMethods: current.paymentMethods.map(m =>
        m.id === 'jawwal' ? { ...m, active: false } : m),
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
    const after = (await api.settings.get()).data;
    const method = after.paymentMethods.find(m => m.id === 'jawwal');
    assert.strictEqual(method.active, false);
    assert.strictEqual((await api.accounts.balance(base.wallet.id)).data, 10000);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('paymentAudit reports where each method money is and flags a deleted method', async () => {
  const { api, repo } = await freshApi('2026-11-20');
  try {
    const base = await seed(api);
    await sell(api, base, '2026-11-02', 10000, 'jawwal', base.wallet.id, 1);
    let audit = (await api.maintenance.paymentAudit()).data;
    const jawwal = audit.methods.find(m => m.id === 'jawwal');
    assert.strictEqual(jawwal.accountId, base.wallet.id);
    assert.strictEqual(jawwal.accountName, 'جوال بي تاجر');
    assert.strictEqual(jawwal.unsettledMinor, 10000);
    assert.strictEqual(jawwal.usage.sales, 1);
    assert.strictEqual(audit.warnings.length, 0);
    assert.strictEqual(audit.totals.accountsMinor, 10000);
    assert.strictEqual(audit.totals.clearingMinor, 10000);

    // Simulate a method deleted outside the guard (older app version or a
    // restored backup) by dropping it from settings and keeping the receipt.
    const settings = (await api.settings.get()).data;
    await repo.transaction(async (tx) => {
      const updated = { ...settings, paymentMethods: settings.paymentMethods.filter(m => m.id !== 'jawwal') };
      tx.put('meta', updated);
    });
    audit = (await api.maintenance.paymentAudit()).data;
    assert.strictEqual(audit.orphans.length, 1);
    assert.strictEqual(audit.orphans[0].id, 'jawwal');
    assert.strictEqual(audit.orphans[0].unsettledMinor, 10000);
    assert.ok(audit.warnings.some(w => w.code === 'DELETED_METHOD'));

    // The settlements screen must not lose the deleted method's balance.
    const overview = (await api.settlements.overview('2026-11-20')).data;
    const row = overview.methods.find(m => m.method === 'jawwal');
    assert.ok(row, 'deleted method still listed');
    assert.strictEqual(row.unsettledMinor, 10000);
    assert.strictEqual(row.missingMethod, true);
  } finally {
    BeeStore.dates.resetClock();
  }
});

test('a method without an account is flagged so its money cannot vanish', async () => {
  const { api } = await freshApi('2026-11-20');
  try {
    await seed(api);
    const current = (await api.settings.get()).data;
    await api.settings.update({
      paymentMethods: current.paymentMethods.map(m =>
        m.id === 'jawwal' ? { ...m, accountId: null } : m),
    });
    const audit = (await api.maintenance.paymentAudit()).data;
    const jawwal = audit.methods.find(m => m.id === 'jawwal');
    assert.strictEqual(jawwal.hasAccount, false);
    assert.ok(audit.warnings.some(w => w.code === 'NO_ACCOUNT'));
  } finally {
    BeeStore.dates.resetClock();
  }
});
