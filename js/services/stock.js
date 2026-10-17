(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class StockService {
    constructor(repo) {
      this.repo = repo;
    }

    // Canonical weighted-average rule (v2 §8): shared by purchase, restock
    // and the migration replay so stored and recomputed avgs always agree.
    blendCost(oldQty, oldCost, qty, unitCost) {
      oldQty = Number(oldQty) || 0;
      if (oldQty <= 0) return BeeStore.money.roundMinor(unitCost);
      return Math.round((oldQty * BeeStore.money.roundMinor(oldCost) +
        Number(qty) * BeeStore.money.roundMinor(unitCost)) / (oldQty + Number(qty)));
    }

    /** Lists stock movements for a variant oldest-first.
     * @param {string} variantId variant id
     * @returns {Promise<Array>} movements
     */
    async movements(variantId) {
      const movements = await this.repo.list('stockMovements', m => m.variantId === variantId);
      movements.sort((a, b) => a.date.localeCompare(b.date));
      return movements;
    }

    /** Posts a manual quantity adjustment in one transaction.
     * @param {string} variantId variant id
     * @param {number} qtyChange signed delta
     * @param {string} reason adjustment reason
     * @param {string} [date] posting date
     * @param {string} [note] extra note
     * @returns {Promise<Object>} created movement
     * @throws {BeeError} NOT_FOUND|PERIOD_CLOSED
     */
    async adjust(variantId, qtyChange, reason, date, note) {
      const movement = await this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, date || BeeStore.dates.today());
        const variant = await tx.get('variants', variantId);
        if (!variant) throw BeeStore.errors.err('NOT_FOUND', 'الصنف غير موجود');
        const newQty = variant.quantity + qtyChange;
        const m = {
          id: BeeStore.ids.randomId('stm'),
          variantId,
          date: date || BeeStore.dates.today(),
          type: 'adjustment',
          qtyChange,
          unitCostMinor: variant.costMinor,
          avgCostAfterMinor: variant.costMinor,
          refType: 'adjustment',
          refId: null,
          note: note || reason || 'تسوية مخزون',
          balanceAfter: newQty,
          createdAt: BeeStore.dates.now(),
        };
        tx.put('stockMovements', m);
        variant.quantity = newQty;
        variant.updatedAt = BeeStore.dates.now();
        tx.put('variants', variant);
        return m;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('stock_adjust', 'variant', variantId, 'تسوية مخزون بمقدار ' + qtyChange + (reason ? ' - ' + reason : ''));
      }
      return movement;
    }

    /** Applies a physical count: posts one movement per differing item.
     * @param {Array} items [{variantId,countedQty}]
     * @param {string} [date] posting date
     * @returns {Promise<Array>} per-item diffs
     * @throws {BeeError} PERIOD_CLOSED if date closed
     */
    async stocktake(items, date) {
      const results = await this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, date || BeeStore.dates.today());
        const res = [];
        for (const item of items) {
          const variant = await tx.get('variants', item.variantId);
          if (!variant) continue;
          const diff = item.countedQty - variant.quantity;
          if (diff === 0) continue;
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: item.variantId,
            date: date || BeeStore.dates.today(),
            type: 'stocktake',
            qtyChange: diff,
            unitCostMinor: variant.costMinor,
            avgCostAfterMinor: variant.costMinor,
            refType: 'stocktake',
            refId: null,
            note: 'جرد',
            balanceAfter: item.countedQty,
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          variant.quantity = item.countedQty;
          variant.updatedAt = BeeStore.dates.now();
          tx.put('variants', variant);
          res.push({ variantId: item.variantId, diff, movement });
        }
        return res;
      });
      if (BeeStore.audit && results.length > 0) {
        BeeStore.audit.record('stocktake', 'stock', null, 'جرد مخزون بعدد ' + results.length + ' صنف');
      }
      return results;
    }

    /** Rebuilds variant quantities from movement sums.
     * @returns {Promise<Array>} corrected {id,old,new} entries
     */
    async recalculateStock() {
      return this.repo.transaction(async (tx) => {
        const allVariants = await tx.list('variants');
        const allMovements = await tx.list('stockMovements');
        const totals = {};
        for (const m of allMovements) {
          totals[m.variantId] = (totals[m.variantId] || 0) + m.qtyChange;
        }
        const updates = [];
        for (const v of allVariants) {
          const correctQty = totals[v.id] || 0;
          if (v.quantity !== correctQty) {
            const oldQty = v.quantity;
            v.quantity = correctQty;
            v.updatedAt = BeeStore.dates.now();
            tx.put('variants', v);
            updates.push({ id: v.id, old: oldQty, new: correctQty });
          }
        }
        return updates;
      });
    }

    /** Inventory value as of date: last balanceAfter × avg cost per variant (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{date:string,totalCost:number,lines:Array}>} valuation
     */
    // v2 §8: inventory at cost as of a date = Σ (last balanceAfter ≤ date
    // × its avgCostAfterMinor) per variant.
    async valueAsOf(date) {
      const movements = await this.repo.list('stockMovements', m => m.date <= date);
      const last = {};
      for (const m of movements) {
        if (!m.variantId) continue;
        const prev = last[m.variantId];
        if (!prev || String(m.date) > String(prev.date) ||
          (m.date === prev.date && String(m.createdAt || '') >= String(prev.createdAt || ''))) {
          last[m.variantId] = m;
        }
      }
      let totalCost = 0;
      const lines = [];
      for (const vid of Object.keys(last)) {
        const m = last[vid];
        const qty = m.balanceAfter != null ? m.balanceAfter : 0;
        const avg = m.avgCostAfterMinor != null ? m.avgCostAfterMinor : (m.unitCostMinor || 0);
        totalCost += qty * avg;
        lines.push({ variantId: vid, qty, avgCostMinor: avg, valueMinor: qty * avg });
      }
      return { date, totalCost, lines };
    }

    /** Compares stored quantities against movement sums without writing.
     * @returns {Promise<{ok:boolean,mismatches:Array}>} verification result
     */
    async verifyStock() {
      const allVariants = await this.repo.list('variants');
      const allMovements = await this.repo.list('stockMovements');
      const totals = {};
      for (const m of allMovements) {
        totals[m.variantId] = (totals[m.variantId] || 0) + m.qtyChange;
      }
      const mismatches = [];
      for (const v of allVariants) {
        const expected = totals[v.id] || 0;
        if (v.quantity !== expected) {
          mismatches.push({ variantId: v.id, stored: v.quantity, calculated: expected });
        }
      }
      return { ok: mismatches.length === 0, mismatches };
    }
  }

  BeeStore.stock = new StockService(null);
  BeeStore.StockService = StockService;
  if (typeof module !== 'undefined') module.exports = StockService;
})(typeof window !== 'undefined' ? window : globalThis);
