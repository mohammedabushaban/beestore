(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class StockService {
    constructor(repo) {
      this.repo = repo;
    }

    // Canonical weighted-average rule (v2 §8): kept as a compatibility helper
    // for imported/legacy data. New postings use tracked value (§3.2).
    blendCost(oldQty, oldCost, qty, unitCost) {
      oldQty = Number(oldQty) || 0;
      if (oldQty <= 0) return BeeStore.money.roundMinor(unitCost);
      return Math.round((oldQty * BeeStore.money.roundMinor(oldCost) +
        Number(qty) * BeeStore.money.roundMinor(unitCost)) / (oldQty + Number(qty)));
    }

    /**
     * v5 §3.2: average cost is derived from tracked value, never authoritative.
     * @param {number} quantity on-hand quantity
     * @param {number} valueMinor tracked inventory value
     * @param {number} [fallback] last known cost when quantity is not positive
     * @returns {number} rounded average cost minor units
     */
    averageCost(quantity, valueMinor, fallback) {
      const qty = Number(quantity) || 0;
      if (qty > 0) return Math.round((Number(valueMinor) || 0) / qty);
      return Math.round(Number(fallback) || 0);
    }

    /** Initializes a legacy variant's missing valueMinor from qty × cost. */
    ensureValue(variant) {
      let value = Number(variant && variant.valueMinor);
      if (!Number.isSafeInteger(value)) {
        value = (Number(variant && variant.quantity) || 0) *
          (Number(variant && variant.costMinor) || 0);
      }
      variant.valueMinor = value;
      return value;
    }

    /** Updates the derived display cost after a value/quantity change. */
    setAverageCost(variant) {
      const qty = Number(variant.quantity) || 0;
      if (qty <= 0) return variant.costMinor || 0;
      const avg = Math.round((Number(variant.valueMinor) || 0) / qty);
      if (avg >= 0) variant.costMinor = avg;
      return variant.costMinor;
    }

    /**
     * Adds stock and its exact cost. Used by purchases, opening stock,
     * restocks and stock gains.
     * @param {object} variant mutable variant
     * @param {number} qty positive integer quantity
     * @param {number} valueMinor exact value added to inventory
     * @returns {{valueChangeMinor:number,valueAfterMinor:number,avgCostAfterMinor:number}}
     */
    receive(variant, qty, valueMinor) {
      const addQty = Number(qty) || 0;
      const addValue = BeeStore.money.roundMinor(valueMinor);
      const before = this.ensureValue(variant);
      variant.quantity = (Number(variant.quantity) || 0) + addQty;
      variant.valueMinor = before + addValue;
      variant.updatedAt = BeeStore.dates.now();
      const avg = this.setAverageCost(variant);
      return {
        valueChangeMinor: addValue,
        valueAfterMinor: variant.valueMinor,
        avgCostAfterMinor: avg,
      };
    }

    /**
     * Removes stock and returns the exact value consumed (§3.2). The last
     * unit takes the remaining value exactly; an unsupported (negative)
     * quantity uses the last known average and is flagged as estimated.
     * @param {object} variant mutable variant
     * @param {number} qty positive integer quantity
     * @returns {{cogsMinor:number,valueChangeMinor:number,valueAfterMinor:number,avgCostAfterMinor:number,estimated:boolean}}
     */
    issue(variant, qty) {
      const outQty = Number(qty) || 0;
      const available = Number(variant.quantity) || 0;
      const value = this.ensureValue(variant);
      const lastCost = Number(variant.costMinor) || 0;
      let cogs;
      let estimated = false;
      if (available > 0 && outQty <= available) {
        cogs = outQty === available
          ? value
          : Math.round(value * outQty / available);
      } else if (available > 0) {
        estimated = true;
        cogs = value + Math.round((outQty - available) * lastCost);
      } else {
        estimated = true;
        cogs = Math.round(outQty * lastCost);
      }
      variant.quantity = available - outQty;
      variant.valueMinor = value - cogs;
      variant.updatedAt = BeeStore.dates.now();
      const avg = this.setAverageCost(variant);
      return {
        cogsMinor: cogs,
        valueChangeMinor: -cogs,
        valueAfterMinor: variant.valueMinor,
        avgCostAfterMinor: avg,
        estimated,
      };
    }

    /**
     * Adds returned stock back at its original cost. Linked returns pass the
     * original sale cost; unlinked returns pass the current average.
     */
    restore(variant, qty, valueMinor) {
      return this.receive(variant, qty, valueMinor);
    }

    /** Removes stock value for a purchase return / adjustment loss. */
    removeValue(variant, qty) {
      return this.issue(variant, qty);
    }

    /**
     * Revalues on-hand stock to a new average cost (v4 R1). Quantity is not
     * changed; the difference is the tracked value delta.
     */
    revalue(variant, newCostMinor) {
      const qty = Number(variant.quantity) || 0;
      const before = this.ensureValue(variant);
      const cost = BeeStore.money.roundMinor(newCostMinor);
      const target = Math.round(cost * qty);
      variant.valueMinor = target;
      variant.costMinor = cost;
      variant.updatedAt = BeeStore.dates.now();
      return {
        valueChangeMinor: target - before,
        valueAfterMinor: target,
        avgCostAfterMinor: cost,
      };
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
        const qty = Number(qtyChange) || 0;
        let change;
        if (qty < 0) change = this.issue(variant, Math.abs(qty));
        else change = this.receive(variant, qty, qty * (Number(variant.costMinor) || 0));
        const m = {
          id: BeeStore.ids.randomId('stm'),
          variantId,
          date: date || BeeStore.dates.today(),
          type: 'adjustment',
          qtyChange: qty,
          unitCostMinor: qty === 0 ? variant.costMinor :
            Math.round(Math.abs(change.valueChangeMinor) / Math.abs(qty)),
          valueChangeMinor: change.valueChangeMinor,
          valueAfterMinor: change.valueAfterMinor,
          avgCostAfterMinor: change.avgCostAfterMinor,
          refType: 'adjustment',
          refId: null,
          note: note || reason || 'تسوية مخزون',
          balanceAfter: variant.quantity,
          createdAt: BeeStore.dates.now(),
          journalEntryIds: [],
        };
        tx.put('stockMovements', m);
        tx.put('variants', variant);
        if (BeeStore.posting && qty !== 0 && change.valueChangeMinor !== 0) {
          const entry = await BeeStore.posting.stockAdjustment(tx, m, change.valueChangeMinor);
          if (entry) {
            BeeStore.posting.link(m, entry);
            tx.put('stockMovements', m);
          }
        }
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
          let change;
          if (diff < 0) change = this.issue(variant, Math.abs(diff));
          else change = this.receive(variant, diff, diff * (Number(variant.costMinor) || 0));
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: item.variantId,
            date: date || BeeStore.dates.today(),
            type: 'stocktake',
            qtyChange: diff,
            unitCostMinor: diff === 0 ? variant.costMinor :
              Math.round(Math.abs(change.valueChangeMinor) / Math.abs(diff)),
            valueChangeMinor: change.valueChangeMinor,
            valueAfterMinor: change.valueAfterMinor,
            avgCostAfterMinor: change.avgCostAfterMinor,
            refType: 'stocktake',
            refId: null,
            note: 'جرد',
            balanceAfter: item.countedQty,
            createdAt: BeeStore.dates.now(),
            journalEntryIds: [],
          };
          tx.put('stockMovements', movement);
          tx.put('variants', variant);
          if (BeeStore.posting && change.valueChangeMinor !== 0) {
            const entry = await BeeStore.posting.stockAdjustment(tx, movement, change.valueChangeMinor);
            if (entry) {
              BeeStore.posting.link(movement, entry);
              tx.put('stockMovements', movement);
            }
          }
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

    /** Inventory value as of date. Uses tracked valueAfterMinor when present.
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{date:string,totalCost:number,lines:Array}>} valuation
     */
    async valueAsOf(date) {
      const variants = await this.repo.list('variants');
      const last = await this.repo.lastManyByIndex(
        'stockMovements', 'variantDate', 'variantId',
        variants.map(v => v.id), 'date', date);
      // A variant with movements after the as-of date but none on/before it
      // had no stock then. Only a variant with no movement ledger at all falls
      // back to its stored quantity/value (legacy record predating A2).
      const missing = variants.filter(v => !last[v.id]).map(v => v.id);
      const everMoved = await this.repo.lastManyByIndex(
        'stockMovements', 'variantDate', 'variantId',
        missing, 'date', '9999-12-31');
      let totalCost = 0;
      const lines = [];
      for (const variant of variants) {
        const m = last[variant.id];
        let qty;
        let value;
        let avg;
        if (m) {
          qty = m.balanceAfter != null ? Number(m.balanceAfter) || 0 : 0;
          if (m.valueAfterMinor != null) {
            value = Number(m.valueAfterMinor) || 0;
            avg = this.averageCost(qty, value,
              m.avgCostAfterMinor != null ? m.avgCostAfterMinor : m.unitCostMinor);
          } else {
            avg = m.avgCostAfterMinor != null ? Number(m.avgCostAfterMinor) || 0
              : Number(m.unitCostMinor) || 0;
            value = qty * avg;
          }
        } else if (everMoved[variant.id]) {
          qty = 0;
          value = 0;
          avg = 0;
        } else {
          qty = Number(variant.quantity) || 0;
          value = variant.valueMinor != null ? Number(variant.valueMinor) || 0
            : qty * (Number(variant.costMinor) || 0);
          avg = this.averageCost(qty, value, variant.costMinor);
        }
        if (qty === 0 && value === 0) continue;
        totalCost += value;
        lines.push({
          variantId: variant.id,
          qty,
          avgCostMinor: avg,
          valueMinor: value,
        });
      }
      return { date, totalCost, lines };
    }

    /** Compares stored quantities/values against the movement ledger.
     * @returns {Promise<{ok:boolean,mismatches:Array}>} verification result
     */
    async verifyStock() {
      const allVariants = await this.repo.list('variants');
      const allMovements = await this.repo.list('stockMovements');
      const qtyTotals = {};
      const valueTotals = {};
      const moveCount = {};
      const valuedCount = {};
      for (const m of allMovements) {
        if (!m.variantId) continue;
        qtyTotals[m.variantId] = (qtyTotals[m.variantId] || 0) + (Number(m.qtyChange) || 0);
        moveCount[m.variantId] = (moveCount[m.variantId] || 0) + 1;
        if (m.valueChangeMinor != null) {
          valueTotals[m.variantId] = (valueTotals[m.variantId] || 0) +
            (Number(m.valueChangeMinor) || 0);
          valuedCount[m.variantId] = (valuedCount[m.variantId] || 0) + 1;
        }
      }
      const mismatches = [];
      for (const v of allVariants) {
        const expected = qtyTotals[v.id] || 0;
        if (v.quantity !== expected) {
          mismatches.push({
            variantId: v.id, field: 'quantity',
            stored: v.quantity, calculated: expected,
          });
        }
        // Only compare value when the entire ledger for the variant carries
        // tracked values; a partially migrated legacy ledger has no baseline.
        if (v.valueMinor != null && moveCount[v.id] > 0 &&
          valuedCount[v.id] === moveCount[v.id] &&
          v.valueMinor !== (valueTotals[v.id] || 0)) {
          mismatches.push({
            variantId: v.id, field: 'value',
            stored: v.valueMinor, calculated: valueTotals[v.id] || 0,
          });
        }
      }
      return { ok: mismatches.length === 0, mismatches };
    }
  }

  BeeStore.stock = new StockService(null);
  BeeStore.StockService = StockService;
  if (typeof module !== 'undefined') module.exports = StockService;
})(typeof window !== 'undefined' ? window : globalThis);
