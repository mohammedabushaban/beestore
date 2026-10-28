(function (global) {
  'use strict';
  const BeeStore = global.BeeStore || (global.BeeStore = {});
  BeeStore.version = '3.1.0-lite';
  BeeStore.schemaVersion = 4;
  if (typeof module !== 'undefined') module.exports = BeeStore;
})(typeof window !== 'undefined' ? window : globalThis);
