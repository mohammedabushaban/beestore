(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  if (!BeeStore.chartSeed && typeof require !== 'undefined') require('../core/chartSeed.js');

  const migrations = [
    {
      from: 1,
      to: 2,
      migrate(data) {
        if (!data.collections) return data;
        for (const sale of (data.collections.sales || [])) {
          if (!sale.returnStatus) sale.returnStatus = 'none';
        }
        return data;
      },
    },
    {
      // v2 periods: expense month/allocation/void flags, recurring template
      // fields, purchase line return tracking, systemStartDate.
      from: 2,
      to: 3,
      migrate(data) {
        if (!data.collections) return data;
        const C = data.collections;
        for (const e of (C.expenses || [])) {
          if (!e.month && e.date) e.month = String(e.date).slice(0, 7);
          if (!e.allocation) e.allocation = { mode: 'single' };
          if (e.voided === undefined) e.voided = false;
          if (e.voidReason === undefined) e.voidReason = null;
        }
        for (const r of (C.recurringExpenses || [])) {
          if (r.startMonth === undefined) r.startMonth = null;
          if (r.endMonth === undefined) r.endMonth = null;
          if (r.lastGeneratedMonth === undefined) r.lastGeneratedMonth = null;
          if (r.effectiveFrom === undefined) r.effectiveFrom = null;
        }
        for (const p of (C.purchases || [])) {
          for (const l of (p.lines || [])) {
            if (l.returnedQty === undefined) l.returnedQty = 0;
          }
        }
        if (!C.periodClosings) C.periodClosings = [];
        // v2 §8/§10: backfill avgCostAfterMinor by replaying each variant's
        // ledger in order (same canonical rule as stock.blendCost).
        const blend = (oldQty, oldCost, qty, unitCost) => {
          oldQty = Number(oldQty) || 0;
          unitCost = Math.round(Number(unitCost) || 0);
          if (oldQty <= 0) return unitCost;
          return Math.round((oldQty * Math.round(Number(oldCost) || 0) + Number(qty) * unitCost) /
            (oldQty + Number(qty)));
        };
        const byVariant = {};
        for (const m of (C.stockMovements || [])) {
          (byVariant[m.variantId] = byVariant[m.variantId] || []).push(m);
        }
        for (const vid of Object.keys(byVariant)) {
          const seq = byVariant[vid].sort((a, b) =>
            String(a.date).localeCompare(String(b.date)) ||
            String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          let qty = 0, avg = 0;
          for (const m of seq) {
            const q = Number(m.qtyChange) || 0;
            if (m.type === 'opening') avg = Math.round(Number(m.unitCostMinor) || 0);
            else if (m.type === 'purchase' || m.type === 'sale_return') {
              avg = blend(qty, avg, q, m.unitCostMinor);
            }
            qty += q;
            if (m.avgCostAfterMinor === undefined) m.avgCostAfterMinor = avg;
          }
        }
        const settings = (data.settings) || {};
        if (!settings.systemStartDate) {
          let earliest = null;
          const consider = (d) => {
            if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
              if (!earliest || d < earliest) earliest = d;
            }
          };
          for (const coll of ['sales', 'purchases', 'expenses', 'stockMovements',
            'customerPayments', 'supplierPayments', 'ownerTransactions', 'transfers']) {
            for (const r of ((C[coll]) || [])) consider(r.date);
          }
          settings.systemStartDate = earliest
            ? earliest.slice(0, 7) + '-01'
            : BeeStore.dates.today().slice(0, 7) + '-01';
          data.settings = settings;
        }
        return data;
      },
    },
    {
      // A1: seed the v5 chart and link legacy money/expense records. Existing
      // documents are untouched; journalEntries starts empty for A3 replay.
      from: 3,
      to: 4,
      migrate(data) {
        if (!data.collections) data.collections = {};
        return BeeStore.chartSeed.applyToData(data);
      },
    },
  ];

  async function migrate(data, currentVersion) {
    let version = data.schemaVersion || 1;
    for (const m of migrations) {
      if (version >= m.from && version < m.to) {
        data = await m.migrate(data);
        version = m.to;
      }
    }
    data.schemaVersion = Math.max(version, currentVersion || version);
    if (data.meta) data.meta.schemaVersion = data.schemaVersion;
    return data;
  }

  BeeStore.migrations = { migrate, migrations };
  if (typeof module !== 'undefined') module.exports = { migrate, migrations };
})(typeof window !== 'undefined' ? window : globalThis);
