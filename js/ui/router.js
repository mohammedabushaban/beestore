(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  class Router {
    constructor() {
      this.routes = {};
      this.currentRoute = null;
    }

    register(path, handler) {
      this.routes[path] = handler;
    }

    _split(path) {
      const s = String(path || '/');
      const q = s.indexOf('?');
      if (q < 0) return { base: s || '/', query: '' };
      return { base: s.slice(0, q) || '/', query: s.slice(q + 1) };
    }

    _selFromQuery(query) {
      try {
        const params = new URLSearchParams(query);
        const m = params.get('m');
        if (m && MONTH_RE.test(m)) return { mode: 'month', month: m };
        const y = params.get('y');
        if (y && /^\d{4}$/.test(y)) return { mode: 'year', year: y };
        const from = params.get('from'), to = params.get('to');
        if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) &&
          /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
          return { mode: 'custom', from, to };
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    navigate(path) {
      const { base, query } = this._split(path);
      // v2 §3: period travels in the hash; it wins over prefs.
      let periodChanged = false;
      const sel = this._selFromQuery(query);
      if (sel && BeeStore.period) {
        const cur = BeeStore.period.toQuery();
        const next = BeeStore.period.toQuery(sel);
        if (cur !== next) {
          BeeStore.period.init(sel);
          periodChanged = true;
        }
      }
      if (this.currentRoute === base && !periodChanged) return;
      this.currentRoute = base;
      const handler = this.routes[base];
      if (handler) {
        handler();
      }
      this._updateUrl(base);
    }

    _updateUrl(base) {
      if (typeof history !== 'undefined' && history.pushState) {
        const q = BeeStore.period ? BeeStore.period.toQuery() : null;
        history.pushState({ path: base }, '', '#' + base + (q ? '?' + q : ''));
      }
    }

    handleHash() {
      const hash = location.hash.slice(1) || '/';
      this.navigate(hash);
    }

    start() {
      window.addEventListener('hashchange', () => this.handleHash());
      this.handleHash();
    }
  }

  BeeStore.router = new Router();
  BeeStore.Router = Router;
  if (typeof module !== 'undefined') module.exports = Router;
})(typeof window !== 'undefined' ? window : globalThis);
