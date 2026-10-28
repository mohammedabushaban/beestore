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

  /**
   * v5 §3.1: split an integer amount proportionally to integer weights using
   * the largest-remainder method. The returned parts always sum exactly to
   * `totalMinor`; ties are broken by line order. When all weights are zero
   * the amount is split equally (still line-order for the remainder).
   * @param {number} totalMinor integer minor units (may be negative)
   * @param {number[]} weights non-negative line values
   * @returns {number[]} integer allocations in input order
   */
  function allocate(totalMinor, weights) {
    const list = Array.isArray(weights) ? weights : [];
    const n = list.length;
    if (n === 0) return [];
    const total = Math.round(Number(totalMinor) || 0);
    const sign = total < 0 ? -1 : 1;
    const absTotal = Math.abs(total);
    let values = list.map(w => Math.max(0, Math.round(Number(w) || 0)));
    let weightSum = values.reduce((acc, w) => acc + w, 0);
    if (weightSum === 0) {
      values = new Array(n).fill(1);
      weightSum = n;
    }
    const T = BigInt(absTotal);
    const S = BigInt(weightSum);
    const bases = new Array(n);
    const remainders = new Array(n);
    let allocated = 0;
    for (let i = 0; i < n; i++) {
      const product = T * BigInt(values[i]);
      bases[i] = Number(product / S);
      remainders[i] = product % S;
      allocated += bases[i];
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      if (remainders[a] === remainders[b]) return a - b;
      return remainders[b] > remainders[a] ? 1 : -1;
    });
    let remaining = absTotal - allocated;
    for (let k = 0; k < remaining; k++) bases[order[k % n]] += 1;
    return bases.map(part => sign * part);
  }

  BeeStore.money = {
    roundMinor, parseDecimal, normalizeDigits, fromMajor, toMajor, format,
    add, sub, mul, sum, allocate,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.money;
})(typeof window !== 'undefined' ? window : globalThis);
