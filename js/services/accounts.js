(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /** Payment-method ids that route their clearing money into `accountId`. */
  function methodsForAccount(settings, accountId) {
    if (!accountId) return [];
    return ((settings && settings.paymentMethods) || [])
      .filter(m => m && m.accountId === accountId)
      .map(m => m.id);
  }

  /**
   * Clearing money a payment method holds for this account. Keyed by method id
   * in the summary, so it survives a deleted or re-pointed method.
   */
  function clearingTotal(summary, settings, accountId) {
    let total = 0;
    for (const methodId of methodsForAccount(settings, accountId)) {
      total += BeeStore.summary.methodBalance(summary, methodId);
    }
    return total;
  }

  function methodName(settings, methodId) {
    const found = ((settings && settings.paymentMethods) || [])
      .find(m => m && m.id === methodId);
    return found ? found.name : methodId;
  }


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
        let stored = account;
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          await BeeStore.chart.ensureSeededTx(tx);
          stored = (await tx.get('accounts', account.id)) || account;
        }
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.openingAccount(tx, stored);
          if (entry) {
            BeeStore.posting.link(stored, entry);
            tx.put('accounts', stored);
          }
        }
        return stored;
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
        const openingChanged = patch && patch.openingBalanceMinor !== undefined &&
          BeeStore.money.roundMinor(patch.openingBalanceMinor) !==
            (Number(acc.openingBalanceMinor) || 0);
        const updated = { ...acc, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('accounts', updated);
        if (acc.chartAccountId) {
          const chartAccount = await tx.get('chartOfAccounts', acc.chartAccountId);
          if (chartAccount && !chartAccount.system) {
            if (patch && patch.name !== undefined) chartAccount.nameAr = String(patch.name || '').trim() || acc.name;
            if (patch && patch.active !== undefined) chartAccount.active = patch.active !== false;
            chartAccount.updatedAt = BeeStore.dates.now();
            tx.put('chartOfAccounts', chartAccount);
          }
        }
        if (openingChanged && BeeStore.posting) {
          // Opening balances are posted once per money account; an edit must
          // reverse the old entry and append the corrected one (v5 §3.5).
          const entries = await BeeStore.posting.reverseDocument(tx, 'OPENING',
            'open:account:' + id,
            { description: 'تعديل رصيد افتتاحي — ' + updated.name },
            { allowClosedDay: true });
          if (entries.length > 0) BeeStore.posting.linkAll([updated], entries);
          const entry = await BeeStore.posting.openingAccount(tx, updated);
          if (entry) BeeStore.posting.link(updated, entry);
          tx.put('accounts', updated);
        }
        return updated;
      });
    }

    /** Computes the current balance (opening + all movements).
     * @param {string} accountId account id
     * @returns {Promise<number>} balance in minor units
     */
    async balance(accountId) {
      // L2 §5: the materialized summary already holds all-time account
      // balances, so the accounts page does not rescan the invoice history.
      // Card/wallet receipts sit in a clearing balance keyed by payment method,
      // so add it for the methods that settle into this account.
      const summary = await this.repo.getSummary();
      const settings = (await this.repo.get('meta', 'settings')) || {};
      return BeeStore.summary.balance(summary, accountId) +
        clearingTotal(summary, settings, accountId);
    }

    /**
     * Every account balance in one read, including clearing (card/wallet)
     * money. The dashboard and the accounts page both use this so the totals
     * always add up.
     * @returns {Promise<Object>} accountId → balance in minor units
     */
    async balances() {
      const accounts = await this.repo.list('accounts');
      const summary = await this.repo.getSummary();
      const settings = (await this.repo.get('meta', 'settings')) || {};
      const out = {};
      for (const a of accounts) {
        out[a.id] = BeeStore.summary.balance(summary, a.id) +
          clearingTotal(summary, settings, a.id);
      }
      return out;
    }

    /**
     * Balances for every account as of a date. Month buckets come from the
     * materialized summary; a mid-month date reads only that month's
     * documents. This keeps Month Review and balance snapshots independent of
     * the total invoice history (L2 §5).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<Object>} accountId → balance in minor units
     */
    async balancesAsOf(date) {
      const accounts = await this.repo.list('accounts');
      const summary = await this.repo.getSummary();
      const month = String(date).slice(0, 7);
      const monthEnd = BeeStore.dates.endOfMonth(date) === date;
      const totals = {};
      for (const a of accounts) {
        let balance = Number(a.openingBalanceMinor) || 0;
        for (const key of BeeStore.summary.monthKeys(summary)) {
          if (key >= month) break;
          balance += ((summary.months[key].accounts || {})[a.id]) || 0;
        }
        if (monthEnd) {
          const bucket = summary.months[month];
          balance += (bucket && bucket.accounts[a.id]) || 0;
        }
        totals[a.id] = balance;
      }
      if (!monthEnd) {
        const partial = await this._partialMonthFlows(month, date);
        for (const a of accounts) {
          totals[a.id] += partial.accounts[a.id] || 0;
        }
      }
      return totals;
    }

    /**
     * Card/wallet money still held by the provider for these methods, as of a
     * date. Reported separately from `balancesAsOf` because the balance sheet
     * adds it as a cash-equivalent asset (`assets.clearingOutstanding`), so
     * including it in both places would double-count it.
     * @param {string[]} methodIds payment method ids
     * @param {string} date YYYY-MM-DD
     * @returns {Promise<number>} signed clearing balance in minor units
     */
    async _clearingAsOf(methodIds, date) {
      if (!methodIds.length) return 0;
      const summary = await this.repo.getSummary();
      const month = String(date).slice(0, 7);
      const monthEnd = BeeStore.dates.endOfMonth(date) === date;
      let total = 0;
      for (const key of BeeStore.summary.monthKeys(summary)) {
        if (key >= month) break;
        for (const id of methodIds) {
          total += ((summary.months[key].methods || {})[id]) || 0;
        }
      }
      if (monthEnd) {
        const bucket = summary.months[month];
        for (const id of methodIds) {
          total += (bucket && bucket.methods && bucket.methods[id]) || 0;
        }
      } else {
        const partial = await this._partialMonthFlows(month, date);
        for (const id of methodIds) total += partial.methods[id] || 0;
      }
      return total;
    }

    /** Sums day-level account deltas from documents in the target month. */
    async _partialMonthFlows(month, toDate) {
      const from = month + '-01';
      const names = [
        'sales', 'customerPayments', 'supplierPayments', 'purchases', 'expenses',
        'expensePayments', 'employeeAdvances', 'ownerTransactions', 'transfers', 'salesReturns',
        'purchaseReturns', 'cashAdjustments', 'cardSettlements',
        'payrollLiabilityPayments', 'fixedAssets', 'fixedAssetPayments',
      ];
      const totals = { accounts: {}, methods: {}, customers: {}, suppliers: {}, tax: 0 };
      const add = (target, source) => {
        for (const id of Object.keys(source || {})) {
          target[id] = (target[id] || 0) + source[id];
        }
      };
      for (const name of names) {
        const docs = await this.repo.listRange(name, from, toDate);
        for (const doc of docs) {
          const contrib = BeeStore.summary.contribution(name, doc);
          for (const day of Object.keys(contrib.days)) {
            if (day < from || day > toDate) continue;
            const delta = contrib.days[day];
            add(totals.accounts, delta.accounts);
            add(totals.methods, delta.methods);
            add(totals.customers, delta.customers);
            add(totals.suppliers, delta.suppliers);
            totals.tax += delta.tax || 0;
          }
        }
      }
      return totals;
    }

    /** Balance as of date = opening + movements dated ≤ date (v2 §8).
     * @param {string} accountId account id
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<number>} balance in minor units
     */
    // v2 §8: balance as of a date = opening + all movements dated ≤ date.
    async balanceAsOf(accountId, date) {
      const all = await this.balancesAsOf(date);
      return all[accountId] || 0;
    }

    /** Builds the dated ledger with running balances, optionally ranged.
     * @param {string} accountId account id
     * @param {Object} [range] {from,to} YYYY-MM-DD bounds
     * @returns {Promise<Array>} movements with balanceAfter
     */
    async getLedger(accountId, range) {
      const from = range && range.from;
      const to = range && range.to;
      // L2 §5: a ranged ledger reads only the requested months through the
      // date indexes; the full history is needed only when no range is given.
      const fetch = (collection) => ((from || to)
        ? this.repo.listRange(collection, from, to)
        : this.repo.list(collection));
      const movements = [];
      // Card/wallet receipts never touch `accountId` on the document; they are
      // held in the clearing balance of the payment method that settles here.
      const settings = (await this.repo.get('meta', 'settings')) || {};
      const clearingMethods = methodsForAccount(settings, accountId);
      const isClearingHere = (methodId) => clearingMethods.indexOf(methodId) >= 0;
      const allSales = await fetch('sales');
      for (const s of allSales) {
        if (s.status === 'void') continue;
        for (const p of (s.payments || [])) {
          const clearing = p.methodKind === 'clearing';
          if (clearing ? !isClearingHere(p.method) : p.accountId !== accountId) continue;
          const pDate = p.date || s.date;
          if (range && pDate < range.from) continue;
          if (range && pDate > range.to) continue;
          // v4 R2.2: the account keeps the receipt net of change handed back
          // (the same rule as balances and the daily closing).
          const net = (Number(p.amountMinor) || 0) - (Number(p.changeMinor) || 0);
          if (net === 0) continue;
          movements.push({
            date: pDate,
            amountMinor: net,
            type: 'sale_payment', refId: s.id, refNumber: s.number,
            description: 'تحصيل فاتورة ' + s.number +
              (p.changeMinor ? ' (بعد الباقي)' : '') +
              (clearing ? ' — ' + methodName(settings, p.method) : ''),
          });
        }
      }
      const customerPayments = await fetch('customerPayments');
      for (const p of customerPayments) {
        const clearing = p.methodKind === 'clearing';
        if (clearing ? !isClearingHere(p.method) : p.accountId !== accountId) continue;
        if (range && p.date < range.from) continue;
        if (range && p.date > range.to) continue;
        movements.push({
          date: p.date, amountMinor: p.amountMinor, type: 'customer_payment', refId: p.id,
          description: 'دفعة زبون' + (clearing ? ' — ' + methodName(settings, p.method) : ''),
        });
      }
      const supplierPayments = await fetch('supplierPayments');
      for (const p of supplierPayments) {
        if (p.accountId === accountId) {
          if (range && p.date < range.from) continue;
          if (range && p.date > range.to) continue;
          movements.push({ date: p.date, amountMinor: -p.amountMinor, type: 'supplier_payment', refId: p.id, description: 'دفعة مورد' });
        }
      }
      const purchases = await fetch('purchases');
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
      const expenses = await fetch('expenses');
      for (const e of expenses) {
        if (e.voided) continue;
        const clearing = e.methodKind === 'clearing';
        const method = e.paymentMethod || e.method;
        if (clearing ? !isClearingHere(method) : e.accountId !== accountId) continue;
        if (range && e.date < range.from) continue;
        if (range && e.date > range.to) continue;
        const paid = BeeStore.expenses._initialPaid(e);
        if (paid) {
          movements.push({ date: e.date, amountMinor: -paid, type: 'expense', refId: e.id, description: e.description || 'مصروف' });
        }
      }
      const expensePayments = await fetch('expensePayments');
      for (const p of expensePayments) {
        if (p.voided) continue;
        const clearing = p.methodKind === 'clearing';
        const method = p.paymentMethod || p.method;
        if (clearing ? !isClearingHere(method) : p.accountId !== accountId) continue;
        if (range && p.date < range.from) continue;
        if (range && p.date > range.to) continue;
        movements.push({ date: p.date, amountMinor: -p.amountMinor, type: 'expense_payment', refId: p.id, description: 'سداد مصروف مستحق' });
      }
      const advances = await fetch('employeeAdvances');
      for (const a of advances) {
        if (a.accountId === accountId) {
          if (range && a.date < range.from) continue;
          if (range && a.date > range.to) continue;
          movements.push({ date: a.date, amountMinor: -a.amountMinor, type: 'advance', refId: a.id, description: 'سلفة موظف' });
        }
      }
      const ownerTx = await fetch('ownerTransactions');
      for (const t of ownerTx) {
        if (t.voided) continue;
        if (t.accountId === accountId) {
          if (range && t.date < range.from) continue;
          if (range && t.date > range.to) continue;
          movements.push({ date: t.date, amountMinor: t.type === 'capital_in' ? t.amountMinor : -t.amountMinor, type: 'owner', refId: t.id, description: t.type === 'capital_in' ? 'رأس مال' : 'سحب شخصي' });
        }
      }
      const transfers = await fetch('transfers');
      for (const t of transfers) {
        if (t.voided) continue;
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
      const salesReturns = await fetch('salesReturns');
      for (const r of salesReturns) {
        if (r.refundMode !== 'cash_refund') continue;
        const clearing = r.refundMethodKind === 'clearing';
        const matches = clearing ? isClearingHere(r.refundPaymentMethod) : r.refundMethod === accountId;
        if (!matches) continue;
        if (range && r.date < range.from) continue;
        if (range && r.date > range.to) continue;
        movements.push({ date: r.date, amountMinor: -r.refundMinor, type: 'return_refund', refId: r.id, refNumber: r.number, description: 'مرتجع ' + r.number });
      }
      const purchaseReturns = await fetch('purchaseReturns');
      for (const r of purchaseReturns) {
        if (r.mode === 'cash_refund' && r.accountId === accountId) {
          if (range && r.date < range.from) continue;
          if (range && r.date > range.to) continue;
          movements.push({ date: r.date, amountMinor: r.totalMinor, type: 'purchase_return_refund', refId: r.id, refNumber: r.number, description: 'استرداد مرتجع مشتريات ' + r.number });
        }
      }
      const settlements = await fetch('cardSettlements');
      for (const settlement of settlements) {
        if (settlement.voided) continue;
        if (isClearingHere(settlement.method)) {
          // The provider pays out the gross: the clearing balance drops by the
          // full amount and the fee is the cost of collecting it.
          movements.push({
            date: settlement.date,
            amountMinor: -(Number(settlement.grossMinor) || 0),
            type: 'card_settlement',
            refId: settlement.id,
            refNumber: settlement.number,
            description: 'تسوية ' + (settlement.methodName || settlement.method) +
              ' — مُحوَّل للبنك',
          });
          continue;
        }
        if (settlement.bankAccountId !== accountId) continue;
        movements.push({
          date: settlement.date,
          amountMinor: settlement.netReceivedMinor,
          type: 'card_settlement',
          refId: settlement.id,
          refNumber: settlement.number,
          description: 'تسوية ' + (settlement.methodName || settlement.method) +
            ' — صافي بعد العمولة',
        });
      }
      const adjustments = await fetch('cashAdjustments');
      for (const a of adjustments) {
        if (a.voided) continue;
        if (a.accountId !== accountId) continue;
        if (range && a.date < range.from) continue;
        if (range && a.date > range.to) continue;
        movements.push({
          date: a.date,
          amountMinor: a.amountMinor,
          type: 'cash_difference',
          refId: a.id,
          description: a.amountMinor < 0 ? 'نقص في الصندوق' : 'زيادة في الصندوق',
        });
      }
      movements.sort((a, b) => a.date.localeCompare(b.date));
      let running = 0;
      const acc = await this.repo.get('accounts', accountId);
      if (acc) running = acc.openingBalanceMinor || 0;
      // A ranged ledger must start from the balance before the range, not from
      // the account opening, otherwise every running balance is wrong.
      if (from && from > '0000-01-01') {
        running = await this.balanceAsOf(accountId, BeeStore.dates.addDays(from, -1));
        // A wallet's ledger also carries the provider's clearing balance, so
        // the opening must include what was already held before the range.
        if (clearingMethods.length) {
          running += await this._clearingAsOf(clearingMethods,
            BeeStore.dates.addDays(from, -1));
        }
      }
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
