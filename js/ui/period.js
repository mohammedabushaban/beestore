(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v2 §3: global period selector. The selection is the single source of
  // truth for "which month am I looking at". Persisted in UI preferences
  // (localStorage) so refresh keeps it. Default = current month.
  const STORE_KEY = 'beestore.period.v1';
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const MONTH_NAMES = {
    '01': 'يناير', '02': 'فبراير', '03': 'مارس', '04': 'أبريل',
    '05': 'مايو', '06': 'يونيو', '07': 'يوليو', '08': 'أغسطس',
    '09': 'سبتمبر', '10': 'أكتوبر', '11': 'نوفمبر', '12': 'ديسمبر',
  };

  function monthLabel(month) {
    const parts = String(month || '').split('-');
    if (parts.length !== 2) return String(month || '');
    return (MONTH_NAMES[parts[1]] || parts[1]) + ' ' + parts[0];
  }

  // v2 §3 + v3-Lite §4.6: selection shapes — { mode:'day', date },
  // { mode:'month', month } (default), { mode:'year', year },
  // { mode:'custom', from, to }.
  const YEAR_RE = /^\d{4}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function _valid(sel) {
    if (!sel || typeof sel !== 'object') return null;
    if (sel.mode === 'day' && DATE_RE.test(sel.date)) return { mode: 'day', date: sel.date };
    if (sel.mode === 'year' && YEAR_RE.test(sel.year)) return { mode: 'year', year: sel.year };
    if (sel.mode === 'custom' && DATE_RE.test(sel.from) && DATE_RE.test(sel.to) && sel.from <= sel.to) {
      return { mode: 'custom', from: sel.from, to: sel.to };
    }
    if (MONTH_RE.test(sel.month)) return { mode: 'month', month: sel.month };
    return null;
  }

  function currentMonth() {
    return BeeStore.dates.today().slice(0, 7);
  }

  // In-memory fallback when localStorage is unavailable (private mode,
  // non-browser envs like the node test suite).
  let memSel = null;

  function get() {
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = _valid(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch (e) { /* storage unavailable — use memory/default */ }
    if (memSel) return memSel;
    return { mode: 'month', month: currentMonth() };
  }

  // Anchor month for month-picking UIs when the selection isn't a month.
  function selMonth() {
    const sel = get();
    if (sel.mode === 'month') return sel.month;
    if (sel.mode === 'day') return sel.date.slice(0, 7);
    return currentMonth();
  }

  function label(sel) {
    const s = sel || get();
    if (s.mode === 'day') return 'يوم ' + s.date;
    if (s.mode === 'year') return 'سنة ' + s.year;
    if (s.mode === 'custom') return s.from + ' ← ' + s.to;
    return monthLabel(s.month);
  }

  function _store(sel) {
    memSel = sel;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(sel)); } catch (e) { /* ignore */ }
  }

  function set(month) {
    if (!MONTH_RE.test(month)) return;
    _store({ mode: 'month', month });
    renderHeader();
    _rerender();
  }

  function setDay(date) {
    if (!DATE_RE.test(String(date))) return;
    _store({ mode: 'day', date: String(date) });
    renderHeader();
    _rerender();
  }

  function setYear(year) {
    if (!YEAR_RE.test(String(year))) return;
    _store({ mode: 'year', year: String(year) });
    renderHeader();
    _rerender();
  }

  function setCustom(from, to) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return;
    _store({ mode: 'custom', from, to });
    renderHeader();
    _rerender();
  }

  function _rerender() {
    if (BeeStore.router && typeof BeeStore.router.rerender === 'function') {
      BeeStore.router.rerender();
    }
    _writeHash();
  }

  // Silent apply (boot / hash navigation): no re-render, no history write.
  function init(sel) {
    if (typeof sel === 'string') sel = { mode: 'month', month: sel };
    const valid = _valid(sel);
    if (!valid) return;
    _store(valid);
    renderHeader();
  }

  function toQuery(sel) {
    const s = sel || get();
    if (s.mode === 'day') return 'd=' + s.date;
    if (s.mode === 'year') return 'y=' + s.year;
    if (s.mode === 'custom') return 'from=' + s.from + '&to=' + s.to;
    return 'm=' + s.month;
  }

  function _writeHash() {
    try {
      if (typeof history !== 'undefined' && history.replaceState &&
        BeeStore.router && BeeStore.router.currentRoute) {
        history.replaceState(null, '',
          '#' + BeeStore.router.currentRoute + '?' + toQuery());
      }
    } catch (e) { /* non-browser env */ }
  }

  function shift(delta) {
    const sel = get();
    if (sel.mode === 'day') {
      setDay(BeeStore.dates.addDays(sel.date, delta));
      return;
    }
    if (sel.mode !== 'month') return;
    set(BeeStore.dates.addMonths(sel.month, delta));
  }

  function getRange() {
    const sel = get();
    if (sel.mode === 'day') return { from: sel.date, to: sel.date };
    if (sel.mode === 'year') return { from: sel.year + '-01-01', to: sel.year + '-12-31' };
    if (sel.mode === 'custom') return { from: sel.from, to: sel.to };
    return BeeStore.dates.monthRange(sel.month);
  }

  async function isClosed(month) {
    if (!BeeStore.api || !MONTH_RE.test(String(month || ''))) return false;
    try {
      const res = await BeeStore.api.periods.get(month);
      return !!(res.ok && res.data && res.data.status === 'closed');
    } catch (e) { return false; }
  }

  async function isDayClosed(date) {
    if (!BeeStore.api || !DATE_RE.test(String(date || ''))) return false;
    try {
      const res = await BeeStore.api.dailyClosings.get(date);
      return !!(res.ok && res.data && res.data.status === 'closed');
    } catch (e) { return false; }
  }

  async function monthsWithData() {
    const out = new Set([currentMonth(), selMonth()]);
    if (BeeStore.api) {
      try {
        const res = await BeeStore.api.periods.monthsWithData();
        if (res.ok) for (const m of res.data) out.add(m);
        const closed = await BeeStore.api.periods.list();
        if (closed.ok) for (const c of closed.data) out.add(c.month);
      } catch (e) { /* offline-safe: fall back to current month */ }
    }
    return Array.from(out).sort().reverse();
  }

  // v2 §3 + v3-Lite §4.6: default date for new entries — today if today is in
  // the selected range, otherwise the end of the range (never in the future).
  // Closed months/days report blocked:true; the services still enforce.
  async function defaultDateForNew() {
    const sel = get();
    const today = BeeStore.dates.today();
    const range = getRange();
    let date = (today >= range.from && today <= range.to) ? today : range.to;
    if (date > today) date = today;
    const month = date.slice(0, 7);
    if (await isClosed(month)) {
      return { date, blocked: true, notice: 'شهر ' + monthLabel(month) + ' مُقفل — اختر شهراً مفتوحاً' };
    }
    if (await isDayClosed(date)) {
      return { date, blocked: true, notice: 'يوم ' + date + ' مُقفل — أعد فتح اليوم أو سجّل التصحيح بتاريخ اليوم' };
    }
    const inSel = (sel.mode === 'day' && date === sel.date) ||
      (sel.mode === 'month' && month === sel.month) ||
      (sel.mode === 'year' && date.slice(0, 4) === sel.year) ||
      (sel.mode === 'custom' && date >= sel.from && date <= sel.to);
    return {
      date,
      blocked: false,
      notice: (!inSel || date !== today) ? 'التاريخ ضمن ' + label(sel) : '',
    };
  }

  // Apply the period default to a date <input>, with a visible notice.
  // Returns the { date, blocked, notice } descriptor for the caller.
  async function applyDefaultDate(dateInput, noticeEl) {
    const d = await defaultDateForNew();
    if (dateInput) dateInput.value = d.date;
    if (noticeEl) {
      noticeEl.textContent = d.notice;
      noticeEl.style.display = d.notice ? 'block' : 'none';
    }
    return d;
  }

  // "يعرض: <النطاق>" scope label + 🔒 badge for closed days/months (v2 §3).
  async function scopeBar(container, month) {
    const sel = get();
    const m = month || (sel.mode === 'month' ? sel.month : null);
    const { el } = BeeStore.ui;
    const bar = el('div', { class: 'period-scope-bar' }, [
      el('span', { class: 'period-scope-label' }, 'يعرض: ' + label(sel)),
      el('span', { class: 'period-scope-lock', style: 'display:none' }, '🔒 مُقفل'),
    ]);
    container.appendChild(bar);
    const lockEl = bar.querySelector('.period-scope-lock');
    const locked = (sel.mode === 'day' && await isDayClosed(sel.date)) ||
      (m && await isClosed(m));
    if (locked) lockEl.style.display = 'inline';
    return bar;
  }

  // Header widget: ◀ label ▶ + dropdown panel (v2 §3).
  function renderHeader() {
    const host = typeof document !== 'undefined' && document.getElementById('period-selector');
    if (!host || !BeeStore.ui) return;
    const { el } = BeeStore.ui;
    const sel = get();
    host.innerHTML = '';

    const showArrows = sel.mode === 'month' || sel.mode === 'day';
    const prevBtn = el('button', {
      class: 'period-nav-btn', 'aria-label': sel.mode === 'day' ? 'اليوم السابق' : 'الشهر السابق',
      style: showArrows ? '' : 'display:none',
      onclick: () => shift(-1),
    }, '▶');
    const nextBtn = el('button', {
      class: 'period-nav-btn', 'aria-label': sel.mode === 'day' ? 'اليوم التالي' : 'الشهر التالي',
      style: showArrows ? '' : 'display:none',
      onclick: () => shift(1),
    }, '◀');
    const labelBtn = el('button', {
      class: 'period-label-btn', 'aria-label': 'اختيار الفترة',
      onclick: () => _togglePanel(host),
    }, label(sel) + ' ');
    const lockBadge = el('span', { class: 'period-lock-badge', style: 'display:none' }, '🔒');
    labelBtn.appendChild(lockBadge);

    const panel = el('div', { class: 'period-panel', style: 'display:none' });
    host.appendChild(prevBtn);
    host.appendChild(labelBtn);
    host.appendChild(nextBtn);
    host.appendChild(panel);

    if (sel.mode === 'month') {
      isClosed(sel.month).then(closed => {
        if (closed) lockBadge.style.display = 'inline';
      });
    } else if (sel.mode === 'day') {
      Promise.all([isDayClosed(sel.date), isClosed(sel.date.slice(0, 7))]).then(([day, month]) => {
        if (day || month) lockBadge.style.display = 'inline';
      });
    }
    _fillPanel(panel, host);
  }

  async function _fillPanel(panel, host) {
    const { el } = BeeStore.ui;
    const { input } = BeeStore.dialogs;
    panel.innerHTML = '';
    // v3-Lite §4.6: day mode — every period-scoped page shows just this day.
    const dayInput = input('date', get().mode === 'day' ? get().date : BeeStore.dates.today());
    const dayBtn = el('button', {
      class: 'btn btn-sm btn-secondary',
      onclick: () => { if (DATE_RE.test(dayInput.value)) { setDay(dayInput.value); _hidePanel(host); } },
    }, 'يوم واحد');
    panel.appendChild(el('div', { class: 'period-panel-row' }, [dayInput, dayBtn]));
    const monthInput = input('month', selMonth());
    const goBtn = el('button', {
      class: 'btn btn-sm btn-primary',
      onclick: () => { if (MONTH_RE.test(monthInput.value)) { set(monthInput.value); _hidePanel(host); } },
    }, 'انتقال');
    panel.appendChild(el('div', { class: 'period-panel-row' }, [monthInput, goBtn]));
    // v2 §3 "السنة كاملة" mode.
    const yearInput = input('number', new Date().getFullYear(), { min: 2000, max: 2100, style: 'max-width:110px' });
    const yearBtn = el('button', {
      class: 'btn btn-sm btn-secondary',
      onclick: () => { setYear(yearInput.value); _hidePanel(host); },
    }, 'السنة كاملة');
    panel.appendChild(el('div', { class: 'period-panel-row' }, [yearInput, yearBtn]));
    // v2 §3 "فترة مخصصة" mode.
    const fromInput = input('date', getRange().from);
    const toInput = input('date', getRange().to);
    const customBtn = el('button', {
      class: 'btn btn-sm btn-secondary',
      onclick: () => {
        if (DATE_RE.test(fromInput.value) && DATE_RE.test(toInput.value) && fromInput.value <= toInput.value) {
          setCustom(fromInput.value, toInput.value); _hidePanel(host);
        }
      },
    }, 'فترة مخصصة');
    panel.appendChild(el('div', { class: 'period-panel-row' }, [fromInput, toInput, customBtn]));
    const list = el('div', { class: 'period-panel-list' }, [el('span', {}, 'جاري التحميل...')]);
    panel.appendChild(list);
    const months = await monthsWithData();
    list.innerHTML = '';
    const closedSet = new Set();
    if (BeeStore.api) {
      try {
        const res = await BeeStore.api.periods.list();
        if (res.ok) for (const c of res.data) closedSet.add(c.month);
      } catch (e) { /* ignore */ }
    }
    const cur = get();
    for (const m of months.slice(0, 12)) {
      const btn = el('button', {
        class: 'period-panel-item' + (cur.mode === 'month' && m === cur.month ? ' active' : ''),
        onclick: () => { set(m); _hidePanel(host); },
      }, monthLabel(m) + (closedSet.has(m) ? ' 🔒' : ''));
      list.appendChild(btn);
    }
  }

  function _togglePanel(host) {
    const panel = host.querySelector('.period-panel');
    if (!panel) return;
    const open = panel.style.display !== 'none';
    _hideAllPanels();
    if (!open) {
      panel.style.display = 'block';
      _fillPanel(panel, host);
    }
  }

  function _hidePanel(host) {
    const panel = host && host.querySelector('.period-panel');
    if (panel) panel.style.display = 'none';
  }

  function _hideAllPanels() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.period-panel').forEach(p => { p.style.display = 'none'; });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#period-selector')) _hideAllPanels();
    });
  }

  BeeStore.period = {
    get, set, setDay, setYear, setCustom, init, toQuery, shift, getRange,
    monthLabel, label, selMonth, currentMonth,
    isClosed, isDayClosed, monthsWithData, defaultDateForNew, applyDefaultDate,
    scopeBar, renderHeader,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.period;
})(typeof window !== 'undefined' ? window : globalThis);
