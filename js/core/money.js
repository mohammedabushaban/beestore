(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function roundMinor(value) {
    return Math.round(Number(value) || 0);
  }

  /**
   * Normalize Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and separators (٫ → `.`,
   * ٬/thousands → removed) to Western digits (v2 §12.1.5).
   * @param {*} str raw user input
   * @returns {string} ASCII digits string (may be empty)
   */
  const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  function normalizeDigits(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/[٠-٩]/g, (ch) => String(EASTERN_DIGITS.indexOf(ch)))
      .replace(/[٫]/g, '.')
      .replace(/[٬']/g, '');
  }

  /**
   * Parse a user-entered decimal (any digits) to a finite number, else 0.
   * @param {*} str raw input
   * @returns {number}
   */
  function parseDecimal(str) {
    if (str === null || str === undefined || str === '') return 0;
    const n = Number(normalizeDigits(str).replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  /**
   * Major units (e.g. 250.50) → integer minor units (25050). Single rounding
   * rule for all user money entry: half up via Math.round.
   * @param {*} major raw user input
   * @returns {number} integer minor units
   */
  function fromMajor(major) {
    return roundMinor(parseDecimal(major) * 100);
  }

  function toMajor(minor) {
    return (roundMinor(minor) / 100).toFixed(2);
  }

  function format(minor, symbol) {
    const s = symbol || '₪';
    return toMajor(minor) + ' ' + s;
  }

  function add(a, b) { return roundMinor(a) + roundMinor(b); }
  function sub(a, b) { return roundMinor(a) - roundMinor(b); }
  function mul(minor, qty) { return roundMinor(minor * Number(qty)); }
  function sum(arr) { return (arr || []).reduce((acc, v) => acc + roundMinor(v), 0); }

  BeeStore.money = { roundMinor, parseDecimal, normalizeDigits, fromMajor, toMajor, format, add, sub, mul, sum };
  if (typeof module !== 'undefined') module.exports = BeeStore.money;
})(typeof window !== 'undefined' ? window : globalThis);
