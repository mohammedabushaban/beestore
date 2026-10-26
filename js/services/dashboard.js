(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class DashboardService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Builds today/month KPIs: revenue, profit, balances, low stock, overdue (read-only).
     * @returns {Promise<Object>} dashboard snapshot
     */
    async get() {
      const today = BeeStore.dates.today();
      const monthStart = BeeStore.dates.startOfMonth(today);
      const settings = await this.repo.get('meta', 'settings') || {};

      // L2 §5: all-time totals (receivables, payables, account balances,
      // overdue installments) come from the small materialized summary; only
      // the current month and the 30-day chart range are read from IndexedDB.
      const summary = await this.repo.getSummary();
      const thirtyStart = BeeStore.dates.addDays(today, -29);
      const rangeStart = monthStart < thirtyStart ? monthStart : thirtyStart;
      const recentSales = await this.repo.listRange('sales', rangeStart, today,
        s => s.status !== 'void');
      const recentReturns = await this.repo.listRange('salesReturns', rangeStart, today);
      const todaySales = recentSales.filter(s => s.date === today);
      const monthSales = recentSales.filter(s => s.date >= monthStart);

      // Newest invoices are read backwards through the date index.
      const latestSales = await this.repo.latest('sales', 30);
      const recentInvoices = latestSales
        .filter(s => s.status !== 'void')
        .slice(0, 10);

      const variants = await this.repo.list('variants');
      const accounts = await this.repo.list('accounts');

      // Net of returns, mirroring the accrual P&L: a returned sale still shows in
      // the gross invoice list, but today's revenue/profit deduct today's returns.
      const todayReturns = recentReturns.filter(r => r.date === today);
      const todayReturnsMinor = BeeStore.money.sum(todayReturns.map(r => r.refundMinor));
      const todayGross = BeeStore.money.sum(todaySales.map(s => s.totalMinor));
      const todayRevenue = todayGross - todayReturnsMinor;
      const todayGrossCogs = BeeStore.money.sum(todaySales.map(s =>
        (s.lines || []).reduce((sum, l) => sum + l.unitCostMinor * l.qty, 0)));
      const todayReturnedCogs = BeeStore.money.sum(todayReturns.map(r =>
        (r.lines || []).filter(l => l.restock).reduce((sum, l) => sum + l.unitCostMinor * l.qty, 0)));
      const todayProfit = todayRevenue - (todayGrossCogs - todayReturnedCogs);

      // v2 §9.5 single source of truth: month KPIs come from the accrual P&L
      // (spread shares, salary accrual), never a parallel cash-date computation.
      const pnl = await BeeStore.reports.profitAndLoss(monthStart, today);
      const monthRevenue = pnl.netSales;
      const monthGrossProfit = pnl.grossProfit;
      const monthExpensesTotal = pnl.operatingExpenses;
      const monthNetProfit = pnl.netProfit;

      let inventoryCost = 0;
      let inventoryRetail = 0;
      for (const v of variants) {
        inventoryCost += v.quantity * v.costMinor;
        inventoryRetail += v.quantity * v.priceMinor;
      }

      const lowStockThreshold = settings.defaultLowStockThreshold || 3;
      const lowStockCount = variants.filter(v => {
        const t = v.lowStockThreshold || lowStockThreshold;
        return v.quantity <= t;
      }).length;

      const receivablesTotal = summary.receivablesMinor || 0;
      const payablesTotal = summary.payablesMinor || 0;
      const accountBalances = {};
      for (const a of accounts) {
        accountBalances[a.name] = BeeStore.summary.balance(summary, a.id);
      }

      const salesByDay = {};
      for (let i = 29; i >= 0; i--) {
        const d = BeeStore.dates.addDays(today, -i);
        salesByDay[d] = 0;
      }
      for (const s of recentSales) {
        if (salesByDay[s.date] !== undefined) {
          salesByDay[s.date] += s.totalMinor;
        }
      }
      for (const r of recentReturns) {
        if (salesByDay[r.date] !== undefined) {
          salesByDay[r.date] -= r.refundMinor;
        }
      }

      const overdueInstallments = BeeStore.summary.overdue(summary, today);

      // Top products by revenue (current month only).
      const productRevenue = {};
      for (const s of monthSales) {
        for (const line of s.lines) {
          const key = line.variantId;
          if (!productRevenue[key]) {
            productRevenue[key] = { name: line.productName, size: line.size, color: line.color, revenue: 0, qty: 0 };
          }
          productRevenue[key].revenue += line.lineTotalMinor;
          productRevenue[key].qty += line.qty;
        }
      }
      const topProducts = Object.values(productRevenue)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

      return {
        today: {
          revenue: todayRevenue,
          returns: todayReturnsMinor,
          invoiceCount: todaySales.length,
          profit: todayProfit,
        },
        month: {
          revenue: monthRevenue,
          grossProfit: monthGrossProfit,
          expenses: monthExpensesTotal,
          netProfit: monthNetProfit,
        },
        balances: accountBalances,
        inventory: { cost: inventoryCost, retail: inventoryRetail },
        lowStockCount,
        receivablesTotal,
        payablesTotal,
        overdueInstallments: overdueInstallments.length,
        salesByDay,
        recentInvoices,
        topProducts,
      };
    }

    /**
     * v3-Lite §7: the cashier sees only its own day's sales summary. No cost,
     * profit, balances, reports, backups or month data are computed for this
     * response at all (the facade returns this instead of get()).
     * @returns {Promise<object>} cashier-only dashboard payload
     */
    async cashierSummary() {
      const today = BeeStore.dates.today();
      const settings = await this.repo.get('meta', 'settings') || {};
      const sales = await this.repo.listRange('sales', today, today,
        s => s.status !== 'void' && s.createdByProfile === 'cashier');
      const returns = await this.repo.listRange('salesReturns', today, today,
        r => r.createdByProfile === 'cashier');
      const invoices = sales.slice().sort((a, b) =>
        String(b.date + b.number).localeCompare(String(a.date + a.number)));
      const revenueMinor = BeeStore.money.sum(sales.map(s => s.totalMinor)) -
        BeeStore.money.sum(returns.map(r => r.refundMinor));
      const variants = await this.repo.list('variants', v => v.active !== false);
      const threshold = Number(settings.defaultLowStockThreshold) || 3;
      const lowStockCount = variants.filter(v => v.quantity <= (v.lowStockThreshold || threshold)).length;
      return {
        cashier: true,
        today: {
          revenue: revenueMinor,
          grossSales: BeeStore.money.sum(sales.map(s => s.totalMinor)),
          returns: BeeStore.money.sum(returns.map(r => r.refundMinor)),
          invoiceCount: sales.length,
        },
        recentInvoices: invoices.slice(0, 10).map(s => ({
          id: s.id, number: s.number, date: s.date,
          totalMinor: s.totalMinor, status: s.status,
        })),
        lowStockCount,
      };
    }
  }

  BeeStore.dashboard = new DashboardService(null);
  BeeStore.DashboardService = DashboardService;
  if (typeof module !== 'undefined') module.exports = DashboardService;
})(typeof window !== 'undefined' ? window : globalThis);
