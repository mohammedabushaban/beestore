(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class ReportsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * Profit & loss. After the A3 parity report is approved the journal is the
     * source; before that (and for explicit legacy calls) the document-derived
     * report is used. `options.journal` forces the journal, `options.legacy`
     * forces the document scan.
     */
    async profitAndLoss(from, to, options) {
      options = options || {};
      if (!options.legacy && (options.journal || await this._journalReportsActive())) {
        return this._journalProfitAndLoss(from, to);
      }
      return this._documentProfitAndLoss(from, to, options);
    }

    async _documentProfitAndLoss(from, to, options) {
      // L2 §5: whole-month ranges are served from the materialized monthly
      // P&L buckets. This is what makes Month Review O(months) instead of
      // O(invoices). Arbitrary day ranges still use indexed range reads;
      // options.legacy forces the direct scan for validation/tests.
      if (!(options && options.legacy) &&
        from === BeeStore.dates.startOfMonth(from) && to === BeeStore.dates.endOfMonth(to)) {
        const summary = await this.repo.getSummary();
        const totals = BeeStore.summary.pnlRange(summary, from.slice(0, 7), to.slice(0, 7));
        return { from, to, ...totals };
      }
      const sales = await this.repo.listRange('sales', from, to, s => s.status !== 'void');
      const salesReturns = await this.repo.listRange('salesReturns', from, to);
      const expenses = await this.repo.list('expenses', e => !e.voided && e.categoryName !== 'رواتب');
      const payroll = await this.repo.listRange('payroll', from.slice(0, 7), to.slice(0, 7));
      const expenseCategories = await this.repo.list('expenseCategories');
      const stockMovements = await this.repo.listRange('stockMovements', from, to, m =>
        (m.type === 'adjustment' || m.type === 'stocktake' ||
          m.type === 'sale_return' || m.type === 'revaluation')
      );
      const purchaseReturns = await this.repo.listRange('purchaseReturns', from, to);
      const cashAdjustments = await this.repo.listRange('cashAdjustments', from, to,
        a => !a.voided);

      let netSales = 0;
      let cogs = 0;
      for (const s of sales) {
        netSales += s.totalMinor - s.taxMinor;
        for (const line of s.lines) {
          cogs += line.cogsMinor != null
            ? Math.round(Number(line.cogsMinor) || 0)
            : line.unitCostMinor * line.qty;
        }
      }
      for (const r of salesReturns) {
        netSales -= r.refundMinor;
        for (const line of r.lines) {
          if (line.restock) {
            cogs -= line.restockCostMinor != null
              ? Math.round(Number(line.restockCostMinor) || 0)
              : line.unitCostMinor * line.qty;
          }
        }
      }

      const grossProfit = netSales - cogs;
      const margin = netSales > 0 ? (grossProfit / netSales * 100).toFixed(1) : '0.0';

      // Salary expense accrues by payroll month (spec §7): gross amounts for ALL
      // records of the month, paid or draft. Advance repayments never reduce
      // salary expense — they settle an asset (employee advances).
      let salaryExpense = 0;
      for (const p of payroll) {
        if (p.month >= from.slice(0, 7) && p.month <= to.slice(0, 7)) {
          salaryExpense += (p.baseMinor || 0) + (p.bonusMinor || 0) +
            (p.overtimeMinor || 0) - (p.deductionsMinor || 0);
        }
      }

      let stockLosses = 0;
      let stockRevaluation = 0;
      for (const m of stockMovements) {
        if (m.type === 'adjustment' || m.type === 'stocktake') {
          if (m.valueChangeMinor != null) {
            // A3 aligns the derived P&L with 5020: a shortage is an expense
            // and a count gain is a negative expense (never silently dropped).
            stockLosses -= Number(m.valueChangeMinor) || 0;
          } else if (m.qtyChange < 0) {
            stockLosses += Math.abs(m.qtyChange) * (m.unitCostMinor || 0);
          }
        }
        if (m.type === 'revaluation') {
          stockRevaluation -= m.valueChangeMinor != null
            ? Number(m.valueChangeMinor) || 0
            : 0;
        }
      }
      // Purchase-return value differences post to 5030 (v5 §4 row 7). The
      // derived P&L must include them too, otherwise parity after A3 fails.
      for (const ret of purchaseReturns) {
        for (const line of (ret.lines || [])) {
          stockRevaluation -= Number(line.differenceMinor) || 0;
        }
      }

      // Profit attribution (v2 §4 + §6.3): single expenses hit their date's
      // month; spread expenses contribute one share per allocation month.
      const fromM = from.slice(0, 7), toM = to.slice(0, 7);
      const expensesByCategory = {};
      const catMap = {};
      for (const c of expenseCategories) catMap[c.id] = c.name;
      let singleTotal = 0;
      for (const e of expenses) {
        const key = e.categoryName || catMap[e.categoryId] || 'أخرى';
        if ((e.allocation || {}).mode === 'spread') {
          for (const s of BeeStore.expenses.spreadShares(e)) {
            if (s.month >= fromM && s.month <= toM) {
              singleTotal += s.amountMinor;
              expensesByCategory[key] = (expensesByCategory[key] || 0) + s.amountMinor;
            }
          }
        } else if (e.date >= from && e.date <= to) {
          singleTotal += e.amountMinor;
          expensesByCategory[key] = (expensesByCategory[key] || 0) + e.amountMinor;
        }
      }

      let cashDifference = 0;
      for (const a of cashAdjustments) cashDifference += Number(a.amountMinor) || 0;
      // v3-Lite §4.3: shortages increase operating expenses, surpluses reduce
      // them. The signed line is returned for the Day/Period reports.
      const operatingExpenses = singleTotal + salaryExpense + stockLosses +
        stockRevaluation - cashDifference;
      const netProfit = grossProfit - operatingExpenses;

      return {
        from, to,
        netSales, cogs, grossProfit, margin,
        operatingExpenses, salaryExpense, stockLosses, stockRevaluation, cashDifference,
        expensesByCategory,
        netProfit,
      };
    }

    async salesReport(from, to, groupBy) {
      const sales = await this.repo.listRange('sales', from, to, s => s.status !== 'void');
      const returns = await this.repo.listRange('salesReturns', from, to);
      const saleById = {};
      for (const s of sales) saleById[s.id] = s;
      const groups = {};
      const ensure = (key) => {
        if (!groups[key]) groups[key] = { count: 0, total: 0, returns: 0, net: 0 };
        return groups[key];
      };
      const saleKey = (s) => {
        if (groupBy === 'customer') return s.customerName || 'نقدي';
        if (groupBy === 'employee') return s.soldByEmployeeId || 'غير محدد';
        if (groupBy === 'payment') return (s.payments && s.payments.length > 0) ? s.payments[0].method : 'نقدي';
        return s.date;
      };
      for (const s of sales) {
        const g = ensure(saleKey(s));
        g.count++;
        g.total += s.totalMinor;
      }
      // Returns subtract from the group in which the original sale was counted
      // (the money came in and goes back through the same channel), dated by the
      // return date so a return only ever hits the report range once.
      for (const r of returns) {
        const sale = saleById[r.saleId] || (await this.repo.get('sales', r.saleId));
        let key;
        if (groupBy === 'payment') {
          key = (sale && sale.payments && sale.payments.length > 0) ? sale.payments[0].method : 'نقدي';
        } else if (groupBy === 'customer') {
          key = (sale && sale.customerName) || 'نقدي';
        } else if (groupBy === 'employee') {
          key = (sale && sale.soldByEmployeeId) || 'غير محدد';
        } else {
          key = r.date;
        }
        ensure(key).returns += r.refundMinor;
      }
      for (const key of Object.keys(groups)) {
        groups[key].net = groups[key].total - groups[key].returns;
      }
      return groups;
    }

    async inventoryValuation() {
      const variants = await this.repo.list('variants');
      let totalCost = 0;
      let totalRetail = 0;
      const rows = variants.map(v => {
        const qty = Number(v.quantity) || 0;
        const valueMinor = v.valueMinor != null
          ? Math.round(Number(v.valueMinor) || 0)
          : BeeStore.money.mul(v.costMinor, qty);
        const avgCostMinor = BeeStore.stock && BeeStore.stock.averageCost
          ? BeeStore.stock.averageCost(qty, valueMinor, v.costMinor)
          : (Number(v.costMinor) || 0);
        totalCost += valueMinor;
        totalRetail += BeeStore.money.mul(v.priceMinor, qty);
        return { ...v, valueMinor, avgCostMinor };
      });
      return {
        totalCost, totalRetail, potentialProfit: totalRetail - totalCost,
        variants: rows,
      };
    }

    async receivablesAging() {
      const customers = await this.repo.list('customers', c => c.active !== false);
      const today = BeeStore.dates.today();
      const result = [];
      for (const c of customers) {
        // Indexed customer lookup: no full-invoice scan per customer.
        const sales = (await this.repo.query('sales', 'customerId', c.id))
          .filter(s => s.status !== 'void' && s.dueMinor > 0);
        const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
        for (const s of sales) {
          const days = BeeStore.dates.diffDays(s.date, today);
          if (days <= 30) buckets['0-30'] += s.dueMinor;
          else if (days <= 60) buckets['31-60'] += s.dueMinor;
          else if (days <= 90) buckets['61-90'] += s.dueMinor;
          else buckets['90+'] += s.dueMinor;
        }
        const total = Object.values(buckets).reduce((a, b) => a + b, 0);
        if (total > 0) {
          result.push({ customerId: c.id, customerName: c.name, phone: c.phone, buckets, total });
        }
      }
      return result;
    }

    async payablesAging() {
      const suppliers = await this.repo.list('suppliers', s => s.active !== false);
      const today = BeeStore.dates.today();
      const result = [];
      for (const s of suppliers) {
        const purchases = (await this.repo.query('purchases', 'supplierId', s.id))
          .filter(p => p.status !== 'void' && p.dueMinor > 0);
        const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
        for (const p of purchases) {
          const days = BeeStore.dates.diffDays(p.date, today);
          if (days <= 30) buckets['0-30'] += p.dueMinor;
          else if (days <= 60) buckets['31-60'] += p.dueMinor;
          else if (days <= 90) buckets['61-90'] += p.dueMinor;
          else buckets['90+'] += p.dueMinor;
        }
        const total = Object.values(buckets).reduce((a, b) => a + b, 0);
        if (total > 0) {
          result.push({ supplierId: s.id, supplierName: s.name, phone: s.phone, buckets, total });
        }
      }
      return result;
    }

    // v2 §9.1 Month Review: the owner's main monthly report (data only).
    async monthReview(month) {
      const { from, to } = BeeStore.dates.monthRange(month);
      const prevMonth = BeeStore.dates.addMonths(month, -1);
      const prevRange = BeeStore.dates.monthRange(prevMonth);
      const pnl = await this.profitAndLoss(from, to);
      const prev = await this.profitAndLoss(prevRange.from, prevRange.to);
      const lastYear = await this.profitAndLoss(
        month.slice(0, 4) - 1 + month.slice(4) + '-01',
        month.slice(0, 4) - 1 + month.slice(4) + '-' + String(BeeStore.dates.daysInMonth(month)).padStart(2, '0'));
      const pct = (cur, base) => base ? +(((cur - base) / Math.abs(base)) * 100).toFixed(1) : null;

      const sales = await this.repo.listRange('sales', from, to, s => s.status !== 'void');
      let units = 0, paidAtSale = 0;
      const byDay = {}, byPayment = {}, byEmployee = {}, byProduct = {};
      for (const s of sales) {
        byDay[s.date] = (byDay[s.date] || 0) + s.totalMinor;
        for (const p of (s.payments || [])) {
          byPayment[p.method] = (byPayment[p.method] || 0) + p.amountMinor;
        }
        const emp = s.soldByEmployeeId || '—';
        byEmployee[emp] = (byEmployee[emp] || 0) + s.totalMinor;
        for (const l of s.lines) {
          units += l.qty;
          const k = l.variantId;
          if (!byProduct[k]) {
            byProduct[k] = { name: l.productName, size: l.size, color: l.color, qty: 0, revenue: 0, cost: 0 };
          }
          byProduct[k].qty += l.qty;
          byProduct[k].revenue += l.lineTotalMinor;
          byProduct[k].cost += l.cogsMinor != null
            ? Math.round(Number(l.cogsMinor) || 0)
            : l.unitCostMinor * l.qty;
        }
      }
      const products = Object.values(byProduct).map(p => ({ ...p, profit: p.revenue - p.cost }));
      const topByQty = [...products].sort((a, b) => b.qty - a.qty).slice(0, 10);
      const topByProfit = [...products].sort((a, b) => b.profit - a.profit).slice(0, 10);

      // Category breakdown via variant → product → category.
      const variants = await this.repo.list('variants');
      const vMap = {};
      for (const v of variants) vMap[v.id] = v;
      const prods = await this.repo.list('products');
      const pMap = {};
      for (const p of prods) pMap[p.id] = p;
      const cats = await this.repo.list('categories');
      const cMap = {};
      for (const c of cats) cMap[c.id] = c.name;
      const byCategory = {};
      for (const s of sales) {
        for (const l of s.lines) {
          const v = vMap[l.variantId];
          const cat = (v && pMap[v.productId] && (cMap[pMap[v.productId].categoryId] || 'بدون تصنيف')) || '—';
          if (!byCategory[cat]) byCategory[cat] = { revenue: 0, cost: 0 };
          byCategory[cat].revenue += l.lineTotalMinor;
          byCategory[cat].cost += l.cogsMinor != null
            ? Math.round(Number(l.cogsMinor) || 0)
            : l.unitCostMinor * l.qty;
        }
      }

      // Cash flow from the materialized month buckets (cash basis, this month).
      const summary = await this.repo.getSummary();
      const accounts = await this.repo.list('accounts');
      const cashflow = { opening: {}, inflows: {}, outflows: {}, closing: {} };
      let cfOpen = 0, cfClose = 0;
      for (const a of accounts) {
        const open = BeeStore.summary.accountBalanceAt(summary, a, month, true);
        const close = BeeStore.summary.accountBalanceAt(summary, a, month, false);
        cashflow.opening[a.name] = open;
        cashflow.closing[a.name] = close;
        cfOpen += open; cfClose += close;
      }
      const flowTypes = BeeStore.summary.accountFlowTypes(summary, month);
      for (const key of Object.keys(flowTypes)) {
        if (flowTypes[key].in) cashflow.inflows[key] = flowTypes[key].in;
        if (flowTypes[key].out) cashflow.outflows[key] = flowTypes[key].out;
      }

      // Balances opening → closing.
      const snapOpen = await this.balanceSnapshot(BeeStore.dates.addDays(from, -1));
      const snapClose = await this.balanceSnapshot(to);
      const balances = {
        inventory: [snapOpen.assets.inventoryValue, snapClose.assets.inventoryValue],
        receivables: [snapOpen.assets.receivables, snapClose.assets.receivables],
        payables: [snapOpen.liabilities.payables, snapClose.liabilities.payables],
        prepaid: [snapOpen.assets.prepaid, snapClose.assets.prepaid],
        accrued: [snapOpen.liabilities.accruedSalaries, snapClose.liabilities.accruedSalaries],
        advances: [snapOpen.assets.advancesOutstanding, snapClose.assets.advancesOutstanding],
      };

      // Inventory movement in units and cost.
      const moves = await this.repo.listRange('stockMovements', from, to);
      const inv = { purchasedUnits: 0, purchasedValue: 0, soldUnits: 0, soldCost: 0, adjustedUnits: 0, adjustedCost: 0 };
      for (const m of moves) {
        const q = m.qtyChange || 0;
        const tracked = m.valueChangeMinor != null;
        const moveValue = tracked
          ? Number(m.valueChangeMinor) || 0
          : q * (m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0));
        if (m.type === 'purchase' || m.type === 'opening') {
          inv.purchasedUnits += q;
          inv.purchasedValue += tracked ? moveValue : q * (m.unitCostMinor || 0);
        } else if (m.type === 'sale' || m.type === 'void_purchase') {
          inv.soldUnits += -q;
          inv.soldCost += tracked ? -moveValue
            : -q * (m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0));
        } else if (m.type === 'sale_return' || m.type === 'void_sale' || m.type === 'purchase_return') {
          inv.adjustedUnits += q;
          inv.adjustedCost += tracked ? moveValue
            : q * (m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0));
        } else {
          inv.adjustedUnits += q;
          inv.adjustedCost += tracked ? moveValue
            : q * (m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0));
        }
      }

      // Customers: new credit, collections, overdue.
      let newCredit = 0;
      for (const s of sales) newCredit += s.dueMinor;
      const collections = await this.repo.listRange('customerPayments', from, to);
      let collected = 0;
      for (const p of collections) collected += p.amountMinor;
      const overdue = await BeeStore.customers.getOverdueInstallments();

      // Payroll rows for the month.
      const payroll = await this.repo.listRange('payroll', month, month);

      const closed = await BeeStore.periods.isClosed(month);
      return {
        month, from, to, closed,
        kpis: {
          netSales: pnl.netSales, grossProfit: pnl.grossProfit, margin: pnl.margin,
          expenses: pnl.operatingExpenses, netProfit: pnl.netProfit,
          invoices: sales.length,
          avgInvoice: sales.length ? Math.round(pnl.netSales / sales.length) : 0,
          units,
        },
        pnl: {
          current: pnl, previous: prev, lastYear: lastYear,
          changePct: {
            netSales: pct(pnl.netSales, prev.netSales),
            netProfit: pct(pnl.netProfit, prev.netProfit),
            expenses: pct(pnl.operatingExpenses, prev.operatingExpenses),
          },
        },
        sales: { byDay, byCategory, topByQty, topByProfit, byPayment, byEmployee },
        expenses: { byCategory: pnl.expensesByCategory, previous: prev.expensesByCategory, salary: pnl.salaryExpense, stockLosses: pnl.stockLosses },
        cashflow: { ...cashflow, openTotal: cfOpen, closeTotal: cfClose },
        balances, inventory: { ...inv, closingValue: snapClose.assets.inventoryValue },
        customers: { newCredit, collected, overdue },
        payroll,
      };
    }
    // receivables + prepaid + advances. Liabilities = payables + customer
    // credits + accrued salaries (+ tax). Equity = opening equity + capital
    // in − withdrawals + cumulative net profit. Must balance.
    async balanceSnapshot(asOf, options) {
      options = options || {};
      if (!options.legacy && (options.journal || await this._journalReportsActive())) {
        return this._journalBalanceSnapshot(asOf);
      }
      return this._documentBalanceSnapshot(asOf, options);
    }

    async _documentBalanceSnapshot(asOf, options) {
      const settings = await this.repo.get('meta', 'settings') || {};
      const startDate = settings.systemStartDate || '0000-01-01';
      const accounts = await this.repo.list('accounts');
      const customers = await this.repo.list('customers');
      const suppliers = await this.repo.list('suppliers');
      const summary = await this.repo.getSummary();
      const month = String(asOf).slice(0, 7);
      const monthEnd = BeeStore.dates.endOfMonth(asOf) === asOf;
      const useSummary = monthEnd && !(options && options.legacy);

      let cashBalance = 0;
      const cashByAccount = {};
      if (useSummary) {
        for (const a of accounts) {
          const bal = BeeStore.summary.accountBalanceAt(summary, a, month, false);
          cashByAccount[a.id] = bal;
          cashBalance += bal;
        }
      } else {
        for (const a of accounts) {
          const bal = await BeeStore.accounts.balanceAsOf(a.id, asOf);
          cashByAccount[a.id] = bal;
          cashBalance += bal;
        }
      }

      const inventory = await BeeStore.stock.valueAsOf(asOf);
      const inventoryValue = inventory.totalCost;

      let receivables = 0, customerCredits = 0;
      if (useSummary) {
        const totals = BeeStore.summary.customerTotals(summary, customers, month);
        receivables = totals.receivables;
        customerCredits = totals.credits;
      } else {
        for (const c of customers) {
          const b = await BeeStore.customers.balance(c.id, asOf);
          if (b >= 0) receivables += b;
          else customerCredits += -b;
        }
      }

      let payables = 0;
      if (useSummary) {
        payables = BeeStore.summary.supplierTotals(summary, suppliers, month).payables;
      } else {
        for (const s of suppliers) {
          payables += await BeeStore.suppliers.balance(s.id, asOf);
        }
      }

      const prepaid = await BeeStore.expenses.prepaidAsOf(asOf);
      const accrued = await BeeStore.payroll.accruedAsOf(asOf);
      const advancesOutstanding = await BeeStore.payroll.advancesOutstandingAsOf(asOf);

      let taxPayable = 0;
      if (settings.taxEnabled) {
        if (useSummary) {
          taxPayable = BeeStore.summary.taxThrough(summary, month);
        } else {
          const sales = await this.repo.listRange('sales', '0000-01-01', asOf, s => s.status !== 'void');
          for (const s of sales) taxPayable += s.taxMinor || 0;
        }
      }

      let capitalIn = 0, withdrawals = 0;
      if (useSummary) {
        const capital = BeeStore.summary.capitalThrough(summary, month);
        capitalIn = capital.capitalIn;
        withdrawals = capital.withdrawals;
      } else {
        const ownerTx = await this.repo.listRange('ownerTransactions', '0000-01-01', asOf);
        for (const t of ownerTx) {
          if (t.type === 'capital_in') capitalIn += t.amountMinor;
          else withdrawals += t.amountMinor;
        }
      }

      // Opening equity (v2 §8): static opening balances (never period flows)
      // plus opening-type stock contributions (owner-contributed inventory,
      // dated and auditable). Advances start at zero — no document can
      // predate systemStartDate, so none exist before the first day.
      let openingCash = 0;
      for (const a of accounts) openingCash += a.openingBalanceMinor || 0;
      let openReceivables = 0;
      for (const c of customers) openReceivables += c.openingBalanceMinor || 0;
      let openPayables = 0;
      for (const s of suppliers) openPayables += s.openingBalanceMinor || 0;
      let openInventory = 0;
      if (useSummary) {
        openInventory = BeeStore.summary.openingInventoryThrough(summary, month);
      } else {
        const openMoves = await this.repo.listRange('stockMovements', '0000-01-01', asOf,
          m => m.type === 'opening');
        for (const m of openMoves) {
          openInventory += (Number(m.qtyChange) || 0) *
            (m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0));
        }
      }
      const openingEquity = (openingCash + openReceivables + openInventory) - openPayables;

      // Cumulative net profit from the start date through asOf.
      let cumulativeProfit;
      if (useSummary) {
        cumulativeProfit = BeeStore.summary.pnlRange(
          summary, String(startDate).slice(0, 7), month).netProfit;
      } else {
        const pnl = await this._documentProfitAndLoss(startDate, asOf, { legacy: true });
        cumulativeProfit = pnl.netProfit;
      }

      const assets = cashBalance + inventoryValue + receivables + prepaid.total + advancesOutstanding;
      const liabilities = payables + customerCredits + accrued.total + taxPayable;
      const equityTotal = openingEquity + capitalIn - withdrawals + cumulativeProfit;
      const retained = equityTotal - (capitalIn - withdrawals) - openingEquity;
      const balanced = Math.abs(assets - (liabilities + equityTotal)) < 1;

      return {
        asOf,
        assets: {
          cashBalance, cashByAccount, inventoryValue, receivables,
          prepaid: prepaid.total, advancesOutstanding, total: assets,
        },
        liabilities: {
          payables, customerCredits,
          accruedSalaries: accrued.total, taxPayable, total: liabilities,
        },
        equity: {
          openingEquity, capitalIn, withdrawals,
          retained: cumulativeProfit, cumulativeProfit, total: equityTotal,
        },
        balanced,
      };
    }

    // ---------------------------------------------------------------------
    // A3: journal-derived reports, parity report and cut-over approval.
    // ---------------------------------------------------------------------

    async _journalReportsActive() {
      const meta = await this.repo.get('meta', 'meta');
      if (!meta || !meta.journalApproval) return false;
      if (meta.journalApproval.status !== 'approved') return false;
      if (meta.journalReplay && meta.journalReplay.needed) return false;
      if (meta.journalReplay && meta.journalReplay.ok === false) return false;
      return true;
    }

    /**
     * Reads every journal line up to `to` once and aggregates balances by
     * account and by account+party. All report calculations below use it.
     * @param {string} from YYYY-MM-DD
     * @param {string} to YYYY-MM-DD
     * @returns {Promise<object>} {entries, chart, byId, balances, party}
     */
    async _journalContext(from, to) {
      const [entries, chart] = await Promise.all([
        this.repo.listRange('journalEntries', from || '0000-01-01', to || '9999-12-31'),
        this.repo.list('chartOfAccounts'),
      ]);
      const byId = new Map(chart.map(a => [a.id, a]));
      const balances = new Map();
      const party = new Map();
      for (const entry of entries) {
        for (const line of (entry.lines || [])) {
          const amount = (Number(line.debitMinor) || 0) - (Number(line.creditMinor) || 0);
          if (!amount) continue;
          balances.set(line.accountId, (balances.get(line.accountId) || 0) + amount);
          if (line.partyType && line.partyId) {
            const key = line.accountId + '\u0000' + line.partyType + '\u0000' + line.partyId;
            party.set(key, (party.get(key) || 0) + amount);
          }
        }
      }
      return { entries, chart, byId, balances, party };
    }

    _ctxAccountBalance(ctx, accountId) {
      return ctx.balances.get(accountId) || 0;
    }

    _ctxSystemBalance(ctx, systemKey, code) {
      let total = 0;
      for (const account of ctx.chart) {
        if (account.systemKey === systemKey ||
          (code && String(account.code) === String(code))) {
          total += this._ctxAccountBalance(ctx, account.id);
        }
      }
      return total;
    }

    /**
     * Journal P&L using the v5 account mapping. Debit-positive account
     * balances are converted back to report signs (revenue credits positive).
     * @param {object} ctx journal context
     * @returns {object} same shape as the document profitAndLoss
     */
    _journalPnlFromContext(ctx) {
      const netSales = -(this._ctxSystemBalance(ctx, 'sales_revenue', '4010') +
        this._ctxSystemBalance(ctx, 'sales_returns', '4020'));
      const cogs = this._ctxSystemBalance(ctx, 'cogs', '5010');
      const salaryExpense = this._ctxSystemBalance(ctx, 'salaries', '6100');
      const stockLosses = this._ctxSystemBalance(ctx, 'inventory_loss', '5020');
      const stockRevaluation = this._ctxSystemBalance(ctx, 'inventory_revaluation', '5030');
      const cashShortage = this._ctxSystemBalance(ctx, 'cash_shortage', '6400');
      const otherIncome = -this._ctxSystemBalance(ctx, 'other_income', '4100');
      const cashDifference = otherIncome - cashShortage;

      const special = new Set([
        'cogs', 'inventory_loss', 'inventory_revaluation',
        'salaries', 'cash_shortage',
      ]);
      const expensesByCategory = {};
      let otherExpenses = 0;
      for (const account of ctx.chart) {
        if (account.type !== 'expense') continue;
        if (special.has(account.systemKey)) continue;
        if (['5010', '5020', '5030', '6100', '6400'].indexOf(String(account.code)) >= 0) continue;
        const amount = this._ctxAccountBalance(ctx, account.id);
        if (!amount) continue;
        const key = account.nameAr || account.code || 'أخرى';
        expensesByCategory[key] = (expensesByCategory[key] || 0) + amount;
        otherExpenses += amount;
      }

      const grossProfit = netSales - cogs;
      const margin = netSales > 0 ? (grossProfit / netSales * 100).toFixed(1) : '0.0';
      const operatingExpenses = otherExpenses + salaryExpense + stockLosses +
        stockRevaluation - cashDifference;
      return {
        netSales, cogs, grossProfit, margin,
        operatingExpenses, salaryExpense, stockLosses, stockRevaluation,
        cashDifference, otherIncome, expensesByCategory,
        netProfit: grossProfit - operatingExpenses,
        source: 'journal',
      };
    }

    async _journalProfitAndLoss(from, to) {
      const ctx = await this._journalContext(from, to);
      return { from, to, ...this._journalPnlFromContext(ctx) };
    }

    _isMoneyChartAccount(account) {
      if (!account) return false;
      if (account.systemKey === 'cash') return true;
      if (account.clearing) return true;
      return !!account.legacyAccountId;
    }

    /**
     * Balance sheet straight from the journal. Control accounts are used as
     * stored; the report is balanced by construction unless a mapped account
     * is missing from the chart.
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<object>} same shape as the document balanceSnapshot
     */
    async _journalBalanceSnapshot(asOf) {
      const settings = await this.repo.get('meta', 'settings') || {};
      const ctx = await this._journalContext('0000-01-01', asOf);
      const pnl = this._journalPnlFromContext(ctx);

      let cashBalance = 0;
      const cashByAccount = {};
      for (const account of ctx.chart) {
        if (!this._isMoneyChartAccount(account)) continue;
        const balance = this._ctxAccountBalance(ctx, account.id);
        cashByAccount[account.legacyAccountId || account.id] = balance;
        cashBalance += balance;
      }

      const inventoryValue = this._ctxSystemBalance(ctx, 'inventory', '1200');
      const receivables = this._ctxSystemBalance(ctx, 'ar', '1100');
      const customerCredits = -this._ctxSystemBalance(ctx, 'customer_credits', '2030');
      const payables = -this._ctxSystemBalance(ctx, 'ap', '2010');
      const prepaid = this._ctxSystemBalance(ctx, 'prepaid', '1300');
      const accruedSalaries = -this._ctxSystemBalance(ctx, 'accrued_salaries', '2100');
      const taxPayable = -this._ctxSystemBalance(ctx, 'tax_payable', '2300');
      const advancesOutstanding = this._ctxSystemBalance(ctx, 'employee_advances', '1150');
      const openingEquity = -this._ctxSystemBalance(ctx, 'opening_equity', '3030');
      const capitalIn = -this._ctxSystemBalance(ctx, 'capital', '3010');
      const withdrawals = this._ctxSystemBalance(ctx, 'drawings', '3020');
      const cumulativeProfit = pnl.netProfit;

      const assets = cashBalance + inventoryValue + receivables + prepaid +
        advancesOutstanding;
      const liabilities = payables + customerCredits + accruedSalaries + taxPayable;
      const equityTotal = openingEquity + capitalIn - withdrawals + cumulativeProfit;
      return {
        asOf,
        assets: {
          cashBalance, cashByAccount, inventoryValue, receivables,
          prepaid, advancesOutstanding, total: assets,
        },
        liabilities: {
          payables, customerCredits,
          accruedSalaries, taxPayable, total: liabilities,
        },
        equity: {
          openingEquity, capitalIn, withdrawals,
          retained: cumulativeProfit, cumulativeProfit, total: equityTotal,
        },
        balanced: assets === liabilities + equityTotal,
        source: 'journal',
      };
    }

    /**
     * Net per-customer position from AR + customer credits. Positive means the
     * customer owes; negative is a credit balance. AR lines are debit-positive,
     * while a 2030 credit is a negative balance, so both are summed as stored.
     * @param {object} ctx journal context
     * @returns {Map<string,number>} customerId → balance
     */
    _journalCustomerBalances(ctx) {
      const out = new Map();
      for (const account of ctx.chart) {
        if (account.systemKey !== 'ar' && account.systemKey !== 'customer_credits') continue;
        for (const [key, amount] of ctx.party) {
          const parts = key.split('\u0000');
          if (parts[0] !== account.id || parts[1] !== 'customer') continue;
          const id = parts[2];
          out.set(id, (out.get(id) || 0) + amount);
        }
      }
      return out;
    }

    _journalSupplierBalances(ctx) {
      const out = new Map();
      for (const account of ctx.chart) {
        if (account.systemKey !== 'ap') continue;
        for (const [key, amount] of ctx.party) {
          const parts = key.split('\u0000');
          if (parts[0] !== account.id || parts[1] !== 'supplier') continue;
          out.set(parts[2], (out.get(parts[2]) || 0) - amount);
        }
      }
      return out;
    }

    /**
     * Traceable §3.2 residual per stock movement: tracked value minus the old
     * quantity × unit-cost formula. Used to explain the only permitted parity
     * difference.
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<object>} {netMinor, movements}
     */
    async _inventoryRounding(asOf) {
      const movements = await this.repo.listRange('stockMovements', '0000-01-01', asOf);
      const round = (v) => Math.round(Number(v) || 0);
      const traced = [];
      let netMinor = 0;
      for (const m of movements) {
        const qty = Number(m.qtyChange) || 0;
        const legacyMinor = round(qty * (Number(m.unitCostMinor) || 0));
        const trackedMinor = m.valueChangeMinor != null
          ? round(m.valueChangeMinor) : legacyMinor;
        const residualMinor = trackedMinor - legacyMinor;
        if (residualMinor === 0) continue;
        netMinor += residualMinor;
        traced.push({
          id: m.id, date: m.date, type: m.type, variantId: m.variantId,
          qtyChange: qty, unitCostMinor: round(m.unitCostMinor),
          trackedMinor, legacyMinor, residualMinor,
        });
      }
      traced.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.id).localeCompare(String(b.id)));
      return { netMinor, movements: traced };
    }

    _pnlDifferences(documentPnl, journalPnl) {
      const keys = ['netSales', 'cogs', 'grossProfit', 'operatingExpenses',
        'salaryExpense', 'stockLosses', 'stockRevaluation', 'cashDifference',
        'netProfit'];
      const differences = {};
      const failures = [];
      for (const key of keys) {
        const value = (Number(journalPnl[key]) || 0) - (Number(documentPnl[key]) || 0);
        differences[key] = value;
        if (value !== 0) {
          failures.push({
            scope: 'pnl', field: key,
            documentMinor: Number(documentPnl[key]) || 0,
            journalMinor: Number(journalPnl[key]) || 0,
            differenceMinor: value,
          });
        }
      }
      const categories = new Set([
        ...Object.keys(documentPnl.expensesByCategory || {}),
        ...Object.keys(journalPnl.expensesByCategory || {}),
      ]);
      differences.expensesByCategory = {};
      for (const key of categories) {
        const value = (journalPnl.expensesByCategory[key] || 0) -
          (documentPnl.expensesByCategory[key] || 0);
        differences.expensesByCategory[key] = value;
        if (value !== 0) {
          failures.push({
            scope: 'pnl-category', field: key,
            documentMinor: documentPnl.expensesByCategory[key] || 0,
            journalMinor: journalPnl.expensesByCategory[key] || 0,
            differenceMinor: value,
          });
        }
      }
      return { differences, failures };
    }

    _snapshotDifferences(documentSnap, journalSnap) {
      const fields = [
        ['assets.cashBalance', documentSnap.assets.cashBalance, journalSnap.assets.cashBalance],
        ['assets.inventoryValue', documentSnap.assets.inventoryValue, journalSnap.assets.inventoryValue],
        ['assets.receivables', documentSnap.assets.receivables, journalSnap.assets.receivables],
        ['assets.prepaid', documentSnap.assets.prepaid, journalSnap.assets.prepaid],
        ['assets.advancesOutstanding', documentSnap.assets.advancesOutstanding, journalSnap.assets.advancesOutstanding],
        ['assets.total', documentSnap.assets.total, journalSnap.assets.total],
        ['liabilities.payables', documentSnap.liabilities.payables, journalSnap.liabilities.payables],
        ['liabilities.customerCredits', documentSnap.liabilities.customerCredits, journalSnap.liabilities.customerCredits],
        ['liabilities.accruedSalaries', documentSnap.liabilities.accruedSalaries, journalSnap.liabilities.accruedSalaries],
        ['liabilities.taxPayable', documentSnap.liabilities.taxPayable, journalSnap.liabilities.taxPayable],
        ['liabilities.total', documentSnap.liabilities.total, journalSnap.liabilities.total],
        ['equity.openingEquity', documentSnap.equity.openingEquity, journalSnap.equity.openingEquity],
        ['equity.capitalIn', documentSnap.equity.capitalIn, journalSnap.equity.capitalIn],
        ['equity.withdrawals', documentSnap.equity.withdrawals, journalSnap.equity.withdrawals],
        ['equity.cumulativeProfit', documentSnap.equity.cumulativeProfit, journalSnap.equity.cumulativeProfit],
        ['equity.total', documentSnap.equity.total, journalSnap.equity.total],
      ];
      const differences = {};
      const failures = [];
      for (const row of fields) {
        const value = (Number(row[2]) || 0) - (Number(row[1]) || 0);
        differences[row[0]] = value;
        if (value !== 0) {
          failures.push({
            scope: 'balance-sheet', field: row[0],
            documentMinor: Number(row[1]) || 0,
            journalMinor: Number(row[2]) || 0,
            differenceMinor: value,
          });
        }
      }
      if (documentSnap.balanced !== journalSnap.balanced) {
        failures.push({
          scope: 'balance-sheet', field: 'balanced',
          document: documentSnap.balanced, journal: journalSnap.balanced,
        });
      }
      return { differences, failures };
    }

    /**
     * v5 §12.9 migration parity report. Replays documents when the schema-6
     * flag says so, then compares journal and document-derived P&L per month,
     * month-end balance sheets, money-account balances, customer/supplier
     * sub-ledgers and inventory. Any unexplained difference is a failure and
     * blocks the report cut-over.
     * @param {object} [options] {from,to,replay}
     * @returns {Promise<object>} report
     */
    async parityReport(options) {
      options = options || {};
      let replay = null;
      let meta = await this.repo.get('meta', 'meta');
      if (BeeStore.posting && BeeStore.posting.replayAll &&
        (options.replay || (meta && meta.journalReplay && meta.journalReplay.needed))) {
        if (!BeeStore.posting.repo) BeeStore.posting.repo = this.repo;
        replay = await BeeStore.posting.replayAll();
        meta = await this.repo.get('meta', 'meta');
      }

      const settings = await this.repo.get('meta', 'settings') || {};
      const entries = await this.repo.list('journalEntries');
      let from = options.from || settings.systemStartDate;
      if (!from) {
        from = entries.length
          ? entries.reduce((min, e) => (e.date < min ? e.date : min), entries[0].date)
          : BeeStore.dates.startOfMonth(BeeStore.dates.today());
      }
      let to = options.to || BeeStore.dates.today();
      for (const entry of entries) {
        if (entry.date && entry.date > to) to = entry.date;
      }
      if (from > to) {
        throw BeeStore.errors.err('VALIDATION', 'تاريخ بداية تقرير المطابقة بعد نهايته');
      }

      const failures = [];
      const months = [];
      const monthEnd = (m) => m + '-' + String(BeeStore.dates.daysInMonth(m)).padStart(2, '0');
      let cursor = BeeStore.dates.startOfMonth(from);
      while (cursor <= to) {
        const month = cursor.slice(0, 7);
        const mFrom = month + '-01';
        const mTo = monthEnd(month);
        const documentPnl = await this._documentProfitAndLoss(mFrom, mTo, { legacy: true });
        const journalPnl = await this._journalProfitAndLoss(mFrom, mTo);
        const diff = this._pnlDifferences(documentPnl, journalPnl);
        const monthFailures = diff.failures.map(f => ({ ...f, month }));
        failures.push(...monthFailures);
        months.push({
          month, from: mFrom, to: mTo,
          document: documentPnl, journal: journalPnl,
          differences: diff.differences,
          ok: monthFailures.length === 0,
        });
        const next = BeeStore.dates.addMonths(month + '-01', 1);
        cursor = BeeStore.dates.startOfMonth(next);
      }

      const snapshotDates = [];
      for (const row of months) {
        if (row.to <= to) snapshotDates.push(row.to);
      }
      if (snapshotDates.length === 0 || snapshotDates[snapshotDates.length - 1] !== to) {
        snapshotDates.push(to);
      }

      const snapshots = [];
      let lastDocument = null;
      let lastJournal = null;
      for (const asOf of snapshotDates) {
        const documentSnap = await this._documentBalanceSnapshot(asOf, { legacy: true });
        const journalSnap = await this._journalBalanceSnapshot(asOf);
        const diff = this._snapshotDifferences(documentSnap, journalSnap);
        failures.push(...diff.failures.map(f => ({ ...f, asOf })));
        snapshots.push({
          asOf, document: documentSnap, journal: journalSnap,
          differences: diff.differences, ok: diff.failures.length === 0,
        });
        lastDocument = documentSnap;
        lastJournal = journalSnap;
      }

      // Per-money-account balances at the report end date.
      const asOf = to;
      const accounts = [];
      const documentCash = (lastDocument && lastDocument.assets.cashByAccount) || {};
      const journalCash = (lastJournal && lastJournal.assets.cashByAccount) || {};
      const legacyAccounts = await this.repo.list('accounts');
      const names = new Map(legacyAccounts.map(a => [a.id, a.name]));
      const cashKeys = new Set([...Object.keys(documentCash), ...Object.keys(journalCash)]);
      for (const key of cashKeys) {
        const documentMinor = Number(documentCash[key]) || 0;
        const journalMinor = Number(journalCash[key]) || 0;
        const differenceMinor = journalMinor - documentMinor;
        accounts.push({
          accountId: key, name: names.get(key) || key,
          documentMinor, journalMinor, differenceMinor,
        });
        if (differenceMinor !== 0) {
          failures.push({
            scope: 'account', asOf, field: key,
            documentMinor, journalMinor, differenceMinor,
          });
        }
      }

      // Customer and supplier sub-ledgers at the report end date.
      const ctx = await this._journalContext('0000-01-01', asOf);
      const journalCustomers = this._journalCustomerBalances(ctx);
      const journalSuppliers = this._journalSupplierBalances(ctx);
      const customers = [];
      for (const c of (await this.repo.list('customers'))) {
        const documentMinor = await BeeStore.customers.balance(c.id, asOf);
        const journalMinor = journalCustomers.get(c.id) || 0;
        const differenceMinor = journalMinor - documentMinor;
        customers.push({
          customerId: c.id, name: c.name,
          documentMinor, journalMinor, differenceMinor,
        });
        if (differenceMinor !== 0) {
          failures.push({
            scope: 'customer', asOf, field: c.id,
            documentMinor, journalMinor, differenceMinor,
          });
        }
      }
      const suppliers = [];
      for (const s of (await this.repo.list('suppliers'))) {
        const documentMinor = await BeeStore.suppliers.balance(s.id, asOf);
        const journalMinor = journalSuppliers.get(s.id) || 0;
        const differenceMinor = journalMinor - documentMinor;
        suppliers.push({
          supplierId: s.id, name: s.name,
          documentMinor, journalMinor, differenceMinor,
        });
        if (differenceMinor !== 0) {
          failures.push({
            scope: 'supplier', asOf, field: s.id,
            documentMinor, journalMinor, differenceMinor,
          });
        }
      }

      // Inventory control 1200 vs the stock sub-ledger, with §3.2 traces.
      const documentInventory = lastDocument ? lastDocument.assets.inventoryValue : 0;
      const journalInventory = lastJournal ? lastJournal.assets.inventoryValue : 0;
      const inventoryDiff = journalInventory - documentInventory;
      const rounding = await this._inventoryRounding(asOf);
      const roundingAllowed = inventoryDiff !== 0 &&
        Math.abs(inventoryDiff) === Math.abs(rounding.netMinor);
      const inventory = {
        asOf, documentMinor: documentInventory, journalMinor: journalInventory,
        differenceMinor: inventoryDiff,
        roundingAllowed,
        roundingNetMinor: rounding.netMinor,
        roundingTraces: rounding.movements.slice(0, 200),
      };
      if (inventoryDiff !== 0 && !roundingAllowed) {
        failures.push({
          scope: 'inventory', asOf, field: 'inventory',
          documentMinor: documentInventory, journalMinor: journalInventory,
          differenceMinor: inventoryDiff,
        });
      }

      const replayOk = !(meta && meta.journalReplay && meta.journalReplay.needed) &&
        !(meta && meta.journalReplay && meta.journalReplay.ok === false);
      return {
        generatedAt: BeeStore.dates.now(),
        from, to,
        replay,
        replayOk,
        months,
        snapshots,
        accounts,
        customers,
        suppliers,
        inventory,
        failures,
        ok: failures.length === 0 && replayOk,
        canApprove: failures.length === 0 && replayOk,
        approval: meta ? meta.journalApproval || null : null,
      };
    }

    /**
     * Stores the owner/accountant approval only when the parity report has no
     * unexplained differences. Reports switch to the journal afterwards.
     * @param {object} [options] {approvedBy,from,to}
     * @returns {Promise<object>} approval record
     */
    async approveJournal(options) {
      options = options || {};
      const report = await this.parityReport(options);
      if (!report.ok) {
        throw BeeStore.errors.err('VALIDATION',
          'لا يمكن اعتماد التقارير من اليومية: توجد ' + report.failures.length +
          ' فروقات غير مفسّرة في تقرير المطابقة');
      }
      const now = BeeStore.dates.now();
      const approval = {
        status: 'approved',
        approvedAt: now,
        approvedBy: options.approvedBy || 'owner',
        from: report.from,
        to: report.to,
        parity: {
          ok: report.ok,
          months: report.months.length,
          snapshots: report.snapshots.length,
          failures: report.failures.length,
        },
      };
      await this.repo.transaction(async (tx) => {
        const meta = (await tx.get('meta', 'meta')) || { id: 'meta' };
        meta.journalApproval = approval;
        tx.put('meta', meta);
      });
      return approval;
    }

    /**
     * Revokes the journal cut-over approval; future reports fall back to the
     * document-derived calculation until a new parity run is approved.
     * @param {string} [reason]
     * @returns {Promise<object>} revoked approval record
     */
    async revokeJournalApproval(reason) {
      const now = BeeStore.dates.now();
      let revoked = null;
      await this.repo.transaction(async (tx) => {
        const meta = (await tx.get('meta', 'meta')) || { id: 'meta' };
        revoked = {
          ...(meta.journalApproval || {}),
          status: 'revoked',
          revokedAt: now,
          revokeReason: reason || '',
        };
        meta.journalApproval = revoked;
        tx.put('meta', meta);
      });
      return revoked;
    }

    async journalReportStatus() {
      const meta = await this.repo.get('meta', 'meta') || {};
      return {
        active: await this._journalReportsActive(),
        approval: meta.journalApproval || null,
        replay: meta.journalReplay || null,
      };
    }

    // v2 §9.3: why profit differs from cash. Must equal actual cash change.
    async profitCashReconciliation(month) {
      const { from, to } = BeeStore.dates.monthRange(month);
      const openDay = BeeStore.dates.addDays(from, -1);
      const pnl = await this.profitAndLoss(from, to);
      const snapOpen = await this.balanceSnapshot(openDay);
      const snapClose = await this.balanceSnapshot(to);
      const d = (a, b) => b - a;
      const dInv = d(snapOpen.assets.inventoryValue, snapClose.assets.inventoryValue);
      const dRec = d(snapOpen.assets.receivables, snapClose.assets.receivables);
      const dPre = d(snapOpen.assets.prepaid, snapClose.assets.prepaid);
      const dPay = d(snapOpen.liabilities.payables, snapClose.liabilities.payables);
      const dAcc = d(snapOpen.liabilities.accruedSalaries, snapClose.liabilities.accruedSalaries);
      const dAdv = d(snapOpen.assets.advancesOutstanding, snapClose.assets.advancesOutstanding);
      const dTax = d(snapOpen.liabilities.taxPayable, snapClose.liabilities.taxPayable);
      const cashFromOperations = pnl.netProfit - dInv - dRec - dPre + dPay + dAcc - dAdv + dTax;
      const capitalIn = snapClose.equity.capitalIn - snapOpen.equity.capitalIn;
      const withdrawals = snapClose.equity.withdrawals - snapOpen.equity.withdrawals;
      const cashChange = cashFromOperations + capitalIn - withdrawals;
      const actualCashChange = snapClose.assets.cashBalance - snapOpen.assets.cashBalance;
      return {
        month, from, to,
        netProfit: pnl.netProfit,
        deltas: { inventory: dInv, receivables: dRec, prepaid: dPre, payables: dPay, accrued: dAcc, advances: dAdv, tax: dTax },
        cashFromOperations, capitalIn, withdrawals, cashChange, actualCashChange,
        matches: Math.abs(cashChange - actualCashChange) < 1,
      };
    }

    // v2 §9.4: two months side by side with differences.
    async compareMonths(a, b) {
      const ra = BeeStore.dates.monthRange(a), rb = BeeStore.dates.monthRange(b);
      const pa = await this.profitAndLoss(ra.from, ra.to);
      const pb = await this.profitAndLoss(rb.from, rb.to);
      const keys = ['netSales', 'cogs', 'grossProfit', 'operatingExpenses', 'salaryExpense', 'stockLosses', 'netProfit'];
      const diff = {};
      for (const k of keys) diff[k] = pb[k] - pa[k];
      const catKeys = new Set([...Object.keys(pa.expensesByCategory), ...Object.keys(pb.expensesByCategory)]);
      const catDiff = {};
      for (const k of catKeys) {
        catDiff[k] = (pb.expensesByCategory[k] || 0) - (pa.expensesByCategory[k] || 0);
      }
      return { a: { month: a, ...pa }, b: { month: b, ...pb }, diff, catDiff };
    }

    // v2 §9.2: twelve monthly columns + totals + open/closed status.
    async yearOverview(year) {
      const y = String(year);
      if (!/^\d{4}$/.test(y)) throw BeeStore.errors.err('VALIDATION', 'سنة غير صالحة');
      const months = [];
      const totals = { netSales: 0, cogs: 0, grossProfit: 0, expenses: 0, salary: 0, netProfit: 0, cashChange: 0 };
      let best = null, worst = null;
      for (let m = 1; m <= 12; m++) {
        const month = y + '-' + String(m).padStart(2, '0');
        const { from, to } = BeeStore.dates.monthRange(month);
        const pnl = await this.profitAndLoss(from, to);
        const rec = await this.profitCashReconciliation(month);
        const closed = await BeeStore.periods.isClosed(month);
        const row = {
          month, netSales: pnl.netSales, cogs: pnl.cogs, grossProfit: pnl.grossProfit,
          expenses: pnl.operatingExpenses, salary: pnl.salaryExpense,
          netProfit: pnl.netProfit, cashChange: rec.actualCashChange, closed,
        };
        months.push(row);
        for (const k of Object.keys(totals)) totals[k] += row[k] || 0;
        if (!best || row.netProfit > best.netProfit) best = row;
        if (!worst || row.netProfit < worst.netProfit) worst = row;
      }
      return { year: y, months, totals, best: best.month, worst: worst.month };
    }

    async dailyClosing(date) {
      const sales = await this.repo.listRange('sales', date, date, s => s.status !== 'void');
      const expenses = await this.repo.listRange('expenses', date, date, e => !e.voided);
      const refunds = await this.repo.listRange('salesReturns', date, date,
        r => r.refundMode === 'cash_refund');
      const salesByMethod = {};
      let totalSales = 0;
      let refundMinor = 0;
      for (const s of sales) {
        totalSales += s.totalMinor;
        let remaining = Math.max(0, s.totalMinor);
        if (remaining <= 0) continue;
        for (const p of (s.payments || [])) {
          const add = Math.min(p.amountMinor, remaining);
          if (add <= 0) continue;
          salesByMethod[p.method] = (salesByMethod[p.method] || 0) + add;
          remaining -= add;
        }
      }
      for (const r of refunds) refundMinor += r.refundMinor;
      if (refundMinor > 0) {
        salesByMethod['cash'] = Math.max(0, (salesByMethod['cash'] || 0) - refundMinor);
      }
      const totalExpenses = BeeStore.money.sum(expenses.map(e => e.amountMinor));
      const expectedCashMinor = (salesByMethod['cash'] || 0) - totalExpenses;
      return { date, salesByMethod, totalSales, totalExpenses, refundMinor, expectedCashMinor };
    }
  }

  BeeStore.reports = new ReportsService(null);
  BeeStore.ReportsService = ReportsService;
  if (typeof module !== 'undefined') module.exports = ReportsService;
})(typeof window !== 'undefined' ? window : globalThis);
