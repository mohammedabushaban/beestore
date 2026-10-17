(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { COLLECTIONS, RepositoryInterface } = BeeStore;

  class MemoryRepository extends RepositoryInterface {
    constructor() {
      super();
      this.data = {};
      this.indexes = {};
      this.counters = {};
      this.revision = 0;
      this.schemaVersion = BeeStore.schemaVersion;
      this.deviceId = null;
      this.opened = false;
      this._initData();
    }

    _initData() {
      for (const c of COLLECTIONS) {
        this.data[c] = new Map();
        this.indexes[c] = {};
      }
      this.data.meta.set('meta', {
        id: 'meta', schemaVersion: this.schemaVersion, counters: {},
        revision: 0, savedAt: null, deviceId: this._genDeviceId(),
      });
    }

    _genDeviceId() {
      if (!this.deviceId) {
        this.deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
      }
      return this.deviceId;
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
      this.opened = true;
      return this;
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
      // v2 §12.1.3/§12.1.4: serialize transactions within this tab so two
      // concurrent creates can't interleave between a dup-check and its put.
      // (Cross-tab concurrency is already excluded by the single-tab lock.)
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
        this._commit(tx._staged);
        this.revision++;
        this.data.meta.get('meta').revision = this.revision;
        this.data.meta.get('meta').updatedAt = BeeStore.dates.now();
        return result;
      } catch (e) {
        this._restore(snapshot);
        throw e;
      }
    }

    _commit(staged) {
      for (const p of staged.puts) {
        this.data[p.collection].set(p.doc.id, JSON.parse(JSON.stringify(p.doc)));
      }
      for (const r of staged.removes) {
        this.data[r.collection].delete(r.id);
      }
      // Perf (v2 §12.1.11): rebuild each touched index ONCE per commit.
      // (Rebuilding per doc per field was O(n²) — minutes at 50k docs.)
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
          const idx = self._ensureIndex(collection, indexName);
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
          if (!meta.counters) meta.counters = {};
          meta.counters[name] = (meta.counters[name] || 0) + 1;
          return meta.counters[name];
        },
        _staged: staged,
      };
      return tx;
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
      return this;
    }

    async clearAll() {
      this._initData();
      this.revision = 0;
    }
  }

  BeeStore.MemoryRepository = MemoryRepository;
  if (typeof module !== 'undefined') module.exports = MemoryRepository;
})(typeof window !== 'undefined' ? window : globalThis);
