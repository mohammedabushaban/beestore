(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class TransactionsService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Records an owner capital-in/draw movement.
     * @param {Object} data {date,type,amountMinor,accountId,note}
     * @returns {Promise<Object>} created record
     * @throws {BeeError} PERIOD_CLOSED if date closed
     */
    async ownerTransaction(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const txRecord = {
          id: BeeStore.ids.randomId('own'),
          date: data.date || BeeStore.dates.today(),
          type: data.type,
          amountMinor: BeeStore.money.roundMinor(data.amountMinor),
          accountId: data.accountId,
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('ownerTransactions', txRecord);
        return txRecord;
      });
    }

    /** Records a transfer between two accounts.
     * @param {Object} data {date,fromAccountId,toAccountId,amountMinor,note}
     * @returns {Promise<Object>} created transfer
     * @throws {BeeError} PERIOD_CLOSED if date closed
     */
    async transfer(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const transfer = {
          id: BeeStore.ids.randomId('trf'),
          date: data.date || BeeStore.dates.today(),
          fromAccountId: data.fromAccountId,
          toAccountId: data.toAccountId,
          amountMinor: BeeStore.money.roundMinor(data.amountMinor),
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('transfers', transfer);
        return transfer;
      });
    }

    /** Creates or updates the daily cash closing for a date.
     * @param {Object} data {date,salesByMethod,expensesMinor,expectedCashMinor,countedCashMinor,differenceMinor,note}
     * @returns {Promise<Object>} created/updated closing
     * @throws {BeeError} PERIOD_CLOSED if date closed
     */
    async dailyClosing(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date);
        const existing = await tx.list('dailyClosings', d => d.date === data.date);
        if (existing.length > 0) {
          const dc = existing[0];
          const updated = { ...dc, ...data, id: dc.id, updatedAt: BeeStore.dates.now() };
          tx.put('dailyClosings', updated);
          return updated;
        }
        const dc = {
          id: BeeStore.ids.randomId('clo'),
          date: data.date,
          salesByMethod: data.salesByMethod || {},
          expensesMinor: BeeStore.money.roundMinor(data.expensesMinor || 0),
          expectedCashMinor: BeeStore.money.roundMinor(data.expectedCashMinor || 0),
          countedCashMinor: BeeStore.money.roundMinor(data.countedCashMinor || 0),
          differenceMinor: BeeStore.money.roundMinor(data.differenceMinor || 0),
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('dailyClosings', dc);
        return dc;
      });
    }
  }

  BeeStore.transactions = new TransactionsService(null);
  BeeStore.TransactionsService = TransactionsService;
  if (typeof module !== 'undefined') module.exports = TransactionsService;
})(typeof window !== 'undefined' ? window : globalThis);
