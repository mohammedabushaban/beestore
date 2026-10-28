(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Purchase returns (v1 §5.14): return goods to a supplier.
   * - Decreases stock (purchase_return movements at original line cost).
   * - mode "reduce_payable": lowers what we owe on the purchase invoice.
   * - mode "cash_refund": lowers the payable AND cash comes back into an
   *   account (picked up by accounts.balance/getLedger).
   * Records are immutable (no delete/void); correct via a new purchase.
   */
  class PurchaseReturnsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * List purchase returns, optionally filtered by date range.
     * @param {object} [filters] {from?, to?}
     * @returns {Promise<object[]>} returns sorted newest-first
     */
    async list(filters) {
      const from = filters && filters.from;
      const to = filters && filters.to;
      const rows = (from || to)
        ? await this.repo.listRange('purchaseReturns', from, to)
        : await this.repo.list('purchaseReturns');
      rows.sort((a, b) => (b.date + b.number).localeCompare(a.date + a.number));
      return rows;
    }

    /**
     * Get a purchase return by id.
     * @param {string} id purchase return id
     * @returns {Promise<object|null>} the return or null when missing
     */
    async get(id) {
      return this.repo.get('purchaseReturns', id);
    }

    /**
     * Post a purchase return: removes stock and reduces the supplier payable.
     * @param {object} data {purchaseId, date?, lines[{purchaseLineIndex,qty}], mode?, method?}
     * @returns {Promise<object>} the created purchase return
     * @throws {BeeError} NOT_FOUND | PURCHASE_VOID | INVALID_LINE | EXCEEDS_PURCHASED | INSUFFICIENT_STOCK | PERIOD_CLOSED
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const returnDate = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, returnDate);
        // A payable reduction has no cash effect; a cash refund does.
        if (data.mode === 'cash_refund') await BeeStore.periods.assertDayOpen(tx, returnDate);
        const purchase = await tx.get('purchases', data.purchaseId);
        if (!purchase) throw BeeStore.errors.err('NOT_FOUND', 'فاتورة المشتريات غير موجودة');
        if (purchase.status === 'void') throw BeeStore.errors.err('PURCHASE_VOID', 'لا يمكن إرجاع فاتورة ملغاة');

        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.returnPrefix || 'RET') + '-' +
          String(await tx.nextCounter('purchaseReturn')).padStart(6, '0');

        const lines = [];
        let totalMinor = 0;
        const seenLines = new Set();
        for (const line of (data.lines || [])) {
          const pline = purchase.lines[line.purchaseLineIndex];
          if (!pline) throw BeeStore.errors.err('INVALID_LINE', 'بند غير صالح');
          if (seenLines.has(line.purchaseLineIndex)) {
            throw BeeStore.errors.err('INVALID_LINE', 'لا يمكن تكرار بند الفاتورة في المرتجع نفسه');
          }
          seenLines.add(line.purchaseLineIndex);
          const qty = Math.floor(Number(line.qty) || 0);
          const maxReturn = pline.qty - (pline.returnedQty || 0);
          if (qty <= 0 || qty > maxReturn) {
            throw BeeStore.errors.err('EXCEEDS_PURCHASED', 'كمية المرتجع تتجاوز الكمية المتبقية من هذا البند');
          }
          const variant = await tx.get('variants', pline.variantId);
          if (!variant) throw BeeStore.errors.err('NOT_FOUND', 'الصنف غير موجود');
          if (!settings.allowNegativeStock && variant.quantity - qty < 0) {
            throw BeeStore.errors.err('INSUFFICIENT_STOCK', 'لا يمكن الإرجاع: المخزون المتوفر من هذا الصنف أقل من الكمية المرتجعة');
          }
          // Refund value follows the net value the purchase carried after its
          // invoice discount (v5 §3.1); the last returned unit takes the
          // remaining value exactly so the parts sum to the line value.
          const lineValue = pline.inventoryValueMinor != null
            ? Math.round(Number(pline.inventoryValueMinor) || 0)
            : BeeStore.money.mul(pline.unitCostMinor, pline.qty);
          const alreadyQty = Number(pline.returnedQty) || 0;
          const alreadyValue = Number(pline.returnedValueMinor) || 0;
          const remainingQty = pline.qty - alreadyQty;
          let allocatedValue;
          if (qty === remainingQty) {
            allocatedValue = lineValue - alreadyValue;
          } else if (alreadyQty === 0) {
            allocatedValue = Math.round(lineValue * qty / pline.qty);
          } else {
            allocatedValue = Math.round(
              (lineValue - alreadyValue) * qty / remainingQty);
          }
          totalMinor += allocatedValue;
          lines.push({
            purchaseLineIndex: line.purchaseLineIndex,
            variantId: pline.variantId,
            qty,
            unitCostMinor: pline.unitCostMinor,
            valueMinor: allocatedValue,
            removedValueMinor: 0,
            differenceMinor: 0,
            lineTotalMinor: allocatedValue,
          });
        }
        if (lines.length === 0) throw BeeStore.errors.err('INVALID', 'أدخل كمية واحدة على الأقل');

        const mode = data.mode === 'cash_refund' ? 'cash_refund' : 'reduce_payable';
        const method = data.method || 'cash';
        const ret = {
          id: BeeStore.ids.randomId('pret'),
          number,
          date: data.date || BeeStore.dates.today(),
          supplierId: purchase.supplierId,
          supplierName: purchase.supplierName || '',
          purchaseId: purchase.id,
          purchaseNumber: purchase.number,
          lines,
          totalMinor,
          mode,
          method,
          accountId: mode === 'cash_refund'
            ? (data.accountId || BeeStore.settings.resolvePaymentAccount(settings, method))
            : null,
          reason: data.reason || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
          journalEntryIds: [],
        };
        tx.put('purchaseReturns', ret);

        let removedValueTotal = 0;
        const returnMovements = [];
        for (const line of lines) {
          const pline = purchase.lines[line.purchaseLineIndex];
          pline.returnedQty = (pline.returnedQty || 0) + line.qty;
          pline.returnedValueMinor = (Number(pline.returnedValueMinor) || 0) + line.valueMinor;
          const variant = await tx.get('variants', line.variantId);
          // v5 §3.2: the value leaves inventory at the current tracked
          // average; any refund difference is posted to 5030.
          const change = BeeStore.stock.issue(variant, line.qty);
          line.removedValueMinor = change.cogsMinor;
          line.differenceMinor = line.valueMinor - change.cogsMinor;
          removedValueTotal += change.cogsMinor;
          tx.put('variants', variant);
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: ret.date,
            type: 'purchase_return',
            qtyChange: -line.qty,
            unitCostMinor: line.qty > 0
              ? Math.round(change.cogsMinor / line.qty)
              : line.unitCostMinor,
            valueChangeMinor: change.valueChangeMinor,
            valueAfterMinor: change.valueAfterMinor,
            avgCostAfterMinor: change.avgCostAfterMinor,
            estimated: !!change.estimated,
            refType: 'purchase_return',
            refId: ret.id,
            note: 'مرتجع مشتريات ' + ret.number,
            balanceAfter: variant.quantity,
            journalEntryIds: [],
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          returnMovements.push(movement);
        }

        purchase.dueMinor = Math.max(0, (purchase.dueMinor || 0) - totalMinor);
        purchase.status = purchase.dueMinor <= 0 ? 'paid'
          : ((purchase.paidMinor || 0) > 0 ? 'partial' : 'unpaid');
        purchase.updatedAt = BeeStore.dates.now();
        tx.put('purchases', purchase);

        if (BeeStore.posting) {
          const entry = await BeeStore.posting.purchaseReturn(
            tx, ret, totalMinor, removedValueTotal);
          if (entry) {
            BeeStore.posting.linkAll([ret].concat(returnMovements), entry);
            for (const movement of returnMovements) tx.put('stockMovements', movement);
          }
        }
        tx.put('purchaseReturns', ret);

        return ret;
      });
    }
  }

  BeeStore.purchaseReturns = new PurchaseReturnsService(null);
  BeeStore.PurchaseReturnsService = PurchaseReturnsService;
  if (typeof module !== 'undefined') module.exports = PurchaseReturnsService;
})(typeof window !== 'undefined' ? window : globalThis);
