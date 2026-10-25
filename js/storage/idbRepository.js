(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { COLLECTIONS, RepositoryInterface } = BeeStore;
  const policy = BeeStore.storagePolicy;

  const BATCH_SIZE = 500;
  const CACHE_LIMIT = 300;

  function isRange(value) {
    return !!(value && typeof value === 'object' && !(value instanceof Date));
  }

  function cloneDoc(doc) {
    return doc == null ? doc : JSON.parse(JSON.stringify(doc));
  }

  function ensureDbIndexes(store, collection) {
    const defs = (policy && policy.indexes && policy.indexes[collection]) || [];
    for (const def of defs) {
      if (!store.indexNames.contains(def[0])) {
        store.createIndex(def[0], def[1]);
      }
    }
  }

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
      this._lazy = {};
      this._window = null;
      this._cache = new Map();
      this.summary = null;
      // Optional UI hook: called with {active, label} while older months are
      // being read from IndexedDB (v3-Lite §5 progress indicator).
      this.onLazyRead = null;
    }

    _setLazyProgress(active, label) {
      if (typeof this.onLazyRead !== 'function') return;
      try {
        this.onLazyRead({ active, label: label || '' });
      } catch (e) {
        // A UI callback must never break a data read.
      }
    }

    /**
     * Starts a progress notification when a read can touch data outside the
     * memory window. Returns a done() function (or null when nothing is shown).
     * Ranges starting inside the window are served without a notification.
     */
    _lazyTracker(collection, from, to, all) {
      if (!this._isLazy(collection)) return null;
      const startDate = this._window && this._window.startDate;
      if (!all && startDate) {
        const fromDate = from ? String(from).slice(0, 10) : '';
        if (fromDate && fromDate >= startDate) return null;
      }
      const label = all
        ? 'جاري تحميل السجلات القديمة…'
        : 'جاري تحميل بيانات شهر قديم…';
      this._setLazyProgress(true, label);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this._setLazyProgress(false, label);
      };
    }

    _genDeviceId() {
      if (!this.deviceId) {
        this.deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
      }
      return this.deviceId;
    }

    _initData() {
      this._lazy = {};
      this._cache.clear();
      this.summary = null;
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

    _isLazy(collection) {
      return !!this._lazy[collection];
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

    _cacheKey(collection, id) {
      return collection + '\u0000' + id;
    }

    _cacheGet(collection, id) {
      const key = this._cacheKey(collection, id);
      if (!this._cache.has(key)) return null;
      const doc = this._cache.get(key);
      // Refresh LRU order.
      this._cache.delete(key);
      this._cache.set(key, doc);
      return doc;
    }

    _cacheSet(collection, id, doc) {
      if (!doc) return;
      const key = this._cacheKey(collection, id);
      this._cache.delete(key);
      this._cache.set(key, doc);
      while (this._cache.size > CACHE_LIMIT) {
        const oldest = this._cache.keys().next().value;
        this._cache.delete(oldest);
      }
    }

    _cacheDrop(collection, id) {
      this._cache.delete(this._cacheKey(collection, id));
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
            let store;
            if (!db.objectStoreNames.contains(c)) {
              store = db.createObjectStore(c, { keyPath: 'id' });
            } else {
              store = e.target.transaction.objectStore(c);
            }
            ensureDbIndexes(store, c);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
      });
      await this._loadAll();
      this.opened = true;
      return this;
    }

    _tx(mode) {
      return this.db.transaction(COLLECTIONS, mode);
    }

    _windowBounds() {
      return policy.windowBounds(BeeStore.dates.today(), policy.memoryWindowMonths());
    }

    /**
     * v3-Lite §5: load master data plus documents in the current/previous
     * months. Older documents stay in IndexedDB and are read on demand.
     */
    async _loadAll() {
      this._window = this._windowBounds();
      const tx = this._tx('readonly');
      await Promise.all(COLLECTIONS.map((c) => this._loadCollection(tx, c)));
      const storedMeta = this.data.meta.get('meta');
      if (storedMeta) {
        if (storedMeta.schemaVersion) this.schemaVersion = storedMeta.schemaVersion;
        this.revision = Number(storedMeta.revision) || 0;
        this.deviceId = storedMeta.deviceId || this._genDeviceId();
        if (storedMeta.summary && storedMeta.summary.version === BeeStore.summary.VERSION) {
          this.summary = storedMeta.summary;
        }
      }
      // First summary-aware start (or a restore from an older backup): build
      // the summary once. Later starts read the tiny persisted document
      // instead of the full invoice history.
      if (!this.summary) await this._rebuildSummary();
    }

    async _rebuildSummary() {
      const collections = {};
      for (const c of BeeStore.summary.COLLECTIONS) {
        collections[c] = await this._dbGetAll(c);
      }
      this.summary = BeeStore.summary.compute(collections);
      const meta = this.data.meta.get('meta');
      if (meta) {
        meta.summary = this.summary;
        await this._persistMeta(meta);
      }
      return this.summary;
    }

    _persistMeta(meta) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    }

    async getSummary() {
      if (!this.summary) await this._rebuildSummary();
      return this.summary;
    }

    _loadCollection(tx, collection) {
      const self = this;
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection);
        const field = policy.dateFieldFor(collection);
        if (!field) {
          const req = store.getAll();
          req.onsuccess = () => {
            self.data[collection] = new Map();
            for (const doc of req.result) self.data[collection].set(doc.id, doc);
            if (collection === 'meta' && !self.data.meta.has('meta')) {
              self.data.meta.set('meta', {
                id: 'meta', schemaVersion: self.schemaVersion, counters: {},
                revision: 0, savedAt: null, deviceId: self._genDeviceId(),
              });
            }
            resolve();
          };
          req.onerror = () => reject(req.error);
          return;
        }

        self._lazy[collection] = true;
        const lower = field === 'month' ? self._window.startMonth : self._window.startDate;
        let req;
        if (store.indexNames && store.indexNames.contains(field)) {
          req = store.index(field).getAll(IDBKeyRange.lowerBound(lower));
        } else {
          req = store.getAll();
        }
        req.onsuccess = () => {
          let docs = req.result || [];
          if (!store.indexNames || !store.indexNames.contains(field)) {
            docs = docs.filter((doc) => policy.inMemoryWindow(doc, field, self._window));
          }
          self.data[collection] = new Map();
          for (const doc of docs) self.data[collection].set(doc.id, doc);
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    }

    _dbGet(collection, id) {
      if (!this.db) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const req = this.db.transaction(collection, 'readonly').objectStore(collection).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    _dbGetAll(collection) {
      if (!this.db) return Promise.resolve([]);
      const done = this._lazyTracker(collection, null, null, true);
      const promise = new Promise((resolve, reject) => {
        const req = this.db.transaction(collection, 'readonly').objectStore(collection).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return done ? promise.finally(done) : promise;
    }

    _dbCount(collection) {
      if (!this.db) return Promise.resolve(0);
      return new Promise((resolve, reject) => {
        const req = this.db.transaction(collection, 'readonly').objectStore(collection).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      });
    }

    _matchesIndex(doc, field, valueOrRange) {
      if (!doc) return false;
      const value = doc[field];
      if (isRange(valueOrRange)) {
        const { gte, lte, gt, lt } = valueOrRange;
        if (gte !== undefined && value < gte) return false;
        if (lte !== undefined && value > lte) return false;
        if (gt !== undefined && value <= gt) return false;
        if (lt !== undefined && value >= lt) return false;
        return true;
      }
      return value === valueOrRange;
    }

    _idbRange(valueOrRange) {
      if (!isRange(valueOrRange)) return null;
      const { gte, lte, gt, lt } = valueOrRange;
      if (gte !== undefined && lte !== undefined) {
        return IDBKeyRange.bound(gte, lte, gt !== undefined, lt !== undefined);
      }
      if (gte !== undefined) return IDBKeyRange.lowerBound(gte, gt !== undefined);
      if (gt !== undefined) return IDBKeyRange.lowerBound(gt, true);
      if (lte !== undefined) return IDBKeyRange.upperBound(lte, lt !== undefined);
      if (lt !== undefined) return IDBKeyRange.upperBound(lt, true);
      return null;
    }

    _dbQuery(collection, indexName, valueOrRange) {
      if (!this.db) return Promise.resolve([]);
      const done = this._lazyTracker(collection, null, null, true);
      const promise = new Promise((resolve, reject) => {
        const tx = this.db.transaction(collection, 'readonly');
        const store = tx.objectStore(collection);
        const hasIndex = !!(indexName && store.indexNames && store.indexNames.contains(indexName));
        const source = hasIndex ? store.index(indexName) : store;
        let req;
        if (hasIndex && isRange(valueOrRange)) {
          const idbRange = this._idbRange(valueOrRange);
          req = idbRange ? source.getAll(idbRange) : source.getAll();
        } else if (hasIndex) {
          req = source.getAll(valueOrRange);
        } else {
          req = store.getAll();
        }
        req.onsuccess = () => {
          let docs = req.result || [];
          if (!hasIndex) docs = docs.filter((doc) => this._matchesIndex(doc, indexName, valueOrRange));
          resolve(docs);
        };
        req.onerror = () => reject(req.error);
      });
      return done ? promise.finally(done) : promise;
    }

    _dbRange(collection, field, from, to) {
      if (!this.db) return Promise.resolve([]);
      const done = this._lazyTracker(collection, from, to, false);
      const promise = new Promise((resolve, reject) => {
        const tx = this.db.transaction(collection, 'readonly');
        const store = tx.objectStore(collection);
        const hasIndex = !!(field && store.indexNames && store.indexNames.contains(field));
        const source = hasIndex ? store.index(field) : store;
        let req;
        if (hasIndex && (from || to)) {
          let range = null;
          if (from && to) range = IDBKeyRange.bound(from, to);
          else if (from) range = IDBKeyRange.lowerBound(from);
          else if (to) range = IDBKeyRange.upperBound(to);
          req = range ? source.getAll(range) : source.getAll();
        } else {
          req = store.getAll();
        }
        req.onsuccess = () => {
          let docs = req.result || [];
          if (!hasIndex) docs = docs.filter((doc) => policy.inRange(doc, field, from, to));
          resolve(docs);
        };
        req.onerror = () => reject(req.error);
      });
      return done ? promise.finally(done) : promise;
    }

    async get(collection, id) {
      const existing = this.data[collection] && this.data[collection].get(id);
      if (existing) return existing;
      if (this._isLazy(collection)) {
        const cached = this._cacheGet(collection, id);
        if (cached) return cached;
        const doc = await this._dbGet(collection, id);
        if (doc) this._cacheSet(collection, id, doc);
        return doc || null;
      }
      return null;
    }

    async list(collection, predicate) {
      let all;
      if (this._isLazy(collection)) {
        all = await this._dbGetAll(collection);
      } else {
        all = Array.from(this.data[collection] ? this.data[collection].values() : []);
      }
      if (predicate) return all.filter(predicate);
      return all;
    }

    async listRange(collection, from, to, predicate) {
      const field = policy.dateFieldFor(collection);
      if (!field) return this.list(collection, predicate);
      let docs;
      if (this._isLazy(collection)) {
        docs = await this._dbRange(collection, field, from, to);
      } else {
        docs = Array.from(this.data[collection] ? this.data[collection].values() : [])
          .filter((doc) => policy.inRange(doc, field, from, to));
      }
      if (predicate) docs = docs.filter(predicate);
      return docs;
    }

    async count(collection) {
      if (this._isLazy(collection)) return this._dbCount(collection);
      return this.data[collection] ? this.data[collection].size : 0;
    }

    /**
     * Newest documents by the collection's date field. The IndexedDB cursor
     * walks the index backwards, so "recent invoices" on the dashboard costs
     * a handful of reads instead of a full collection scan.
     */
    async latest(collection, limit) {
      const n = Math.max(0, Number(limit) || 0);
      if (n === 0) return [];
      const field = policy.dateFieldFor(collection);
      if (this._isLazy(collection) && field) {
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(collection, 'readonly');
          const store = tx.objectStore(collection);
          if (!store.indexNames.contains(field)) {
            store.getAll().onsuccess = (e) => {
              const docs = (e.target.result || [])
                .sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
              resolve(docs.slice(0, n));
            };
            return;
          }
          const out = [];
          const req = store.index(field).openCursor(null, 'prev');
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor || out.length >= n) {
              resolve(out);
              return;
            }
            out.push(cursor.value);
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        });
      }
      const docs = Array.from(this.data[collection] ? this.data[collection].values() : []);
      if (field) {
        docs.sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
      }
      return docs.slice(0, n);
    }

    /**
     * Last document per key with `dateField <= toDate`. Uses a compound
     * `[keyField, dateField]` index and a backwards cursor per key, so stock
     * valuation reads ~one movement per variant instead of the full history.
     * @param {string} collection collection name
     * @param {string} indexName compound index name
     * @param {string} keyField first index field (e.g. variantId)
     * @param {Array<string>} keys keys to resolve
     * @param {string} dateField second index field (e.g. date)
     * @param {string} toDate inclusive upper date
     * @returns {Promise<Object>} key → latest document
     */
    async lastManyByIndex(collection, indexName, keyField, keys, dateField, toDate) {
      if (!this.db) return {};
      const wanted = Array.from(new Set((keys || []).filter(Boolean)));
      if (!wanted.length) return {};
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(collection, 'readonly');
        const store = tx.objectStore(collection);
        const out = {};
        if (!store.indexNames.contains(indexName)) {
          // Older/incomplete databases: read once and filter in memory.
          const req = store.getAll();
          req.onsuccess = () => {
            const upper = toDate ? String(toDate) : '';
            const later = (a, b) => {
              if (String(a[dateField] || '') !== String(b[dateField] || '')) {
                return String(a[dateField] || '') > String(b[dateField] || '');
              }
              return String(a.createdAt || '') >= String(b.createdAt || '');
            };
            for (const doc of (req.result || [])) {
              const key = doc[keyField];
              if (!wanted.includes(key)) continue;
              if (upper && String(doc[dateField] || '') > upper) continue;
              const current = out[key];
              if (!current || later(doc, current)) out[key] = doc;
            }
            resolve(out);
          };
          req.onerror = () => reject(req.error);
          return;
        }
        const source = store.index(indexName);
        const upper = toDate ? String(toDate) : '\uffff';
        let pending = wanted.length;
        let settled = false;
        for (const key of wanted) {
          const req = source.openCursor(IDBKeyRange.bound([key, ''], [key, upper]), 'prev');
          req.onsuccess = () => {
            if (settled) return;
            const cursor = req.result;
            const best = out[key];
            if (!cursor) {
              pending--;
              if (pending === 0) {
                settled = true;
                resolve(out);
              }
              return;
            }
            if (!best) {
              out[key] = cursor.value;
              cursor.continue();
              return;
            }
            // A compound index orders equal dates by primary key, not by
            // creation time. Walk the rows that share the latest date and
            // pick the one actually written last (usually 1–2 rows).
            if (String(cursor.value[dateField] || '') !== String(best[dateField] || '')) {
              pending--;
              if (pending === 0) {
                settled = true;
                resolve(out);
              }
              return;
            }
            if (String(cursor.value.createdAt || '') >= String(best.createdAt || '')) {
              out[key] = cursor.value;
            }
            cursor.continue();
          };
          req.onerror = () => {
            if (settled) return;
            settled = true;
            reject(req.error);
          };
        }
      });
    }

    async query(collection, indexName, valueOrRange) {
      if (this._isLazy(collection)) return this._dbQuery(collection, indexName, valueOrRange);
      const idx = this._ensureIndex(collection, indexName);
      if (isRange(valueOrRange)) {
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
      const summarySnapshot = this.summary ? JSON.parse(JSON.stringify(this.summary)) : null;
      const tx = this._createTx();
      try {
        const result = await fn(tx);
        await this._applySummary(tx._staged);
        const meta = this.data.meta.get('meta');
        if (meta) {
          this.revision++;
          meta.revision = this.revision;
          meta.updatedAt = BeeStore.dates.now();
          if (this.summary) {
            this.summary.computedAt = meta.updatedAt;
            meta.summary = this.summary;
          }
          tx.put('meta', meta);
        }
        await this._commit(tx._staged);
        return result;
      } catch (e) {
        this._restore(snapshot);
        this.summary = summarySnapshot;
        throw e;
      }
    }

    /**
     * Updates the materialized dashboard summary in the same transaction as
     * the business documents. Old values are needed for updates: an edited
     * invoice must first remove its previous contribution.
     */
    async _applySummary(staged) {
      if (!this.summary) return;
      const names = BeeStore.summary.COLLECTIONS;
      const pending = new Map();
      const keyOf = (collection, id) => collection + '\u0000' + id;
      const existing = async (collection, id, key) => {
        if (pending.has(key)) return pending.get(key);
        let doc = this.data[collection] && this.data[collection].get(id);
        if (!doc && this._isLazy(collection)) doc = await this._dbGet(collection, id);
        return doc || null;
      };

      for (const p of staged.puts) {
        if (names.indexOf(p.collection) < 0) continue;
        const key = keyOf(p.collection, p.doc.id);
        const old = await existing(p.collection, p.doc.id, key);
        BeeStore.summary.apply(this.summary, p.collection, old, p.doc);
        pending.set(key, p.doc);
      }
      for (const r of staged.removes) {
        if (names.indexOf(r.collection) < 0) continue;
        const key = keyOf(r.collection, r.id);
        const old = await existing(r.collection, r.id, key);
        BeeStore.summary.apply(this.summary, r.collection, old, null);
        pending.set(key, null);
      }
    }

    _snapshot() {
      // Shallow Map copies are enough: transaction reads clone their results
      // (see _createTx), so uncommitted work never mutates the live documents.
      // Deep-cloning the whole 6k-doc memory window on every save was the main
      // cost against the L2 100 ms save target. Meta/settings are tiny and are
      // still copied deeply because nextCounter mutates meta in place.
      const snap = {};
      for (const c of COLLECTIONS) {
        if (c === 'meta') {
          snap[c] = new Map();
          for (const [k, v] of this.data[c]) snap[c].set(k, JSON.parse(JSON.stringify(v)));
        } else {
          snap[c] = new Map(this.data[c]);
        }
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
          const existing = self.data[collection] && self.data[collection].get(id);
          if (existing) return JSON.parse(JSON.stringify(existing));
          if (self._isLazy(collection)) {
            const doc = await self._dbGet(collection, id);
            if (doc) return JSON.parse(JSON.stringify(doc));
          }
          return null;
        },
        async list(collection, predicate) {
          const all = self._isLazy(collection)
            ? await self._dbGetAll(collection)
            : Array.from(self.data[collection] ? self.data[collection].values() : []).map(cloneDoc);
          const stagedDocs = staged.puts.filter(p => p.collection === collection).map(p => p.doc);
          const stagedIds = new Set(stagedDocs.map(d => d.id));
          const removedIds = new Set(staged.removes.filter(r => r.collection === collection).map(r => r.id));
          const merged = all.filter(d => !removedIds.has(d.id) && !stagedIds.has(d.id)).concat(stagedDocs);
          if (predicate) return merged.filter(predicate);
          return merged;
        },
        async listRange(collection, from, to, predicate) {
          const field = policy.dateFieldFor(collection);
          let base = field ? await self.listRange(collection, from, to) : await tx.list(collection);
          const stagedDocs = staged.puts.filter(p => p.collection === collection).map(p => p.doc);
          const stagedIds = new Set(stagedDocs.map(d => d.id));
          const removedIds = new Set(staged.removes.filter(r => r.collection === collection).map(r => r.id));
          base = base.filter(d => !removedIds.has(d.id) && !stagedIds.has(d.id));
          for (const doc of stagedDocs) {
            if (!field || policy.inRange(doc, field, from, to)) base.push(doc);
          }
          if (predicate) base = base.filter(predicate);
          return base;
        },
        async query(collection, indexName, valueOrRange) {
          const base = await self.query(collection, indexName, valueOrRange);
          const map = new Map();
          // Master collections return live references; clone them before a
          // service can mutate a document in place and defeat rollback.
          for (const d of base) map.set(d.id, self._isLazy(collection) ? d : cloneDoc(d));
          for (const r of staged.removes) {
            if (r.collection === collection) map.delete(r.id);
          }
          for (const p of staged.puts) {
            if (p.collection !== collection) continue;
            // A staged update replaces the stored document even when the new
            // value no longer matches the index key.
            map.delete(p.doc.id);
            if (self._matchesIndex(p.doc, indexName, valueOrRange)) {
              map.set(p.doc.id, p.doc);
            }
          }
          return Array.from(map.values());
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
        for (const p of staged.puts) {
          tx.objectStore(p.collection).put(p.doc);
        }
        for (const r of staged.removes) {
          tx.objectStore(r.collection).delete(r.id);
        }
        tx.oncomplete = () => {
          for (const p of staged.puts) {
            this.data[p.collection].set(p.doc.id, JSON.parse(JSON.stringify(p.doc)));
            this._cacheDrop(p.collection, p.doc.id);
          }
          for (const r of staged.removes) {
            this.data[r.collection].delete(r.id);
            this._cacheDrop(r.collection, r.id);
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
            // Lazy collections query IndexedDB indexes directly; their
            // in-memory maps are only the small window and keeping them
            // current on every save wastes the save-invoice budget.
            if (this._isLazy(collection)) continue;
            for (const field of fields) {
              // Rebuild only indexes that were actually used. Creating one
              // for every field of every document made saves O(window).
              if (this.indexes[collection] && this.indexes[collection][field]) {
                this._rebuildIndex(collection, field);
              }
            }
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
        result.collections[c] = this._isLazy(c)
          ? await this._dbGetAll(c)
          : Array.from(this.data[c].values());
      }
      return result;
    }

    async _readBatches(collection, onBatch) {
      if (!this.db) return 0;
      return new Promise((resolve, reject) => {
        let count = 0;
        let batch = [];
        const req = this.db.transaction(collection, 'readonly').objectStore(collection).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            if (batch.length) {
              try { onBatch(batch); } catch (e) { reject(e); return; }
              count += batch.length;
            }
            resolve(count);
            return;
          }
          batch.push(cursor.value);
          if (batch.length >= BATCH_SIZE) {
            try { onBatch(batch); } catch (e) { reject(e); return; }
            count += batch.length;
            batch = [];
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }

    async _streamCollection(parts, collection, counts) {
      let count = 0;
      let first = true;
      const emit = (docs) => {
        if (!docs.length) return;
        if (!first) parts.push(',');
        first = false;
        parts.push(JSON.stringify(docs).slice(1, -1));
        count += docs.length;
      };
      parts.push(JSON.stringify(collection) + ':[');
      if (this._isLazy(collection)) {
        await this._readBatches(collection, emit);
      } else {
        const docs = Array.from(this.data[collection] ? this.data[collection].values() : []);
        for (let i = 0; i < docs.length; i += BATCH_SIZE) emit(docs.slice(i, i + BATCH_SIZE));
      }
      parts.push(']');
      counts[collection] = count;
    }

    /**
     * Builds the backup JSON as a Blob from per-collection chunks. Older
     * documents are read from IndexedDB too, so a memory window never causes
     * a partial backup. No single string ever contains the whole database.
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
        if (!firstCollection) parts.push(',');
        firstCollection = false;
        await this._streamCollection(parts, c, counts);
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
        // Never trust a summary that travelled inside a backup: rebuild it
        // from the restored documents so a stale/tampered value cannot skew
        // balances. The rebuild also persists the fresh summary.
        const restoredMeta = JSON.parse(JSON.stringify(json.meta));
        delete restoredMeta.summary;
        this.data.meta.set('meta', restoredMeta);
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
      // Restored data must obey the same memory window as a normal startup.
      // The app reloads after restore, but tests and direct callers should
      // observe an already-correct window.
      this._initData();
      await this._loadAll();
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
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    }

    async clearAll() {
      this._initData();
      this.revision = 0;
      this.summary = BeeStore.summary.compute({});
      const meta = this.data.meta.get('meta');
      if (meta) meta.summary = this.summary;
      await this._persistAll();
    }
  }

  BeeStore.IdbRepository = IdbRepository;
  if (typeof module !== 'undefined') module.exports = IdbRepository;
})(typeof window !== 'undefined' ? window : globalThis);
