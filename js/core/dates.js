(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function pad(n) { return String(n).padStart(2, '0'); }

  // Injectable clock for tests (v2 §2): setClock(() => '2026-10-14').
  // Production default is null → real local date.
  let _clockFn = null;
  function setClock(fn) { _clockFn = fn || null; }
  function resetClock() { _clockFn = null; }

  /**
   * Today's business date as local YYYY-MM-DD (v2 §2). Uses local date
   * parts — never toISOString() (UTC shifts the day near midnight).
   * @returns {string} e.g. '2026-10-14' (or the injected clock value)
   */
  function today() {
    if (_clockFn) return _clockFn();
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function now() { return new Date().toISOString(); }

  function nowTime() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(str) {
    if (!str) return '';
    const d = parseDate(str);
    if (!d) return str;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = parseDate(iso);
    if (!d) return iso;
    return formatDate(iso) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function monthKey(dateStr) { return (dateStr || today()).slice(0, 7); }

  // v2 §2: month helpers. Month keys are 'YYYY-MM' calendar months.
  // Pure string arithmetic — never Date objects (no timezone pitfalls).
  function monthOf(dateStr) {
    const s = String(dateStr || today());
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error('Invalid date: ' + dateStr);
    return s.slice(0, 7);
  }

  function daysInMonth(year, month) {
    if (typeof year === 'string' && month === undefined) {
      const m = year.match(/^(\d{4})-(\d{2})$/);
      if (!m) throw new Error('Invalid month: ' + year);
      return new Date(Number(m[1]), Number(m[2]), 0).getDate();
    }
    return new Date(year, month, 0).getDate();
  }

  /**
   * First/last day of a calendar month (leap-year and Dec→Jan safe).
   * @param {string} month 'YYYY-MM'
   * @returns {{from:string,to:string}} inclusive day bounds
   * @throws {Error} on malformed month
   */
  function monthRange(month) {
    const m = String(month).match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new Error('Invalid month: ' + month);
    const dim = daysInMonth(month);
    return { from: month + '-01', to: month + '-' + pad(dim) };
  }

  function isSameMonth(a, b) { return monthOf(a) === monthOf(b); }

  // -1 if a<b, 0 if equal, 1 if a>b. Works for dates and month keys.
  function compare(a, b) {
    const sa = String(a), sb = String(b);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  function addDays(dateStr, days) {
    const d = parseDate(dateStr);
    if (!d) return dateStr;
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addMonths(input, count) {
    // Month-key arithmetic (v2 §2): pure string math, Dec→Jan rollover safe.
    const mk = String(input).match(/^(\d{4})-(\d{2})$/);
    if (mk) {
      let y = Number(mk[1]);
      let m = Number(mk[2]) + Number(count || 0);
      y += Math.floor((m - 1) / 12);
      m = (((m - 1) % 12) + 12) % 12 + 1;
      return y + '-' + pad(m);
    }
    // Legacy full-date behavior (installment schedules).
    const d = parseDate(input);
    if (!d) return input;
    const day = d.getDate();
    d.setMonth(d.getMonth() + count);
    if (d.getDate() < day) d.setDate(0);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function startOfMonth(dateStr) { return (dateStr || today()).slice(0, 7) + '-01'; }

  function endOfMonth(dateStr) {
    const ym = (dateStr || today()).slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    return ym + '-' + pad(daysInMonth(y, m));
  }

  function diffDays(a, b) {
    const da = parseDate(a), db = parseDate(b);
    if (!da || !db) return 0;
    return Math.round((db - da) / 86400000);
  }

  BeeStore.dates = {
    pad, today, now, nowTime, parseDate, formatDate, formatDateTime,
    monthKey, daysInMonth, addDays, addMonths, startOfMonth, endOfMonth, diffDays,
    monthOf, monthRange, isSameMonth, compare, setClock, resetClock,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.dates;
})(typeof window !== 'undefined' ? window : globalThis);
