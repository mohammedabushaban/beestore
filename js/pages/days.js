(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, toast, confirmDialog } = BeeStore.ui;
  const { input, select, formField, textarea } = BeeStore.dialogs;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function _today() { return BeeStore.dates.today(); }

  function _money(v) { return formatMoney(Number(v) || 0); }

  function _signedMoney(v) {
    const n = Number(v) || 0;
    return (n > 0 ? '+' : '') + formatMoney(n);
  }

  function _statusBadge(row) {
    if (row.status === 'closed') {
      return el('span', { class: 'badge badge-success' }, row.noCount ? 'مُقفل — بدون جرد' : 'مُقفل');
    }
    return row.activity
      ? el('span', { class: 'badge badge-warning' }, 'مفتوح')
      : el('span', { class: 'badge badge-muted' }, 'لا نشاط');
  }

  function _differenceEl(v) {
    const n = Number(v) || 0;
    return el('span', {
      class: n < 0 ? 'text-danger' : (n > 0 ? 'cash-over' : ''),
      style: 'font-weight:700;',
    }, _signedMoney(n));
  }

  function _loading() {
    return el('div', { class: 'loading-overlay' }, [
      el('div', { class: 'loading-spinner' }),
      el('span', {}, 'جاري التحميل...'),
    ]);
  }

  function _table(headers, rows) {
    const bodyRows = rows.map(row => {
      const cells = Array.isArray(row) ? row : [row];
      return el('tr', {}, cells.map(cell => {
        if (cell && cell.nodeType === 1 && cell.tagName === 'TD') return cell;
        return el('td', {}, cell);
      }));
    });
    return el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
      el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))),
      el('tbody', {}, bodyRows),
    ]));
  }

  function _kv(label, value, opts) {
    const o = opts || {};
    return [
      el('td', { style: o.total ? 'font-weight:800;' : '' }, label),
      el('td', {
        class: o.danger ? 'text-danger' : (o.success ? 'cash-over' : ''),
        style: 'font-weight:600;',
      }, value),
    ];
  }

  async function _latestClosedDate() {
    const res = await BeeStore.api.dailyClosings.list();
    if (!res.ok) return null;
    const dates = (res.data || []).filter(c => c.status === 'closed')
      .map(c => c.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  // ─────────────────────────────────────────────────────────────
  // Days page
  // ─────────────────────────────────────────────────────────────

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'الأيام'));
    if (BeeStore.period) await BeeStore.period.scopeBar(container);

    const preferred = BeeStore.period ? BeeStore.period.selMonth() : _today().slice(0, 7);
    const state = { month: MONTH_RE.test(preferred) ? preferred : _today().slice(0, 7) };

    const monthInput = input('month', state.month);
    const showBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        if (!MONTH_RE.test(monthInput.value)) { toast('اختر شهراً صحيحاً', 'error'); return; }
        state.month = monthInput.value;
        _renderMonth(out, state);
      },
    }, 'عرض');

    const dayInput = input('date', _today());
    const reportBtn = el('button', {
      class: 'btn btn-secondary',
      onclick: () => {
        if (!DATE_RE.test(dayInput.value)) { toast('اختر تاريخاً صحيحاً', 'error'); return; }
        openReport(dayInput.value, () => _renderMonth(out, state));
      },
    }, 'تقرير يوم');

    const closeTodayBtn = el('button', {
      class: 'btn btn-success',
      onclick: () => openWizard(_today(), () => _renderMonth(out, state)),
    }, 'إغلاق اليوم');

    container.appendChild(el('div', { class: 'filter-row' }, [
      el('label', { class: 'form-label' }, 'الشهر'), monthInput, showBtn,
      el('label', { class: 'form-label' }, 'يوم'), dayInput, reportBtn,
      closeTodayBtn,
    ]));

    const out = el('div', { id: 'days-content' });
    container.appendChild(out);
    await _renderMonth(out, state);
  }

  async function _renderMonth(out, state) {
    out.innerHTML = '';
    out.appendChild(_loading());
    const [daysRes, latest] = await Promise.all([
      BeeStore.api.dailyClosings.daysInMonth(state.month),
      _latestClosedDate(),
    ]);
    out.innerHTML = '';
    if (!daysRes.ok) {
      out.appendChild(el('p', { class: 'alert alert-danger' }, daysRes.error.message));
      return;
    }
    const d = daysRes.data;
    const today = _today();
    const monthLabel = BeeStore.period ? BeeStore.period.monthLabel(state.month) : state.month;

    out.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'أيام ' + monthLabel),
      el('p', { class: 'form-hint' },
        'الإقفال اليومي ضبط للصندوق وليس فترة محاسبية — الشهر يبقى الفترة. الأيام تُقفل بالترتيب، ويمكن إقفال يوم قديم بدون جرد.'),
    ]));

    out.appendChild(el('div', { class: 'cards-grid' }, [
      _stat('أيام بها نشاط', String(d.counts.active), 'من أصل ' + d.counts.total + ' يوم'),
      _stat('أيام مُقفلة', String(d.counts.closed), ''),
      _stat('نشاط لم يُقفل', String(d.counts.unclosedActive), d.counts.unclosedActive ? '⚠️ يحتاج مراجعة' : '✓ لا يوجد'),
      _stat('إجمالي فروقات الصندوق', _signedMoney(d.totalDifferenceMinor), 'للأيام المُقفلة هذا الشهر'),
    ]));

    // Cross-month warning list, because a forgotten day may belong to the
    // previous month. Today itself is not a warning.
    const unclosedRes = await BeeStore.api.dailyClosings.unclosedDays({ days: 60 });
    if (unclosedRes.ok && unclosedRes.data.length > 0) {
      const list = el('div', { class: 'day-warning-list' });
      for (const row of unclosedRes.data.slice(0, 10)) {
        list.appendChild(el('div', { class: 'day-warning-row' }, [
          el('span', { class: 'day-warning-date' }, formatDate(row.date)),
          el('span', {}, row.invoicesCount + ' فاتورة · ' + _money(row.salesMinor)),
          el('button', {
            class: 'btn btn-sm btn-warning',
            onclick: () => openWizard(row.date, () => _renderMonth(out, state)),
          }, 'إقفال'),
          el('button', {
            class: 'btn btn-sm btn-secondary',
            onclick: () => openReport(row.date, () => _renderMonth(out, state)),
          }, 'تقرير'),
        ]));
      }
      out.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, '⚠️ أيام بها نشاط ولم تُقفل'),
        list,
        unclosedRes.data.length > 10
          ? el('p', { class: 'form-hint' }, 'تظهر أول 10 أيام فقط. أقفل الأقدم أولاً.')
          : null,
      ]));
    }

    const rows = d.days.map(row => {
      const closed = row.status === 'closed';
      const actions = el('div', { class: 'day-actions' }, [
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: () => openReport(row.date, () => _renderMonth(out, state)),
        }, 'تقرير'),
      ]);
      if (!closed && row.date <= today) {
        actions.appendChild(el('button', {
          class: 'btn btn-sm btn-primary',
          onclick: () => openWizard(row.date, () => _renderMonth(out, state)),
        }, 'إقفال'));
      }
      if (closed && row.date === latest) {
        actions.appendChild(el('button', {
          class: 'btn btn-sm btn-warning',
          onclick: () => _reopenDay(row.date, () => _renderMonth(out, state)),
        }, 'إعادة فتح'));
      }
      return [
        el('span', { style: 'font-weight:700;' }, formatDate(row.date)),
        _money(row.salesMinor),
        String(row.invoicesCount),
        _money(row.returnsMinor),
        _money(row.expensesMinor),
        _money(row.netCashMinor),
        _statusBadge(row),
        closed ? _differenceEl(row.differenceMinor) : '—',
        actions,
      ];
    });

    out.appendChild(el('div', { class: 'card' }, [
      el('h4', {}, 'جدول الأيام'),
      rows.length === 0
        ? el('p', { class: 'empty-state' }, 'لا توجد أيام في هذا الشهر')
        : _table([
          'التاريخ', 'المبيعات', 'فواتير', 'مرتجعات', 'مصاريف',
          'صافي حركة النقد', 'الحالة', 'الفرق', 'إجراءات',
        ], rows),
    ]));
  }

  function _stat(title, value, sub) {
    return el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-title' }, title),
      el('div', { class: 'stat-value' }, value),
      sub ? el('div', { class: 'stat-sub' }, sub) : null,
    ]);
  }

  // ─────────────────────────────────────────────────────────────
  // Day Report
  // ─────────────────────────────────────────────────────────────

  async function openReport(date, onChange) {
    if (!DATE_RE.test(String(date || ''))) { toast('تاريخ غير صالح', 'error'); return; }
    const { overlay, dialog } = BeeStore.dialogs.openDialog(
      'تقرير يوم ' + date,
      el('div', { class: 'day-report-body' }),
      null,
      { large: true }
    );
    const body = dialog.querySelector('.dialog-body');
    const titleEl = dialog.querySelector('.dialog-header h3');
    const settingsRes = await BeeStore.api.settings.get();
    const settings = settingsRes.ok ? settingsRes.data : {};

    async function load(d) {
      body.innerHTML = '';
      body.appendChild(_loading());
      const res = await BeeStore.api.dailyClosings.report(d);
      if (!res.ok) {
        body.innerHTML = '';
        body.appendChild(el('p', { class: 'alert alert-danger' }, res.error.message));
        return;
      }
      const report = res.data;
      const latest = await _latestClosedDate();
      titleEl.textContent = 'تقرير يوم ' + formatDate(report.date);
      body.innerHTML = '';
      body.appendChild(_buildReportView(report, {
        settings,
        latestClosed: latest,
        reload: load,
        onChange,
        closeDialog: () => overlay.remove(),
      }));
    }

    await load(String(date));
  }

  function _buildReportView(report, ctx) {
    const wrap = el('div', { class: 'day-report' });
    const dateInput = input('date', report.date);
    const nav = el('div', { class: 'filter-row no-print day-report-nav' }, [
      el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => ctx.reload(BeeStore.dates.addDays(report.date, -1)),
      }, '▶ اليوم السابق'),
      dateInput,
      el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => {
          if (!DATE_RE.test(dateInput.value)) { toast('تاريخ غير صالح', 'error'); return; }
          ctx.reload(dateInput.value);
        },
      }, 'عرض'),
      el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => ctx.reload(BeeStore.dates.addDays(report.date, 1)),
      }, 'اليوم التالي ◀'),
    ]);
    wrap.appendChild(nav);

    const actions = el('div', { class: 'dialog-actions no-print day-report-actions' }, [
      el('button', {
        class: 'btn btn-sm btn-info',
        onclick: () => BeeStore.print.printDayReport(report, ctx.settings, 'A4'),
      }, 'طباعة / PDF A4'),
      el('button', {
        class: 'btn btn-sm btn-info',
        onclick: () => BeeStore.print.printDayReport(report, ctx.settings, '80mm'),
      }, 'طباعة 80mm'),
      el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => _shareReport(report),
      }, 'مشاركة التقرير'),
      el('button', {
        class: 'btn btn-sm btn-success',
        onclick: async () => {
          if (BeeStore.backupUI) await BeeStore.backupUI.shareBackup();
        },
      }, 'نسخة احتياطية الآن'),
    ]);
    if (report.status === 'closed' && report.date === ctx.latestClosed) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm btn-warning',
        onclick: () => _reopenDay(report.date, async () => {
          await ctx.reload(report.date);
          if (ctx.onChange) ctx.onChange();
        }),
      }, 'إعادة فتح اليوم'));
    }
    if (report.status !== 'closed' && report.date <= _today()) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm btn-success',
        onclick: () => {
          ctx.closeDialog();
          openWizard(report.date, ctx.onChange);
        },
      }, 'إغلاق هذا اليوم'));
    }
    wrap.appendChild(actions);

    const status = report.status === 'closed'
      ? (report.noCount ? 'مُقفل — بدون جرد نقدي' : 'مُقفل')
      : 'مفتوح';
    wrap.appendChild(el('div', { class: 'card day-report-head' }, [
      el('div', { class: 'day-report-title-row' }, [
        el('h3', {}, 'تقرير يوم ' + formatDate(report.date)),
        el('span', { class: 'badge ' + (report.status === 'closed' ? 'badge-success' : 'badge-warning') }, status),
      ]),
      report.closedAt
        ? el('p', { class: 'form-hint' }, 'وقت الإقفال: ' + BeeStore.dates.formatDateTime(report.closedAt))
        : el('p', { class: 'form-hint' }, 'هذا اليوم لم يُقفل بعد — الأرقام مباشرة من الدفاتر.'),
    ]));

    wrap.appendChild(el('div', { class: 'cards-grid day-report-kpis' }, [
      _stat('إجمالي المبيعات', _money(report.totalSalesMinor), report.invoicesCount + ' فاتورة'),
      _stat('متوسط الفاتورة', _money(report.averageInvoiceMinor), ''),
      _stat('المتوقع في الصندوق', _money(report.expectedCashMinor), 'الرصيد الافتتاحي ' + _money(report.openingCashMinor)),
      _stat('المعدود', report.countedCashMinor === null || report.countedCashMinor === undefined
        ? '—' : _money(report.countedCashMinor), report.status === 'closed' ? 'الفرق ' + _signedMoney(report.differenceMinor) : 'لم يُجرد'),
    ]));

    const methodRows = Object.keys(report.salesByMethod || {}).map(method => [
      (BeeStore.settings.methodLabel(ctx.settings, method) || method),
      _money(report.salesByMethod[method]),
    ]);
    const collectionRows = Object.keys(report.customerCollectionsByMethod || {}).map(method => [
      (BeeStore.settings.methodLabel(ctx.settings, method) || method),
      _money(report.customerCollectionsByMethod[method]),
    ]);
    wrap.appendChild(el('div', { class: 'day-report-grid' }, [
      el('div', { class: 'card' }, [
        el('h4', {}, 'المبيعات حسب طريقة الدفع (صافي المرتجعات)'),
        methodRows.length ? _table(['الطريقة', 'المبلغ'], methodRows)
          : el('p', { class: 'empty-state' }, 'لا مبيعات'),
        el('p', { class: 'form-hint' }, 'مرتجعات نقدية من الصندوق: ' + _money(report.returnsCashRefundMinor)),
      ]),
      el('div', { class: 'card' }, [
        el('h4', {}, 'تحصيلات الزبائن'),
        collectionRows.length ? _table(['الطريقة', 'المبلغ'], collectionRows)
          : el('p', { class: 'empty-state' }, 'لا تحصيلات'),
        el('p', { class: 'form-hint' }, 'ديون جديدة اليوم: ' + _money(report.openCreditMinor)),
      ]),
    ]));

    wrap.appendChild(el('div', { class: 'card' }, [
      el('h4', {}, 'مطابقة الصندوق'),
      _table(['البند', 'المبلغ'], [
        _kv('الرصيد الافتتاحي', _money(report.openingCashMinor)),
        _kv('+ مبيعات نقدية', _money(report.cashSalesMinor)),
        _kv('+ تحصيلات نقدية', _money(report.customerCollectionsCashMinor)),
        _kv('+ حركات نقدية أخرى', _money(report.cashInOtherMinor)),
        _kv('− مرتجعات من الصندوق', _money(report.returnsCashRefundMinor)),
        _kv('− مدفوعات موردين من الصندوق', _money(report.supplierCashPaymentsMinor)),
        _kv('− مصاريف من الصندوق', _money(report.cashExpensesMinor)),
        _kv('− حركات نقدية أخرى', _money(report.cashOutOtherMinor)),
        _kv('= المتوقع في الصندوق', _money(report.expectedCashMinor), { total: true }),
        ...(report.countedCashMinor === null || report.countedCashMinor === undefined ? [] : [
          _kv('المعدود', _money(report.countedCashMinor), { total: true }),
          _kv('الفرق (معدود − متوقع)', _signedMoney(report.differenceMinor), {
            danger: report.differenceMinor < 0,
            success: report.differenceMinor > 0,
          }),
          _kv('المُخرج (بنك/سحب)', _money(report.takenOutMinor)),
          _kv('الصندوق المتبقي', _money(report.retainedFloatMinor), { total: true }),
        ]),
      ]),
    ]));

    if (report.externalWarnings && report.externalWarnings.length > 0) {
      wrap.appendChild(el('div', { class: 'alert alert-warning' }, [
        el('strong', {}, '⚠️ فروقات الأجهزة الخارجية (لم تُسجّل قيود): '),
        ...report.externalWarnings.map(w => el('div', {},
          (BeeStore.settings.methodLabel(ctx.settings, w.method) || w.method) + ': ' + _signedMoney(w.differenceMinor))),
      ]));
    }

    if (report.expenses && report.expenses.length > 0) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'المصاريف'),
        _table(['البيان', 'المبلغ'], report.expenses.map(e => [e.description, _money(e.amountMinor)])),
      ]));
    }

    if (report.returns && report.returns.length > 0) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'المرتجعات'),
        _table(['الرقم', 'المبلغ', 'السبب'], report.returns.map(r => [
          r.number || '', _money(r.refundMinor), r.reason || '',
        ])),
      ]));
    }

    const side = el('div', { class: 'day-report-grid' }, []);
    if (report.topItems && report.topItems.length > 0) {
      side.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'أعلى 5 أصناف مبيعاً'),
        _table(['الصنف', 'الكمية', 'الإيراد'], report.topItems.map(i => [
          (i.productName || '') + ' ' + (i.size || '') + ' ' + (i.color || ''),
          String(i.qty), _money(i.revenueMinor),
        ])),
      ]));
    }
    if (report.lowStock && report.lowStock.length > 0) {
      side.appendChild(el('div', { class: 'card' }, [
        el('h4', {}, 'مخزون منخفض (أصناف بيعت اليوم)'),
        _table(['الصنف', 'المتبقي'], report.lowStock.map(v => [
          (v.size || '') + ' / ' + (v.color || ''), String(v.quantity),
        ])),
      ]));
    }
    if (side.children.length > 0) wrap.appendChild(side);

    wrap.appendChild(el('div', { class: 'card' }, [
      el('h4', {}, 'ملاحظات'),
      el('p', { class: 'day-report-note' }, report.note || '—'),
      el('div', { class: 'day-signature' }, [
        el('span', {}, 'توقيع المسؤول: ____________________'),
        el('span', {}, 'التاريخ: ' + formatDate(report.date)),
      ]),
    ]));

    return wrap;
  }

  async function _shareReport(report) {
    const textRes = await BeeStore.api.dailyClosings.textSummary(report);
    const text = textRes.ok ? textRes.data : ('تقرير يوم ' + report.date);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'تقرير يوم ' + report.date, text });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('تم نسخ ملخص اليوم — الصقه في واتساب');
    } catch (e) {
      BeeStore.dialogs.openDialog('ملخص اليوم', [
        el('p', { class: 'form-hint' }, 'انسخ النص يدوياً:'),
        el('textarea', { class: 'form-input', rows: 10, readonly: true }, text),
      ]);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 4-step closing wizard
  // ─────────────────────────────────────────────────────────────

  async function openWizard(date, onDone) {
    if (!DATE_RE.test(String(date || ''))) { toast('تاريخ غير صالح', 'error'); return; }
    const [previewRes, settingsRes, accountsRes] = await Promise.all([
      BeeStore.api.dailyClosings.preview(date),
      BeeStore.api.settings.get(),
      BeeStore.api.accounts.list(),
    ]);
    if (!previewRes.ok) { toast(previewRes.error.message, 'error'); return; }
    const preview = previewRes.data;
    if (preview.status === 'closed') {
      openReport(date, onDone);
      return;
    }
    const latestClosed = await _latestClosedDate();
    if (latestClosed && date < latestClosed) {
      toast('لا يمكن إقفال يوم أقدم بعد إقفال يوم أحدث (' + latestClosed + ') — أعد فتح الأيام الأحدث أولاً', 'error');
      return;
    }
    const settings = settingsRes.ok ? settingsRes.data : {};
    const accounts = accountsRes.ok ? accountsRes.data : [];
    const state = {
      date,
      preview,
      settings,
      accounts,
      step: 1,
      countedMajor: '',
      denomQty: {},
      noCount: false,
      externalValues: {},
      takenOutMode: 'none',
      takenOutMajor: '',
      bankAccountId: preview.bankAccountId || settings.defaultBankAccountId || '',
      note: '',
      record: null,
    };
    state.externalMethods = _externalMethods(settings, preview);
    state.banks = accounts.filter(a => a.type === 'bank' && a.active !== false);

    const steps = el('div', { class: 'day-steps' });
    const body = el('div', { class: 'day-wizard-body' });
    const actions = el('div', { class: 'dialog-actions day-wizard-actions' });
    const { overlay, dialog } = BeeStore.dialogs.openDialog(
      'إغلاق يوم ' + formatDate(date), [steps, body, actions], null, { large: true }
    );

    const next = (n) => {
      state.step = n;
      if (n === 4) state.note = state.note || '';
      renderStep();
    };
    const cancel = () => overlay.remove();

    function countedUsedMinor() {
      return state.noCount ? preview.expectedCashMinor : BeeStore.money.fromMajor(state.countedMajor);
    }
    function takenOutMinor() {
      return state.takenOutMode === 'none' ? 0 : BeeStore.money.fromMajor(state.takenOutMajor);
    }
    function denomTotalMinor() {
      let total = 0;
      for (const key of Object.keys(state.denomQty)) {
        const qty = Number(state.denomQty[key]) || 0;
        if (qty > 0) total += Math.round(Number(key) * 100) * qty;
      }
      return total;
    }
    function externalTotalsPayload() {
      const out = {};
      for (const method of state.externalMethods) {
        const raw = state.externalValues[method];
        if (raw !== undefined && String(raw).trim() !== '') {
          out[method] = BeeStore.money.fromMajor(raw);
        }
      }
      return out;
    }

    function renderSteps() {
      steps.innerHTML = '';
      const labels = ['الملخص', 'جرد النقد', 'إخراج النقد', 'التأكيد'];
      labels.forEach((label, i) => {
        const n = i + 1;
        const cls = state.step === 'done' || state.step > n ? 'done' : (state.step === n ? 'active' : '');
        steps.appendChild(el('div', { class: 'day-step ' + cls }, [
          el('span', { class: 'day-step-num' }, state.step === 'done' || state.step > n ? '✓' : String(n)),
          el('span', {}, label),
        ]));
      });
    }

    function renderActions(buttons) {
      actions.innerHTML = '';
      for (const b of buttons) actions.appendChild(b);
    }

    function renderStep() {
      renderSteps();
      body.innerHTML = '';
      if (state.step === 1) return renderSummary();
      if (state.step === 2) return renderCount();
      if (state.step === 3) return renderTakeOut();
      if (state.step === 4) return renderConfirm();
      return renderDone();
    }

    function renderSummary() {
      body.appendChild(el('div', { class: 'card day-wizard-summary' }, [
        el('h3', {}, 'ملخص يوم ' + formatDate(date)),
        el('p', { class: 'form-hint' },
          'الصندوق: ' + (preview.cashDrawerAccountName || '—') + ' — المتوقع محسوب من رصيد الصندوق آخر اليوم قبل سجلات الإقفال.'),
        _table(['البند', 'المبلغ'], [
          _kv('الرصيد الافتتاحي', _money(preview.openingCashMinor)),
          _kv('إجمالي المبيعات', _money(preview.totalSalesMinor) + ' (' + preview.invoicesCount + ' فاتورة)'),
          ...Object.keys(preview.salesByMethod || {}).map(method =>
            _kv('  ' + (BeeStore.settings.methodLabel(settings, method) || method) + ' (صافي)',
              _money(preview.salesByMethod[method]))),
          _kv('تحصيلات نقدية', _money(preview.customerCollectionsCashMinor)),
          _kv('مرتجعات نقدية', _money(preview.returnsCashRefundMinor)),
          _kv('مصاريف من الصندوق', _money(preview.cashExpensesMinor)),
          _kv('مدفوعات موردين من الصندوق', _money(preview.supplierCashPaymentsMinor)),
          _kv('حركات نقدية أخرى (داخل)', _money(preview.cashInOtherMinor)),
          _kv('حركات نقدية أخرى (خارج)', _money(preview.cashOutOtherMinor)),
          _kv('= المتوقع في الصندوق', _money(preview.expectedCashMinor), { total: true }),
        ]),
      ]));
      renderActions([
        el('button', { class: 'btn btn-secondary', onclick: cancel }, 'إلغاء'),
        el('button', { class: 'btn btn-primary', onclick: () => next(2) }, 'التالي: جرد النقد'),
      ]);
    }

    function renderCount() {
      const expected = preview.expectedCashMinor;

      const countedInput = input('number', state.countedMajor, {
        min: 0, step: '0.01', placeholder: '0.00', inputmode: 'decimal',
      });
      const diffEl = el('span', { style: 'font-weight:800;' }, '0.00');
      const denomTotalEl = el('span', {}, _money(denomTotalMinor()));

      function refreshDiff() {
        const diff = countedUsedMinor() - expected;
        diffEl.textContent = _signedMoney(diff);
        diffEl.className = diff < 0 ? 'text-danger' : (diff > 0 ? 'cash-over' : '');
        denomTotalEl.textContent = _money(denomTotalMinor());
        if (state.noCount) {
          countedInput.value = BeeStore.money.toMajor(expected);
          diffEl.textContent = _money(0);
          diffEl.className = '';
        }
      }

      countedInput.oninput = () => {
        if (state.noCount) return;
        state.countedMajor = countedInput.value;
        refreshDiff();
      };

      const noCountBox = el('input', {
        type: 'checkbox', id: 'day-no-count',
      });
      noCountBox.checked = state.noCount;
      noCountBox.onchange = () => {
        state.noCount = noCountBox.checked;
        countedInput.disabled = state.noCount;
        denomRows.querySelectorAll('input').forEach(i => { i.disabled = state.noCount; });
        if (state.noCount) countedInput.value = BeeStore.money.toMajor(expected);
        refreshDiff();
      };

      const denomRows = el('div', { class: 'denom-grid' });
      const denoms = (Array.isArray(settings.cashDenominations) && settings.cashDenominations.length)
        ? settings.cashDenominations.slice().sort((a, b) => Number(b) - Number(a))
        : [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.1];
      for (const denom of denoms) {
        const key = String(denom);
        const qtyInput = input('number', state.denomQty[key] || '', {
          min: 0, step: '1', inputmode: 'numeric', placeholder: '0',
        });
        qtyInput.oninput = () => {
          if (state.noCount) return;
          const qty = Math.max(0, Math.floor(Number(qtyInput.value) || 0));
          if (qty > 0) state.denomQty[key] = qty; else delete state.denomQty[key];
          if (Object.keys(state.denomQty).length > 0) {
            const total = denomTotalMinor();
            state.countedMajor = BeeStore.money.toMajor(total);
            countedInput.value = state.countedMajor;
          }
          refreshDiff();
        };
        denomRows.appendChild(el('div', { class: 'denom-row' }, [
          el('span', { class: 'denom-label' }, formatMoney(Math.round(Number(denom) * 100))),
          qtyInput,
        ]));
      }

      const externalBox = el('div', { class: 'external-totals' });
      for (const method of state.externalMethods) {
        const recorded = (preview.salesByMethod[method] || 0) +
          (preview.customerCollectionsByMethod[method] || 0);
        const extInput = input('number', state.externalValues[method] || '', {
          min: 0, step: '0.01', inputmode: 'decimal', placeholder: BeeStore.money.toMajor(recorded),
        });
        const warn = el('span', { class: 'form-hint' }, '');
        function refreshExternal() {
          if (String(extInput.value).trim() === '') { warn.textContent = ''; return; }
          const diff = BeeStore.money.fromMajor(extInput.value) - recorded;
          warn.textContent = diff === 0
            ? '✓ مطابق للمسجّل'
            : '⚠️ فرق ' + _signedMoney(diff) + ' — لن يُسجّل أي قيد';
          warn.className = 'form-hint ' + (diff === 0 ? 'cash-over' : 'text-danger');
        }
        extInput.oninput = () => {
          state.externalValues[method] = extInput.value;
          refreshExternal();
        };
        refreshExternal();
        externalBox.appendChild(el('div', { class: 'external-row' }, [
          el('span', { class: 'external-label' }, BeeStore.settings.methodLabel(settings, method) || method),
          el('div', { class: 'external-input' }, [
            extInput,
            el('span', { class: 'form-hint' }, 'المسجّل: ' + _money(recorded)),
            warn,
          ]),
        ]));
      }

      body.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'جرد النقد'),
        formField('النقد المعدود', countedInput, true),
        el('div', { class: 'day-difference-line' }, [
          el('span', {}, 'الفرق (معدود − متوقع): '), diffEl,
          el('span', { class: 'form-hint' }, ' — المتوقع ' + _money(expected)),
        ]),
        el('label', { class: 'day-no-count' }, [
          noCountBox,
          document.createTextNode(' إقفال بدون جرد نقدي (ليوم قديم منسي) — يُسجّل الفرق صفراً'),
        ]),
        el('div', { class: 'day-denom-header' }, [
          el('h4', {}, 'عدّاد الفئات (اختياري)'),
          el('span', { class: 'form-hint' }, 'الإجمالي: '), denomTotalEl,
        ]),
        denomRows,
        state.externalMethods.length > 0 ? el('div', {}, [
          el('h4', { style: 'margin-top:16px;' }, 'إجماليات الأجهزة الخارجية (اختياري)'),
          el('p', { class: 'form-hint' }, 'أدخل إجمالي جهاز البطاقة/البنك/المحفظة إن أردت؛ الفروقات تظهر كتنبيه فقط.'),
          externalBox,
        ]) : null,
      ]));
      refreshDiff();
      renderActions([
        el('button', { class: 'btn btn-secondary', onclick: () => next(1) }, 'السابق'),
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            if (!state.noCount) {
              if (String(state.countedMajor).trim() === '') {
                toast('أدخل النقد المعدود أو اختر «إقفال بدون جرد»', 'error');
                return;
              }
              if (BeeStore.money.fromMajor(state.countedMajor) < 0) {
                toast('النقد المعدود لا يمكن أن يكون سالباً', 'error');
                return;
              }
            }
            next(3);
          },
        }, 'التالي: إخراج النقد'),
      ]);
    }

    function renderTakeOut() {
      const counted = countedUsedMinor();
      const retainedEl = el('span', { style: 'font-weight:800;' }, _money(counted));
      const amountInput = input('number', state.takenOutMajor, {
        min: 0, step: '0.01', inputmode: 'decimal', placeholder: '0.00',
      });
      amountInput.disabled = state.takenOutMode === 'none';
      amountInput.oninput = () => {
        state.takenOutMajor = amountInput.value;
        retainedEl.textContent = _money(counted - takenOutMinor());
        retainedEl.className = (counted - takenOutMinor()) < 0 ? 'text-danger' : '';
      };
      const modeSelect = select([
        { value: 'none', label: 'بدون — يبقى النقد في الصندوق' },
        { value: 'bank_deposit', label: 'إيداع بالبنك' },
        { value: 'owner_withdrawal', label: 'سحب شخصي (المالك)' },
      ], state.takenOutMode);
      const bankSelect = select([{ value: '', label: 'اختر الحساب البنكي' }].concat(
        state.banks.map(a => ({ value: a.id, label: a.name }))
      ), state.bankAccountId || '');
      const bankField = el('div', { class: 'form-group', style: state.takenOutMode === 'bank_deposit' ? '' : 'display:none' }, [
        el('label', { class: 'form-label' }, 'الحساب البنكي'),
        bankSelect,
        state.banks.length === 0
          ? el('p', { class: 'alert alert-warning' }, 'لا يوجد حساب بنكي. أضف حساباً من صفحة الحسابات أو اختر «بدون».')
          : null,
      ]);

      modeSelect.onchange = () => {
        state.takenOutMode = modeSelect.value;
        amountInput.disabled = modeSelect.value === 'none';
        if (modeSelect.value === 'none') {
          state.takenOutMajor = '';
          amountInput.value = '';
        }
        bankField.style.display = modeSelect.value === 'bank_deposit' ? '' : 'none';
        retainedEl.textContent = _money(counted - takenOutMinor());
      };
      bankSelect.onchange = () => { state.bankAccountId = bankSelect.value; };

      body.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'إخراج النقد'),
        el('p', { class: 'form-hint' },
          'المبلغ المُخرج يُنشئ تلقائياً تحويلاً إلى البنك أو سحباً شخصياً — لا تُدخله مرة ثانية.'),
        formField('الطريقة', modeSelect),
        formField('المبلغ', amountInput),
        bankField,
        el('div', { class: 'day-retained' }, [
          el('span', {}, 'الصندوق المتبقي لليوم التالي: '), retainedEl,
        ]),
        el('p', { class: 'form-hint' }, 'المعدود: ' + _money(counted) + (state.noCount ? ' (بدون جرد)' : '')),
      ]));
      renderActions([
        el('button', { class: 'btn btn-secondary', onclick: () => next(2) }, 'السابق'),
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const taken = takenOutMinor();
            if (taken > counted) { toast('المبلغ المُخرج يتجاوز النقد المعدود', 'error'); return; }
            if (taken > 0 && state.takenOutMode === 'none') {
              toast('اختر «إيداع بالبنك» أو «سحب شخصي» عند إخراج نقد', 'error');
              return;
            }
            if (state.takenOutMode === 'bank_deposit' && !state.bankAccountId) {
              toast('اختر الحساب البنكي', 'error');
              return;
            }
            next(4);
          },
        }, 'التالي: التأكيد'),
      ]);
    }

    function renderConfirm() {
      const counted = countedUsedMinor();
      const taken = takenOutMinor();
      const diff = counted - preview.expectedCashMinor;
      const modeLabel = state.takenOutMode === 'bank_deposit' ? 'إيداع بالبنك'
        : state.takenOutMode === 'owner_withdrawal' ? 'سحب شخصي' : 'بدون';
      const noteInput = textarea(state.note, { placeholder: 'ملاحظة على اليوم (اختياري)' });
      noteInput.oninput = () => { state.note = noteInput.value; };
      const confirmBtn = el('button', { class: 'btn btn-success' }, 'تأكيد الإقفال');
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        const payload = {
          date,
          noCount: state.noCount,
          note: state.note.trim(),
          denominationsCount: Object.keys(state.denomQty).length ? { ...state.denomQty } : null,
          externalTotals: externalTotalsPayload(),
          takenOutMinor: taken,
          takenOutMode: state.takenOutMode,
          bankAccountId: state.takenOutMode === 'bank_deposit' ? state.bankAccountId : undefined,
        };
        if (!state.noCount) payload.countedCashMinor = counted;
        const res = await BeeStore.api.dailyClosings.close(payload);
        if (!res.ok) {
          confirmBtn.disabled = false;
          toast(res.error.message, 'error');
          return;
        }
        state.record = res.data;
        state.step = 'done';
        if (onDone) onDone(res.data);
        renderStep();
      };

      body.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, 'تأكيد الإقفال'),
        _table(['البند', 'المبلغ'], [
          _kv('المتوقع في الصندوق', _money(preview.expectedCashMinor), { total: true }),
          _kv('المعدود', state.noCount ? '— (بدون جرد)' : _money(counted)),
          _kv('الفرق', state.noCount ? _money(0) : _signedMoney(diff), {
            danger: !state.noCount && diff < 0,
            success: !state.noCount && diff > 0,
          }),
          _kv('سيُخرج', _money(taken) + ' — ' + modeLabel),
          _kv('الصندوق المتبقي', _money(counted - taken), { total: true }),
        ]),
        formField('ملاحظة', noteInput),
        el('p', { class: 'alert alert-info' },
          'سيتم إنشاء قيد فرق الصندوق (إن وجد) والتحويل/السحب، وقفل اليوم في معاملة واحدة.'),
      ]));
      renderActions([
        el('button', { class: 'btn btn-secondary', onclick: () => next(3) }, 'السابق'),
        el('button', { class: 'btn btn-secondary', onclick: cancel }, 'إلغاء'),
        confirmBtn,
      ]);
    }

    function renderDone() {
      const rec = state.record || {};
      body.appendChild(el('div', { class: 'card day-done' }, [
        el('h3', {}, '✓ تم إقفال يوم ' + formatDate(date)),
        _table(['البند', 'المبلغ'], [
          _kv('المتوقع', _money(rec.expectedCashMinor)),
          _kv('المعدود', rec.noCount ? '— (بدون جرد)' : _money(rec.countedCashMinor)),
          _kv('الفرق', _signedMoney(rec.differenceMinor), {
            danger: rec.differenceMinor < 0,
            success: rec.differenceMinor > 0,
          }),
          _kv('المُخرج', _money(rec.takenOutMinor)),
          _kv('الصندوق المتبقي', _money(rec.retainedFloatMinor), { total: true }),
        ]),
        rec.externalDifferences && Object.keys(rec.externalDifferences).length > 0
          ? el('p', { class: 'alert alert-warning' },
            'توجد فروقات أجهزة خارجية: ' + Object.keys(rec.externalDifferences)
              .map(m => (BeeStore.settings.methodLabel(settings, m) || m) + ' ' + _signedMoney(rec.externalDifferences[m]))
              .join('، '))
          : null,
        el('p', { class: 'form-hint' }, 'تقرير اليوم جاهز للمشاركة أو الطباعة، وخُذ نسخة احتياطية الآن.'),
      ]));
      renderActions([
        el('button', {
          class: 'btn btn-secondary',
          onclick: () => { overlay.remove(); openReport(date, onDone); },
        }, 'مشاركة تقرير اليوم'),
        el('button', {
          class: 'btn btn-info',
          onclick: () => _printReport(date, 'A4', settings),
        }, 'طباعة / PDF'),
        el('button', {
          class: 'btn btn-success',
          onclick: async () => {
            if (BeeStore.backupUI) await BeeStore.backupUI.shareBackup();
          },
        }, 'نسخة احتياطية الآن'),
        el('button', { class: 'btn btn-primary', onclick: cancel }, 'تم'),
      ]);
    }

    renderStep();
  }

  async function _printReport(date, size, settings) {
    const res = await BeeStore.api.dailyClosings.report(date);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    let s = settings;
    if (!s) {
      const settingsRes = await BeeStore.api.settings.get();
      s = settingsRes.ok ? settingsRes.data : {};
    }
    BeeStore.print.printDayReport(res.data, s, size);
  }

  function _externalMethods(settings, preview) {
    const out = [];
    const methods = (settings.paymentMethods && settings.paymentMethods.length)
      ? settings.paymentMethods
      : BeeStore.settings.methodOptions();
    for (const m of methods) {
      if (m.id === 'cash') continue;
      const account = m.accountId || BeeStore.settings.resolvePaymentAccount(settings, m.id);
      if (account && account === preview.cashDrawerAccountId) continue;
      out.push(m.id);
    }
    for (const key of Object.keys(preview.salesByMethod || {})) {
      if (key !== 'cash' && out.indexOf(key) < 0) out.push(key);
    }
    for (const key of Object.keys(preview.customerCollectionsByMethod || {})) {
      if (key !== 'cash' && out.indexOf(key) < 0) out.push(key);
    }
    return out;
  }

  async function _reopenDay(date, onChange) {
    const latest = await _latestClosedDate();
    if (latest !== date) {
      toast('يمكن إعادة فتح آخر يوم مُقفل فقط (' + (latest || '—') + ')', 'error');
      return;
    }
    const noteInput = input('text', '', { placeholder: 'سبب إعادة الفتح' });
    const typeInput = input('text', '', { placeholder: 'اكتب ' + date + ' للتأكيد' });
    const { overlay } = BeeStore.dialogs.openDialog('إعادة فتح يوم ' + formatDate(date), [
      el('p', { class: 'alert alert-warning' },
        'ستُلغى قيود الإقفال المولّدة (فرق الصندوق/التحويل/السحب) مع الاحتفاظ بها في السجل، ويصبح اليوم مفتوحاً للتعديل.'),
      formField('السبب', noteInput),
      formField('تأكيد (' + date + ')', typeInput, true),
      el('button', {
        class: 'btn btn-warning',
        onclick: async () => {
          if (typeInput.value.trim() !== date) {
            toast('اكتب التاريخ كما هو للتأكيد', 'error');
            return;
          }
          const res = await BeeStore.api.dailyClosings.reopen(date, { note: noteInput.value.trim() });
          if (!res.ok) { toast(res.error.message, 'error'); return; }
          toast('تم إعادة فتح اليوم — أُلغي ' + res.data.voidedCount + ' سجل');
          overlay.remove();
          if (onChange) onChange();
        },
      }, 'إعادة الفتح'),
    ]);
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.days = {
    render,
    openWizard,
    openReport,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.pages.days;
})(typeof window !== 'undefined' ? window : globalThis);
