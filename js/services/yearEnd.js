(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const YEAR_RE = /^\d{4}$/;
  const SOURCE_TYPE = 'YEAR_CLOSE';
  const RETAINED = {
    code: '3040', nameAr: 'الأرباح المبقاة', type: 'equity',
    normalSide: 'credit', systemKey: 'retained_earnings',
  };

  function sourceId(year) { return 'year:' + year; }

  /**
   * Fiscal year-end closing (IAS 1 / GAAP closing entries).
   *
   * Closing a calendar year posts one entry dated 31 December that brings
   * every revenue and expense account to zero and moves the year's net
   * result to 3040 retained earnings. The journal stays append-only:
   * reopening a year appends the exact reversal of that entry.
   *
   * Rules: the year must be over, every month of it that has data must be
   * locked, earlier years are closed first and reopened last. While a year is
   * closed none of its months can be reopened.
   */
  class YearEndService {
    constructor(repo) {
      this.repo = repo;
    }

    async _liveClosings(reader) {
      const entries = (await reader.list('journalEntries'))
        .filter(e => e.sourceType === SOURCE_TYPE);
      const reversed = new Set(entries.filter(e => e.reversalOf).map(e => e.reversalOf));
      return entries.filter(e => !e.reversalOf && !reversed.has(e.id));
    }

    /**
     * @param {object} [reader] repo or transaction
     * @returns {Promise<string[]>} closed years, ascending
     */
    async closedYears(reader) {
      return (await this._liveClosings(reader || this.repo))
        .map(e => String(e.date).slice(0, 4)).sort();
    }

    /**
     * @param {object} reader repo or transaction
     * @param {string} year YYYY
     * @returns {Promise<boolean>}
     */
    async isYearClosed(reader, year) {
      return (await this.closedYears(reader)).indexOf(String(year)) >= 0;
    }

    async _yearsWithData(reader) {
      const months = BeeStore.periods && BeeStore.periods._monthsWithData
        ? await BeeStore.periods._monthsWithData(reader)
        : [];
      const years = new Set(months.map(m => String(m).slice(0, 4)));
      for (const e of await reader.list('journalEntries')) {
        if (e.sourceType !== SOURCE_TYPE) years.add(String(e.date).slice(0, 4));
      }
      return Array.from(years).filter(y => YEAR_RE.test(y)).sort();
    }

    /**
     * Closing lines for a year: every P&L account balance through 31 Dec
     * (earlier closings already zeroed prior years) mirrored, plus the net to
     * 3040. Pure computation; nothing is written.
     * @param {object} reader repo or transaction
     * @param {string} year YYYY
     * @returns {Promise<object>} {year, date, lines, netProfitMinor, revenueMinor, expenseMinor}
     */
    async _plan(reader, year) {
      const end = year + '-12-31';
      const [entries, chart] = await Promise.all([
        reader.list('journalEntries'),
        reader.list('chartOfAccounts'),
      ]);
      const byId = new Map(chart.map(a => [a.id, a]));
      const balances = new Map();
      for (const entry of entries) {
        if (String(entry.date) > end) continue;
        for (const line of (entry.lines || [])) {
          const account = byId.get(line.accountId);
          if (!account || (account.type !== 'revenue' && account.type !== 'expense')) continue;
          balances.set(account.id, (balances.get(account.id) || 0) +
            (Number(line.debitMinor) || 0) - (Number(line.creditMinor) || 0));
        }
      }
      const lines = [];
      let revenue = 0;
      let expense = 0;
      let net = 0; // debit-positive: < 0 is a profit
      const ids = Array.from(balances.keys()).sort((a, b) =>
        String(byId.get(a).code).localeCompare(String(byId.get(b).code), undefined, { numeric: true }));
      for (const id of ids) {
        const balance = balances.get(id);
        if (!balance) continue;
        const account = byId.get(id);
        if (account.type === 'revenue') revenue += -balance;
        else expense += balance;
        net += balance;
        lines.push({
          accountId: id, code: account.code, nameAr: account.nameAr,
          debitMinor: balance < 0 ? -balance : 0,
          creditMinor: balance > 0 ? balance : 0,
          memo: 'إقفال ' + year,
        });
      }
      return {
        year, date: end, lines,
        revenueMinor: revenue, expenseMinor: expense, netProfitMinor: -net,
      };
    }

    async _blockers(reader, year) {
      const blockers = [];
      if (!YEAR_RE.test(String(year))) {
        blockers.push('سنة غير صالحة');
        return blockers;
      }
      if (BeeStore.dates.today() <= year + '-12-31') {
        blockers.push('السنة ' + year + ' لم تنتهِ بعد');
      }
      const closed = await this.closedYears(reader);
      if (closed.indexOf(year) >= 0) blockers.push('السنة ' + year + ' مقفلة مسبقاً');
      const years = await this._yearsWithData(reader);
      const earlierOpen = years.filter(y => y < year && closed.indexOf(y) < 0);
      if (earlierOpen.length) blockers.push('أقفل السنوات السابقة أولاً: ' + earlierOpen.join('، '));
      const months = BeeStore.periods && BeeStore.periods._monthsWithData
        ? (await BeeStore.periods._monthsWithData(reader)).filter(m => String(m).slice(0, 4) === year)
        : [];
      const openMonths = [];
      for (const m of months) {
        const rows = await reader.list('periodClosings', c => c.month === m && c.status === 'closed');
        if (rows.length === 0) openMonths.push(m);
      }
      if (openMonths.length) blockers.push('أقفل كل شهور السنة أولاً: ' + openMonths.join('، '));
      return blockers;
    }

    /**
     * Read-only preview of a year-end close.
     * @param {string} year YYYY
     * @returns {Promise<object>} plan + {blockers, canClose}
     */
    async preview(year) {
      year = String(year);
      const plan = await this._plan(this.repo, year);
      const blockers = await this._blockers(this.repo, year);
      return { ...plan, blockers, canClose: blockers.length === 0 };
    }

    /**
     * Fiscal-year status for the UI: every year with data, closed or not.
     * @returns {Promise<object[]>} [{year, closed, entryNumber}]
     */
    async status() {
      const live = await this._liveClosings(this.repo);
      const years = new Set(await this._yearsWithData(this.repo));
      for (const e of live) years.add(String(e.date).slice(0, 4));
      return Array.from(years).sort().map((year) => {
        const entry = live.find(e => String(e.date).slice(0, 4) === year);
        return { year, closed: !!entry, entryNumber: entry ? entry.number : null };
      });
    }

    /**
     * Posts the year-end closing entry.
     * @param {string} year YYYY
     * @param {string} [note] reason / reference
     * @returns {Promise<object>} the closing entry
     */
    async close(year, note) {
      year = String(year);
      return this.repo.transaction(async (tx) => {
        const blockers = await this._blockers(tx, year);
        if (blockers.length) {
          throw BeeStore.errors.err('CONFLICT', 'لا يمكن إقفال السنة: ' + blockers.join('؛ '));
        }
        let retained = (await tx.list('chartOfAccounts'))
          .find(a => a.systemKey === RETAINED.systemKey);
        if (!retained) {
          const now = BeeStore.dates.now();
          const taken = (await tx.list('chartOfAccounts')).some(a => String(a.code) === RETAINED.code);
          retained = {
            id: taken ? 'coa_retained_earnings' : 'coa_' + RETAINED.code,
            code: taken ? '3049' : RETAINED.code,
            nameAr: RETAINED.nameAr, type: RETAINED.type, normalSide: RETAINED.normalSide,
            system: true, active: true, parentCode: null, contra: false,
            systemKey: RETAINED.systemKey, createdAt: now, updatedAt: now,
          };
          tx.put('chartOfAccounts', retained);
        }
        const plan = await this._plan(tx, year);
        const lines = plan.lines.map(l => ({
          accountId: l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, memo: l.memo,
        }));
        const net = plan.netProfitMinor;
        if (net > 0) lines.push({ accountId: retained.id, creditMinor: net, memo: 'صافي ربح ' + year });
        else if (net < 0) lines.push({ accountId: retained.id, debitMinor: -net, memo: 'صافي خسارة ' + year });
        if (lines.length < 2) {
          throw BeeStore.errors.err('VALIDATION', 'لا توجد إيرادات أو مصروفات لإقفالها في ' + year);
        }
        // Every month of the year is locked by design; the closing entry is
        // the one posting allowed into them (an audited, reversible step).
        const entry = await BeeStore.journal.post(tx, {
          date: plan.date,
          time: '23:59:59',
          sourceType: SOURCE_TYPE,
          sourceId: sourceId(year),
          event: 'YEAR_CLOSE',
          description: 'إقفال السنة المالية ' + year + ' — ترحيل صافي النتيجة إلى الأرباح المبقاة' +
            (note ? ' — ' + note : ''),
          lines,
        }, { allowInactive: true, allowClosedDay: true, replay: true });
        if (BeeStore.audit && BeeStore.audit.build) {
          tx.put('auditLog', BeeStore.audit.build('year_close', 'period', year,
            'إقفال السنة ' + year + ' — صافي النتيجة ' + net + (note ? ' - ' + note : '')));
        }
        return entry;
      });
    }

    /**
     * Reopens the latest closed year by appending the reversal of its
     * closing entry.
     * @param {string} year YYYY
     * @param {string} [note] reason
     * @returns {Promise<object[]>} reversal entries
     */
    async reopen(year, note) {
      year = String(year);
      return this.repo.transaction(async (tx) => {
        const closed = await this.closedYears(tx);
        if (closed.length === 0) throw BeeStore.errors.err('CONFLICT', 'لا توجد سنة مقفلة');
        const latest = closed[closed.length - 1];
        if (year !== latest) {
          throw BeeStore.errors.err('CONFLICT',
            'يمكن إعادة فتح آخر سنة مقفلة فقط (' + latest + ')');
        }
        const reversals = await BeeStore.journal.reverseActiveSourceTx(tx, SOURCE_TYPE, sourceId(year), {
          description: 'إعادة فتح السنة المالية ' + year + (note ? ' — ' + note : ''),
        }, { allowClosedDay: true, replay: true });
        if (BeeStore.audit && BeeStore.audit.build) {
          tx.put('auditLog', BeeStore.audit.build('year_reopen', 'period', year,
            'إعادة فتح السنة ' + year + (note ? ' - ' + note : '')));
        }
        return reversals;
      });
    }
  }

  YearEndService.SOURCE_TYPE = SOURCE_TYPE;
  YearEndService.RETAINED = RETAINED;
  BeeStore.yearEnd = new YearEndService(null);
  BeeStore.YearEndService = YearEndService;
  if (typeof module !== 'undefined') module.exports = YearEndService;
})(typeof window !== 'undefined' ? window : globalThis);
