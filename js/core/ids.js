(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function randomId(prefix) {
    let s = '';
    const arr = new Uint8Array(10);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (let i = 0; i < 10; i++) arr[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < 10; i++) s += CHARS[arr[i] % CHARS.length];
    return (prefix || 'id') + '_' + s;
  }

  function nextBarcode() {
    const now = Date.now();
    const base = String(now).slice(-8);
    const seq = String(Math.floor(Math.random() * 900) + 100);
    const digits = '2' + base + seq;
    const check = eanCheckDigit(digits);
    return digits + check;
  }

  function eanCheckDigit(digits12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const d = Number(digits12[i]);
      sum += i % 2 === 0 ? d : d * 3;
    }
    return String((10 - (sum % 10)) % 10);
  }

  BeeStore.ids = { randomId, nextBarcode, eanCheckDigit };
  if (typeof module !== 'undefined') module.exports = BeeStore.ids;
})(typeof window !== 'undefined' ? window : globalThis);
