(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class SuppliersService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all suppliers.
     * @returns {Promise<Array>} All supplier records. */
    async list() {
      return this.repo.list('suppliers');
    }

    /** Fetches a single supplier by id.
     * @param {string} id Supplier id.
     * @returns {Promise<Object|undefined>} Supplier record or undefined. */
    async get(id) {
      return this.repo.get('suppliers', id);
    }

    /** Creates a supplier with defaults and opening balance.
     * @param {Object} data Supplier fields (name, phone, openingBalanceMinor).
     * @returns {Promise<Object>} Created supplier record. */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const supplier = {
          id: BeeStore.ids.randomId('sup'),
          name: data.name,
          phone: data.phone || '',
          address: data.address || '',
          notes: data.notes || '',
          openingBalanceMinor: BeeStore.money.roundMinor(data.openingBalanceMinor || 0),
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('suppliers', supplier);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.openingSupplier(tx, supplier);
          if (entry) {
            BeeStore.posting.link(supplier, entry);
            tx.put('suppliers', supplier);
          }
        }
        return supplier;
      });
    }

    /** Updates a supplier by merging the patch.
     * @param {string} id Supplier id. @param {Object} patch Fields to update.
     * @returns {Promise<Object>} Updated record. @throws {BeeError} NOT_FOUND if missing. */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const s = await tx.get('suppliers', id);
        if (!s) throw BeeStore.errors.err('NOT_FOUND', 'المورد غير موجود');
        const openingChanged = patch && patch.openingBalanceMinor !== undefined &&
          BeeStore.money.roundMinor(patch.openingBalanceMinor) !==
            (Number(s.openingBalanceMinor) || 0);
        const updated = { ...s, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('suppliers', updated);
        if (openingChanged && BeeStore.posting) {
          const entries = await BeeStore.posting.reverseDocument(tx, 'OPENING',
            'open:supplier:' + id,
            { description: 'تعديل رصيد افتتاحي — ' + updated.name },
            { allowClosedDay: true });
          if (entries.length > 0) BeeStore.posting.linkAll([updated], entries);
          const entry = await BeeStore.posting.openingSupplier(tx, updated);
          if (entry) BeeStore.posting.link(updated, entry);
          tx.put('suppliers', updated);
        }
        return updated;
      });
    }

    /** Computes supplier payable now or as of a date (opening + invoiced − paid − returned).
     * @param {string} supplierId Supplier id. @param {string} [asOf] YYYY-MM-DD cutoff.
     * @returns {Promise<number>} Balance in minor units (0 if supplier missing). */
    async balance(supplierId, asOf) {
      const supplier = await this.repo.get('suppliers', supplierId);
      if (!supplier) return 0;
      if (!asOf) {
        let balance = supplier.openingBalanceMinor || 0;
        const purchases = (await this.repo.query('purchases', 'supplierId', supplierId))
          .filter(p => p.status !== 'void');
        for (const p of purchases) {
          balance += p.dueMinor;
        }
        return balance;
      }
      // v2 §8: opening + invoiced − paid − payable-reducing returns. A cash
      // refund does not reduce AP: the supplier still owes the original
      // invoice, but the money for the returned goods came back separately.
      let balance = supplier.openingBalanceMinor || 0;
      const purchases = (await this.repo.query('purchases', 'supplierId', supplierId))
        .filter(p => p.status !== 'void' && p.date <= asOf);
      for (const p of purchases) {
        balance += p.totalMinor;
        for (const pay of (p.payments || [])) {
          if ((pay.date || p.date) <= asOf) balance -= pay.amountMinor;
        }
      }
      const payments = (await this.repo.query('supplierPayments', 'supplierId', supplierId))
        .filter(p => p.date <= asOf);
      for (const p of payments) balance -= p.amountMinor;
      const returns = (await this.repo.query('purchaseReturns', 'supplierId', supplierId))
        .filter(r => r.date <= asOf && r.mode !== 'cash_refund');
      for (const r of returns) balance -= r.totalMinor;
      return balance;
    }

    /** Builds supplier statement with purchases, payments, returns and balance.
     * @param {string} supplierId Supplier id.
     * @returns {Promise<Object|null>} Statement bundle or null if missing. */
    async statement(supplierId) {
      const supplier = await this.repo.get('suppliers', supplierId);
      if (!supplier) return null;
      const purchases = (await this.repo.query('purchases', 'supplierId', supplierId))
        .filter(p => p.status !== 'void');
      const payments = await this.repo.query('supplierPayments', 'supplierId', supplierId);
      const returns = await this.repo.query('purchaseReturns', 'supplierId', supplierId);
      purchases.sort((a, b) => a.date.localeCompare(b.date));
      payments.sort((a, b) => a.date.localeCompare(b.date));
      return { supplier, purchases, payments, returns, balance: await this.balance(supplierId) };
    }

    async pay(data) {
      return this.repo.transaction(async (tx) => {
        const paymentDate = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, paymentDate);
        await BeeStore.periods.assertDayOpen(tx, paymentDate);
        const supplier = await tx.get('suppliers', data.supplierId);
        if (!supplier) throw BeeStore.errors.err('NOT_FOUND', 'المورد غير موجود');
        const settings = await tx.get('meta', 'settings') || {};

        const payment = {
          id: BeeStore.ids.randomId('spay'),
          supplierId: data.supplierId,
          purchaseId: data.purchaseId || null,
          date: data.date || BeeStore.dates.today(),
          amountMinor: BeeStore.money.roundMinor(data.amountMinor),
          method: data.method,
          accountId: data.accountId || BeeStore.settings.resolvePaymentAccount(settings, data.method),
          payerName: (data.payerName || '').trim(),
          payerPhone: (data.payerPhone || '').trim(),
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
        };
        tx.put('supplierPayments', payment);

        if (!data.purchaseId) {
          // Indexed by supplierId: no full scan of old purchases.
          const purchases = (await tx.query('purchases', 'supplierId', data.supplierId))
            .filter(p => p.status !== 'void' && p.dueMinor > 0);
          purchases.sort((a, b) => a.date.localeCompare(b.date));
          let remaining = payment.amountMinor;
          for (const p of purchases) {
            if (remaining <= 0) break;
            const apply = Math.min(remaining, p.dueMinor);
            p.dueMinor -= apply;
            p.paidMinor += apply;
            if (p.dueMinor <= 0) p.status = 'paid';
            else if (p.paidMinor > 0) p.status = 'partial';
            p.updatedAt = BeeStore.dates.now();
            tx.put('purchases', p);
            remaining -= apply;
          }
        } else {
          const purchase = await tx.get('purchases', data.purchaseId);
          if (purchase && purchase.supplierId === data.supplierId) {
            const apply = Math.min(payment.amountMinor, purchase.dueMinor);
            purchase.dueMinor -= apply;
            purchase.paidMinor += apply;
            if (purchase.dueMinor <= 0) purchase.status = 'paid';
            else if (purchase.paidMinor > 0) purchase.status = 'partial';
            purchase.updatedAt = BeeStore.dates.now();
            tx.put('purchases', purchase);
          }
        }

        if (BeeStore.posting) {
          // v5 §4 row 6: Dr AP / Cr money. Overpayment leaves a debit AP
          // balance (supplier credit) exactly like the document sub-ledger.
          const entry = await BeeStore.posting.supplierPayment(tx, payment);
          if (entry) {
            BeeStore.posting.link(payment, entry);
            tx.put('supplierPayments', payment);
          }
        }

        return payment;
      });
    }
  }

  BeeStore.suppliers = new SuppliersService(null);
  BeeStore.SuppliersService = SuppliersService;
  if (typeof module !== 'undefined') module.exports = SuppliersService;
})(typeof window !== 'undefined' ? window : globalThis);
