(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast } = BeeStore.ui;
  const { input, select } = BeeStore.dialogs;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'التقارير'));

    const content = el('div', { id: 'reports-content' });

    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: 'tab active', onclick: function () { _showTab('month', content); _setActiveTab(this); } }, 'تقرير الشهر'),
      el('button', { class: 'tab', onclick: function () { _showTab('pnl', content); _setActiveTab(this); } }, 'قائمة الدخل'),
      el('button', { class: 'tab', onclick: function () { _showTab('recon', content); _setActiveTab(this); } }, 'الربح ⇄ النقد'),
      el('button', { class: 'tab', onclick: function () { _showTab('compare', content); _setActiveTab(this); } }, 'مقارنة شهرين'),
      el('button', { class: 'tab', onclick: function () { _showTab('year', content); _setActiveTab(this); } }, 'نظرة سنوية'),
      el('button', { class: 'tab', onclick: function () { _showTab('sales', content); _setActiveTab(this); } }, 'المبيعات'),
      el('button', { class: 'tab', onclick: function () { _showTab('inventory', content); _setActiveTab(this); } }, 'تقييم المخزون'),
      el('button', { class: 'tab', onclick: function () { _showTab('receivables', content); _setActiveTab(this); } }, 'ذمم الزبائن'),
      el('button', { class: 'tab', onclick: function () { _showTab('payables', content); _setActiveTab(this); } }, 'ذمم الموردين'),
      el('button', { class: 'tab', onclick: function () { _showTab('balance', content); _setActiveTab(this); } }, 'الميزانية'),
      el('button', { class: 'tab', onclick: function () { _showTab('trial', content); _setActiveTab(this); } }, 'ميزان المراجعة'),
      el('button', { class: 'tab', onclick: function () { _showTab('ledger', content); _setActiveTab(this); } }, 'دفتر الأستاذ'),
      el('button', { class: 'tab', onclick: function () { _showTab('journal', content); _setActiveTab(this); } }, 'دفتر اليومية'),
      el('button', { class: 'tab', onclick: function () { _showTab('controls', content); _setActiveTab(this); } }, 'ضوابط ومراجعة'),
    ]);
    container.appendChild(tabs);
    container.appendChild(content);
    _showTab('month', content);
  }

  function _setActiveTab(btn) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  function _showTab(tab, container) {
    container.innerHTML = '';
    if (tab === 'month') _renderMonth(container);
    else if (tab === 'recon') _renderRecon(container);
    else if (tab === 'compare') _renderCompare(container);
    else if (tab === 'year') _renderYear(container);
    else if (tab === 'pnl') _renderPnL(container);
    else if (tab === 'sales') _renderSales(container);
    else if (tab === 'inventory') _renderInventory(container);
    else if (tab === 'receivables') _renderReceivables(container);
    else if (tab === 'payables') _renderPayables(container);
    else if (tab === 'balance') _renderBalance(container);
    else if (tab === 'trial') _renderTrialBalance(container);
    else if (tab === 'ledger') _renderLedger(container);
    else if (tab === 'journal') _renderJournal(container);
    else if (tab === 'controls') _renderControls(container);
  }

  function _monthInput() {
    return input('month', BeeStore.period ? BeeStore.period.selMonth() : BeeStore.dates.today().slice(0, 7));
  }

  // v2 §9.1 Month Review — the owner's main monthly report.
  // Controls & review: anomaly/fraud checks for a period, then the one-off
  // review of data recorded before the 2026-11-17 accounting fixes.
  async function _renderControls(container) {
    const toInput = input('date', BeeStore.dates.today());
    const fromInput = input('date', BeeStore.dates.addDays(BeeStore.dates.today(), -30));
    container.appendChild(_dateRow(fromInput, toInput, load));
    const out = el('div', {});
    const history = el('div', {});
    container.appendChild(out);
    container.appendChild(history);
    const table = (headers, rows) => el('div', { class: 'table-wrapper' },
      el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
      ]));
    const section = (title, count, body, emptyText) => el('div', { class: 'card' }, [
      el('h3', {}, title + ' (' + count + ')'),
      count ? body() : el('p', { class: 'empty-state' }, emptyText || '✓ لا شيء'),
    ]);
    const profileAr = (p) => (p === 'cashier' ? 'الكاشير' : 'المالك');
    await load();
    await loadHistory();


    async function load() {
      const res = await BeeStore.api.auditReview.anomalies({
        from: fromInput.value || undefined, to: toInput.value || undefined,
      });
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const a = res.data;
      out.innerHTML = '';
      out.appendChild(el('p', { class: 'form-hint' },
        'تنبيهات للمراجعة، وليست بالضرورة أخطاء: فواتير متطابقة خلال ' + a.duplicateMinutes +
        ' دقائق، خصم ' + a.discountPercent + '% فأكثر، بيع بأقل من التكلفة، والإلغاءات والمرتجعات حسب المستخدم.'));
      out.appendChild(section('فواتير مكررة محتملة', a.duplicates.length, () => table(
        ['التاريخ', 'الأولى', 'الثانية', 'الفارق (دقيقة)', 'المبلغ', 'المستخدم'],
        a.duplicates.map(d => [d.date, d.first, d.second, String(d.minutesApart), formatMoney(d.totalMinor), profileAr(d.profile)]))));
      out.appendChild(section('خصومات كبيرة', a.largeDiscounts.length, () => table(
        ['الفاتورة', 'التاريخ', 'سعر القائمة', 'المبلغ', 'الخصم %', 'المستخدم'],
        a.largeDiscounts.map(d => [d.number, d.date, formatMoney(d.listMinor), formatMoney(d.totalMinor), d.discountPercent + '%', profileAr(d.profile)]))));
      out.appendChild(section('بيع بأقل من التكلفة', a.belowCost.length, () => table(
        ['الفاتورة', 'التاريخ', 'الصنف', 'الكمية', 'الإيراد', 'التكلفة', 'الخسارة'],
        a.belowCost.map(d => [d.number, d.date, d.item, String(d.qty), formatMoney(d.revenueMinor), formatMoney(d.costMinor), formatMoney(d.lossMinor)]))));
      out.appendChild(section('الإلغاءات والمرتجعات حسب المستخدم', a.byProfile.length, () => table(
        ['المستخدم', 'إلغاءات', 'قيمة الإلغاءات', 'مرتجعات', 'قيمة المرتجعات', 'منها بدون فاتورة', 'قيمتها'],
        a.byProfile.map(r => [profileAr(r.profile), String(r.voids), formatMoney(r.voidMinor), String(r.returns),
          formatMoney(r.returnMinor), String(r.unlinkedReturns), formatMoney(r.unlinkedMinor)]))));
      out.appendChild(section('عجز الصندوق في الإقفالات', a.shortages.length, () => table(
        ['اليوم', 'العجز'], a.shortages.map(d => [d.date, formatMoney(d.shortageMinor)]))));
      out.appendChild(section('أصناف بمخزون سالب', a.negativeStock.length, () => table(
        ['الصنف', 'الكمية'], a.negativeStock.map(d => [d.item, String(d.quantity)]))));
    }

    async function loadHistory() {
      const res = await BeeStore.api.auditReview.historicalErrors();
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const h = res.data;
      history.innerHTML = '';
      history.appendChild(el('h3', {}, 'مراجعة البيانات المسجلة قبل إصلاحات التدقيق'));
      if (h.totals.findings === 0) {
        history.appendChild(el('p', { class: 'alert alert-success' },
          '✓ لا توجد مستندات قديمة تأثرت بالأخطاء التي أُصلحت.'));
        return;
      }
      history.appendChild(section('مرتجعات ردّت سعراً قبل خصم الفاتورة — زيادة ' +
        formatMoney(h.totals.overRefundMinor), h.discountReturns.length, () => el('div', {}, [
        el('p', { class: 'form-hint' }, h.guidance.discountReturns),
        table(['المرتجع', 'التاريخ', 'الفاتورة', 'الزبون', 'المبلغ المردود', 'الزيادة'],
          h.discountReturns.map(r => [r.returnNumber, r.date, r.saleNumber, r.customerName || 'نقدي',
            formatMoney(r.refundMinor), formatMoney(r.overRefundMinor)])),
      ])));
      history.appendChild(section('باقٍ سُجّل على بطاقة/تحويل بدل الصندوق — ' +
        formatMoney(h.totals.misattributedChangeMinor), h.mixedChange.length, () => el('div', {}, [
        el('p', { class: 'form-hint' }, h.guidance.mixedChange),
        table(['الفاتورة', 'اليوم', 'الطريقة', 'الباقي', 'عجز إقفال ذلك اليوم'],
          h.mixedChange.map(r => [r.saleNumber, r.date, r.method, formatMoney(r.changeMinor),
            r.dayClosed ? formatMoney(r.dayShortageMinor) : 'اليوم غير مُقفل'])),
      ])));
      history.appendChild(section('ضريبة فواتير قديمة لم تُعكس في المرتجع — ' +
        formatMoney(h.totals.taxNotReversedMinor), h.legacyTax.length, () => el('div', {}, [
        el('p', { class: 'form-hint' }, h.guidance.legacyTax),
        table(['المرتجع', 'التاريخ', 'الفاتورة', 'الضريبة'],
          h.legacyTax.map(r => [r.returnNumber, r.date, r.saleNumber, formatMoney(r.taxNotReversedMinor)])),
      ])));
    }
  }

  async function _renderMonth(container) {
    const mInput = _monthInput();
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');
    container.appendChild(el('div', { class: 'filter-row' }, [mInput, loadBtn]));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const m = mInput.value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) { toast('اختر شهراً صحيحاً', 'error'); return; }
      const [res, daysRes] = await Promise.all([
        BeeStore.api.reports.monthReview(m),
        BeeStore.api.dailyClosings.daysInMonth(m),
      ]);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      const k = d.kpis;
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'تقرير شهر ' + (BeeStore.period ? BeeStore.period.monthLabel(m) : m) + ' '
          + (d.closed ? '🔒 مُقفل' : '(مفتوح)')),
        el('p', { class: 'form-hint' },
          'شراء البضاعة لا يُنقص ربح الشهر — بل يحوّل النقد إلى مخزون. ينقص الربح عند بيع البضاعة (تكلفة البضاعة المباعة).'),
      ]));
      const kpiCards = [
        _stat('صافي المبيعات', formatMoney(k.netSales)),
        _stat('مجمل الربح (' + k.margin + '%)', formatMoney(k.grossProfit)),
        _stat('إجمالي المصاريف', formatMoney(k.grossExpenses)),
      ];
      if (k.gains > 0) {
        kpiCards.push(_stat('أرباح/فروقات (تُضاف للربح)', formatMoney(k.gains)));
      }
      kpiCards.push(
        _stat('صافي الربح', formatMoney(k.netProfit)),
        _stat('عدد الفواتير', String(k.invoices)),
        _stat('متوسط الفاتورة', formatMoney(k.avgInvoice)),
        _stat('الوحدات المباعة', String(k.units))
      );
      out.appendChild(el('div', { class: 'cards-grid' }, kpiCards));
      out.appendChild(el('p', { class: 'form-hint' },
        'صافي الربح = ربح المبيعات (' + formatMoney(k.salesProfit) + ')' +
        ' + أرباح/فروقات (' + formatMoney(k.gains) + ')'));

      // v3-Lite §4.6: days table + closed/unclosed counts + total differences.
      if (daysRes.ok) {
        const dd = daysRes.data;
        const diffLine = dd.totalDifferenceMinor < 0
          ? 'عجز ' + formatMoney(-dd.totalDifferenceMinor)
          : (dd.totalDifferenceMinor > 0
            ? 'زيادة ' + formatMoney(dd.totalDifferenceMinor)
            : formatMoney(0));
        const dayRows = dd.days.filter(row => row.activity || row.status === 'closed').map(row => {
          const status = row.status === 'closed'
            ? (row.noCount ? 'مُقفل بدون جرد' : 'مُقفل') : 'مفتوح';
          const diff = row.status === 'closed'
            ? (row.differenceMinor < 0 ? '−' + formatMoney(-row.differenceMinor)
              : (row.differenceMinor > 0 ? '+' + formatMoney(row.differenceMinor) : formatMoney(0)))
            : '—';
          const tr = el('tr', { style: 'cursor: pointer;' }, [
            el('td', { style: 'font-weight:700;' }, row.date),
            el('td', {}, formatMoney(row.salesMinor)),
            el('td', {}, String(row.invoicesCount)),
            el('td', {}, formatMoney(row.returnsMinor)),
            el('td', {}, formatMoney(row.expensesMinor)),
            el('td', {}, formatMoney(row.netCashMinor)),
            el('td', {}, status),
            el('td', {
              class: row.differenceMinor < 0 ? 'text-danger' : (row.differenceMinor > 0 ? 'cash-over' : ''),
              style: 'font-weight:700;',
            }, diff),
          ]);
          tr.onclick = () => {
            if (BeeStore.pages.days && BeeStore.pages.days.openReport) {
              BeeStore.pages.days.openReport(row.date, load);
            } else {
              BeeStore.router.navigate('/days');
            }
          };
          return tr;
        });
        out.appendChild(el('div', { class: 'card' }, [
          el('div', { class: 'day-home-head' }, [
            el('h4', {}, 'أيام الشهر'),
            el('button', {
              class: 'btn btn-sm btn-secondary',
              onclick: () => BeeStore.router.navigate('/days'),
            }, 'صفحة الأيام'),
          ]),
          el('p', { class: 'form-hint' },
            'مقفلة: ' + dd.counts.closed + ' · نشاط لم يُقفل: ' + dd.counts.unclosedActive +
            ' · إجمالي فروقات الصندوق: ' + diffLine),
          dayRows.length === 0
            ? el('p', { class: 'empty-state' }, 'لا أيام بها نشاط في هذا الشهر')
            : el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
              el('thead', {}, el('tr', {}, [
                el('th', {}, 'اليوم'), el('th', {}, 'المبيعات'), el('th', {}, 'فواتير'),
                el('th', {}, 'مرتجعات'), el('th', {}, 'مصاريف'), el('th', {}, 'صافي النقد'),
                el('th', {}, 'الحالة'), el('th', {}, 'الفرق'),
              ])),
              el('tbody', {}, dayRows),
            ])),
        ]));
      }

      const pct = (v) => (v === null || v === undefined) ? '—' : (v > 0 ? '+' : '') + v + '%';
      const pnlRow = (label, cur, prev, ly, ch) => el('tr', {}, [
        el('td', {}, label), el('td', {}, formatMoney(cur)),
        el('td', {}, formatMoney(prev)), el('td', {}, pct(ch)), el('td', {}, formatMoney(ly)),
      ]);
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'قائمة الدخل: الحالي | السابق | التغير % | نفس الشهر العام الماضي'),
        el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'البند'), el('th', {}, 'الحالي'), el('th', {}, 'السابق'),
            el('th', {}, 'التغير'), el('th', {}, 'العام الماضي'),
          ])),
          el('tbody', {}, [
            pnlRow('صافي المبيعات', d.pnl.current.netSales, d.pnl.previous.netSales, d.pnl.lastYear.netSales, d.pnl.changePct.netSales),
            pnlRow('تكلفة البضاعة', d.pnl.current.cogs, d.pnl.previous.cogs, d.pnl.lastYear.cogs, null),
            pnlRow('إجمالي المصاريف', d.pnl.current.expensesBeforeGains, d.pnl.previous.expensesBeforeGains, d.pnl.lastYear.expensesBeforeGains, null),
            pnlRow('أرباح/فروقات (تُخصم من المصاريف)', d.pnl.current.gains, d.pnl.previous.gains, d.pnl.lastYear.gains, null),
            pnlRow('صافي المصاريف التشغيلية', d.pnl.current.operatingExpenses, d.pnl.previous.operatingExpenses, d.pnl.lastYear.operatingExpenses, d.pnl.changePct.expenses),
            pnlRow('  منها فروقات الصندوق (عجز − / زيادة +)', d.pnl.current.cashDifference, d.pnl.previous.cashDifference, d.pnl.lastYear.cashDifference, null),
            pnlRow('ربح المبيعات', d.pnl.current.salesProfit, d.pnl.previous.salesProfit, d.pnl.lastYear.salesProfit, null),
            pnlRow('صافي الربح', d.pnl.current.netProfit, d.pnl.previous.netProfit, d.pnl.lastYear.netProfit, d.pnl.changePct.netProfit),
          ]),
        ])),
      ]));
      const catNames = new Set([...Object.keys(d.expenses.byCategory), ...Object.keys(d.expenses.previous)]);
      const catRows = [...catNames].map(n => el('tr', {}, [
        el('td', {}, n), el('td', {}, formatMoney(d.expenses.byCategory[n] || 0)),
        el('td', {}, formatMoney(d.expenses.previous[n] || 0)),
      ]));
      catRows.push(el('tr', { class: 'total-row' }, [
        el('td', {}, 'الرواتب (تلقائي)'), el('td', {}, formatMoney(d.expenses.salary)), el('td', {}, '—'),
      ]));
      catRows.push(el('tr', { class: 'total-row' }, [
        el('td', {}, 'فروقات مخزون (خسارة/ربح)'), el('td', {}, formatMoney(d.expenses.stockLosses)), el('td', {}, '—'),
      ]));
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'المصاريف حسب التصنيف (الحالي | السابق)'),
        el('table', { class: 'data-table' }, [el('tbody', {}, catRows)]),
      ]));
      const flow = d.cashflow;
      const flowLine = (label, v) => el('p', {}, label + ': ' + formatMoney(v));
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'التدفق النقدي'),
        flowLine('النقدية أول الشهر', flow.openTotal),
        ...Object.entries(flow.inflows).map(([t, v]) => flowLine('داخل (' + t + ')', v)),
        ...Object.entries(flow.outflows).map(([t, v]) => flowLine('خارج (' + t + ')', v)),
        flowLine('النقدية آخر الشهر', flow.closeTotal),
      ]));
      const balRow = (label, pair) => el('tr', {}, [
        el('td', {}, label), el('td', {}, formatMoney(pair[0])), el('td', {}, formatMoney(pair[1])),
      ]);
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'الأرصدة (أول الشهر ← آخره)'),
        el('table', { class: 'data-table' }, [el('tbody', {}, [
          balRow('المخزون (تكلفة)', d.balances.inventory),
          balRow('ذمم الزبائن', d.balances.receivables),
          balRow('ذمم الموردين', d.balances.payables),
          balRow('مصاريف مقدمة', d.balances.prepaid),
          balRow('رواتب مستحقة', d.balances.accrued),
          balRow('سلف الموظفين', d.balances.advances),
        ])]),
      ]));
      if (d.sales.topByQty.length > 0) {
        out.appendChild(el('div', { class: 'card' }, [
          el('h4', {}, 'أعلى 10 أصناف كمية'),
          el('table', { class: 'data-table' }, [el('tbody', {},
            d.sales.topByQty.map(p => el('tr', {}, [
              el('td', {}, (p.name || '') + ' ' + (p.size || '') + ' ' + (p.color || '')),
              el('td', {}, String(p.qty)), el('td', {}, formatMoney(p.profit)),
            ])))]),
        ]));
      }
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'الزبائن والرواتب'),
        el('p', {}, 'ديون جديدة: ' + formatMoney(d.customers.newCredit) + ' — تحصيلات: ' + formatMoney(d.customers.collected)),
        el('p', {}, 'سجلات الرواتب للشهر: ' + d.payroll.length),
      ]));
      out.appendChild(el('button', { class: 'btn btn-info no-print', onclick: () => window.print() }, 'طباعة'));
    }
  }

  function _stat(title, value) {
    return el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-title' }, title),
      el('div', { class: 'stat-value' }, value),
    ]);
  }

  // v3-Lite §4.3: shortage increases operating expenses, surplus decreases
  // them. Negative cashDifference = عجز, positive = زيادة.
  function _cashDiffText(v) {
    const n = Number(v) || 0;
    if (n < 0) return 'عجز ' + formatMoney(-n);
    if (n > 0) return 'زيادة ' + formatMoney(n);
    return formatMoney(0);
  }

  // Expenses are shown in parentheses, but a negative net expense is income
  // (a surplus/gain), so parentheses would read as a double negative.
  function _expenseText(v) {
    const n = Number(v) || 0;
    if (n < 0) return 'دخل ' + formatMoney(-n);
    return '(' + formatMoney(n) + ')';
  }

  // v2 §9.3 Profit ⇄ Cash reconciliation.
  async function _renderRecon(container) {
    const mInput = _monthInput();
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');
    container.appendChild(el('div', { class: 'filter-row' }, [mInput, loadBtn]));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const res = await BeeStore.api.reports.profitCashReconciliation(mInput.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const r = res.data;
      const line = (label, v) => el('tr', {}, [el('td', {}, label), el('td', {}, formatMoney(v))]);
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'لماذا يختلف الربح عن النقد؟ — ' + mInput.value),
        el('p', {}, r.matches ? '✓ مطابَق مع التغير الفعلي للنقدية' : '⚠ غير مطابَق — راجع البيانات'),
        el('table', { class: 'data-table' }, [el('tbody', {}, [
          line('صافي الربح', r.netProfit),
          line('− الزيادة في المخزون', -r.deltas.inventory),
          line('− الزيادة في ذمم الزبائن', -r.deltas.receivables),
          line('− الزيادة في المصاريف المقدمة', -r.deltas.prepaid),
          line('+ الزيادة في ذمم الموردين', r.deltas.payables),
          line('+ الزيادة في الرواتب المستحقة', r.deltas.accrued),
          line('− الزيادة في السلف', -r.deltas.advances),
          line('+ الزيادة في أرصدة الزبائن الدائنة', r.deltas.customerCredits || 0),
          el('tr', { class: 'total-row' }, [el('td', {}, 'النقد من العمليات'), el('td', {}, formatMoney(r.cashFromOperations))]),
          line('+ رأس مال داخل', r.capitalIn),
          line('− سحوبات', -r.withdrawals),
          line('+ أرصدة افتتاحية مُدخلة خلال الشهر', r.openingBalances || 0),
          el('tr', { class: 'total-row' }, [el('td', {}, 'التغير المحسوب'), el('td', {}, formatMoney(r.cashChange))]),
          el('tr', { class: 'total-row' }, [el('td', {}, 'التغير الفعلي'), el('td', {}, formatMoney(r.actualCashChange))]),
        ])]),
      ]));
      if (r.activities) {
        const a = r.activities;
        out.appendChild(el('div', { class: 'card' }, [
          el('h3', {}, 'التدفقات النقدية حسب النشاط (من القيود)'),
          el('table', { class: 'data-table' }, [el('tbody', {}, [
            line('الأنشطة التشغيلية', a.operating),
            line('الأنشطة الاستثمارية (أصول ثابتة)', a.investing),
            line('الأنشطة التمويلية (رأس مال / مسحوبات)', a.financing),
            line('أرصدة افتتاحية', a.opening),
            el('tr', { class: 'total-row' }, [el('td', {}, 'صافي التغير في النقدية'), el('td', {}, formatMoney(a.total))]),
          ])]),
        ]));
      }
    }
  }

  // v2 §9.4 Compare two months.
  async function _renderCompare(container) {
    const aInput = _monthInput();
    const bInput = input('month', BeeStore.dates.today().slice(0, 7));
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'قارن');
    container.appendChild(el('div', { class: 'filter-row' }, [aInput, bInput, loadBtn]));
    const out = el('div', {});
    container.appendChild(out);

    async function load() {
      const res = await BeeStore.api.reports.compareMonths(aInput.value, bInput.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const { a, b, diff, catDiff } = res.data;
      const labels = {
        netSales: 'صافي المبيعات', cogs: 'تكلفة البضاعة', grossProfit: 'مجمل الربح',
        operatingExpenses: 'المصاريف التشغيلية', salaryExpense: 'الرواتب',
        stockLosses: 'خسائر المخزون', netProfit: 'صافي الربح',
      };
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'مقارنة ' + a.month + ' × ' + b.month),
        el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'البند'), el('th', {}, a.month), el('th', {}, b.month), el('th', {}, 'الفرق'),
          ])),
          el('tbody', {}, Object.keys(labels).map(k => el('tr', {}, [
            el('td', {}, labels[k]), el('td', {}, formatMoney(a[k])),
            el('td', {}, formatMoney(b[k])), el('td', {}, formatMoney(diff[k])),
          ]))),
        ])),
      ]));
      const cats = Object.keys(catDiff);
      if (cats.length > 0) {
        out.appendChild(el('div', { class: 'card' }, [
          el('h4', {}, 'التصنيفات'),
          el('table', { class: 'data-table' }, [el('tbody', {},
            cats.map(c => el('tr', {}, [el('td', {}, c), el('td', {}, formatMoney(catDiff[c]))])))]),
        ]));
      }
    }
  }

  // v2 §9.2 Year overview: 12 monthly columns + total + status.
  async function _renderYear(container) {
    const yInput = input('number', String(new Date().getFullYear()), { min: 2000, max: 2100 });
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');
    container.appendChild(el('div', { class: 'filter-row' }, [yInput, loadBtn]));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const res = await BeeStore.api.reports.yearOverview(yInput.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      const head = [el('th', {}, 'البند'), ...d.months.map(m => el('th', {}, m.month.slice(5))), el('th', {}, 'الإجمالي')];
      const row = (label, get) => el('tr', {}, [
        el('td', {}, label),
        ...d.months.map(m => el('td', {
          style: m.month === d.best || m.month === d.worst ? 'font-weight:bold;' : '',
        }, formatMoney(get(m)))),
        el('td', {}, formatMoney(d.totals[get.key])),
      ]);
      const defs = [
        ['صافي المبيعات', 'netSales'], ['تكلفة البضاعة', 'cogs'], ['مجمل الربح', 'grossProfit'],
        ['المصاريف', 'expenses'], ['صافي الربح', 'netProfit'], ['التغير في النقد', 'cashChange'],
      ];
      out.innerHTML = '';
      out.appendChild(el('p', {}, 'أفضل شهر: ' + d.best + ' — أسوأ شهر: ' + d.worst));
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'نظرة على سنة ' + d.year),
        el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, head)),
          el('tbody', {}, defs.map(([label, key]) => {
            const get = (m) => m[key];
            get.key = key;
            return row(label, get);
          })),
          el('tbody', {}, [el('tr', {}, [
            el('td', {}, 'الحالة'),
            ...d.months.map(m => el('td', {}, m.closed ? '🔒' : (m.netSales || m.expenses ? 'مفتوح' : '—'))),
            el('td', {}, ''),
          ])]),
        ])),
      ]));
    }
  }


  async function _renderPnL(container) {
    const fromInput = input('date', BeeStore.dates.startOfMonth());
    const toInput = input('date', BeeStore.dates.today());
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');

    container.appendChild(el('div', { class: 'filter-row' }, [fromInput, toInput, loadBtn]));

    const resultDiv = el('div', { id: 'pnl-result' });
    container.appendChild(resultDiv);

    async function load() {
      const res = await BeeStore.api.reports.profitAndLoss(fromInput.value, toInput.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      resultDiv.innerHTML = '';
      resultDiv.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'قائمة الدخل'),
        el('p', {}, 'من ' + fromInput.value + ' إلى ' + toInput.value),
        el('table', { class: 'data-table' }, [
          el('tbody', {}, [
            el('tr', {}, [el('td', {}, 'صافي المبيعات'), el('td', {}, formatMoney(d.netSales))]),
            el('tr', {}, [el('td', {}, 'تكلفة البضاعة المباعة'), el('td', {}, '(' + formatMoney(d.cogs) + ')')]),
            el('tr', { class: 'total-row' }, [el('td', {}, 'مجمل الربح'), el('td', {}, formatMoney(d.grossProfit))]),
            el('tr', {}, [el('td', {}, 'هامش الربح'), el('td', {}, d.margin + '%')]),
            el('tr', {}, [el('td', {}, 'إجمالي المصاريف (قبل الفروقات)'), el('td', {}, formatMoney(d.expensesBeforeGains))]),
            el('tr', {}, [el('td', {}, 'أرباح/فروقات (تُضاف)'), el('td', {}, formatMoney(d.gains))]),
            el('tr', {}, [el('td', {}, 'المصاريف التشغيلية (صافي)'), el('td', {}, _expenseText(d.operatingExpenses))]),
            el('tr', {}, [el('td', {}, '  - الرواتب'), el('td', {}, _expenseText(d.salaryExpense))]),
            el('tr', {}, [el('td', {}, '  - خسائر المخزون'), el('td', {}, _expenseText(d.stockLosses))]),
            el('tr', {}, [el('td', {}, '  - فروقات الصندوق (عجز/زيادة)'), el('td', {}, _cashDiffText(d.cashDifference))]),
            el('tr', { class: 'total-row' }, [el('td', {}, 'ربح المبيعات'), el('td', {}, formatMoney(d.salesProfit))]),
            el('tr', { class: 'total-row' }, [el('td', {}, 'صافي الربح'), el('td', {}, formatMoney(d.netProfit))]),
          ]),
        ]),
      ]));

      if (Object.keys(d.expensesByCategory).length > 0) {
        const catRows = Object.entries(d.expensesByCategory).map(([name, amt]) =>
          el('tr', {}, [el('td', {}, name), el('td', {}, formatMoney(amt))])
        );
        resultDiv.appendChild(el('div', { class: 'card' }, [
          el('h4', {}, 'المصاريف حسب التصنيف'),
          el('table', { class: 'data-table' }, [el('tbody', {}, catRows)]),
        ]));
      }
    }
  }

  async function _renderSales(container) {
    const fromInput = input('date', BeeStore.dates.startOfMonth());
    const toInput = input('date', BeeStore.dates.today());
    const groupSelect = select([
      { value: 'day', label: 'يومي' },
      { value: 'customer', label: 'حسب الزبون' },
      { value: 'payment', label: 'حسب طريقة الدفع' },
    ], 'day');
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');

    container.appendChild(el('div', { class: 'filter-row' }, [fromInput, toInput, groupSelect, loadBtn]));

    const resultDiv = el('div', { id: 'sales-result' });
    container.appendChild(resultDiv);

    async function load() {
      const res = await BeeStore.api.reports.salesReport(fromInput.value, toInput.value, groupSelect.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      resultDiv.innerHTML = '';
      const keys = Object.keys(d).sort();
      const rows = keys.map(key => {
        const g = d[key];
        return el('tr', {}, [
          el('td', {}, key),
          el('td', {}, g.count + ' فاتورة'),
          el('td', {}, formatMoney(g.total)),
          el('td', {}, g.returns > 0 ? '-' + formatMoney(g.returns) : '-'),
          el('td', { style: 'font-weight:600' }, formatMoney(g.net)),
        ]);
      });
      const totals = keys.reduce((acc, k) => {
        acc.total += d[k].total; acc.returns += d[k].returns; acc.net += d[k].net;
        return acc;
      }, { total: 0, returns: 0, net: 0 });
      rows.push(el('tr', { style: 'font-weight:700; border-top:2px solid #ddd' }, [
        el('td', {}, 'الإجمالي'),
        el('td', {}, ''),
        el('td', {}, formatMoney(totals.total)),
        el('td', {}, totals.returns > 0 ? '-' + formatMoney(totals.returns) : '-'),
        el('td', {}, formatMoney(totals.net)),
      ]));
      resultDiv.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'تقرير المبيعات'),
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'البند'), el('th', {}, 'العدد'), el('th', {}, 'الإجمالي'),
            el('th', {}, 'المرتجعات'), el('th', {}, 'الصافي'),
          ])),
          el('tbody', {}, rows),
        ]),
      ]));
    }
  }

  async function _renderInventory(container) {
    const res = await BeeStore.api.reports.inventoryValuation();
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const d = res.data;

    container.appendChild(el('div', { class: 'cards-grid' }, [
      el('div', { class: 'card stat-card' }, [
        el('div', { class: 'stat-title' }, 'قيمة المخزون (تكلفة)'),
        el('div', { class: 'stat-value' }, formatMoney(d.totalCost)),
      ]),
      el('div', { class: 'card stat-card' }, [
        el('div', { class: 'stat-title' }, 'قيمة المخزون (بيع)'),
        el('div', { class: 'stat-value' }, formatMoney(d.totalRetail)),
      ]),
      el('div', { class: 'card stat-card' }, [
        el('div', { class: 'stat-title' }, 'الربح المتوقع'),
        el('div', { class: 'stat-value' }, formatMoney(d.potentialProfit)),
      ]),
    ]));

    const rows = d.variants.map(v => {
      const variantLabel = [v.size, v.color].filter(Boolean).join(' / ');
      const name = v.productName || v.productItemCode || v.itemCode || v.barcode ||
        'صنف غير معروف';
      return [
        variantLabel ? name + ' — ' + variantLabel : name,
        String(v.quantity),
        formatMoney(v.avgCostMinor != null ? v.avgCostMinor : v.costMinor),
        formatMoney(v.priceMinor),
        formatMoney(v.valueMinor != null ? v.valueMinor : v.quantity * v.costMinor),
      ];
    });

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'تفاصيل الأصناف'),
      el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'الصنف'), el('th', {}, 'الكمية'), el('th', {}, 'التكلفة'),
            el('th', {}, 'السعر'), el('th', {}, 'القيمة (تكلفة)'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ),
    ]));
  }

  async function _renderReceivables(container) {
    const res = await BeeStore.api.reports.receivablesAging();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    if (res.data.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد ذمم زبائن'));
      return;
    }

    const rows = res.data.map(r => [
      r.customerName,
      r.phone || '-',
      formatMoney(r.buckets['0-30']),
      formatMoney(r.buckets['31-60']),
      formatMoney(r.buckets['61-90']),
      formatMoney(r.buckets['90+']),
      formatMoney(r.total),
    ]);

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'ذمم الزبائن'),
      el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'الزبون'), el('th', {}, 'الهاتف'), el('th', {}, '0-30 يوم'),
            el('th', {}, '31-60 يوم'), el('th', {}, '61-90 يوم'), el('th', {}, '+90 يوم'), el('th', {}, 'الإجمالي'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ),
    ]));
  }

  async function _renderPayables(container) {
    const res = await BeeStore.api.reports.payablesAging();
    if (!res.ok) { toast(res.error.message, 'error'); return; }

    if (res.data.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا توجد ذمم موردين'));
      return;
    }

    const rows = res.data.map(r => [
      r.supplierName,
      r.phone || '-',
      formatMoney(r.buckets['0-30']),
      formatMoney(r.buckets['31-60']),
      formatMoney(r.buckets['61-90']),
      formatMoney(r.buckets['90+']),
      formatMoney(r.total),
    ]);

    container.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'ذمم الموردين'),
      el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'المورد'), el('th', {}, 'الهاتف'), el('th', {}, '0-30 يوم'),
            el('th', {}, '31-60 يوم'), el('th', {}, '61-90 يوم'), el('th', {}, '+90 يوم'), el('th', {}, 'الإجمالي'),
          ])),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))),
        ])
      ),
    ]));
  }

  async function _renderBalance(container) {
    const dateInput = input('date', BeeStore.dates.today());
    const loadBtn = el('button', { class: 'btn btn-primary', onclick: load }, 'عرض');

    container.appendChild(el('div', { class: 'filter-row' }, [dateInput, loadBtn]));

    const resultDiv = el('div', { id: 'balance-result' });
    container.appendChild(resultDiv);

    async function load() {
      const res = await BeeStore.api.reports.balanceSnapshot(dateInput.value);
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      resultDiv.innerHTML = '';
      // Every component of each total is listed (zero lines hidden), so the
      // printed lines always add up to the totals (IAS 1 current/non-current).
      const row = (label, v, always) => (v || always)
        ? el('p', {}, label + ': ' + formatMoney(v || 0)) : null;
      const a = d.assets, l = d.liabilities, q = d.equity;
      const unpaid = (l.unpaidExpenses || 0) + (l.unpaidFixedAssets || 0);
      const payroll = (l.accruedSalaries != null ? l.accruedSalaries : (l.accrued || 0)) +
        (l.accruedWithholdings || 0) + (l.accruedEmployer || 0);
      const closedYears = q.retainedEarnings != null && q.retainedEarnings !== 0;
      resultDiv.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'الميزانية كما في ' + dateInput.value),
        el('p', {}, d.balanced ? '✓ الميزانية متوازنة' : '⚠ الميزانية غير متوازنة'),
        el('div', { class: 'balances-grid' }, [
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'الأصول المتداولة'),
            row('النقدية والبنوك', a.cashBalance - (a.clearingOutstanding || 0), true),
            row('مبالغ بطاقات/محافظ قيد التسوية', a.clearingOutstanding),
            row('المخزون', a.inventoryValue, true),
            row('ذمم الزبائن', a.receivables, true),
            row('مصاريف مدفوعة مقدماً', a.prepaid),
            row('سلف الموظفين', a.advancesOutstanding),
            (a.fixedAssetsCost || a.fixedAssetsNet) ? el('h4', {}, 'الأصول غير المتداولة') : null,
            row('الأصول الثابتة (التكلفة)', a.fixedAssetsCost),
            row('− مجمع الإهلاك', a.accumulatedDepreciation ? -a.accumulatedDepreciation : 0),
            row('صافي الأصول الثابتة', a.fixedAssetsNet),
            el('p', { class: 'total-final' }, 'إجمالي الأصول: ' + formatMoney(a.total)),
          ]),
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'الخصوم المتداولة'),
            row('ذمم الموردين', l.payables, true),
            row('أرصدة الزبائن الدائنة', l.customerCredits),
            row('مصاريف مستحقة غير مدفوعة', unpaid),
            row('رواتب ومستحقات رواتب', payroll),
            row('ضريبة مستحقة', l.taxPayable),
            l.endOfService ? el('h4', {}, 'الخصوم غير المتداولة') : null,
            row('مخصص نهاية الخدمة', l.endOfService),
            el('p', { class: 'total-final' }, 'إجمالي الخصوم: ' + formatMoney(l.total)),
          ]),
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'حقوق الملكية'),
            row('حقوق الملكية الافتتاحية', q.openingEquity),
            row('رأس المال المضاف', q.capitalIn),
            row('− المسحوبات', q.withdrawals ? -q.withdrawals : 0),
            closedYears ? row('أرباح مبقاة (سنوات مقفلة)', q.retainedEarnings, true) : null,
            closedYears
              ? row('أرباح السنة الحالية', q.currentProfit, true)
              : row('الأرباح المحتجزة', q.retained, true),
            el('p', { class: 'total-final' }, 'إجمالي حقوق الملكية: ' + formatMoney(q.total)),
            el('p', { class: 'total-final' }, 'الخصوم + حقوق الملكية: ' + formatMoney(l.total + q.total)),
          ]),
        ]),
      ]));
    }
  }

  // v5 §10 journal reports. Amounts come straight from journal lines; a
  // difference is shown, never plugged.
  function _moneyCell(minor) {
    return el('td', { class: 'num' }, minor ? formatMoney(minor) : '');
  }

  function _dateRow(fromInput, toInput, onLoad, extra) {
    return el('div', { class: 'filter-row' }, [
      el('label', {}, 'من'), fromInput, el('label', {}, 'إلى'), toInput,
      ...(extra || []),
      el('button', { class: 'btn btn-primary', onclick: onLoad }, 'عرض'),
    ]);
  }

  async function _renderTrialBalance(container) {
    const fromInput = input('date', '');
    const toInput = input('date', BeeStore.dates.today());
    container.appendChild(_dateRow(fromInput, toInput, load));
    container.appendChild(el('p', { class: 'form-hint' },
      'اترك "من" فارغاً لعرض الأرصدة التراكمية حتى التاريخ، أو حدده لعرض حركة الفترة فقط.'));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const res = await BeeStore.api.journal.trialBalance({
        from: fromInput.value || undefined, to: toInput.value || undefined,
      });
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      out.innerHTML = '';
      const rows = d.accounts.map(a => el('tr', {}, [
        el('td', {}, a.code || ''),
        el('td', {}, a.nameAr),
        _moneyCell(a.debitMinor),
        _moneyCell(a.creditMinor),
        _moneyCell(a.balanceMinor > 0 ? a.balanceMinor : 0),
        _moneyCell(a.balanceMinor < 0 ? -a.balanceMinor : 0),
      ]));
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'ميزان المراجعة ' + (d.from ? 'من ' + d.from + ' ' : '') + (d.to ? 'حتى ' + d.to : '')),
        el('p', {}, d.balanced
          ? '✓ الميزان متوازن (' + d.entryCount + ' قيد)'
          : '⚠ الميزان غير متوازن — الفرق ' + formatMoney(d.differenceMinor)),
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'الرمز'), el('th', {}, 'الحساب'),
              el('th', { class: 'num' }, 'حركة مدينة'), el('th', { class: 'num' }, 'حركة دائنة'),
              el('th', { class: 'num' }, 'رصيد مدين'), el('th', { class: 'num' }, 'رصيد دائن'),
            ])),
            el('tbody', {}, rows),
            el('tfoot', {}, el('tr', {}, [
              el('td', {}, ''), el('td', {}, 'الإجمالي'),
              _moneyCell(d.totalDebitMinor), _moneyCell(d.totalCreditMinor),
              _moneyCell(d.accounts.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0)),
              _moneyCell(d.accounts.reduce((s, a) => s + Math.max(0, -a.balanceMinor), 0)),
            ])),
          ])),
      ]));
    }
  }

  async function _renderLedger(container) {
    const chartRes = await BeeStore.api.chart.list();
    if (!chartRes.ok) { toast(chartRes.error.message, 'error'); return; }
    const accounts = chartRes.data.slice().sort((a, b) =>
      String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    if (accounts.length === 0) {
      container.appendChild(el('p', { class: 'empty-state' }, 'لا يوجد دليل حسابات بعد'));
      return;
    }
    const accountSelect = select(accounts.map(a => ({
      value: a.id, label: a.code + ' — ' + a.nameAr + (a.active === false ? ' (موقوف)' : ''),
    })), accounts[0].id);
    const month = BeeStore.dates.today().slice(0, 7);
    const fromInput = input('date', month + '-01');
    const toInput = input('date', BeeStore.dates.today());
    container.appendChild(_dateRow(fromInput, toInput, load, [accountSelect]));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const res = await BeeStore.api.journal.generalLedger({
        accountId: accountSelect.value,
        from: fromInput.value || undefined, to: toInput.value || undefined,
      });
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const d = res.data;
      out.innerHTML = '';
      const sourceLabel = (t) => BeeStore.journal ? BeeStore.journal.sourceLabel(t) : t;
      const rows = d.rows.map(r => el('tr', {
        class: 'clickable', onclick: () => BeeStore.journalView.show(null, [r.entryId], 'القيد ' + r.number),
      }, [
        el('td', { class: 'num' }, BeeStore.dates.formatDocDateTime(r)),
        el('td', { class: 'num' }, r.number),
        el('td', {}, sourceLabel(r.sourceType) + (r.reversalOf ? ' (عكسي)' : '')),
        el('td', {}, r.description + (r.memo ? ' — ' + r.memo : '')),
        _moneyCell(r.debitMinor),
        _moneyCell(r.creditMinor),
        el('td', { class: 'num' }, formatMoney(r.balanceMinor)),
      ]));
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'دفتر الأستاذ: ' + d.account.code + ' — ' + d.account.nameAr),
        el('p', { class: 'form-hint' }, 'الأرصدة موجبة للمدين وسالبة للدائن. اضغط على السطر لعرض القيد.'),
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'التاريخ'), el('th', {}, 'رقم القيد'), el('th', {}, 'المصدر'),
              el('th', {}, 'البيان'), el('th', { class: 'num' }, 'مدين'),
              el('th', { class: 'num' }, 'دائن'), el('th', { class: 'num' }, 'الرصيد'),
            ])),
            el('tbody', {}, [
              el('tr', {}, [
                el('td', { class: 'num' }, d.from || ''), el('td', {}, ''), el('td', {}, ''),
                el('td', {}, 'رصيد افتتاحي'), el('td', {}, ''), el('td', {}, ''),
                el('td', { class: 'num' }, formatMoney(d.openingMinor)),
              ]),
              ...rows,
            ]),
            el('tfoot', {}, el('tr', {}, [
              el('td', {}, ''), el('td', {}, ''), el('td', {}, ''), el('td', {}, 'الإجمالي / الرصيد الختامي'),
              _moneyCell(d.debitMinor), _moneyCell(d.creditMinor),
              el('td', { class: 'num' }, formatMoney(d.closingMinor)),
            ])),
          ])),
      ]));
    }
  }

  async function _renderJournal(container) {
    const month = BeeStore.dates.today().slice(0, 7);
    const fromInput = input('date', month + '-01');
    const toInput = input('date', BeeStore.dates.today());
    const searchInput = input('search', '', { placeholder: 'رقم القيد أو البيان' });
    container.appendChild(_dateRow(fromInput, toInput, load, [searchInput]));
    const out = el('div', {});
    container.appendChild(out);
    await load();

    async function load() {
      const res = await BeeStore.api.journal.list({
        from: fromInput.value || undefined, to: toInput.value || undefined,
        search: searchInput.value.trim() || undefined,
      });
      if (!res.ok) { toast(res.error.message, 'error'); return; }
      const entries = res.data;
      out.innerHTML = '';
      if (entries.length === 0) {
        out.appendChild(el('p', { class: 'empty-state' }, 'لا توجد قيود في هذه الفترة'));
        return;
      }
      const LIMIT = 300;
      const sourceLabel = (t) => BeeStore.journal ? BeeStore.journal.sourceLabel(t) : t;
      const rows = entries.slice(0, LIMIT).map((e) => {
        const total = (e.lines || []).reduce((s, l) => s + (Number(l.debitMinor) || 0), 0);
        return el('tr', {
          class: 'clickable', onclick: () => BeeStore.journalView.show(null, [e.id], 'القيد ' + e.number),
        }, [
          el('td', { class: 'num' }, e.number),
          el('td', { class: 'num' }, BeeStore.dates.formatDocDateTime(e)),
          el('td', {}, sourceLabel(e.sourceType) + (e.reversalOf ? ' (عكسي)' : '') +
            (e.isScheduled ? ' (مجدول)' : '')),
          el('td', {}, e.description || ''),
          el('td', { class: 'num' }, formatMoney(total)),
        ]);
      });
      out.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'دفتر اليومية (' + entries.length + ' قيد)'),
        entries.length > LIMIT
          ? el('p', { class: 'form-hint' }, 'يُعرض أحدث ' + LIMIT + ' قيد فقط — ضيّق الفترة أو استخدم البحث.')
          : null,
        el('div', { class: 'table-wrapper' },
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'رقم القيد'), el('th', {}, 'التاريخ'), el('th', {}, 'المصدر'),
              el('th', {}, 'البيان'), el('th', { class: 'num' }, 'المبلغ'),
            ])),
            el('tbody', {}, rows),
          ])),
      ]));
    }
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.reports = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
