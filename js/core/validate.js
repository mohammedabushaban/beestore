(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function required(value, fieldName) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return fieldName + ' مطلوب';
    }
    return null;
  }

  function isNumber(value) {
    return value !== '' && value !== null && isFinite(Number(value));
  }

  function min(value, min, fieldName) {
    if (!isNumber(value) || Number(value) < min) return fieldName + ' يجب أن يكون ' + min + ' على الأقل';
    return null;
  }

  function max(value, max, fieldName) {
    if (!isNumber(value) || Number(value) > max) return fieldName + ' يجب أن يكون ' + max + ' كحد أقصى';
    return null;
  }

  function phone(value) {
    if (!value) return null;
    return /^[0-9+\-\s()]{6,20}$/.test(value) ? null : 'رقم هاتف غير صالح';
  }

  function email(value) {
    if (!value) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'بريد إلكتروني غير صالح';
  }

  BeeStore.validate = { required, isNumber, min, max, phone, email };
  if (typeof module !== 'undefined') module.exports = BeeStore.validate;
})(typeof window !== 'undefined' ? window : globalThis);
