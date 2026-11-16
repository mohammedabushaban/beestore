#!/usr/bin/env node
'use strict';

/**
 * Compare the three P&L sources for one month from an exported backup.
 *
 *   node scripts/diagnose-pnl.js [db.json] [YYYY-MM]
 *
 * Sources:
 *   document  direct scan of sales/returns/expenses/stock/... (legacy route)
 *   summary   materialized monthly buckets (the fast whole-month route)
 *   journal   v5 journal balances (used only after approval)
 *
 * The script never writes to the backup file; it imports into memory.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dbPath = path.resolve(process.cwd(), process.argv[2] || 'DB/db.json');
const monthArg = process.argv[3] || '';

if (!fs.existsSync(dbPath)) {
  console.error('Backup not found: ' + dbPath);
  console.error('Usage: node scripts/diagnose-pnl.js [db.json] [YYYY-MM]');
  process.exit(1);
}

global.window = global.window || global;
require(path.join(ROOT, 'js/core/namespace.js'));
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors', 'chartSeed']
  .forEach((f) => require(path.join(ROOT, 'js/core', f + '.js')));
require(path.join(ROOT, 'js/storage/repository.js'));
require(path.join(ROOT, 'js/storage/summary.js'));
const MemoryRepository = require(path.join(ROOT, 'js/storage/memoryRepository.js'));

[
  'settings', 'audit', 'accounts', 'chartOfAccounts', 'categories', 'products',
  'variants', 'stock', 'sales', 'customers', 'returns', 'purchases',
  'purchaseReturns', 'suppliers', 'expenses', 'payroll', 'fixedAssets',
  'employees', 'transactions', 'periods', 'journal', 'posting', 'settlements',
  'dailyClosing', 'reports', 'dashboard', 'maintenance',
].forEach((f) => require(path.join(ROOT, 'js/services', f + '.js')));
const Api = require(path.join(ROOT, 'js/api/api.js'));

function fmt(minor) {
  return BeeStore.money.format(Number(minor) || 0);
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function printRow(label, doc, sum, journal) {
  console.log(
    pad(label, 26) +
    pad(doc === undefined ? '-' : fmt(doc), 18) +
    pad(sum === undefined ? '-' : fmt(sum), 18) +
    pad(journal === undefined ? '-' : fmt(journal), 18)
  );
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const repo = new MemoryRepository();
  await repo.open();
  await repo.importAll(raw);
  const api = new Api(repo);

  const allMonths = new Set();
  for (const c of ['sales', 'expenses', 'payroll', 'cashAdjustments', 'stockMovements',
    'purchaseReturns', 'fixedAssets']) {
    for (const doc of (raw.collections && raw.collections[c]) || []) {
      const key = String(doc.month || doc.date || doc.purchaseDate || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(key)) allMonths.add(key);
    }
  }
  const month = monthArg || [...allMonths].sort().pop() || BeeStore.dates.monthKey();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Invalid month: ' + month + ' (expected YYYY-MM)');
  }
  const range = BeeStore.dates.monthRange(month);

  const documentPnl = (await api.reports.profitAndLoss(range.from, range.to, { legacy: true })).data;
  const summaryPnl = BeeStore.summary.pnlRange(await repo.getSummary(), month, month);
  const journalRes = await api.reports.profitAndLoss(range.from, range.to, { journal: true });
  const journalPnl = journalRes.ok ? journalRes.data : null;

  const meta = await repo.get('meta', 'meta') || {};
  const approval = meta.journalApproval || {};
  const replay = meta.journalReplay || {};

  console.log('Backup:  ' + dbPath);
  console.log('Month:   ' + month);
  console.log('Version: schema ' + (raw.schemaVersion || '?') + ', app ' + (raw.meta && raw.meta.appVersion || '?'));
  console.log('Journal: approval=' + (approval.status || 'none') +
    ', replay=' + (replay.status || replay.lastStatus || 'n/a') +
    ', entries=' + String(((raw.collections && raw.collections.journalEntries) || []).length));
  console.log('');

  console.log(pad('Field', 26) + pad('document', 18) + pad('summary', 18) + pad('journal', 18));
  console.log('-'.repeat(80));
  for (const key of ['netSales', 'cogs', 'grossProfit', 'expensesBeforeGains', 'gains',
    'operatingExpenses', 'salaryExpense', 'employerExpense', 'endOfServiceExpense',
    'depreciationExpense', 'assetSaleGain', 'assetSaleLoss', 'stockLosses',
    'stockRevaluation', 'cardFees', 'cashDifference', 'otherIncome', 'netProfit']) {
    printRow(key, documentPnl[key], summaryPnl[key], journalPnl && journalPnl[key]);
  }

  console.log('');
  console.log('Why the expense line can be negative:');
  console.log('  expensesBeforeGains = manual expenses + salaries + card fees + stock shortages + cash shortages');
  console.log('  gains               = cash surplus + stock count gains + revaluation gains + asset sale gains');
  console.log('  operatingExpenses   = expensesBeforeGains - gains   (signed; may be negative by design)');
  console.log('  netProfit           = grossProfit + otherIncome - operatingExpenses');
  console.log('');

  const review = (await api.reports.monthReview(month)).data;
  console.log('Month Review KPI:');
  console.log('  expenses      = ' + fmt(review.kpis.expenses) + '  (signed net line, backward compatible)');
  console.log('  grossExpenses = ' + fmt(review.kpis.grossExpenses) + '  (displayed as "إجمالي المصاريف")');
  console.log('  gains         = ' + fmt(review.kpis.gains) + '  (displayed as "أرباح/فروقات تُخصم")');
  console.log('  netProfit     = ' + fmt(review.kpis.netProfit));

  const dash = (await api.dashboard.get()).data;
  console.log('');
  console.log('Dashboard month (current month only):');
  console.log('  revenue      = ' + fmt(dash.month.revenue));
  console.log('  grossProfit  = ' + fmt(dash.month.grossProfit));
  console.log('  expenses     = ' + fmt(dash.month.expenses) + '  (signed net line)');
  console.log('  netProfit    = ' + fmt(dash.month.netProfit));

  const collections = raw.collections || {};
  console.log('');
  console.log('Source counts (whole backup):');
  for (const name of ['sales', 'salesReturns', 'expenses', 'payroll', 'cashAdjustments',
    'stockMovements', 'purchaseReturns', 'fixedAssets']) {
    console.log('  ' + pad(name, 20) + String((collections[name] || []).length));
  }

  const stockGains = ((collections.stockMovements) || []).filter((m) =>
    (m.type === 'adjustment' || m.type === 'stocktake' || m.type === 'revaluation') &&
    String(m.date || '').slice(0, 7) === month && (Number(m.valueChangeMinor) || 0) > 0);
  const stockLosses = ((collections.stockMovements) || []).filter((m) =>
    (m.type === 'adjustment' || m.type === 'stocktake') &&
    String(m.date || '').slice(0, 7) === month && (Number(m.valueChangeMinor) || 0) < 0);
  const surpluses = ((collections.cashAdjustments) || []).filter((a) =>
    !a.voided && String(a.date || '').slice(0, 7) === month && (Number(a.amountMinor) || 0) > 0);
  const shortages = ((collections.cashAdjustments) || []).filter((a) =>
    !a.voided && String(a.date || '').slice(0, 7) === month && (Number(a.amountMinor) || 0) < 0);

  console.log('');
  console.log('Month-specific signed sources:');
  console.log('  stock gains (positive valueChange, reduce expenses) = ' + stockGains.length);
  console.log('  stock losses (negative valueChange, raise expenses) = ' + stockLosses.length);
  console.log('  cash surpluses (reduce expenses)                    = ' + surpluses.length);
  console.log('  cash shortages (raise expenses)                     = ' + shortages.length);

  const diff = ['operatingExpenses', 'expensesBeforeGains', 'gains', 'netProfit']
    .filter((k) => documentPnl[k] !== summaryPnl[k]);
  if (diff.length) {
    console.log('');
    console.log('WARNING: document and summary disagree on: ' + diff.join(', '));
    console.log('Run maintenance.integrityCheck() in the app, or rebuild the summary.');
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
