(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v3-Lite §5: the dashboard and Month Review need all-time totals
  // (receivables, payables, account balances, overdue installments) plus
  // per-month P&L and cash-flow totals. Reading 50k invoices on every screen
  // visit would miss the 1 s / 2 s targets, so those totals are materialized
  // in one small summary document and updated by the repository in the same
  // transaction as the documents that change them. This module is pure and
  // shared by both repositories/tests.
  //
  // `months` keeps only month-level buckets. Exact day-level deltas are
  // returned transiently in `days` (never persisted) so an as-of date inside
  // the current month can be computed from that month's documents without
  // scanning the whole history.
  const VERSION = 4;

  const COLLECTIONS = [
    'accounts', 'sales', 'purchases', 'customerPayments', 'supplierPayments',
    'expenses', 'employeeAdvances', 'ownerTransactions', 'transfers',
    'salesReturns', 'purchaseReturns', 'payroll', 'stockMovements',
    'cashAdjustments',
  ];

  function empty() {
    return {
      version: VERSION,
      accountBalances: {},
      receivablesMinor: 0,
      payablesMinor: 0,
      installments: [],
      months: {},
      computedAt: null,
    };
  }

  function emptyMonth() {
    return {
      accounts: {},
      flowTypes: {},
      customers: {},
      suppliers: {},
      capitalIn: 0,
      withdrawals: 0,
      openingInventory: 0,
      pnl: {
        netSales: 0,
        cogs: 0,
        salaryExpense: 0,
        stockLosses: 0,
        stockRevaluation: 0,
        tax: 0,
        expensesTotal: 0,
        spreadExpenses: 0,
        cashDifference: 0,
        expensesByCategory: {},
      },
    };
  }

  function emptyDay() {
    return { accounts: {}, customers: {}, suppliers: {}, tax: 0, openingInventory: 0 };
  }

  function emptyContribution() {
    return {
      accounts: {},
      receivables: 0,
      payables: 0,
      installments: null,
      months: {},
      days: {},
    };
  }

  function dayOf(value) {
    if (!value) return '';
    return String(value).slice(0, 10);
  }

  function monthOf(value) {
    if (!value) return '';
    return String(value).slice(0, 7);
  }

  function addTo(map, key, amount) {
    if (!key || !amount) return;
    map[key] = (map[key] || 0) + amount;
  }

  function ensureMonth(out, month) {
    if (!month) return null;
    if (!out.months[month]) out.months[month] = emptyMonth();
    return out.months[month];
  }

  function ensureDay(out, day) {
    if (!day) return null;
    if (!out.days[day]) out.days[day] = emptyDay();
    return out.days[day];
  }

  function addFlow(bucket, type, amount) {
    if (!type || !amount) return;
    const flow = bucket.flowTypes[type] || (bucket.flowTypes[type] = { in: 0, out: 0 });
    if (amount >= 0) flow.in += amount;
    else flow.out += amount;
  }

  function addCustomer(out, monthBucket, dayBucket, customerId, amount) {
    if (!customerId || !amount) return;
    if (monthBucket) addTo(monthBucket.customers, customerId, amount);
    if (dayBucket) addTo(dayBucket.customers, customerId, amount);
  }

  // Dated customer/supplier movements (invoice payments can be dated apart
  // from the invoice itself).
  function addCustomerAt(out, customerId, amount, when) {
    if (!customerId || !amount) return;
    const day = dayOf(when);
    const mb = ensureMonth(out, monthOf(day));
    if (mb) addTo(mb.customers, customerId, amount);
    const db = ensureDay(out, day);
    if (db) addTo(db.customers, customerId, amount);
  }

  function addSupplierAt(out, supplierId, amount, when) {
    if (!supplierId || !amount) return;
    const day = dayOf(when);
    const mb = ensureMonth(out, monthOf(day));
    if (mb) addTo(mb.suppliers, supplierId, amount);
    const db = ensureDay(out, day);
    if (db) addTo(db.suppliers, supplierId, amount);
  }

  function addSupplier(out, monthBucket, dayBucket, supplierId, amount) {
    if (!supplierId || !amount) return;
    if (monthBucket) addTo(monthBucket.suppliers, supplierId, amount);
    if (dayBucket) addTo(dayBucket.suppliers, supplierId, amount);
  }

  // v2 §6.3 spread shares (kept local so summary does not depend on the
  // expenses service being loaded first in Node tests).
  function spreadShares(expense) {
    const alloc = expense.allocation || { mode: 'single' };
    if (alloc.mode !== 'spread') {
      return [{ month: expense.month || monthOf(expense.date), amountMinor: expense.amountMinor }];
    }
    const n = Number(alloc.months) || 0;
    if (n < 1) return [];
    const out = [];
    const base = Math.floor(expense.amountMinor / n);
    let assigned = 0;
    for (let i = 0; i < n; i++) {
      const month = BeeStore.dates.addMonths(alloc.startMonth, i);
      const amountMinor = i === n - 1 ? expense.amountMinor - assigned : base;
      assigned += amountMinor;
      out.push({ month, amountMinor });
    }
    return out;
  }

  // Expenses may spread one payment across months outside the document month,
  // so a contribution can create several month buckets.
  function addExpenseToMonths(out, expense) {
    const key = expense.categoryName || 'أخرى';
    const spread = (expense.allocation || {}).mode === 'spread';
    for (const share of spreadShares(expense)) {
      const target = ensureMonth(out, share.month);
      if (!target) continue;
      target.pnl.expensesTotal += share.amountMinor;
      target.pnl.expensesByCategory[key] =
        (target.pnl.expensesByCategory[key] || 0) + share.amountMinor;
      if (spread) target.pnl.spreadExpenses += share.amountMinor;
    }
  }

  /**
   * A document's effect on the summary. Every function here must be pure so
   * removing an old document and adding its replacement gives the exact same
   * result as a full recomputation.
   * @param {string} collection collection name
   * @param {Object} doc document
   * @returns {Object} contribution
   */
  function contribution(collection, doc) {
    const out = emptyContribution();
    if (!doc) return out;
    const date = dayOf(doc.date || doc.timestamp || doc.month);
    const month = monthOf(date);
    const monthBucket = ensureMonth(out, month);
    const dayBucket = ensureDay(out, date);

    // A movement can have its own date (e.g. a payment inside an invoice), so
    // the month/day buckets follow the movement date, never the document date.
    const account = (type, accountId, amount, when) => {
      const day = dayOf(when || date);
      addTo(out.accounts, accountId, amount);
      const mb = ensureMonth(out, monthOf(day));
      if (mb) {
        addTo(mb.accounts, accountId, amount);
        addFlow(mb, type, amount);
      }
      const db = ensureDay(out, day);
      if (db) addTo(db.accounts, accountId, amount);
    };

    switch (collection) {
      case 'accounts':
        addTo(out.accounts, doc.id, doc.openingBalanceMinor || 0);
        break;
      case 'sales':
        if (doc.status === 'void') break;
        out.receivables += Number(doc.dueMinor) || 0;
        if (doc.customerId) {
          addCustomer(out, monthBucket, dayBucket, doc.customerId, Number(doc.totalMinor) || 0);
        }
        for (const p of (doc.payments || [])) {
          const amount = Number(p.amountMinor) || 0;
          account('sale_payment', p.accountId, amount, p.date || doc.date);
          // A payment attached to the invoice cuts the customer's balance on
          // its own date; later collections are separate customerPayments.
          addCustomerAt(out, doc.customerId, -amount, p.date || doc.date);
        }
        if (monthBucket) {
          monthBucket.pnl.netSales += (Number(doc.totalMinor) || 0) - (Number(doc.taxMinor) || 0);
          monthBucket.pnl.tax += Number(doc.taxMinor) || 0;
          for (const line of (doc.lines || [])) {
            monthBucket.pnl.cogs += line.cogsMinor != null
              ? Math.round(Number(line.cogsMinor) || 0)
              : (Number(line.unitCostMinor) || 0) * (Number(line.qty) || 0);
          }
        }
        if (dayBucket) dayBucket.tax += Number(doc.taxMinor) || 0;
        if (doc.installmentPlan && Array.isArray(doc.installmentPlan.schedule)) {
          out.installments = doc.installmentPlan.schedule
            .filter(inst => inst && inst.status !== 'paid')
            .map(inst => ({
              saleId: doc.id,
              saleNumber: doc.number || '',
              customerId: doc.customerId || null,
              dueDate: inst.dueDate,
              amountMinor: Number(inst.amountMinor) || 0,
              paidMinor: Number(inst.paidMinor) || 0,
            }));
        }
        break;
      case 'purchases':
        if (doc.status === 'void') break;
        out.payables += Number(doc.dueMinor) || 0;
        if (doc.supplierId) {
          addSupplier(out, monthBucket, dayBucket, doc.supplierId, Number(doc.totalMinor) || 0);
        }
        for (const p of (doc.payments || [])) {
          const amount = Number(p.amountMinor) || 0;
          account('purchase_payment', p.accountId, -amount, p.date || doc.date);
          addSupplierAt(out, doc.supplierId, -amount, p.date || doc.date);
        }
        break;
      case 'customerPayments': {
        const amount = Number(doc.amountMinor) || 0;
        account('customer_payment', doc.accountId, amount);
        addCustomer(out, monthBucket, dayBucket, doc.customerId, -amount);
        break;
      }
      case 'supplierPayments': {
        const amount = Number(doc.amountMinor) || 0;
        account('supplier_payment', doc.accountId, -amount);
        addSupplier(out, monthBucket, dayBucket, doc.supplierId, -amount);
        break;
      }
      case 'expenses':
        if (doc.voided) break;
        account('expense', doc.accountId, -(Number(doc.amountMinor) || 0));
        if (doc.categoryName !== 'رواتب') addExpenseToMonths(out, doc);
        break;
      case 'employeeAdvances':
        account('advance', doc.accountId, -(Number(doc.amountMinor) || 0));
        break;
      case 'ownerTransactions': {
        // Daily-closing records are soft-voided when a day is reopened.
        if (doc.voided) break;
        const amount = Number(doc.amountMinor) || 0;
        const signed = doc.type === 'capital_in' ? amount : -amount;
        account('owner', doc.accountId, signed);
        if (monthBucket) {
          if (doc.type === 'capital_in') monthBucket.capitalIn += amount;
          else monthBucket.withdrawals += amount;
        }
        break;
      }
      case 'transfers':
        if (doc.voided) break;
        account('transfer_out', doc.fromAccountId, -(Number(doc.amountMinor) || 0));
        account('transfer_in', doc.toAccountId, Number(doc.amountMinor) || 0);
        break;
      case 'cashAdjustments': {
        // v3-Lite §4.3: a shortage is an expense, a surplus is income. The
        // account entry and the P&L line have the same signed amount so the
        // balance snapshot stays balanced.
        if (doc.voided) break;
        const amount = Number(doc.amountMinor) || 0;
        account('cash_difference', doc.accountId, amount);
        if (monthBucket) monthBucket.pnl.cashDifference += amount;
        break;
      }
      case 'salesReturns': {
        const amount = Number(doc.refundMinor) || 0;
        if (doc.refundMode === 'cash_refund') {
          account('return_refund', doc.refundMethod, -amount);
        }
        if (doc.refundMode === 'customer_credit' && doc.customerId) {
          addCustomer(out, monthBucket, dayBucket, doc.customerId, -amount);
        }
        if (monthBucket) {
          monthBucket.pnl.netSales -= amount;
          for (const line of (doc.lines || [])) {
            if (line.restock) {
              monthBucket.pnl.cogs -= line.restockCostMinor != null
                ? Math.round(Number(line.restockCostMinor) || 0)
                : (Number(line.unitCostMinor) || 0) * (Number(line.qty) || 0);
            }
          }
        }
        break;
      }
      case 'purchaseReturns': {
        const amount = Number(doc.totalMinor) || 0;
        if (doc.mode === 'cash_refund') {
          account('purchase_return_refund', doc.accountId, amount);
        }
        addSupplier(out, monthBucket, dayBucket, doc.supplierId, -amount);
        break;
      }
      case 'payroll':
        if (monthBucket) {
          monthBucket.pnl.salaryExpense += (Number(doc.baseMinor) || 0) +
            (Number(doc.bonusMinor) || 0) + (Number(doc.overtimeMinor) || 0) -
            (Number(doc.deductionsMinor) || 0);
        }
        break;
      case 'stockMovements': {
        const qty = Number(doc.qtyChange) || 0;
        const unitCost = Number(doc.unitCostMinor) || 0;
        if (doc.type === 'opening' && monthBucket) {
          const openingValue = doc.valueChangeMinor != null
            ? Number(doc.valueChangeMinor) || 0
            : qty * (doc.avgCostAfterMinor != null ? Number(doc.avgCostAfterMinor) : unitCost);
          monthBucket.openingInventory += openingValue;
          if (dayBucket) dayBucket.openingInventory += openingValue;
        }
        if (monthBucket) {
          if (doc.type === 'adjustment' || doc.type === 'stocktake') {
            if (doc.valueChangeMinor != null) {
              // Document-derived reports keep the v2 convention until the A3
              // journal cut-over: only shortages are expenses. A count gain
              // still posts Dr 1200 / Cr 5020 to the journal, but it never
              // creates income in this legacy P&L.
              const delta = Number(doc.valueChangeMinor) || 0;
              if (delta < 0) monthBucket.pnl.stockLosses -= delta;
            } else if (qty < 0) {
              monthBucket.pnl.stockLosses += Math.abs(qty) * unitCost;
            }
          }
          if (doc.type === 'sale_return' && qty < 0) {
            monthBucket.pnl.stockLosses += Math.abs(qty) * unitCost;
          }
          if (doc.type === 'revaluation') {
            monthBucket.pnl.stockRevaluation -= doc.valueChangeMinor != null
              ? Number(doc.valueChangeMinor) || 0
              : 0;
          }
        }
        break;
      }
      default:
        break;
    }
    prune(out);
    return out;
  }

  function isEmptyMonth(bucket) {
    if (!bucket) return true;
    if (Object.keys(bucket.accounts).length || Object.keys(bucket.flowTypes).length ||
      Object.keys(bucket.customers).length || Object.keys(bucket.suppliers).length) return false;
    if (bucket.capitalIn || bucket.withdrawals || bucket.openingInventory) return false;
    const pnl = bucket.pnl;
    for (const key of ['netSales', 'cogs', 'salaryExpense', 'stockLosses', 'stockRevaluation',
      'tax', 'expensesTotal', 'spreadExpenses', 'cashDifference']) {
      if (pnl[key]) return false;
    }
    return Object.keys(pnl.expensesByCategory).length === 0;
  }

  function prune(out) {
    for (const key of Object.keys(out.months)) {
      if (isEmptyMonth(out.months[key])) delete out.months[key];
    }
    for (const key of Object.keys(out.days)) {
      const day = out.days[key];
      if (!Object.keys(day.accounts).length && !Object.keys(day.customers).length &&
        !Object.keys(day.suppliers).length && !day.tax && !day.openingInventory) {
        delete out.days[key];
      }
    }
  }

  function applyNumeric(target, source, sign) {
    for (const key of Object.keys(source)) {
      const value = Number(source[key]) || 0;
      target[key] = (target[key] || 0) + sign * value;
      if (target[key] === 0) delete target[key];
    }
  }

  function applyContribution(summary, contrib, sign) {
    if (!summary || !contrib) return;
    applyNumeric(summary.accountBalances, contrib.accounts, sign);
    summary.receivablesMinor += sign * (Number(contrib.receivables) || 0);
    summary.payablesMinor += sign * (Number(contrib.payables) || 0);

    for (const month of Object.keys(contrib.months)) {
      if (!summary.months[month]) {
        if (sign < 0) continue;
        summary.months[month] = emptyMonth();
      }
      const bucket = summary.months[month];
      const source = contrib.months[month];
      applyNumeric(bucket.accounts, source.accounts, sign);
      applyNumeric(bucket.customers, source.customers, sign);
      applyNumeric(bucket.suppliers, source.suppliers, sign);
      applyNumeric(bucket.pnl.expensesByCategory, source.pnl.expensesByCategory, sign);
      for (const key of ['netSales', 'cogs', 'salaryExpense', 'stockLosses', 'tax',
        'expensesTotal', 'spreadExpenses', 'cashDifference']) {
        bucket.pnl[key] += sign * (Number(source.pnl[key]) || 0);
      }
      bucket.capitalIn += sign * (Number(source.capitalIn) || 0);
      bucket.withdrawals += sign * (Number(source.withdrawals) || 0);
      bucket.openingInventory += sign * (Number(source.openingInventory) || 0);
      for (const type of Object.keys(source.flowTypes)) {
        const flow = source.flowTypes[type];
        if (!bucket.flowTypes[type]) {
          if (sign < 0) continue;
          bucket.flowTypes[type] = { in: 0, out: 0 };
        }
        bucket.flowTypes[type].in += sign * (Number(flow.in) || 0);
        bucket.flowTypes[type].out += sign * (Number(flow.out) || 0);
        if (!bucket.flowTypes[type].in && !bucket.flowTypes[type].out) {
          delete bucket.flowTypes[type];
        }
      }
    }
  }

  function removeSaleInstallments(summary, saleId) {
    if (!summary || !saleId) return;
    summary.installments = summary.installments.filter(i => i.saleId !== saleId);
  }

  /**
   * Applies a document change to a summary in place.
   * @param {Object} summary summary to update
   * @param {string} collection collection name
   * @param {Object|null} oldDoc previous document (null when created)
   * @param {Object|null} newDoc new document (null when deleted)
   * @returns {Object} the same summary
   */
  function apply(summary, collection, oldDoc, newDoc) {
    if (!summary) return summary;
    if (collection === 'sales') {
      if (oldDoc && oldDoc.id) removeSaleInstallments(summary, oldDoc.id);
      if (newDoc && newDoc.id) removeSaleInstallments(summary, newDoc.id);
    }
    if (oldDoc) applyContribution(summary, contribution(collection, oldDoc), -1);
    if (newDoc) {
      const contrib = contribution(collection, newDoc);
      applyContribution(summary, contrib, 1);
      if (collection === 'sales' && contrib.installments) {
        summary.installments.push(...contrib.installments);
      }
    }
    return summary;
  }

  /**
   * Recomputes the summary from complete collection arrays.
   * @param {Object} collections collection name → array of documents
   * @returns {Object} summary
   */
  function compute(collections) {
    const summary = empty();
    for (const name of COLLECTIONS) {
      for (const doc of (collections[name] || [])) {
        apply(summary, name, null, doc);
      }
    }
    summary.computedAt = (BeeStore.dates && BeeStore.dates.now) ? BeeStore.dates.now() : new Date().toISOString();
    return summary;
  }

  function monthKeys(summary) {
    return Object.keys((summary && summary.months) || {}).sort();
  }

  /**
   * P&L totals for whole months from the materialized buckets. The result
   * mirrors ReportsService.profitAndLoss for a full-month range.
   */
  function pnlRange(summary, fromMonth, toMonth) {
    let netSales = 0, cogs = 0, salaryExpense = 0, stockLosses = 0;
    let stockRevaluation = 0, expensesTotal = 0, cashDifference = 0;
    const expensesByCategory = {};
    for (const month of monthKeys(summary)) {
      if (month < fromMonth || month > toMonth) continue;
      const pnl = summary.months[month].pnl;
      netSales += pnl.netSales || 0;
      cogs += pnl.cogs || 0;
      salaryExpense += pnl.salaryExpense || 0;
      stockLosses += pnl.stockLosses || 0;
      stockRevaluation += pnl.stockRevaluation || 0;
      expensesTotal += pnl.expensesTotal || 0;
      cashDifference += pnl.cashDifference || 0;
      for (const key of Object.keys(pnl.expensesByCategory || {})) {
        expensesByCategory[key] = (expensesByCategory[key] || 0) + pnl.expensesByCategory[key];
      }
    }
    const grossProfit = netSales - cogs;
    // Shortage (negative) increases operating expenses; surplus (positive)
    // reduces them. `cashDifference` keeps its signed form for the report.
    const operatingExpenses = expensesTotal + salaryExpense + stockLosses +
      stockRevaluation - cashDifference;
    return {
      netSales, cogs, grossProfit,
      margin: netSales > 0 ? (grossProfit / netSales * 100).toFixed(1) : '0.0',
      operatingExpenses, salaryExpense, stockLosses, stockRevaluation, cashDifference,
      expensesByCategory,
      netProfit: grossProfit - operatingExpenses,
    };
  }

  /**
   * Account balance at the end of a month, including all earlier months.
   * @param {Object} summary summary
   * @param {Object} account account document (for the opening balance)
   * @param {string} month YYYY-MM
   * @param {boolean} [before] exclude the month itself
   */
  function accountBalanceAt(summary, account, month, before) {
    let balance = Number(account.openingBalanceMinor) || 0;
    for (const key of monthKeys(summary)) {
      if (before ? key >= month : key > month) continue;
      balance += ((summary.months[key].accounts || {})[account.id]) || 0;
    }
    return balance;
  }

  function accountFlowTypes(summary, month) {
    const bucket = summary && summary.months && summary.months[month];
    return (bucket && bucket.flowTypes) || {};
  }

  function customerTotals(summary, customers, month) {
    let receivables = 0, credits = 0;
    const byId = {};
    for (const customer of customers) {
      let balance = Number(customer.openingBalanceMinor) || 0;
      for (const key of monthKeys(summary)) {
        if (key > month) break;
        balance += ((summary.months[key].customers || {})[customer.id]) || 0;
      }
      byId[customer.id] = balance;
      if (balance >= 0) receivables += balance;
      else credits += -balance;
    }
    return { receivables, credits, byId };
  }

  function supplierTotals(summary, suppliers, month) {
    let payables = 0;
    const byId = {};
    for (const supplier of suppliers) {
      let balance = Number(supplier.openingBalanceMinor) || 0;
      for (const key of monthKeys(summary)) {
        if (key > month) break;
        balance += ((summary.months[key].suppliers || {})[supplier.id]) || 0;
      }
      byId[supplier.id] = balance;
      payables += balance;
    }
    return { payables, byId };
  }

  function sumFieldThrough(summary, month, getter) {
    let total = 0;
    for (const key of monthKeys(summary)) {
      if (key > month) break;
      total += getter(summary.months[key]) || 0;
    }
    return total;
  }

  function taxThrough(summary, month) {
    return sumFieldThrough(summary, month, bucket => bucket.pnl.tax);
  }

  function openingInventoryThrough(summary, month) {
    return sumFieldThrough(summary, month, bucket => bucket.openingInventory);
  }

  function capitalThrough(summary, month) {
    return {
      capitalIn: sumFieldThrough(summary, month, bucket => bucket.capitalIn),
      withdrawals: sumFieldThrough(summary, month, bucket => bucket.withdrawals),
    };
  }

  /**
   * Overdue rows as of a business date, without scanning every invoice.
   * @param {Object} summary summary
   * @param {string} today YYYY-MM-DD
   * @returns {Array} unpaid installments whose due date passed
   */
  function overdue(summary, today) {
    return ((summary && summary.installments) || [])
      .filter(i => i.dueDate && i.dueDate < today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  }

  function balance(summary, accountId) {
    return (summary && summary.accountBalances && summary.accountBalances[accountId]) || 0;
  }

  BeeStore.summary = {
    VERSION,
    COLLECTIONS,
    empty,
    emptyMonth,
    contribution,
    apply,
    compute,
    pnlRange,
    monthKeys,
    accountBalanceAt,
    accountFlowTypes,
    customerTotals,
    supplierTotals,
    taxThrough,
    openingInventoryThrough,
    capitalThrough,
    overdue,
    balance,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.summary;
})(typeof window !== 'undefined' ? window : globalThis);
