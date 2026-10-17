(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  BeeStore.config = {
    dbName: 'beestore-db',
    dbVersion: 3,
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
