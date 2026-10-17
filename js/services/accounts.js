(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class AccountsService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Fetches one account by id.
     * @param {string} id account id
     * @returns {Promise<Object|null>} account or null
     */
    async get(id) {
      return this.repo.get('accounts', id);
    }

    /** Lists all accounts.
     * @returns {Promise<Array>} all accounts
     */
    async list() {
      return this.repo.list('accounts');
    }

    /** Creates an account with an opening balance.
     * @param {Object} data {name,type,openingBalanceMinor,active}
     * @returns {Promise<Object>} created account
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const account = {
          id: BeeStore.ids.randomId('acc'),
          name: data.name,
          type: data.type || 'cash',
          openingBalanceMinor: BeeStore.money.roundMinor(data.openingBalanceMinor || 0),
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('accounts', account);
        return account;
      });
    }

    /** Updates an account.
     * @param {string} id account id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated account
     * @throws {BeeError} NOT_FOUND if missing
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const acc = await tx.get('accounts', id);
        if (!acc) throw BeeStore.errors.err('NOT_FOUND', 'الحساب غير موجود');
        const updated = { ...acc, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('accounts', updated);
        return updated;
      });
    }

    /** Computes the current balance (opening + all movements).
     * @param {string} accountId account id
     * @returns {Promise<number>} balance in minor units
     */
    async balance(accountId) {
      const acc = await this.repo.get('accounts', accountId);
      if (!acc) return 0;
      let balance = acc.openingBalanceMinor || 0;
      const sales = await this.repo.list('sales');
      for (const s of sales) {
        if (s.status === 'void') continue;
        for (const p of (s.payments || [])) {
          if (p.accountId === accountId) balance += p.amountMinor;
        }
      }
      const customerPayments = await this.repo.list('customerPayments');
      for (const p of customerPayments) {
        if (p.accountId === accountId) balance += p.amountMinor;
      }
      const supplierPayments = await this.repo.list('supplierPayments');
      for (const p of supplierPayments) {
        if (p.accountId === accountId) balance -= p.amountMinor;
      }
      const purchases = await this.repo.list('purchases');
      for (const p of purchases) {
        if (p.status === 'void') continue;
        for (const pay of (p.payments || [])) {
          if (pay.accountId === accountId) balance -= pay.amountMinor;
        }
      }
      const expenses = await this.repo.list('expenses');
      for (const e of expenses) {
        if (e.voided) continue;
        if (e.accountId === accountId) balance -= e.amountMinor;
      }
      const advances = await this.repo.list('employeeAdvances');
      for (const a of advances) {
        if (a.accountId === accountId) balance -= a.amountMinor;
      }
      const ownerTx = await this.repo.list('ownerTransactions');
      for (const t of ownerTx) {
        if (t.accountId === accountId) {
          if (t.type === 'capital_in') balance += t.amountMinor;
          else balance -= t.amountMinor;
        }
      }
      const transfers = await this.repo.list('transfers');
      for (const t of transfers) {
        if (t.fromAccountId === accountId) balance -= t.amountMinor;
        if (t.toAccountId === accountId) balance += t.amountMinor;
      }
      const salesReturns = await this.repo.list('salesReturns');
      for (const r of salesReturns) {
        if (r.refundMode === 'cash_refund' && r.refundMethod === accountId) {
          balance -= r.refundMinor;
        }
      }
      const purchaseReturns = await this.repo.list('purchaseReturns');
      for (const r of purchaseReturns) {
        if (r.mode === 'cash_refund' && r.accountId === accountId) {
          balance += r.totalMinor;
        }
      }
      return balance;
    }

    /** Balance as of date = opening + movements dated ≤ date (v2 §8).
     * @param {string} accountId account id
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<number>} balance in minor units
     */
    // v2 §8: balance as of a date = opening + all movements dated ≤ date.
    async balanceAsOf(accountId, date) {
      const acc = await this.repo.get('accounts', accountId);
      if (!acc) return 0;
      const movements = await this.getLedger(accountId, { from: '0000-01-01', to: date });
      if (movements.length === 0) return acc.openingBalanceMinor || 0;
      return movements[movements.length - 1].balanceAfter;
    }

    /** Builds the dated ledger with running balances, optionally ranged.
     * @param {string} accountId account id
     * @param {Object} [range] {from,to} YYYY-MM-DD bounds
     * @returns {Promise<Array>} movements with balanceAfter
     */
    async getLedger(accountId, range) {
      const movements = [];
      const allSales = await this.repo.list('sales');
      for (const s of allSales) {
        if (s.status === 'void') continue;
        for (const p of (s.payments || [])) {
          if (p.accountId === accountId) {
            if (range && p.date < range.from) continue;
            if (range && p.date > range.to) continue;
            movements.push({ date: p.date, amountMinor: p.amountMinor, type: 'sale_payment', refId: s.id, refNumber: s.number, description: 'تحصيل فاتورة ' + s.number });
          }
        }
      }
      const customerPayments = await this.repo.list('customerPayments');
      for (const p of customerPayments) {
        if (p.accountId === accountId) {
          if (range && p.date < range.from) continue;
          if (range && p.date > range.to) continue;
          movements.push({ date: p.date, amountMinor: p.amountMinor, type: 'customer_payment', refId: p.id, description: 'دفعة زبون' });
        }
      }
      const supplierPayments = await this.repo.list('supplierPayments');
      for (const p of supplierPayments) {
        if (p.accountId === accountId) {
          if (range && p.date < range.from) continue;
          if (range && p.date > range.to) continue;
          movements.push({ date: p.date, amountMinor: -p.amountMinor, type: 'supplier_payment', refId: p.id, description: 'دفعة مورد' });
        }
      }
      const purchases = await this.repo.list('purchases');
      for (const p of purchases) {
        if (p.status === 'void') continue;
        for (const pay of (p.payments || [])) {
          if (pay.accountId === accountId) {
            if (range && pay.date < range.from) continue;
            if (range && pay.date > range.to) continue;
            movements.push({ date: pay.date, amountMinor: -pay.amountMinor, type: 'purchase_payment', refId: p.id, refNumber: p.number, description: 'دفع مشتريات ' + p.number });
          }
        }
      }
      const expenses = await this.repo.list('expenses');
      for (const e of expenses) {
        if (e.voided) continue;
        if (e.accountId === accountId) {
          if (range && e.date < range.from) continue;
          if (range && e.date > range.to) continue;
          movements.push({ date: e.date, amountMinor: -e.amountMinor, type: 'expense', refId: e.id, description: e.description || 'مصروف' });
        }
      }
      const advances = await this.repo.list('employeeAdvances');
      for (const a of advances) {
        if (a.accountId === accountId) {
          if (range && a.date < range.from) continue;
          if (range && a.date > range.to) continue;
          movements.push({ date: a.date, amountMinor: -a.amountMinor, type: 'advance', refId: a.id, description: 'سلفة موظف' });
        }
      }
      const ownerTx = await this.repo.list('ownerTransactions');
      for (const t of ownerTx) {
        if (t.accountId === accountId) {
          if (range && t.date < range.from) continue;
          if (range && t.date > range.to) continue;
          movements.push({ date: t.date, amountMinor: t.type === 'capital_in' ? t.amountMinor : -t.amountMinor, type: 'owner', refId: t.id, description: t.type === 'capital_in' ? 'رأس مال' : 'سحب شخصي' });
        }
      }
      const transfers = await this.repo.list('transfers');
      for (const t of transfers) {
        if (t.fromAccountId === accountId) {
          if (range && t.date < range.from) continue;
          if (range && t.date > range.to) continue;
          movements.push({ date: t.date, amountMinor: -t.amountMinor, type: 'transfer_out', refId: t.id, description: 'تحويل خارج' });
        }
        if (t.toAccountId === accountId) {
          if (range && t.date < range.from) continue;
          if (range && t.date > range.to) continue;
          movements.push({ date: t.date, amountMinor: t.amountMinor, type: 'transfer_in', refId: t.id, description: 'تحويل داخل' });
        }
      }
      const salesReturns = await this.repo.list('salesReturns');
      for (const r of salesReturns) {
        if (r.refundMode === 'cash_refund' && r.refundMethod === accountId) {
          if (range && r.date < range.from) continue;
          if (range && r.date > range.to) continue;
          movements.push({ date: r.date, amountMinor: -r.refundMinor, type: 'return_refund', refId: r.id, refNumber: r.number, description: 'مرتجع ' + r.number });
        }
      }
      const purchaseReturns = await this.repo.list('purchaseReturns');
      for (const r of purchaseReturns) {
        if (r.mode === 'cash_refund' && r.accountId === accountId) {
          if (range && r.date < range.from) continue;
          if (range && r.date > range.to) continue;
          movements.push({ date: r.date, amountMinor: r.totalMinor, type: 'purchase_return_refund', refId: r.id, refNumber: r.number, description: 'استرداد مرتجع مشتريات ' + r.number });
        }
      }
      movements.sort((a, b) => a.date.localeCompare(b.date));
      let running = 0;
      const acc = await this.repo.get('accounts', accountId);
      if (acc) running = acc.openingBalanceMinor || 0;
      for (const m of movements) {
        running += m.amountMinor;
        m.balanceAfter = running;
      }
      return movements;
    }
  }

  BeeStore.accounts = new AccountsService(null);
  BeeStore.AccountsService = AccountsService;
  if (typeof module !== 'undefined') module.exports = AccountsService;
})(typeof window !== 'undefined' ? window : globalThis);
