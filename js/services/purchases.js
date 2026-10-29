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
      const from = filters && filters.from;
      const to = filters && filters.to;
      let purchases = (from || to)
        ? await this.repo.listRange('purchases', from, to)
        : await this.repo.list('purchases');
      if (filters && filters.supplierId) {
        purchases = purchases.filter(p => p.supplierId === filters.supplierId);
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
        const purchaseDate = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, purchaseDate);
        // v3-Lite §4.5: an unpaid purchase and its stock movement are allowed
        // on a closed day; only the payment/receipt side is day-locked.
        const paymentDates = new Set();
        for (const p of (data.payments || [])) {
          paymentDates.add(p.date || purchaseDate);
        }
        for (const d of paymentDates) await BeeStore.periods.assertDayOpen(tx, d);
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
        // v5 §3.1: invoice discount is allocated to lines by largest
        // remainder so the parts sum exactly to the discount, and inventory
        // is carried at the net line value (§4 row 5).
        const grossValues = lines.map(l => BeeStore.money.mul(l.unitCostMinor, l.qty));
        const discountParts = BeeStore.money.allocate(discountMinor, grossValues);
        let allocatedValueMinor = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineValue = grossValues[i] - discountParts[i];
          lines[i].grossMinor = grossValues[i];
          lines[i].discountMinor = discountParts[i];
          lines[i].inventoryValueMinor = lineValue;
          lines[i].netUnitCostMinor = lines[i].qty > 0
            ? Math.round(lineValue / lines[i].qty)
            : lines[i].unitCostMinor;
          lines[i].returnedValueMinor = 0;
          allocatedValueMinor += lineValue;
        }
        if (allocatedValueMinor !== totalMinor) {
          throw BeeStore.errors.err('VALIDATION', 'توزيع خصم فاتورة الشراء غير متوازن');
        }

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
          inventoryValueMinor: totalMinor,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };

        tx.put('purchases', purchase);

        const purchaseMovements = [];
        for (const line of lines) {
          const variant = await tx.get('variants', line.variantId);
          // v5 §3.2: receive the exact net value, average cost is derived.
          const change = BeeStore.stock.receive(variant, line.qty, line.inventoryValueMinor);
          tx.put('variants', variant);
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: purchase.date,
            type: 'purchase',
            qtyChange: line.qty,
            unitCostMinor: line.qty > 0
              ? Math.round(line.inventoryValueMinor / line.qty)
              : line.unitCostMinor,
            valueChangeMinor: change.valueChangeMinor,
            valueAfterMinor: change.valueAfterMinor,
            avgCostAfterMinor: change.avgCostAfterMinor,
            refType: 'purchase',
            refId: purchase.id,
            note: 'مشتريات ' + purchase.number,
            balanceAfter: variant.quantity,
            journalEntryIds: [],
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          purchaseMovements.push(movement);
        }

        if (BeeStore.posting) {
          const entry = await BeeStore.posting.purchase(tx, purchase, totalMinor);
          if (entry) {
            BeeStore.posting.linkAll([purchase].concat(purchaseMovements), entry);
            for (const movement of purchaseMovements) tx.put('stockMovements', movement);
          }
          // v5 §4 row 5: each embedded supplier payment clears AP on its date.
          const paymentsPosted = await BeeStore.posting.purchasePayments(tx, purchase);
          BeeStore.posting.linkAll([purchase], paymentsPosted);
          tx.put('purchases', purchase);
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
        const settings = await tx.get('meta', 'settings') || {};
        // Unpaid purchase voids only move stock; paid ones reverse a payment.
        for (const pay of (p.payments || [])) {
          await BeeStore.periods.assertDayOpen(tx, pay.date || p.date);
        }

        for (const line of p.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (!variant) continue;
          if (!settings.allowNegativeStock && variant.quantity - line.qty < 0) {
            throw BeeStore.errors.err('STOCK_NEGATIVE', 'لا يمكن إلغاء الفاتورة: المخزون سيصبح سالباً');
          }
          const removedValue = line.inventoryValueMinor != null
            ? Math.round(Number(line.inventoryValueMinor) || 0)
            : BeeStore.money.mul(line.unitCostMinor, line.qty);
          if (!settings.allowNegativeStock &&
            BeeStore.stock.ensureValue(variant) - removedValue < 0) {
            throw BeeStore.errors.err('STOCK_NEGATIVE',
              'لا يمكن إلغاء الفاتورة: قيمة المخزون المتبقية ستكون سالبة');
          }
        }

        const voidMovements = [];
        for (const line of p.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (!variant) continue;
          const removedValue = line.inventoryValueMinor != null
            ? Math.round(Number(line.inventoryValueMinor) || 0)
            : BeeStore.money.mul(line.unitCostMinor, line.qty);
          variant.quantity -= line.qty;
          variant.valueMinor = BeeStore.stock.ensureValue(variant) - removedValue;
          BeeStore.stock.setAverageCost(variant);
          variant.updatedAt = BeeStore.dates.now();
          tx.put('variants', variant);
          const movement = {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: p.date,
            type: 'void_purchase',
            qtyChange: -line.qty,
            unitCostMinor: line.qty > 0 ? Math.round(removedValue / line.qty) : 0,
            valueChangeMinor: -removedValue,
            valueAfterMinor: variant.valueMinor,
            avgCostAfterMinor: variant.costMinor,
            refType: 'void_purchase',
            refId: p.id,
            note: 'إلغاء مشتريات ' + p.number,
            balanceAfter: variant.quantity,
            journalEntryIds: [],
            createdAt: BeeStore.dates.now(),
          };
          tx.put('stockMovements', movement);
          voidMovements.push(movement);
        }

        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(
            tx, 'PURCHASE', p.id,
            { description: 'إلغاء مشتريات ' + p.number },
            { allowClosedDay: true });
          if (reversals.length > 0) {
            BeeStore.posting.linkAll([p].concat(voidMovements), reversals);
            // Re-persist after linking: IndexedDB structured-clones at put
            // time, so a later mutation of the staged object is not saved.
            for (const movement of voidMovements) tx.put('stockMovements', movement);
          }
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
