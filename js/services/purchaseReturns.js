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
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const purchase = await tx.get('purchases', data.purchaseId);
        if (!purchase) throw BeeStore.errors.err('NOT_FOUND', 'فاتورة المشتريات غير موجودة');
        if (purchase.status === 'void') throw BeeStore.errors.err('PURCHASE_VOID', 'لا يمكن إرجاع فاتورة ملغاة');

        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.returnPrefix || 'RET') + '-' +
          String(await tx.nextCounter('purchaseReturn')).padStart(6, '0');

        const lines = [];
        let totalMinor = 0;
        for (const line of (data.lines || [])) {
          const pline = purchase.lines[line.purchaseLineIndex];
          if (!pline) throw BeeStore.errors.err('INVALID_LINE', 'بند غير صالح');
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
          totalMinor += pline.unitCostMinor * qty;
          lines.push({
            purchaseLineIndex: line.purchaseLineIndex,
            variantId: pline.variantId,
            qty,
            unitCostMinor: pline.unitCostMinor,
            lineTotalMinor: pline.unitCostMinor * qty,
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
        };
        tx.put('purchaseReturns', ret);

        for (const line of lines) {
          const pline = purchase.lines[line.purchaseLineIndex];
          pline.returnedQty = (pline.returnedQty || 0) + line.qty;
          const variant = await tx.get('variants', line.variantId);
          variant.quantity -= line.qty;
          variant.updatedAt = BeeStore.dates.now();
          tx.put('variants', variant);
          tx.put('stockMovements', {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: ret.date,
            type: 'purchase_return',
            qtyChange: -line.qty,
            unitCostMinor: line.unitCostMinor,
            avgCostAfterMinor: variant.costMinor,
            refType: 'purchase_return',
            refId: ret.id,
            note: 'مرتجع مشتريات ' + ret.number,
            balanceAfter: variant.quantity,
            createdAt: BeeStore.dates.now(),
          });
        }

        purchase.dueMinor = Math.max(0, (purchase.dueMinor || 0) - totalMinor);
        purchase.status = purchase.dueMinor <= 0 ? 'paid'
          : ((purchase.paidMinor || 0) > 0 ? 'partial' : 'unpaid');
        purchase.updatedAt = BeeStore.dates.now();
        tx.put('purchases', purchase);

        return ret;
      });
    }
  }

  BeeStore.purchaseReturns = new PurchaseReturnsService(null);
  BeeStore.PurchaseReturnsService = PurchaseReturnsService;
  if (typeof module !== 'undefined') module.exports = PurchaseReturnsService;
})(typeof window !== 'undefined' ? window : globalThis);
