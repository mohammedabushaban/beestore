(function (global) {
  'use strict';
  const BeeStore = global.BeeStore || (global.BeeStore = {});
  BeeStore.version = '3.2.0-lite';
  BeeStore.schemaVersion = 5;
  if (typeof module !== 'undefined') module.exports = BeeStore;
})(typeof window !== 'undefined' ? window : globalThis);
