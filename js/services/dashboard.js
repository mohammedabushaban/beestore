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

      const sales = await this.repo.list('sales', s => s.status !== 'void');
      const todaySales = sales.filter(s => s.date === today);
      const monthSales = sales.filter(s => s.date >= monthStart && s.date <= today);

      const variants = await this.repo.list('variants');
      const accounts = await this.repo.list('accounts');
      const customers = await this.repo.list('customers');
      const suppliers = await this.repo.list('suppliers');

      // Net of returns, mirroring the accrual P&L: a returned sale still shows in
      // the gross invoice list, but today's revenue/profit deduct today's returns.
      const todayReturns = await this.repo.list('salesReturns', r => r.date === today);
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

      let receivablesTotal = 0;
      for (const c of customers) {
        const cSales = sales.filter(s => s.customerId === c.id);
        for (const s of cSales) receivablesTotal += s.dueMinor;
      }

      let payablesTotal = 0;
      for (const s of suppliers) {
        const purchases = await this.repo.list('purchases', p => p.supplierId === s.id && p.status !== 'void');
        for (const p of purchases) payablesTotal += p.dueMinor;
      }

      const accountBalances = {};
      for (const a of accounts) {
        accountBalances[a.name] = await BeeStore.accounts.balance(a.id);
      }

      const recentInvoices = sales.slice(-10).reverse();

      const salesByDay = {};
      for (let i = 29; i >= 0; i--) {
        const d = BeeStore.dates.addDays(today, -i);
        salesByDay[d] = 0;
      }
      for (const s of sales) {
        if (salesByDay[s.date] !== undefined) {
          salesByDay[s.date] += s.totalMinor;
        }
      }
      const windowReturns = await this.repo.list('salesReturns',
        r => salesByDay[r.date] !== undefined);
      for (const r of windowReturns) {
        salesByDay[r.date] -= r.refundMinor;
      }

      const overdueInstallments = [];
      for (const s of sales) {
        if (s.installmentPlan && s.status !== 'void') {
          for (const inst of (s.installmentPlan.schedule || [])) {
            if (inst.status !== 'paid' && inst.dueDate < today) {
              const customer = await this.repo.get('customers', s.customerId);
              overdueInstallments.push({
                customerName: customer ? customer.name : '',
                customerPhone: customer ? customer.phone : '',
                dueDate: inst.dueDate,
                amountMinor: inst.amountMinor,
              });
            }
          }
        }
      }

      // Top products by revenue
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
  }

  BeeStore.dashboard = new DashboardService(null);
  BeeStore.DashboardService = DashboardService;
  if (typeof module !== 'undefined') module.exports = DashboardService;
})(typeof window !== 'undefined' ? window : globalThis);
