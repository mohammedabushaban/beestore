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
  }

  function _monthInput() {
    return input('month', BeeStore.period ? BeeStore.period.selMonth() : BeeStore.dates.today().slice(0, 7));
  }

  // v2 §9.1 Month Review — the owner's main monthly report.
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
      const res = await BeeStore.api.reports.monthReview(m);
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
      out.appendChild(el('div', { class: 'cards-grid' }, [
        _stat('صافي المبيعات', formatMoney(k.netSales)),
        _stat('مجمل الربح (' + k.margin + '%)', formatMoney(k.grossProfit)),
        _stat('المصاريف', formatMoney(k.expenses)),
        _stat('صافي الربح', formatMoney(k.netProfit)),
        _stat('عدد الفواتير', String(k.invoices)),
        _stat('متوسط الفاتورة', formatMoney(k.avgInvoice)),
        _stat('الوحدات المباعة', String(k.units)),
      ]));
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
            pnlRow('المصاريف التشغيلية', d.pnl.current.operatingExpenses, d.pnl.previous.operatingExpenses, d.pnl.lastYear.operatingExpenses, d.pnl.changePct.expenses),
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
        el('td', {}, 'خسائر مخزون (تلقائي)'), el('td', {}, formatMoney(d.expenses.stockLosses)), el('td', {}, '—'),
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
          el('tr', { class: 'total-row' }, [el('td', {}, 'النقد من العمليات'), el('td', {}, formatMoney(r.cashFromOperations))]),
          line('+ رأس مال داخل', r.capitalIn),
          line('− سحوبات', -r.withdrawals),
          el('tr', { class: 'total-row' }, [el('td', {}, 'التغير المحسوب'), el('td', {}, formatMoney(r.cashChange))]),
          el('tr', { class: 'total-row' }, [el('td', {}, 'التغير الفعلي'), el('td', {}, formatMoney(r.actualCashChange))]),
        ])]),
      ]));
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
            el('tr', {}, [el('td', {}, 'المصاريف التشغيلية'), el('td', {}, '(' + formatMoney(d.operatingExpenses) + ')')]),
            el('tr', {}, [el('td', {}, '  - الرواتب'), el('td', {}, '(' + formatMoney(d.salaryExpense) + ')')]),
            el('tr', {}, [el('td', {}, '  - خسائر المخزون'), el('td', {}, '(' + formatMoney(d.stockLosses) + ')')]),
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

    const rows = d.variants.map(v => [
      v.size + ' / ' + v.color,
      String(v.quantity),
      formatMoney(v.costMinor),
      formatMoney(v.priceMinor),
      formatMoney(v.quantity * v.costMinor),
    ]);

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
      resultDiv.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'الميزانية المبسطة كما في ' + dateInput.value),
        el('p', {}, d.balanced ? '✓ الميزانية متوازنة' : '⚠ الميزانية غير متوازنة'),
        el('div', { class: 'balances-grid' }, [
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'الأصول'),
            el('p', {}, 'النقدية: ' + formatMoney(d.assets.cashBalance)),
            el('p', {}, 'المخزون: ' + formatMoney(d.assets.inventoryValue)),
            el('p', {}, 'ذمم الزبائن: ' + formatMoney(d.assets.receivables)),
            el('p', {}, 'سلف الموظفين: ' + formatMoney(d.assets.advancesOutstanding)),
            el('p', { class: 'total-final' }, 'إجمالي الأصول: ' + formatMoney(d.assets.total)),
          ]),
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'الخصوم'),
            el('p', {}, 'ذمم الموردين: ' + formatMoney(d.liabilities.payables)),
            el('p', {}, 'أرصدة الزبائن: ' + formatMoney(d.liabilities.customerCredits)),
            el('p', { class: 'total-final' }, 'إجمالي الخصوم: ' + formatMoney(d.liabilities.total)),
          ]),
          el('div', { class: 'balance-section' }, [
            el('h4', {}, 'حقوق الملكية'),
            el('p', {}, 'رأس المال: ' + formatMoney(d.equity.capitalIn)),
            el('p', {}, 'السحوبات: ' + formatMoney(d.equity.withdrawals)),
            el('p', {}, 'الأرباح المحتجزة: ' + formatMoney(d.equity.retained)),
            el('p', { class: 'total-final' }, 'إجمالي حقوق الملكية: ' + formatMoney(d.equity.total)),
          ]),
        ]),
      ]));
    }
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.reports = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
