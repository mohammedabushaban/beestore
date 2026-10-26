(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast, confirmDialog } = BeeStore.ui;
  const { input, formField } = BeeStore.dialogs;

  // v2 §7: "إقفال الشهور" — checklist page for the selected month.
  async function render(container) {
    container.innerHTML = '';
    container.appendChild(el('h2', { class: 'page-title' }, 'إقفال الشهور'));
    await BeeStore.period.scopeBar(container);

    const state = { month: BeeStore.period.selMonth(), ack: false };

    const monthInput = input('month', state.month);
    const showBtn = el('button', { class: 'btn btn-primary', onclick: () => {
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(monthInput.value)) {
        state.month = monthInput.value; state.ack = false; _renderDetail(detailDiv, state);
      }
    } }, 'عرض');
    container.appendChild(el('div', { class: 'filter-row' }, [
      el('label', { class: 'form-label' }, 'الشهر'), monthInput, showBtn,
    ]));

    const listDiv = el('div', { id: 'periods-list' });
    const detailDiv = el('div', { id: 'period-detail' });
    container.appendChild(listDiv);
    container.appendChild(detailDiv);

    await _renderList(listDiv, state, detailDiv);
    await _renderDetail(detailDiv, state);
  }

  async function _renderList(listDiv, state, detailDiv) {
    listDiv.innerHTML = '';
    const monthsRes = await BeeStore.api.periods.monthsWithData();
    const months = monthsRes.ok ? monthsRes.data : [];
    const closedRes = await BeeStore.api.periods.list();
    const closedMap = {};
    if (closedRes.ok) for (const c of closedRes.data) closedMap[c.month] = c;

    if (months.length === 0) {
      listDiv.appendChild(el('p', { class: 'empty-state' }, 'لا توجد شهور بها بيانات بعد'));
      return;
    }
    const rows = months.map(m => {
      const c = closedMap[m];
      return el('tr', {}, [
        el('td', {}, BeeStore.period.monthLabel(m)),
        el('td', {}, c
          ? el('span', { class: 'badge badge-muted' }, '🔒 مُقفل')
          : el('span', { class: 'badge badge-success' }, 'مفتوح')),
        el('td', {}, c && c.closedAt ? c.closedAt.slice(0, 10) : '—'),
        el('td', {}, el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: () => { state.month = m; state.ack = false; _renderDetail(detailDiv, state); },
        }, 'مراجعة')),
      ]);
    });
    listDiv.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, 'الشهور'),
      el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'الشهر'), el('th', {}, 'الحالة'), el('th', {}, 'تاريخ القفل'), el('th', {}, ''),
        ])),
        el('tbody', {}, rows),
      ])),
    ]));
  }

  async function _renderDetail(detailDiv, state) {
    detailDiv.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';
    const m = state.month;

    const [checkRes, reviewRes, recRes, closedRes, pkgRes] = await Promise.all([
      BeeStore.api.periods.checklist(m),
      BeeStore.api.reports.monthReview(m),
      BeeStore.api.reports.profitCashReconciliation(m),
      BeeStore.api.periods.list(),
      BeeStore.api.accountingPackage.info(m),
    ]);
    if (!checkRes.ok) { detailDiv.innerHTML = ''; detailDiv.appendChild(el('p', { class: 'alert alert-danger' }, checkRes.error.message)); return; }
    const check = checkRes.data;
    const closedMonths = closedRes.ok ? closedRes.data.map(c => c.month).sort() : [];
    const latestClosed = closedMonths.length ? closedMonths[closedMonths.length - 1] : null;

    detailDiv.innerHTML = '';
    detailDiv.appendChild(el('h3', {}, 'مراجعة شهر ' + BeeStore.period.monthLabel(m)));

    // Checklist (v2 §7.2).
    const blockers = check.items.filter(i => i.level === 'blocker' && !i.ok);
    const warnings = check.items.filter(i => i.level === 'warning' && !i.ok);
    const itemEls = check.items.map(i => {
      const icon = i.ok ? '✓' : (i.level === 'blocker' ? '⛔' : (i.level === 'warning' ? '⚠️' : 'ℹ️'));
      const cls = i.ok ? 'checklist-ok' : ('checklist-' + i.level);
      return el('div', { class: 'checklist-item ' + cls }, [
        el('span', { class: 'checklist-icon' }, icon), el('span', {}, i.text),
      ]);
    });
    detailDiv.appendChild(el('div', { class: 'card' }, [
      el('h4', {}, 'قائمة الإقفال' + (check.closed ? ' — الشهر مُقفل 🔒' : '')),
      ...itemEls,
    ]));

    // KPIs from Month Review (v2 §9.1).
    if (reviewRes.ok && recRes.ok) {
      const k = reviewRes.data.kpis;
      detailDiv.appendChild(el('div', { class: 'cards-grid' }, [
        _kpi('صافي المبيعات', formatMoney(k.netSales)),
        _kpi('تكلفة البضاعة', formatMoney(k.cogs)),
        _kpi('مجمل الربح', formatMoney(k.grossProfit)),
        _kpi('المصاريف', formatMoney(k.expenses)),
        _kpi('صافي الربح', formatMoney(k.netProfit)),
        _kpi('التغير في النقدية', formatMoney(recRes.data.actualCashChange)),
      ]));
    }

    // Actions.
    const actions = el('div', { class: 'dialog-actions no-print' });
    if (!check.closed) {
      if (warnings.length > 0) {
        const ackBox = el('input', { type: 'checkbox', id: 'ack-warnings' });
        ackBox.checked = state.ack;
        ackBox.onchange = () => { state.ack = ackBox.checked; };
        actions.appendChild(el('label', { for: 'ack-warnings', style: 'display:flex;gap:8px;align-items:center;' }, [
          ackBox, document.createTextNode('اطّلعت على التحذيرات وأريد الإقفال رغم ذلك'),
        ]));
      }
      const canClose = blockers.length === 0 && (warnings.length === 0 || state.ack);
      const closeBtn = el('button', {
        class: 'btn btn-primary',
        title: blockers.length ? blockers.map(b => b.text).join('؛ ') : '',
        onclick: () => _closeMonth(m),
      }, 'إقفال الشهر');
      // NOTE: el() sets every attr verbatim, so toggle the property instead.
      if (!canClose) closeBtn.disabled = true;
      actions.appendChild(closeBtn);
    } else if (m === latestClosed) {
      actions.appendChild(el('button', {
        class: 'btn btn-warning', onclick: () => _reopenMonth(m),
      }, 'إعادة فتح الشهر'));
    } else if (check.closed) {
      actions.appendChild(el('p', { class: 'form-hint' },
        'لا يمكن إعادة فتح هذا الشهر إلا بعد إعادة فتح الشهور الأحدث أولاً'));
    }
    actions.appendChild(el('button', {
      class: 'btn btn-secondary', onclick: () => _runIntegrity(detailDiv),
    }, 'فحص سلامة البيانات'));
    actions.appendChild(el('button', {
      class: 'btn btn-info', onclick: () => window.print(),
    }, 'طباعة تقرير الشهر'));
    detailDiv.appendChild(el('div', { class: 'card no-print' }, [el('h4', {}, 'إجراءات'), actions]));

    // v3-Lite §8: accountant package. It is generated offline in the browser
    // and shared through the OS share sheet (Drive/WhatsApp/email) or a plain
    // download. Open months carry a visible "غير نهائي" status everywhere.
    if (pkgRes.ok) {
      const pkg = pkgRes.data;
      const statusEl = el('p', { class: 'form-hint' },
        pkg.closed
          ? 'الشهر مُقفل — الحزمة نهائية وتحتوي كل الجداول وبصمات التحقق.'
          : 'الشهر مفتوح — ستظهر علامة «غير نهائي — الشهر مفتوح» في التقرير والملفات.');
      const pkgCard = el('div', { class: 'card no-print' }, [
        el('h4', {}, 'حزمة المحاسب'),
        el('p', { class: 'form-hint' },
          'ZIP واحد: تقرير PDF عربي، ملف Excel بثماني عشرة ورقة، نسخ CSV بترميز UTF-8، وملف manifest ببصمات SHA-256.'),
        statusEl,
        el('div', { class: 'dialog-actions' }, [
          el('button', {
            class: 'btn btn-primary',
            onclick: () => _runPackageAction('share', m, pkgCard, statusEl),
          }, 'مشاركة الحزمة'),
          el('button', {
            class: 'btn btn-secondary',
            onclick: () => _runPackageAction('download', m, pkgCard, statusEl),
          }, 'تنزيل الحزمة'),
          el('button', {
            class: 'btn btn-info',
            onclick: () => _runPackageAction('sharePdf', m, pkgCard, statusEl),
          }, 'مشاركة تقرير PDF'),
        ]),
        el('p', { class: 'form-hint' },
          'من نافذة المشاركة اختر Google Drive أو واتساب أو البريد. المحاسب يفتح الحزمة للقراءة فقط ولا يعدّل بيانات التطبيق.'),
      ]);
      detailDiv.appendChild(pkgCard);
    }

    const integDiv = el('div', { id: 'period-integrity' });
    detailDiv.appendChild(integDiv);
  }

  async function _runPackageAction(kind, month, card, statusEl) {
    const buttons = Array.from(card.querySelectorAll('button'));
    const previous = statusEl.textContent;
    for (const b of buttons) b.disabled = true;
    statusEl.textContent = kind === 'sharePdf'
      ? 'جاري تجهيز تقرير الشهر PDF… قد يستغرق لحظات.'
      : 'جاري تجهيز الحزمة… قد يستغرق لحظات.';
    try {
      const api = BeeStore.api.accountingPackage;
      const res = kind === 'sharePdf' ? await api.sharePdf(month)
        : (kind === 'download' ? await api.download(month) : await api.share(month));
      if (!res.ok) {
        statusEl.textContent = previous;
        toast(res.error.message, 'error');
        return;
      }
      const method = res.data && res.data.method;
      if (method === 'share') {
        statusEl.textContent = 'تم فتح نافذة المشاركة. اختر Google Drive أو واتساب أو البريد.';
        toast('تم تجهيز الملف للمشاركة');
      } else if (method === 'download') {
        statusEl.textContent = 'تم تنزيل الملف: ' + (res.data.filename || '');
        toast('تم تنزيل الملف');
      } else if (method === 'cancelled') {
        statusEl.textContent = 'أُلغيت المشاركة. يمكنك التنزيل بدلاً منها.';
      } else {
        statusEl.textContent = 'تم تجهيز الملف، لكن المشاركة غير مدعومة على هذا الجهاز.';
      }
    } catch (e) {
      statusEl.textContent = previous;
      toast((e && e.message) || 'تعذّر تجهيز الحزمة', 'error');
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  function _kpi(title, value) {
    return el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-title' }, title),
      el('div', { class: 'stat-value' }, value),
    ]);
  }

  async function _closeMonth(month) {
    confirmDialog('إقفال شهر ' + BeeStore.period.monthLabel(month),
      'سيتم قفل الشهر نهائياً ومنع أي تعديل عليه. سيُؤخذ نسخة احتياطية أولاً. هل تريد المتابعة؟',
      async () => {
        try { await BeeStore.api.backup.createNow(); } catch (e) { /* folder may be unlinked */ }
        const res = await BeeStore.api.periods.close(month);
        if (res.ok) {
          toast('تم إقفال الشهر بنجاح');
          BeeStore.period.renderHeader();
          render(document.getElementById('page-content'));
        } else {
          toast(res.error.message, 'error');
        }
      });
  }

  function _reopenMonth(month) {
    // v2 §7.5: typed confirmation; snapshot discarded; backup first.
    const { openDialog } = BeeStore.dialogs;
    const noteInput = input('text', '', { placeholder: 'سبب إعادة الفتح' });
    const typeInput = input('text', '', { placeholder: 'اكتب ' + month + ' للتأكيد' });
    const { overlay } = openDialog('إعادة فتح شهر ' + BeeStore.period.monthLabel(month), [
      el('p', { class: 'alert alert-warning' }, 'سيتم حذف لقطة الإقفال. اكتب اسم الشهر للتأكيد.'),
      formField('السبب', noteInput),
      formField('تأكيد (' + month + ')', typeInput, true),
      el('button', {
        class: 'btn btn-warning',
        onclick: async () => {
          if (typeInput.value.trim() !== month) { toast('اكتب اسم الشهر كما هو للتأكيد', 'error'); return; }
          try { await BeeStore.api.backup.createNow(); } catch (e) { /* ignore */ }
          const res = await BeeStore.api.periods.reopen(month, noteInput.value.trim());
          if (res.ok) {
            toast('تم إعادة فتح الشهر');
            overlay.remove();
            BeeStore.period.renderHeader();
            render(document.getElementById('page-content'));
          } else {
            toast(res.error.message, 'error');
          }
        },
      }, 'إعادة الفتح'),
    ]);
  }

  async function _runIntegrity(detailDiv) {
    const host = detailDiv.querySelector('#period-integrity');
    if (!host) return;
    host.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';
    const res = await BeeStore.api.maintenance.integrityCheck();
    host.innerHTML = '';
    if (!res.ok) { host.appendChild(el('p', { class: 'alert alert-danger' }, res.error.message)); return; }
    const { errors, warnings } = res.data;
    const head = errors.length === 0
      ? el('p', { class: 'alert alert-success' }, '✓ الفحص سليم' + (warnings.length ? ' مع ' + warnings.length + ' تنبيهات' : ''))
      : el('p', { class: 'alert alert-danger' }, '⛔ ' + errors.length + ' أخطاء — لا يمكن الإقفال قبل إصلاحها');
    const item = (x) => el('div', { class: 'checklist-item' }, [
      el('span', { class: 'checklist-icon' }, x.level === 'error' ? '⛔' : '⚠️'),
      el('span', {}, '[' + x.check + '] ' + x.message + (x.recordId ? ' (' + x.recordId + ')' : '')),
    ]);
    host.appendChild(el('div', { class: 'card' }, [
      el('h4', {}, 'نتيجة فحص سلامة البيانات'),
      head,
      ...errors.map(item),
      ...warnings.map(item),
    ]));
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.periods = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
