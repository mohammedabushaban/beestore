(function (global) {
  'use strict';
  const BeeStore = global.BeeStore || (global.BeeStore = {});
  BeeStore.version = '3.4.0-lite';
  BeeStore.schemaVersion = 7;
  if (typeof module !== 'undefined') module.exports = BeeStore;
})(typeof window !== 'undefined' ? window : globalThis);
