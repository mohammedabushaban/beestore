(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class PurchasesService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * List purchase invoices, optionally filtered by date/supplier.
     * @param {object} [filters] {from?, to?, supplierId?}
     * @returns {Promise<object[]>} purchases sorted newest-first
     */
    async list(filters) {
      let purchases = await this.repo.list('purchases');
      if (filters) {
        if (filters.from) purchases = purchases.filter(p => p.date >= filters.from);
        if (filters.to) purchases = purchases.filter(p => p.date <= filters.to);
        if (filters.supplierId) purchases = purchases.filter(p => p.supplierId === filters.supplierId);
      }
      purchases.sort((a, b) => (b.date + b.number).localeCompare(a.date + a.number));
      return purchases;
    }

    /**
     * Get a purchase invoice by id.
     * @param {string} id purchase id
     * @returns {Promise<object|null>} the purchase or null when missing
     */
    async get(id) {
      return this.repo.get('purchases', id);
    }

    /**
     * Post a purchase: blends avg cost, adds stock, tracks supplier payable.
     * @param {object} data {date?, lines[{variantId,qty,unitCostMinor}], payments?, supplierId?}
     * @returns {Promise<object>} the created purchase
     * @throws {BeeError} NOT_FOUND | PERIOD_CLOSED when variant missing or month closed
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.purchasePrefix || 'PUR') + '-' + String(await tx.nextCounter('purchase')).padStart(6, '0');

        const lines = [];
        if (!Array.isArray(data.lines) || data.lines.length === 0) {
          throw BeeStore.errors.err('VALIDATION', 'فاتورة الشراء يجب أن تحتوي على صنف واحد على الأقل');
        }
        for (const line of data.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (!variant) throw BeeStore.errors.err('NOT_FOUND', 'الصنف غير موجود: ' + line.variantId);
          const qty = Number(BeeStore.money.normalizeDigits(line.qty));
          if (!Number.isInteger(qty) || qty <= 0) {
            throw BeeStore.errors.err('VALIDATION', 'كمية الشراء يجب أن تكون عدداً صحيحاً أكبر من صفر');
          }
          const unitCostMinor = BeeStore.money.roundMinor(line.unitCostMinor);
          if (unitCostMinor < 0) {
            throw BeeStore.errors.err('VALIDATION', 'تكلفة الصنف لا يمكن أن تكون سالبة');
          }
          lines.push({
            variantId: variant.id,
            qty,
            unitCostMinor,
            returnedQty: 0,
          });
        }

        const subtotalMinor = BeeStore.money.sum(lines.map(l => BeeStore.money.mul(l.unitCostMinor, l.qty)));
        const discountMinor = BeeStore.money.roundMinor(data.discountMinor || 0);
        if (discountMinor < 0 || discountMinor > subtotalMinor) {
          throw BeeStore.errors.err('VALIDATION', 'خصم فاتورة الشراء غير صالح');
        }
        const totalMinor = subtotalMinor - discountMinor;

        const payments = [];
        let paidMinor = 0;
        if (data.payments) {
          for (const p of data.payments) {
            const amt = BeeStore.money.roundMinor(p.amountMinor);
            if (!isFinite(amt) || amt < 0) {
              throw BeeStore.errors.err('VALIDATION', 'مبلغ الدفعة غير صالح');
            }
            payments.push({
              method: p.method,
              accountId: p.accountId || BeeStore.settings.resolvePaymentAccount(settings, p.method),
              amountMinor: amt,
              date: p.date || data.date || BeeStore.dates.today(),
            });
            paidMinor += amt;
          }
        }
        if (paidMinor > totalMinor) paidMinor = totalMinor;
        const dueMinor = totalMinor - paidMinor;
        const status = paidMinor >= totalMinor ? 'paid' : (paidMinor > 0 ? 'partial' : 'unpaid');

        const purchase = {
          id: BeeStore.ids.randomId('pur'),
          number,
          supplierInvoiceNo: data.supplierInvoiceNo || '',
          date: data.date || BeeStore.dates.today(),
          supplierId: data.supplierId,
          supplierName: data.supplierName || '',
          lines,
          subtotalMinor,
          discountMinor,
          totalMinor,
          payments,
          paidMinor,
          dueMinor,
          status,
          notes: data.notes || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };

        tx.put('purchases', purchase);

        for (const line of lines) {
          const variant = await tx.get('variants', line.variantId);
          const oldQty = variant.quantity;
          const oldCost = variant.costMinor;
          const newQty = oldQty + line.qty;
          const newCost = BeeStore.stock.blendCost(oldQty, oldCost, line.qty, line.unitCostMinor);
          variant.quantity = newQty;
          variant.costMinor = newCost;
          variant.updatedAt = BeeStore.dates.now();
          tx.put('variants', variant);
          tx.put('stockMovements', {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: purchase.date,
            type: 'purchase',
            qtyChange: line.qty,
            unitCostMinor: line.unitCostMinor,
            avgCostAfterMinor: newCost,
            refType: 'purchase',
            refId: purchase.id,
            note: 'مشتريات ' + purchase.number,
            balanceAfter: newQty,
            createdAt: BeeStore.dates.now(),
          });
        }

        return purchase;
      });
    }

    /**
     * Void a purchase: removes purchased stock unless it would go negative.
     * @param {string} id purchase id
     * @returns {Promise<object>} the voided purchase
     * @throws {BeeError} NOT_FOUND | ALREADY_VOID | HAS_RETURNS | STOCK_NEGATIVE | PERIOD_CLOSED
     */
    async void(id) {
      const purchase = await this.repo.transaction(async (tx) => {
        const p = await tx.get('purchases', id);
        if (!p) throw BeeStore.errors.err('NOT_FOUND', 'الفاتورة غير موجودة');
        if (p.status === 'void') throw BeeStore.errors.err('ALREADY_VOID', 'الفاتورة ملغاة مسبقاً');
        const alreadyReturned = (p.lines || []).reduce((s, l) => s + (l.returnedQty || 0), 0);
        if (alreadyReturned > 0) {
          throw BeeStore.errors.err('HAS_RETURNS', 'لا يمكن إلغاء مشتريات لها مرتجعات');
        }
        await BeeStore.periods.assertOpen(tx, p.date);
        await BeeStore.periods.assertOpen(tx, BeeStore.dates.today());

        for (const line of p.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (!variant) continue;
          if (variant.quantity - line.qty < 0) {
            throw BeeStore.errors.err('STOCK_NEGATIVE', 'لا يمكن إلغاء الفاتورة: المخزون سيصبح سالباً');
          }
        }

        for (const line of p.lines) {
          const variant = await tx.get('variants', line.variantId);
          variant.quantity -= line.qty;
          variant.updatedAt = BeeStore.dates.now();
          tx.put('variants', variant);
          tx.put('stockMovements', {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: BeeStore.dates.today(),
            type: 'void_purchase',
            qtyChange: -line.qty,
            unitCostMinor: line.unitCostMinor,
            avgCostAfterMinor: variant.costMinor,
            refType: 'void_purchase',
            refId: p.id,
            note: 'إلغاء مشتريات ' + p.number,
            balanceAfter: variant.quantity,
            createdAt: BeeStore.dates.now(),
          });
        }

        p.status = 'void';
        p.updatedAt = BeeStore.dates.now();
        tx.put('purchases', p);
        return p;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('void', 'purchase', purchase.id, 'إلغاء مشتريات ' + purchase.number);
      }
      return purchase;
    }
  }

  BeeStore.purchases = new PurchasesService(null);
  BeeStore.PurchasesService = PurchasesService;
  if (typeof module !== 'undefined') module.exports = PurchasesService;
})(typeof window !== 'undefined' ? window : globalThis);
