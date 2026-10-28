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
    {
      // A2: tracked inventory value. Replays every legacy stock movement with
      // its historical unit cost so existing data keeps its old gross value
      // (no retrospective discount reallocation), then backfills the fields
      // new postings and reports rely on. No journal entries are created here:
      // A3 replays the documents into the journal.
      from: 4,
      to: 5,
      migrate(data) {
        if (!data.collections) data.collections = {};
        const C = data.collections;
        if (!Array.isArray(C.journalEntries)) C.journalEntries = [];
        const round = (v) => Math.round(Number(v) || 0);
        const ensureLinks = (doc) => {
          if (!Array.isArray(doc.journalEntryIds)) doc.journalEntryIds = [];
        };

        for (const sale of (C.sales || [])) {
          ensureLinks(sale);
          let totalCogs = 0;
          for (const line of (sale.lines || [])) {
            const qty = Number(line.qty) || 0;
            const cogs = line.cogsMinor != null
              ? round(line.cogsMinor)
              : round((Number(line.unitCostMinor) || 0) * qty);
            line.cogsMinor = cogs;
            if (line.costEstimated === undefined) line.costEstimated = false;
            if (line.costFlag === undefined) {
              line.costFlag = line.costEstimated ? 'COST_ESTIMATED' : null;
            }
            if (line.returnedCostMinor === undefined) {
              const returned = Number(line.returnedQty) || 0;
              line.returnedCostMinor = qty > 0
                ? Math.round(cogs * returned / qty)
                : 0;
            }
            if (line.returnedDiscountMinor === undefined) {
              line.returnedDiscountMinor = 0;
            }
            totalCogs += cogs;
          }
          if (sale.cogsMinor === undefined) sale.cogsMinor = totalCogs;
          if (sale.costEstimated === undefined) sale.costEstimated = false;
          if (sale.costFlag === undefined) {
            sale.costFlag = sale.costEstimated ? 'COST_ESTIMATED' : null;
          }
        }

        for (const ret of (C.salesReturns || [])) {
          ensureLinks(ret);
          let totalRestock = 0;
          for (const line of (ret.lines || [])) {
            const qty = Number(line.qty) || 0;
            const originalCost = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.returnedCostMinor === undefined) line.returnedCostMinor = originalCost;
            if (line.restockCostMinor === undefined) {
              line.restockCostMinor = line.restock === false ? 0 : originalCost;
            }
            if (line.valueChangeMinor === undefined) line.valueChangeMinor = 0;
            totalRestock += round(line.restockCostMinor);
          }
          if (ret.restockCostMinor === undefined) ret.restockCostMinor = totalRestock;
        }

        // Reconstruct the line discount already refunded by legacy returns so
        // the next partial return takes the exact remainder (v5 §3.1). The
        // old refund formula was unitPrice × qty − rounded discount, so the
        // difference is the discount actually granted.
        const saleById = new Map((C.sales || []).map(s => [s.id, s]));
        for (const ret of (C.salesReturns || [])) {
          const sale = saleById.get(ret.saleId);
          if (!sale || !Array.isArray(sale.lines)) continue;
          for (const line of (ret.lines || [])) {
            const saleLine = sale.lines[Number(line.saleLineIndex)];
            if (!saleLine || line.lineRefundMinor == null) continue;
            const qty = Number(line.qty) || 0;
            const unitPrice = line.unitPriceMinor != null
              ? round(line.unitPriceMinor)
              : round(saleLine.unitPriceMinor);
            const discount = Math.max(0,
              round(unitPrice * qty) - round(line.lineRefundMinor));
            const lineDiscount = Math.max(0, round(saleLine.lineDiscountMinor));
            saleLine.returnedDiscountMinor = Math.min(lineDiscount,
              round(saleLine.returnedDiscountMinor) + discount);
          }
        }

        for (const purchase of (C.purchases || [])) {
          ensureLinks(purchase);
          let totalValue = 0;
          for (const line of (purchase.lines || [])) {
            const qty = Number(line.qty) || 0;
            const gross = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.grossMinor === undefined) line.grossMinor = gross;
            if (line.discountMinor === undefined) line.discountMinor = 0;
            if (line.inventoryValueMinor === undefined) {
              // Preserve the old document-derived inventory value exactly.
              line.inventoryValueMinor = gross;
            }
            if (line.netUnitCostMinor === undefined) {
              line.netUnitCostMinor = qty > 0
                ? Math.round(line.inventoryValueMinor / qty)
                : (Number(line.unitCostMinor) || 0);
            }
            if (line.returnedValueMinor === undefined) line.returnedValueMinor = 0;
            totalValue += round(line.inventoryValueMinor);
          }
          if (purchase.inventoryValueMinor === undefined) {
            purchase.inventoryValueMinor = totalValue;
          }
        }

        for (const ret of (C.purchaseReturns || [])) {
          ensureLinks(ret);
          let totalValue = 0;
          for (const line of (ret.lines || [])) {
            const qty = Number(line.qty) || 0;
            const fallback = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.valueMinor === undefined) {
              line.valueMinor = line.lineTotalMinor != null
                ? round(line.lineTotalMinor)
                : fallback;
            }
            if (line.lineTotalMinor === undefined) line.lineTotalMinor = line.valueMinor;
            if (line.removedValueMinor === undefined) line.removedValueMinor = line.valueMinor;
            if (line.differenceMinor === undefined) {
              line.differenceMinor = round(line.valueMinor - line.removedValueMinor);
            }
            totalValue += round(line.valueMinor);
          }
          if (ret.totalMinor === undefined) ret.totalMinor = totalValue;
        }

        // Replay tracked value in the same date/created order as the stock
        // ledger. Movements already carrying value (a partially migrated or
        // re-imported dump) keep that exact value; all others use their
        // historical unit cost so old reports keep the same gross figures.
        const byVariant = {};
        const movements = C.stockMovements || [];
        for (let i = 0; i < movements.length; i++) {
          const m = movements[i];
          ensureLinks(m);
          if (!m.variantId) continue;
          (byVariant[m.variantId] = byVariant[m.variantId] || []).push({ m, i });
        }
        const replay = {};
        for (const variantId of Object.keys(byVariant)) {
          const seq = byVariant[variantId].sort((a, b) =>
            String(a.m.date || '').localeCompare(String(b.m.date || '')) ||
            String(a.m.createdAt || '').localeCompare(String(b.m.createdAt || '')) ||
            a.i - b.i);
          let qty = 0;
          let value = 0;
          let lastCost = 0;
          for (const entry of seq) {
            const m = entry.m;
            const q = Number(m.qtyChange) || 0;
            const unitCost = round(m.unitCostMinor);
            let valueChange;
            if (m.valueChangeMinor != null) {
              valueChange = round(m.valueChangeMinor);
            } else if (m.type === 'revaluation') {
              valueChange = 0;
            } else {
              // Signed movement value: opening/purchase/void_sale positive,
              // sale/purchase_return/void_purchase negative, adjustments by
              // their own signed quantity.
              valueChange = round(q * unitCost);
            }
            m.valueChangeMinor = valueChange;
            value += valueChange;
            qty += q;
            if (m.type === 'opening' || qty > 0) {
              if (value >= 0 && qty > 0) lastCost = Math.round(value / qty);
            }
            m.valueAfterMinor = round(value);
            const derived = qty > 0 && value >= 0 ? Math.round(value / qty) : 0;
            m.avgCostAfterMinor = derived || lastCost || unitCost;
          }
          replay[variantId] = { qty, value, lastCost };
        }

        for (const variant of (C.variants || [])) {
          ensureLinks(variant);
          const qty = Number(variant.quantity) || 0;
          const oldCost = round(variant.costMinor);
          const state = replay[variant.id];
          if (state) {
            variant.valueMinor = round(state.value);
            if (qty > 0 && variant.valueMinor >= 0) {
              variant.costMinor = Math.round(variant.valueMinor / qty);
            } else if (state.lastCost >= 0) {
              variant.costMinor = state.lastCost;
            }
          } else if (variant.valueMinor == null) {
            variant.valueMinor = round(qty * oldCost);
          }
        }

        return data;
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
