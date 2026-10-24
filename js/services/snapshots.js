(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const DB_NAME = 'beestore-snapshots';
  const DB_VERSION = 1;
  const META_STORE = 'snapshots';
  const DATA_STORE = 'snapshotData';

  /** Newest first. */
  function sortNewest(records) {
    return (records || []).slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  /** Returns the ids that fall outside the newest `max` records. */
  function pickExpired(records, max) {
    const limit = Math.max(0, Number(max) || 0);
    return sortNewest(records).slice(limit).map(function (record) { return record.id; });
  }

  function countDocuments(dump) {
    let total = 0;
    const collections = (dump && dump.collections) || {};
    for (const key of Object.keys(collections)) {
      if (Array.isArray(collections[key])) total += collections[key].length;
    }
    return total;
  }

  class SnapshotService {
    constructor(options) {
      options = options || {};
      this.dbName = options.dbName || DB_NAME;
      this.max = Math.max(1, Number(options.max || (BeeStore.config && BeeStore.config.snapshotCount) || 10));
      this.db = null;
    }

    _open() {
      if (this.db) return Promise.resolve(this.db);
      if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB is not available'));
      }
      const self = this;
      return new Promise(function (resolve, reject) {
        const request = indexedDB.open(self.dbName, DB_VERSION);
        request.onupgradeneeded = function (event) {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(DATA_STORE)) {
            db.createObjectStore(DATA_STORE, { keyPath: 'id' });
          }
        };
        request.onsuccess = function () {
          self.db = request.result;
          resolve(self.db);
        };
        request.onerror = function () { reject(request.error); };
      });
    }

    async _put(meta, json) {
      const db = await this._open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
        tx.objectStore(META_STORE).put(meta);
        tx.objectStore(DATA_STORE).put({ id: meta.id, json: json });
        tx.oncomplete = function () { resolve(meta); };
        tx.onerror = function () { reject(tx.error); };
      });
    }

    async list() {
      const db = await this._open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(META_STORE, 'readonly');
        const request = tx.objectStore(META_STORE).getAll();
        request.onsuccess = function () { resolve(sortNewest(request.result || [])); };
        request.onerror = function () { reject(request.error); };
      });
    }

    async latest() {
      const records = await this.list();
      return records.length ? records[0] : null;
    }

    async create(reason, dump) {
      if (!dump || typeof dump !== 'object') throw new Error('Snapshot data is required');
      const json = JSON.stringify(dump);
      const now = new Date().toISOString();
      const size = (typeof TextEncoder !== 'undefined')
        ? new TextEncoder().encode(json).length
        : json.length;
      const meta = {
        id: 'snap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        createdAt: now,
        reason: reason || 'manual',
        schemaVersion: dump.schemaVersion || 1,
        appVersion: (BeeStore.version || ''),
        deviceId: (dump.meta && dump.meta.deviceId) || null,
        size: size,
        documents: countDocuments(dump),
      };
      await this._put(meta, json);
      await this.prune();
      return meta;
    }

    async get(id) {
      const db = await this._open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DATA_STORE, 'readonly');
        const request = tx.objectStore(DATA_STORE).get(id);
        request.onsuccess = function () {
          const row = request.result;
          if (!row) return resolve(null);
          try { resolve(JSON.parse(row.json)); }
          catch (e) { reject(e); }
        };
        request.onerror = function () { reject(request.error); };
      });
    }

    async download(id) {
      const dump = await this.get(id);
      if (!dump) throw new Error('Snapshot not found');
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'beestore-snapshot-' + id + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    }

    async prune() {
      const records = await this.list();
      const expired = pickExpired(records, this.max);
      if (!expired.length) return 0;
      const db = await this._open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
        for (const id of expired) {
          tx.objectStore(META_STORE).delete(id);
          tx.objectStore(DATA_STORE).delete(id);
        }
        tx.oncomplete = function () { resolve(expired.length); };
        tx.onerror = function () { reject(tx.error); };
      });
    }
  }

  BeeStore.SnapshotService = SnapshotService;
  BeeStore.snapshots = BeeStore.snapshots || null;
  if (typeof module !== 'undefined') {
    module.exports = { SnapshotService, pickExpired, countDocuments, sortNewest };
  }
})(typeof window !== 'undefined' ? window : globalThis);
