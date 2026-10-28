(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  BeeStore.config = {
    dbName: 'beestore-db',
    dbVersion: 7,
    // L2 §5: keep the current month plus this many previous months in memory.
    memoryWindowMonths: 2,
    fileName: 'db.json',
    backupDir: 'backups',
    backupPrefix: 'db-',
    snapshotCount: 10,
    debounceMs: 3000,
    storageKey: 'beestore-folder-handle',
    handlesDbName: 'beestore-handles',
    lockName: 'beestore-single-tab',
    lockTimeout: 5000,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.config;
})(typeof window !== 'undefined' ? window : globalThis);
