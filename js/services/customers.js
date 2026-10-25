(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class CustomersService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all customers.
     * @returns {Promise<Array>} All customer records. */
    async list() {
      return this.repo.list('customers');
    }

    /** Fetches a single customer by id.
     * @param {string} id Customer id.
     * @returns {Promise<Object|undefined>} Customer record or undefined. */
    async get(id) {
      return this.repo.get('customers', id);
    }

    /** Creates a customer with defaults and opening balance.
     * @param {Object} data Customer fields (name, phone, openingBalanceMinor).
     * @returns {Promise<Object>} Created customer record. */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const customer = {
          id: BeeStore.ids.randomId('cus'),
          name: data.name,
          phone: data.phone || '',
          address: data.address || '',
          notes: data.notes || '',
          openingBalanceMinor: BeeStore.money.roundMinor(data.openingBalanceMinor || 0),
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('customers', customer);
        return customer;
      });
    }

    /** Updates a customer by merging the patch.
     * @param {string} id Customer id. @param {Object} patch Fields to update.
     * @returns {Promise<Object>} Updated record. @throws {BeeError} NOT_FOUND if missing. */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const c = await tx.get('customers', id);
        if (!c) throw BeeStore.errors.err('NOT_FOUND', 'الزبون غير موجود');
        const updated = { ...c, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('customers', updated);
        return updated;
      });
    }

    // Balance now, or as of a date (v2 §8): opening + invoiced − collected
    // − return credits. FIFO affects WHICH invoice is settled, never the total.
    /** Computes customer balance now or as of a date (opening + invoiced − collected).
     * @param {string} customerId Customer id. @param {string} [asOf] YYYY-MM-DD cutoff.
     * @returns {Promise<number>} Balance in minor units (0 if customer missing). */
    async balance(customerId, asOf) {
      const customer = await this.repo.get('customers', customerId);
      if (!customer) return 0;
      if (!asOf) {
        let balance = customer.openingBalanceMinor || 0;
        // Indexed by customerId, so old invoices do not require a full scan.
        const sales = (await this.repo.query('sales', 'customerId', customerId))
          .filter(s => s.status !== 'void');
        for (const s of sales) {
          balance += s.dueMinor;
        }
        const returns = await this.repo.query('salesReturns', 'customerId', customerId);
        for (const r of returns) {
          if (r.refundMode === 'customer_credit') balance -= r.refundMinor;
        }
        return balance;
      }
      let balance = customer.openingBalanceMinor || 0;
      const sales = (await this.repo.query('sales', 'customerId', customerId))
        .filter(s => s.status !== 'void' && s.date <= asOf);
      for (const s of sales) {
        balance += s.totalMinor;
        for (const p of (s.payments || [])) {
          if ((p.date || s.date) <= asOf) balance -= p.amountMinor;
        }
      }
      const payments = (await this.repo.query('customerPayments', 'customerId', customerId))
        .filter(p => p.date <= asOf);
      for (const p of payments) balance -= p.amountMinor;
      const returns = (await this.repo.query('salesReturns', 'customerId', customerId))
        .filter(r => r.date <= asOf);
      for (const r of returns) {
        if (r.refundMode === 'customer_credit') balance -= r.refundMinor;
      }
      return balance;
    }

    /** Builds customer statement with sales, payments, returns and balance.
     * @param {string} customerId Customer id.
     * @returns {Promise<Object|null>} Statement bundle or null if missing. */
    async statement(customerId) {
      const customer = await this.repo.get('customers', customerId);
      if (!customer) return null;
      const sales = (await this.repo.query('sales', 'customerId', customerId))
        .filter(s => s.status !== 'void');
      const payments = await this.repo.query('customerPayments', 'customerId', customerId);
      const returns = await this.repo.query('salesReturns', 'customerId', customerId);
      sales.sort((a, b) => a.date.localeCompare(b.date));
      payments.sort((a, b) => a.date.localeCompare(b.date));
      return { customer, sales, payments, returns, balance: await this.balance(customerId) };
    }

    async receivePayment(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const customer = await tx.get('customers', data.customerId);
        if (!customer) throw BeeStore.errors.err('NOT_FOUND', 'الزبون غير موجود');
        const settings = await tx.get('meta', 'settings') || {};

        const payment = {
          id: BeeStore.ids.randomId('cpay'),
          customerId: data.customerId,
          saleId: data.saleId || null,
          date: data.date || BeeStore.dates.today(),
          amountMinor: BeeStore.money.roundMinor(data.amountMinor),
          method: data.method,
          accountId: data.accountId || BeeStore.settings.resolvePaymentAccount(settings, data.method),
          payerName: (data.payerName || '').trim(),
          payerPhone: (data.payerPhone || '').trim(),
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
        };
        tx.put('customerPayments', payment);

        if (!data.saleId) {
          // Indexed by customerId: allocating a payment must not scan old
          // invoices that live outside the memory window.
          const sales = (await tx.query('sales', 'customerId', data.customerId))
            .filter(s => s.status !== 'void' && s.dueMinor > 0);
          sales.sort((a, b) => a.date.localeCompare(b.date));
          let remaining = payment.amountMinor;
          for (const s of sales) {
            if (remaining <= 0) break;
            const apply = Math.min(remaining, s.dueMinor);
            s.dueMinor -= apply;
            s.paidMinor += apply;
            this._applyInstallmentPayment(s, apply);
            if (s.dueMinor <= 0) s.status = 'paid';
            else if (s.paidMinor > 0) s.status = 'partial';
            s.updatedAt = BeeStore.dates.now();
            tx.put('sales', s);
            remaining -= apply;
          }
        } else {
          const sale = await tx.get('sales', data.saleId);
          if (sale && sale.customerId === data.customerId) {
            const apply = Math.min(payment.amountMinor, sale.dueMinor);
            sale.dueMinor -= apply;
            sale.paidMinor += apply;
            this._applyInstallmentPayment(sale, apply);
            if (sale.dueMinor <= 0) sale.status = 'paid';
            else if (sale.paidMinor > 0) sale.status = 'partial';
            sale.updatedAt = BeeStore.dates.now();
            tx.put('sales', sale);
          }
        }

        return payment;
      });
    }

    _applyInstallmentPayment(sale, amount) {
      if (!sale.installmentPlan || !Array.isArray(sale.installmentPlan.schedule)) return;
      let remaining = amount;
      for (const inst of sale.installmentPlan.schedule) {
        if (remaining <= 0) break;
        if (inst.status === 'paid') continue;
        const dueNow = inst.amountMinor - (inst.paidMinor || 0);
        if (dueNow <= 0) { inst.status = 'paid'; continue; }
        const applied = Math.min(remaining, dueNow);
        inst.paidMinor = (inst.paidMinor || 0) + applied;
        remaining -= applied;
        if (inst.paidMinor >= inst.amountMinor) inst.status = 'paid';
      }
    }

    /** Collects overdue installment entries with customer contact info.
     * @returns {Promise<Array>} Overdue installment rows. */
    async getOverdueInstallments() {
      const today = BeeStore.dates.today();
      // The repository summary keeps only unpaid installments, so this no
      // longer scans 50k invoices on the dashboard / Month Review path.
      const summary = await this.repo.getSummary();
      const rows = BeeStore.summary.overdue(summary, today);
      const customers = {};
      const overdue = [];
      for (const inst of rows) {
        if (!inst.customerId) continue;
        if (!Object.prototype.hasOwnProperty.call(customers, inst.customerId)) {
          customers[inst.customerId] = await this.repo.get('customers', inst.customerId);
        }
        const customer = customers[inst.customerId];
        overdue.push({
          saleId: inst.saleId,
          saleNumber: inst.saleNumber,
          customerId: inst.customerId,
          customerName: customer ? customer.name : '',
          customerPhone: customer ? customer.phone : '',
          dueDate: inst.dueDate,
          amountMinor: inst.amountMinor,
          paidMinor: inst.paidMinor,
          remainingMinor: inst.amountMinor - inst.paidMinor,
        });
      }
      return overdue;
    }
  }

  BeeStore.customers = new CustomersService(null);
  BeeStore.CustomersService = CustomersService;
  if (typeof module !== 'undefined') module.exports = CustomersService;
})(typeof window !== 'undefined' ? window : globalThis);
