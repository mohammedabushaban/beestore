(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
    const { el, formatMoney, formatDate, toast, safeWidget } = BeeStore.ui;

  let salesChart = null;
  let profitChart = null;
  let topProductsChart = null;

  async function render(container) {
    container.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div><span>جاري تحميل البيانات...</span></div>';
    
    const res = await BeeStore.api.dashboard.get();
    if (!res.ok) { 
      container.innerHTML = '<p class="alert alert-danger">' + res.error.message + '</p>'; 
      return; 
    }
    const d = res.data;

    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الرئيسية'));
    if (BeeStore.period) await BeeStore.period.scopeBar(container);

    // v2 §6.2/§9.5: banner when this month's recurring expenses are missing.
    await _maybeRecurringBanner(container);

    const prevMonth = BeeStore.dates.addMonths(BeeStore.dates.today().slice(0, 7), -1);
    const prevRange = BeeStore.dates.monthRange(prevMonth);
    let prev = null;
    try {
      const prevRes = await BeeStore.api.reports.profitAndLoss(prevRange.from, prevRange.to);
      if (prevRes.ok) prev = prevRes.data;
    } catch (e) { /* arrows are best-effort */ }
    const arrow = (cur, base) => {
      if (!base) return '';
      const pct = Math.round(((cur - base) / Math.abs(base)) * 10) / 10;
      if (pct === 0) return ' ➖ مثل الشهر الماضي';
      return (pct > 0 ? ' ▲ +' : ' ▼ ') + pct + '% عن الشهر الماضي';
    };

    // v2 §12.3: each block is an isolated widget — one failure can't blank the rest.
    await safeWidget(container, async () => {
      const cards = el('div', { class: 'cards-grid' }, [
        _card('مبيعات اليوم', formatMoney(d.today.revenue), d.today.invoiceCount + ' فاتورة', '💰'),
        _card('مبيعات الشهر', formatMoney(d.month.revenue), prev ? 'الشهر الماضي: ' + formatMoney(prev.netSales) + arrow(d.month.revenue, prev.netSales) : '', '📈'),
        _card('صافي ربح الشهر', formatMoney(d.month.netProfit), (d.month.netProfit >= 0 ? '📊' : '📉') + (prev ? arrow(d.month.netProfit, prev.netProfit) : '')),
        _card('مخزون (تكلفة)', formatMoney(d.inventory.cost), '', '📦'),
        _card('مخزون (بيع)', formatMoney(d.inventory.retail), '', '🏷️'),
        _card('ذمم الزبائن', formatMoney(d.receivablesTotal), '', '👥'),
        _card('ذمم الموردين', formatMoney(d.payablesTotal), '', '🏭'),
        _card('أصناف منخفضة', String(d.lowStockCount), d.lowStockCount > 0 ? '⚠️ تحتاج مراجعة' : '', '📉'),
      ]);
      container.appendChild(cards);
    });

    // v3-Lite §6: the phone is the only live copy; show backup freshness on
    // the dashboard, not only deep inside Settings.
    await safeWidget(container, async () => {
      const res = await BeeStore.api.backup.status();
      if (!res.ok) return;
      const status = res.data || {};
      let text;
      let cls = 'alert alert-info';
      if (!status.lastBackupAt) {
        text = '⚠️ لم تُنشئ نسخة احتياطية بعد. الهاتف هو النسخة الوحيدة من بياناتك.';
        cls = status.critical ? 'alert alert-danger' : 'alert alert-warning';
      } else {
        const method = status.lastBackupMethod === 'download'
          ? ' — نُزّلت على هذا الجهاز، انقلها خارج الهاتف'
          : status.lastBackupMethod === 'share'
            ? ' — محفوظة خارج الهاتف'
            : '';
        text = 'آخر نسخة احتياطية: ' + BeeStore.dates.formatDateTime(status.lastBackupAt) + method;
        if (status.critical) cls = 'alert alert-danger';
        else if (status.overdue) cls = 'alert alert-warning';
      }
      container.appendChild(el('div', { class: cls }, [
        el('span', {}, text + ' '),
        el('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          onclick: async function () {
            if (!BeeStore.backupUI) return;
            const result = await BeeStore.backupUI.shareBackup();
            if (result && result.ok && result.data && result.data.method !== 'cancelled') {
              render(container);
            }
          },
        }, 'نسخ الآن'),
      ]));
    });

    // v2 §9.5: payroll status for the current month + selected-month strip.
    await safeWidget(container, async () => {
      await _payrollStatusLine(container);
      if (BeeStore.period && BeeStore.period.get().mode === 'month' &&
        BeeStore.period.get().month !== BeeStore.dates.today().slice(0, 7)) {
        await _selectedMonthStrip(container);
      }
    });

    await safeWidget(container, async () => {
      const chartsRow = el('div', { class: 'cards-grid', style: 'grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));' }, [
        _chartCard('مبيعات آخر 30 يوم', 'sales-chart'),
        _chartCard('ربحية الشهر (مبيعات vs مصاريف)', 'profit-chart'),
      ]);
      container.appendChild(chartsRow);

      const bottomRow = el('div', { class: 'cards-grid', style: 'grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));' }, [
        _chartCard('أكثر 5 منتجات مبيعاً', 'top-products-chart', 'chart-container-sm'),
        _accountsCard(d),
      ]);
      container.appendChild(bottomRow);
    });

    if (d.overdueInstallments > 0) {
      container.appendChild(el('div', { class: 'alert alert-warning' },
        '⚠️ لديك ' + d.overdueInstallments + ' قسط متأخر'));
    }

    await safeWidget(container, async () => {
      const recentSection = el('div', { class: 'card' }, [
        el('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' }, [
          el('h3', {}, 'آخر الفواتير'),
          el('button', { class: 'btn btn-sm btn-secondary', onclick: () => BeeStore.router.navigate('/invoices') }, 'عرض الكل'),
        ]),
        el('div', { class: 'recent-invoices' },
          d.recentInvoices.slice(0, 10).map(inv =>
            el('div', { class: 'recent-invoice' }, [
              el('span', {}, inv.number),
              el('span', {}, formatDate(inv.date)),
              el('span', {}, formatMoney(inv.totalMinor)),
              inv.status ? el('span', { class: 'badge ' + _statusBadgeClass(inv.status) }, _statusLabel(inv.status)) : null,
            ])
          )
        ),
      ]);
      container.appendChild(recentSection);
    });

    setTimeout(() => {
      _renderCharts(d);
    }, 100);
  }

  function _card(title, value, sub, icon) {
    return el('div', { class: 'card stat-card' }, [
      el('div', { style: 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;' }, [
        el('div', { class: 'stat-title' }, title),
        icon ? el('div', { style: 'font-size: 24px; opacity: 0.7;' }, icon) : null,
      ]),
      el('div', { class: 'stat-value' }, value),
      sub ? el('div', { class: 'stat-sub' }, sub) : null,
    ]);
  }

  function _chartCard(title, canvasId, chartClass = 'chart-container') {
    return el('div', { class: 'card' }, [
      el('h3', { style: 'margin-bottom: 16px;' }, title),
      el('div', { class: chartClass }, [
        el('canvas', { id: canvasId }),
      ]),
    ]);
  }

  function _accountsCard(d) {
    return el('div', { class: 'card' }, [
      el('h3', { style: 'margin-bottom: 16px;' }, 'أرصدة الحسابات'),
      el('div', { class: 'balances-grid' },
        Object.entries(d.balances).map(([name, bal]) =>
          el('div', { class: 'balance-item' }, [
            el('span', { class: 'balance-name' }, name),
            el('span', { class: 'balance-value' + (bal < 0 ? ' text-danger' : '') }, formatMoney(bal)),
          ])
        )
      ),
    ]);
  }

  function _statusBadgeClass(status) {
    const classes = {
      paid: 'badge-success', partial: 'badge-warning', unpaid: 'badge-danger', void: 'badge-muted',
    };
    return classes[status] || 'badge-muted';
  }

  function _statusLabel(status) {
    const labels = { paid: 'مدفوع', partial: 'مدفوع جزئياً', unpaid: 'غير مدفوع', void: 'ملغي' };
    return labels[status] || status;
  }

  // v2 §6.2: never post silently — banner when recurring records are missing.
  async function _maybeRecurringBanner(container) {
    try {
      const res = await BeeStore.api.expenses.recurring();
      if (!res.ok) return;
      const month = BeeStore.dates.today().slice(0, 7);
      const templates = (res.data || []).filter(r => r.active !== false);
      if (templates.length === 0) return;
      const range = BeeStore.dates.monthRange(month);
      const listRes = await BeeStore.api.expenses.list({ from: range.from, to: range.to });
      if (!listRes.ok) return;
      const genIds = new Set((listRes.data || []).filter(e => e.recurringId).map(e => e.recurringId));
      const missing = templates.filter(t => !genIds.has(t.id)).length;
      if (missing > 0) {
        const banner = el('div', { class: 'alert alert-warning' }, [
          el('span', {}, 'مصاريف شهرية لم تُنشأ بعد (' + missing + ') — '),
          el('button', {
            class: 'btn btn-sm btn-warning',
            onclick: async () => {
              const g = await BeeStore.api.expenses.generateRecurring(month);
              if (g.ok) { toast('تم توليد المصاريف الشهرية (' + g.data.length + ')'); render(document.getElementById('page-content')); }
              else toast(g.error.message, 'error');
            },
          }, 'إنشاؤها الآن'),
        ]);
        container.appendChild(banner);
      }
    } catch (e) { /* banner is best-effort */ }
  }

  // v2 §9.5: payroll status for the current month.
  async function _payrollStatusLine(container) {
    try {
      const month = BeeStore.dates.today().slice(0, 7);
      const [empRes, payRes] = await Promise.all([
        BeeStore.api.employees.list(), BeeStore.api.payroll.list({ month }),
      ]);
      if (!empRes.ok || !payRes.ok) return;
      const active = (empRes.data || []).filter(e => e.active !== false);
      if (active.length === 0) return;
      const rows = payRes.data || [];
      const unpaid = rows.filter(p => p.status !== 'paid').length;
      const label = BeeStore.period ? BeeStore.period.monthLabel(month) : month;
      const text = rows.length < active.length
        ? 'رواتب ' + label + ': غير مجهزة (' + rows.length + '/' + active.length + ')'
        : (unpaid === 0
          ? 'رواتب ' + label + ': مدفوعة ✓'
          : 'رواتب ' + label + ': مجهزة، ' + unpaid + ' غير مدفوعة (مستحقة)');
      container.appendChild(el('div', {
        class: 'alert ' + (unpaid === 0 && rows.length === active.length ? 'alert-success' : 'alert-warning'),
      }, text));
    } catch (e) { /* best-effort */ }
  }

  // v2 §5: when the selected period is not the current month, show its KPIs.
  async function _selectedMonthStrip(container) {
    try {
      const m = BeeStore.period.selMonth();
      const res = await BeeStore.api.reports.monthReview(m);
      if (!res.ok) return;
      const k = res.data.kpis;
      container.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'الشهر المحدد: ' + BeeStore.period.monthLabel(m) + (res.data.closed ? ' 🔒' : '')),
        el('div', { class: 'cards-grid' }, [
          _card('صافي المبيعات', formatMoney(k.netSales), '', '💰'),
          _card('صافي الربح', formatMoney(k.netProfit), '', '📊'),
        ]),
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: () => BeeStore.router.navigate('/reports'),
        }, 'فتح تقرير الشهر الكامل'),
      ]));
    } catch (e) { /* best-effort */ }
  }

  function _renderCharts(d) {
    if (typeof Chart === 'undefined') return;

    _renderSalesChart(d.salesByDay);
    _renderProfitChart(d.month);
    _renderTopProductsChart(d.topProducts || []);
  }

  function _renderSalesChart(salesByDay) {
    const ctx = document.getElementById('sales-chart');
    if (!ctx) return;
    if (salesChart) salesChart.destroy();

    const labels = Object.keys(salesByDay);
    const data = Object.values(salesByDay);

    salesChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.map(l => l.slice(5)),
        datasets: [{
          label: 'المبيعات',
          data: data.map(v => v / 100),
          borderColor: '#F5B700',
          backgroundColor: 'rgba(245, 183, 0, 0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { 
            grid: { color: '#eef1f6' },
            ticks: { callback: v => BeeStore.money.format(v * 100) }
          }
        }
      }
    });
  }

  function _renderProfitChart(monthData) {
    const ctx = document.getElementById('profit-chart');
    if (!ctx) return;
    if (profitChart) profitChart.destroy();

    const revenue = monthData.revenue / 100;
    const grossProfit = monthData.grossProfit / 100;
    const expenses = monthData.expenses / 100;
    const netProfit = monthData.netProfit / 100;

    profitChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['الإيرادات', 'الربح الإجمالي', 'المصاريف', 'صافي الربح'],
        datasets: [{
          label: 'المبلغ',
          data: [revenue, grossProfit, expenses, netProfit],
          backgroundColor: [
            'rgba(245, 183, 0, 0.85)',
            'rgba(22, 163, 74, 0.85)',
            'rgba(220, 38, 38, 0.85)',
            netProfit >= 0 ? 'rgba(22, 163, 74, 0.85)' : 'rgba(220, 38, 38, 0.85)'
          ],
          borderColor: [
            '#F5B700', '#16A34A', '#DC2626', netProfit >= 0 ? '#16A34A' : '#DC2626'
          ],
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { 
            grid: { color: '#eef1f6' },
            ticks: { callback: v => v.toLocaleString() }
          }
        }
      }
    });
  }

  function _renderTopProductsChart(topProducts) {
    const ctx = document.getElementById('top-products-chart');
    if (!ctx) return;
    if (topProductsChart) topProductsChart.destroy();

    if (topProducts.length === 0) {
      ctx.parentElement.innerHTML = '<p class="empty-state">لا توجد بيانات منتجات</p>';
      return;
    }

    const labels = topProducts.map(p => p.name.length > 15 ? p.name.slice(0, 15) + '...' : p.name);
    const data = topProducts.map(p => p.revenue / 100);

    topProductsChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: [
            '#F5B700', '#0EA5E9', '#16A34A', '#8B5CF6', '#F97316'
          ],
          borderWidth: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
          legend: { position: 'right', labels: { font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + BeeStore.money.format(ctx.raw * 100) } }
        }
      }
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.dashboard = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
