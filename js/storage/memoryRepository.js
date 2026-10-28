(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  if (!BeeStore.summary && typeof require !== 'undefined') require('./summary.js');
  const { COLLECTIONS, RepositoryInterface } = BeeStore;

  function repoErr(code, message) {
    return BeeStore.errors && BeeStore.errors.err
      ? BeeStore.errors.err(code, message)
      : Object.assign(new Error(message), { code });
  }

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
      this._summaryCache = null;
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

    async count(collection) {
      return this.data[collection] ? this.data[collection].size : 0;
    }

    async getSummary() {
      // The repository is the single writer, so caching until the next commit
      // keeps the memory backend's cost close to IndexedDB's materialized
      // summary (Month Review reads it several times).
      if (this._summaryCache) return this._summaryCache;
      const collections = {};
      for (const c of BeeStore.summary.COLLECTIONS) {
        collections[c] = await this.list(c);
      }
      this._summaryCache = BeeStore.summary.compute(collections);
      return this._summaryCache;
    }

    async listRange(collection, from, to, predicate) {
      const field = BeeStore.storagePolicy && BeeStore.storagePolicy.dateFieldFor(collection);
      let docs = Array.from(this.data[collection] ? this.data[collection].values() : []);
      if (field) docs = docs.filter(d => BeeStore.storagePolicy.inRange(d, field, from, to));
      if (predicate) docs = docs.filter(predicate);
      return docs;
    }

    async latest(collection, limit) {
      const field = BeeStore.storagePolicy && BeeStore.storagePolicy.dateFieldFor(collection);
      const docs = Array.from(this.data[collection] ? this.data[collection].values() : []);
      if (field) {
        docs.sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
      }
      return docs.slice(0, Math.max(0, Number(limit) || 0));
    }

    /**
     * Last document per key with `dateField <= toDate`. Mirrors the browser
     * repository's compound index read (used by stock valuation).
     */
    async lastManyByIndex(collection, indexName, keyField, keys, dateField, toDate) {
      const out = {};
      const wanted = new Set((keys || []).filter(Boolean));
      for (const doc of (this.data[collection] ? this.data[collection].values() : [])) {
        const key = doc[keyField];
        if (!wanted.has(key)) continue;
        if (toDate && String(doc[dateField] || '') > String(toDate)) continue;
        const current = out[key];
        if (!current || String(doc[dateField] || '') > String(current[dateField] || '') ||
          (doc[dateField] === current[dateField] &&
            String(doc.createdAt || '') >= String(current.createdAt || ''))) {
          out[key] = doc;
        }
      }
      return out;
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
      this._summaryCache = null;
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
      this._summaryCache = null;
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
          // Later puts win: chart seeding may stage a link update right after
          // the caller staged the record itself.
          for (let i = staged.puts.length - 1; i >= 0; i--) {
            const p = staged.puts[i];
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
          const stagedDocs = new Map();
          for (const p of staged.puts) {
            if (p.collection === collection) stagedDocs.set(p.doc.id, p.doc);
          }
          const removedIds = new Set(staged.removes.filter(r => r.collection === collection).map(r => r.id));
          const merged = all.filter(d => !removedIds.has(d.id) && !stagedDocs.has(d.id))
            .concat(Array.from(stagedDocs.values()));
          if (predicate) return merged.filter(predicate);
          return merged;
        },
        async listRange(collection, from, to, predicate) {
          const merged = await tx.list(collection);
          const field = BeeStore.storagePolicy && BeeStore.storagePolicy.dateFieldFor(collection);
          let docs = field ? merged.filter(d => BeeStore.storagePolicy.inRange(d, field, from, to)) : merged;
          if (predicate) docs = docs.filter(predicate);
          return docs;
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
          if (BeeStore.isAppendOnly && BeeStore.isAppendOnly(collection)) {
            throw repoErr('APPEND_ONLY',
              'دفتر اليومية للإضافة فقط — لا يمكن تعديل أو حذف قيد. أنشئ قيداً عكسياً.');
          }
          const d = JSON.parse(JSON.stringify(doc));
          if (!d.id) d.id = BeeStore.ids.randomId(collection.slice(0, 3));
          if (!d.createdAt) d.createdAt = BeeStore.dates.now();
          d.updatedAt = BeeStore.dates.now();
          staged.puts.push({ collection, doc: d });
          return d;
        },
        async append(collection, doc) {
          const d = JSON.parse(JSON.stringify(doc));
          if (!d.id) d.id = BeeStore.ids.randomId(collection.slice(0, 3));
          const existing = await tx.get(collection, d.id);
          if (existing) {
            throw repoErr('DUPLICATE', 'لا يمكن إلحاق مستند بمعرّف موجود: ' + d.id);
          }
          if (!d.createdAt) d.createdAt = BeeStore.dates.now();
          d.updatedAt = BeeStore.dates.now();
          staged.puts.push({ collection, doc: d });
          return d;
        },
        remove(collection, id) {
          if (BeeStore.isAppendOnly && BeeStore.isAppendOnly(collection)) {
            throw repoErr('APPEND_ONLY',
              'دفتر اليومية للإضافة فقط — لا يمكن تعديل أو حذف قيد. أنشئ قيداً عكسياً.');
          }
          staged.removes.push({ collection, id });
        },
        async nextCounter(name) {
          const meta = self.data.meta.get('meta');
          if (!meta) return 1;
          if (!meta.counters) meta.counters = {};
          meta.counters[name] = (meta.counters[name] || 0) + 1;
          return meta.counters[name];
        },
        async setCounter(name, value) {
          const meta = self.data.meta.get('meta');
          if (!meta) return 0;
          if (!meta.counters) meta.counters = {};
          const requested = Math.max(0, Math.floor(Number(value) || 0));
          const current = Number(meta.counters[name]) || 0;
          meta.counters[name] = Math.max(current, requested);
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

    /**
     * Builds the backup JSON as a Blob from per-collection chunks. This avoids
     * one giant JSON.stringify of the whole database (v3-Lite §5/§6).
     * @returns {Promise<{blob: Blob, schemaVersion: number, counts: Object, meta: Object, settings: Object}>}
     */
    async exportAllStreamed() {
      const parts = [];
      const meta = this.data.meta.get('meta') || null;
      const settings = this.data.meta.get('settings') || null;
      const counts = {};
      parts.push('{"schemaVersion":' + JSON.stringify(this.schemaVersion));
      parts.push(',"meta":' + JSON.stringify(meta));
      parts.push(',"settings":' + JSON.stringify(settings));
      parts.push(',"collections":{');
      let firstCollection = true;
      for (const c of COLLECTIONS) {
        if (c === 'meta') continue;
        const docs = Array.from(this.data[c].values());
        counts[c] = docs.length;
        if (!firstCollection) parts.push(',');
        firstCollection = false;
        parts.push(JSON.stringify(c) + ':[');
        for (let i = 0; i < docs.length; i += 500) {
          if (i > 0) parts.push(',');
          parts.push(JSON.stringify(docs.slice(i, i + 500)).slice(1, -1));
        }
        parts.push(']');
      }
      parts.push('}}');
      return {
        blob: new Blob(parts, { type: 'application/json' }),
        schemaVersion: this.schemaVersion,
        counts: counts,
        meta: meta,
        settings: settings,
      };
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
