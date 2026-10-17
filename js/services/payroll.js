(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class PayrollService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Creates draft payroll records for active employees for a month.
     * @param {string} month YYYY-MM payroll month
     * @returns {Promise<Array>} newly created draft records
     * @throws {BeeError} PERIOD_CLOSED if month closed
     */
    async prepare(month) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, month + '-01');
        const employees = await tx.list('employees', e => e.active !== false);
        const created = [];
        for (const emp of employees) {
          const existing = await tx.list('payroll', p => p.employeeId === emp.id && p.month === month);
          if (existing.length > 0) continue;
          const record = {
            id: BeeStore.ids.randomId('pay'),
            employeeId: emp.id,
            employeeName: emp.name,
            month,
            baseMinor: emp.baseSalaryMinor || 0,
            bonusMinor: 0,
            overtimeMinor: 0,
            deductionsMinor: 0,
            advanceRepaymentMinor: 0,
            netMinor: emp.baseSalaryMinor || 0,
            status: 'draft',
            paidDate: null,
            method: null,
            accountId: null,
            note: '',
            createdAt: BeeStore.dates.now(),
            updatedAt: BeeStore.dates.now(),
          };
          tx.put('payroll', record);
          created.push(record);
        }
        return created;
      });
    }

    /** Lists payroll records newest-first.
     * @param {Object} [filters] {month,employeeId,status}
     * @returns {Promise<Array>} matching payroll records
     */
    async list(filters) {
      let payroll = await this.repo.list('payroll');
      if (filters) {
        if (filters.month) payroll = payroll.filter(p => p.month === filters.month);
        if (filters.employeeId) payroll = payroll.filter(p => p.employeeId === filters.employeeId);
        if (filters.status) payroll = payroll.filter(p => p.status === filters.status);
      }
      payroll.sort((a, b) => (b.month + b.employeeId).localeCompare(a.month + a.employeeId));
      return payroll;
    }

    /** Updates a payroll record and recomputes net.
     * @param {string} id payroll id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated record
     * @throws {BeeError} NOT_FOUND if missing
     */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const p = await tx.get('payroll', id);
        if (!p) throw BeeStore.errors.err('NOT_FOUND', 'سجل الراتب غير موجود');
        const updated = { ...p, ...patch, id, updatedAt: BeeStore.dates.now() };
        updated.netMinor = updated.baseMinor + updated.bonusMinor + updated.overtimeMinor -
          updated.deductionsMinor - updated.advanceRepaymentMinor;
        tx.put('payroll', updated);
        return updated;
      });
    }

    /** Pays payroll: books salary expense, applies capped advance repayment (accrual month v2 §4).
     * @param {string} id payroll id
     * @param {string} method payment method
     * @param {string} accountId target account
     * @param {string} note optional note
     * @param {number} advanceRepaymentMinor requested advance deduction
     * @param {string} [paidDate] cash date, defaults to today
     * @returns {Promise<Object>} paid payroll record
     * @throws {BeeError} NOT_FOUND|ALREADY_PAID|INVALID|PERIOD_CLOSED
     */
    async pay(id, method, accountId, note, advanceRepaymentMinor, paidDate) {
      const p = await this.repo.transaction(async (tx) => {
        const p = await tx.get('payroll', id);
        if (!p) throw BeeStore.errors.err('NOT_FOUND', 'سجل الراتب غير موجود');
        if (p.status === 'paid') throw BeeStore.errors.err('ALREADY_PAID', 'الراتب مدفوع مسبقاً');
        // The payment event is always allowed to be "today" (v2 §7.4); only
        // the cash date must be in an open month. Amounts of a closed payroll
        // month never change (salary expense excludes advance repayments).
        const payDate = paidDate || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, payDate);
        const settings = await tx.get('meta', 'settings') || {};
        const resolvedAccountId = accountId || BeeStore.settings.resolvePaymentAccount(settings, method || 'cash');

        const salaryExpense = p.baseMinor + p.bonusMinor + p.overtimeMinor - p.deductionsMinor;
        const requested = BeeStore.money.roundMinor(advanceRepaymentMinor || 0);
        if (requested < 0) throw BeeStore.errors.err('INVALID', 'مبلغ سداد السلف لا يمكن أن يكون سالباً');

        // Repayment is capped at the outstanding balance (spec §5.18: "up to the
        // remaining balance"). Only the actually-applied amount reduces the net.
        let remaining = requested;
        let appliedTotal = 0;
        if (remaining > 0) {
          const outstanding = (await tx.list('employeeAdvances',
            a => a.employeeId === p.employeeId && (a.amountMinor - (a.repaidMinor || 0)) > 0))
            .sort((a, b) => a.date.localeCompare(b.date));
          for (const a of outstanding) {
            if (remaining <= 0) break;
            const owed = a.amountMinor - (a.repaidMinor || 0);
            const pay = Math.min(owed, remaining);
            a.repaidMinor = (a.repaidMinor || 0) + pay;
            a.updatedAt = BeeStore.dates.now();
            tx.put('employeeAdvances', a);
            appliedTotal += pay;
            remaining -= pay;
          }
        }

        const net = salaryExpense - appliedTotal;
        if (net < 0) throw BeeStore.errors.err('INVALID', 'صافي الراتب لا يمكن أن يكون سالباً بعد الخصومات');

        const expense = {
          id: BeeStore.ids.randomId('exp'),
          date: payDate,
          month: payDate.slice(0, 7),
          categoryId: null,
          categoryName: 'رواتب',
          amountMinor: net,
          method,
          accountId: resolvedAccountId,
          description: 'راتب ' + p.employeeName + ' - ' + p.month,
          recurringId: null,
          allocation: { mode: 'single' },
          voided: false,
          voidReason: null,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expenses', expense);

        p.status = 'paid';
        p.paidDate = payDate;
        p.method = method;
        p.accountId = resolvedAccountId;
        p.note = note || p.note;
        p.advanceRepaymentMinor = (p.advanceRepaymentMinor || 0) + appliedTotal;
        p.netMinor = net;
        p.updatedAt = BeeStore.dates.now();
        tx.put('payroll', p);
        return p;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('pay', 'payroll', id, 'دفع راتب ' + p.employeeName + ' - ' + p.month + ' بمبلغ ' + p.netMinor);
      }
      return p;
    }

    /** Lists advances for one employee.
     * @param {string} employeeId employee id
     * @returns {Promise<Array>} advance records
     */
    async getAdvances(employeeId) {
      return this.repo.list('employeeAdvances', a => a.employeeId === employeeId);
    }

    /** Grants an employee advance.
     * @param {Object} data {employeeId,date,amountMinor,accountId,note}
     * @returns {Promise<Object>} created advance
     * @throws {BeeError} PERIOD_CLOSED if date closed
     */
    async createAdvance(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const advance = {
          id: BeeStore.ids.randomId('adv'),
          employeeId: data.employeeId,
          date: data.date || BeeStore.dates.today(),
          amountMinor: BeeStore.money.roundMinor(data.amountMinor),
          repaidMinor: 0,
          accountId: data.accountId || null,
          note: data.note || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('employeeAdvances', advance);
        return advance;
      });
    }

    /** Sums unrepaid advances for one employee.
     * @param {string} employeeId employee id
     * @returns {Promise<number>} outstanding minor units
     */
    async getOutstandingAdvances(employeeId) {
      const advances = await this.getAdvances(employeeId);
      return advances.reduce((sum, a) => sum + (a.amountMinor - (a.repaidMinor || 0)), 0);
    }

    /** Accrued salaries as of date: unpaid/paid-after-D nets with month ≤ D (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{total:number,perEmployee:Object}>} accrued totals
     */
    // v2 §8: accrued salaries = Σ net of records with month ≤ D's month that
    // are unpaid or paid after D.
    async accruedAsOf(date) {
      const dm = String(date).slice(0, 7);
      const all = await this.repo.list('payroll', p => p.month && p.month <= dm);
      let total = 0;
      const perEmployee = {};
      for (const p of all) {
        const settled = p.status === 'paid' && p.paidDate && p.paidDate <= date;
        if (!settled) {
          const net = p.netMinor != null ? p.netMinor
            : (p.baseMinor || 0) + (p.bonusMinor || 0) + (p.overtimeMinor || 0) -
              (p.deductionsMinor || 0) - (p.advanceRepaymentMinor || 0);
          total += net;
          perEmployee[p.employeeId] = (perEmployee[p.employeeId] || 0) + net;
        }
      }
      return { total, perEmployee };
    }

    /** Advances outstanding as of date: given ≤ D minus repaid in paid payrolls ≤ D's month (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<number>} outstanding minor units
     */
    // v2 §8: advances given ≤ date minus repayments recognized in PAID
    // payrolls with month ≤ D's month.
    async advancesOutstandingAsOf(date) {
      const dm = String(date).slice(0, 7);
      const advances = await this.repo.list('employeeAdvances', a => a.date <= date);
      let given = 0;
      for (const a of advances) given += a.amountMinor;
      const payroll = await this.repo.list('payroll',
        p => p.status === 'paid' && p.month && p.month <= dm);
      let repaid = 0;
      for (const p of payroll) repaid += p.advanceRepaymentMinor || 0;
      return given - repaid;
    }
  }

  BeeStore.payroll = new PayrollService(null);
  BeeStore.PayrollService = PayrollService;
  if (typeof module !== 'undefined') module.exports = PayrollService;
})(typeof window !== 'undefined' ? window : globalThis);
