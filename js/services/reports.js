(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class ReportsService {
    constructor(repo) {
      this.repo = repo;
    }

    async profitAndLoss(from, to, options) {
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
            // v2 convention until the A3 journal cut-over: only a shortage is
            // an expense; a count gain never turns into income here.
            const delta = Number(m.valueChangeMinor) || 0;
            if (delta < 0) stockLosses -= delta;
          } else if (m.qtyChange < 0) {
            stockLosses += Math.abs(m.qtyChange) * (m.unitCostMinor || 0);
          }
        }
        if (m.type === 'sale_return' && m.qtyChange < 0) {
          stockLosses += Math.abs(m.qtyChange) * (m.unitCostMinor || 0);
        }
        if (m.type === 'revaluation') {
          stockRevaluation -= m.valueChangeMinor != null
            ? Number(m.valueChangeMinor) || 0
            : 0;
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
        const pnl = await this.profitAndLoss(startDate, asOf, { legacy: true });
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
