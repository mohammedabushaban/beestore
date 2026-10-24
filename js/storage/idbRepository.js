(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { COLLECTIONS, RepositoryInterface } = BeeStore;

  class IdbRepository extends RepositoryInterface {
    constructor() {
      super();
      this.db = null;
      this.data = {};
      this.indexes = {};
      this.counters = {};
      this.revision = 0;
      this.schemaVersion = BeeStore.schemaVersion;
      this.deviceId = null;
      this.opened = false;
    }

    _genDeviceId() {
      if (!this.deviceId) {
        this.deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
      }
      return this.deviceId;
    }

    _initData() {
      for (const c of COLLECTIONS) {
        this.data[c] = new Map();
        this.indexes[c] = {};
        if (c === 'meta') {
          this.data[c].set('meta', {
            id: 'meta', schemaVersion: this.schemaVersion, counters: {},
            revision: 0, savedAt: null, deviceId: this._genDeviceId(),
          });
        }
      }
    }

    _ensureIndex(collection, field) {
      if (!this.indexes[collection]) this.indexes[collection] = {};
      if (!this.indexes[collection][field]) {
        const idx = new Map();
        for (const [id, doc] of this.data[collection]) {
          const key = doc[field];
          if (key !== undefined && key !== null) {
            if (!idx.has(key)) idx.set(key, []);
            idx.get(key).push(doc);
          }
        }
        this.indexes[collection][field] = idx;
      }
      return this.indexes[collection][field];
    }

    _rebuildIndex(collection, field) {
      this.indexes[collection][field] = null;
      return this._ensureIndex(collection, field);
    }

    async open() {
      if (this.opened) return this;
      this._initData();
      const cfg = BeeStore.config;
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(cfg.dbName, cfg.dbVersion);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          for (const c of COLLECTIONS) {
            if (!db.objectStoreNames.contains(c)) {
              db.createObjectStore(c, { keyPath: 'id' });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await this._loadAll();
      this.opened = true;
      return this;
    }

    _tx(mode) {
      return this.db.transaction(COLLECTIONS, mode);
    }

    _loadAll() {
      return new Promise((resolve, reject) => {
        const tx = this._tx('readonly');
        let pending = COLLECTIONS.length;
        for (const c of COLLECTIONS) {
          const store = tx.objectStore(c);
          const req = store.getAll();
          req.onsuccess = () => {
            this.data[c] = new Map();
            for (const doc of req.result) {
              this.data[c].set(doc.id, doc);
            }
            if (c === 'meta' && !this.data.meta.has('meta')) {
              this.data.meta.set('meta', {
                id: 'meta', schemaVersion: this.schemaVersion, counters: {},
                revision: 0, savedAt: null, deviceId: this._genDeviceId(),
              });
            }
            if (--pending === 0) {
              // exportAll() must report the schema version that is actually
              // stored, otherwise startup migrations see the new version and
              // silently skip every migration step.
              const storedMeta = this.data.meta.get('meta');
              if (storedMeta && storedMeta.schemaVersion) {
                this.schemaVersion = storedMeta.schemaVersion;
              }
              resolve();
            }
          };
          req.onerror = () => reject(req.error);
        }
      });
    }

    async get(collection, id) {
      return this.data[collection].get(id) || null;
    }

    async list(collection, predicate) {
      const all = Array.from(this.data[collection].values());
      if (predicate) return all.filter(predicate);
      return all;
    }

    async query(collection, indexName, valueOrRange) {
      const idx = this._ensureIndex(collection, indexName);
      if (valueOrRange && typeof valueOrRange === 'object' && !(valueOrRange instanceof Date)) {
        const { gte, lte, gt, lt } = valueOrRange;
        const results = [];
        for (const [key, docs] of idx) {
          let match = true;
          if (gte !== undefined && key < gte) match = false;
          if (lte !== undefined && key > lte) match = false;
          if (gt !== undefined && key <= gt) match = false;
          if (lt !== undefined && key >= lt) match = false;
          if (match) results.push(...docs);
        }
        return results;
      }
      return idx.get(valueOrRange) || [];
    }

    async transaction(fn) {
      // v2 §12.1.3/§12.1.4: serialize transactions within this tab (same as
      // the memory repo) — concurrent same-key creates can't interleave.
      const gate = this._txGate || Promise.resolve();
      let release;
      this._txGate = new Promise((res) => { release = res; });
      await gate;
      try {
        return await this._runTransaction(fn);
      } finally {
        release();
      }
    }

    async _runTransaction(fn) {
      const snapshot = this._snapshot();
      const tx = this._createTx();
      try {
        const result = await fn(tx);
        const meta = this.data.meta.get('meta');
        if (meta) {
          this.revision++;
          meta.revision = this.revision;
          meta.updatedAt = BeeStore.dates.now();
          tx.put('meta', meta);
        }
        await this._commit(tx._staged);
        return result;
      } catch (e) {
        this._restore(snapshot);
        throw e;
      }
    }

    _snapshot() {
      const snap = {};
      for (const c of COLLECTIONS) {
        snap[c] = new Map();
        for (const [k, v] of this.data[c]) snap[c].set(k, JSON.parse(JSON.stringify(v)));
      }
      return snap;
    }

    _restore(snap) {
      for (const c of COLLECTIONS) {
        this.data[c] = new Map(snap[c]);
        this.indexes[c] = {};
      }
    }

    _createTx() {
      const self = this;
      const staged = { puts: [], removes: [] };
      const tx = {
        async get(collection, id) {
          for (const p of staged.puts) {
            if (p.collection === collection && p.doc.id === id) return JSON.parse(JSON.stringify(p.doc));
          }
          for (const r of staged.removes) {
            if (r.collection === collection && r.id === id) return null;
          }
          const existing = self.data[collection].get(id);
          if (existing) return JSON.parse(JSON.stringify(existing));
          return null;
        },
        async list(collection, predicate) {
          const all = Array.from(self.data[collection].values());
          const stagedDocs = staged.puts.filter(p => p.collection === collection).map(p => p.doc);
          const stagedIds = new Set(stagedDocs.map(d => d.id));
          const removedIds = new Set(staged.removes.filter(r => r.collection === collection).map(r => r.id));
          const merged = all.filter(d => !removedIds.has(d.id) && !stagedIds.has(d.id)).concat(stagedDocs);
          if (predicate) return merged.filter(predicate);
          return merged;
        },
        async query(collection, indexName, valueOrRange) {
          const all = await tx.list(collection);
          if (valueOrRange && typeof valueOrRange === 'object' && !(valueOrRange instanceof Date)) {
            const { gte, lte, gt, lt } = valueOrRange;
            return all.filter(d => {
              const key = d[indexName];
              if (gte !== undefined && key < gte) return false;
              if (lte !== undefined && key > lte) return false;
              if (gt !== undefined && key <= gt) return false;
              if (lt !== undefined && key >= lt) return false;
              return true;
            });
          }
          return all.filter(d => d[indexName] === valueOrRange);
        },
        put(collection, doc) {
          const d = JSON.parse(JSON.stringify(doc));
          if (!d.id) d.id = BeeStore.ids.randomId(collection.slice(0, 3));
          if (!d.createdAt) d.createdAt = BeeStore.dates.now();
          d.updatedAt = BeeStore.dates.now();
          staged.puts.push({ collection, doc: d });
          return d;
        },
        remove(collection, id) {
          staged.removes.push({ collection, id });
        },
        async nextCounter(name) {
          const meta = self.data.meta.get('meta');
          if (!meta) return 1;
          if (!meta.counters) meta.counters = {};
          meta.counters[name] = (meta.counters[name] || 0) + 1;
          return meta.counters[name];
        },
        _staged: staged,
      };
      return tx;
    }

    _commit(staged) {
      return new Promise((resolve, reject) => {
        const tx = this._tx('readwrite');
        const stores = new Set();
        for (const p of staged.puts) {
          tx.objectStore(p.collection).put(p.doc);
          stores.add(p.collection);
        }
        for (const r of staged.removes) {
          tx.objectStore(r.collection).delete(r.id);
          stores.add(r.collection);
        }
        tx.oncomplete = () => {
          for (const p of staged.puts) {
            this.data[p.collection].set(p.doc.id, JSON.parse(JSON.stringify(p.doc)));
          }
          for (const r of staged.removes) {
            this.data[r.collection].delete(r.id);
          }
          // Perf (v2 §12.1.11): rebuild each touched index ONCE per commit.
          const touched = new Map();
      const touch = (collection, field) => {
        let s = touched.get(collection);
        if (!s) { s = new Set(); touched.set(collection, s); }
        s.add(field);
      };
      for (const p of staged.puts) {
        for (const field of Object.keys(p.doc)) touch(p.collection, field);
      }
      for (const r of staged.removes) {
        for (const field of Object.keys(this.indexes[r.collection] || {})) touch(r.collection, field);
      }
      for (const [collection, fields] of touched) {
        for (const field of fields) this._rebuildIndex(collection, field);
      }
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    }

    async exportAll() {
      const result = {
        schemaVersion: this.schemaVersion,
        meta: this.data.meta.get('meta'),
        settings: this.data.meta.get('settings') || null,
        collections: {},
      };
      for (const c of COLLECTIONS) {
        if (c === 'meta') continue;
        result.collections[c] = Array.from(this.data[c].values());
      }
      return result;
    }

    async importAll(json) {
      this._initData();
      this.schemaVersion = json.schemaVersion || 1;
      if (json.meta) {
        this.data.meta.set('meta', json.meta);
        this.revision = json.meta.revision || 0;
        this.deviceId = json.meta.deviceId || this._genDeviceId();
      }
      if (json.settings) {
        this.data.meta.set('settings', json.settings);
      }
      for (const c of COLLECTIONS) {
        if (c === 'meta') continue;
        const docs = (json.collections && json.collections[c]) || [];
        for (const doc of docs) {
          this.data[c].set(doc.id, JSON.parse(JSON.stringify(doc)));
        }
      }
      await this._persistAll();
      return this;
    }

    _persistAll() {
      return new Promise((resolve, reject) => {
        const tx = this._tx('readwrite');
        for (const c of COLLECTIONS) {
          tx.objectStore(c).clear();
          for (const doc of this.data[c].values()) {
            tx.objectStore(c).put(doc);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async clearAll() {
      this._initData();
      this.revision = 0;
      await this._persistAll();
    }
  }

  BeeStore.IdbRepository = IdbRepository;
  if (typeof module !== 'undefined') module.exports = IdbRepository;
})(typeof window !== 'undefined' ? window : globalThis);
