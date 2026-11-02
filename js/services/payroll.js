(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function rounded(value) {
    return Math.round(Number(value) || 0);
  }

  const LIABILITY_ACCOUNTS = {
    withholding: 'accrued_withholdings',
    employer: 'accrued_employer',
    end_of_service: 'end_of_service',
  };

  const LIABILITY_LABELS = {
    withholding: 'استقطاعات رواتب',
    employer: 'مساهمات صاحب العمل',
    end_of_service: 'مخصص نهاية الخدمة',
  };

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
        const settings = (await tx.get('meta', 'settings')) || {};
        const created = [];
        for (const emp of employees) {
          const existing = await tx.list('payroll', p => p.employeeId === emp.id && p.month === month);
          if (existing.length > 0) continue;
          const baseMinor = emp.baseSalaryMinor || 0;
          const totals = BeeStore.settings.payrollComponentTotals(settings, baseMinor);
          const record = {
            id: BeeStore.ids.randomId('pay'),
            employeeId: emp.id,
            employeeName: emp.name,
            month,
            baseMinor,
            bonusMinor: 0,
            overtimeMinor: 0,
            deductionsMinor: 0,
            withholdingMinor: totals.withholdingMinor,
            employerCostMinor: totals.employerCostMinor,
            endOfServiceMinor: totals.endOfServiceMinor,
            payrollComponentSnapshot: totals.components,
            advanceRepaymentMinor: 0,
            netMinor: baseMinor - totals.withholdingMinor,
            status: 'draft',
            paidDate: null,
            method: null,
            accountId: null,
            note: '',
            createdAt: BeeStore.dates.now(),
            updatedAt: BeeStore.dates.now(),
          };
          tx.put('payroll', record);
          if (BeeStore.posting) {
            const entry = await BeeStore.posting.payrollAccrual(tx, record);
            if (entry) {
              BeeStore.posting.link(record, entry);
              tx.put('payroll', record);
            }
          }
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
      const month = filters && filters.month;
      let payroll = month
        ? await this.repo.listRange('payroll', month, month)
        : await this.repo.list('payroll');
      if (filters) {
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
        const financialKeys = ['month', 'baseMinor', 'bonusMinor', 'overtimeMinor',
          'deductionsMinor', 'withholdingMinor', 'employerCostMinor',
          'endOfServiceMinor', 'advanceRepaymentMinor', 'status', 'paidDate',
          'method', 'accountId'];
        const touchesFinancials = Object.keys(patch || {}).some(k =>
          financialKeys.indexOf(k) >= 0);
        if (p.status === 'paid' && touchesFinancials) {
          throw BeeStore.errors.err('VALIDATION',
            'الراتب مدفوع — لا يمكن تعديل مبالغه أو شهره. أعد فتح الفترة أو صحّح بقيد جديد');
        }
        if (touchesFinancials) {
          await BeeStore.periods.assertOpen(tx, String(patch.month || p.month) + '-01');
        }
        const updated = { ...p, ...patch, id, updatedAt: BeeStore.dates.now() };
        // A base change recomputes the configured percentage components unless
        // the caller supplied explicit component amounts for this record.
        const explicitComponents = ['withholdingMinor', 'employerCostMinor',
          'endOfServiceMinor'].some(k => Object.prototype.hasOwnProperty.call(patch || {}, k));
        if (patch && patch.baseMinor !== undefined && !explicitComponents) {
          const settings = (await tx.get('meta', 'settings')) || {};
          const totals = BeeStore.settings.payrollComponentTotals(settings,
            updated.baseMinor);
          updated.withholdingMinor = totals.withholdingMinor;
          updated.employerCostMinor = totals.employerCostMinor;
          updated.endOfServiceMinor = totals.endOfServiceMinor;
          updated.payrollComponentSnapshot = totals.components;
        }
        const gross = rounded(updated.baseMinor) + rounded(updated.bonusMinor) +
          rounded(updated.overtimeMinor) - rounded(updated.deductionsMinor);
        updated.withholdingMinor = Math.max(0, rounded(updated.withholdingMinor));
        updated.employerCostMinor = Math.max(0, rounded(updated.employerCostMinor));
        updated.endOfServiceMinor = Math.max(0, rounded(updated.endOfServiceMinor));
        updated.advanceRepaymentMinor = Math.max(0, rounded(updated.advanceRepaymentMinor));
        if (updated.withholdingMinor > gross) {
          throw BeeStore.errors.err('VALIDATION',
            'الاستقطاعات أكبر من إجمالي الراتب — راجع مكوّنات الراتب');
        }
        updated.netMinor = gross - updated.withholdingMinor -
          updated.advanceRepaymentMinor;
        if (updated.netMinor < 0) {
          throw BeeStore.errors.err('VALIDATION', 'صافي الراتب لا يمكن أن يكون سالباً');
        }
        tx.put('payroll', updated);
        if (BeeStore.posting && touchesFinancials) {
          // A draft accrual is reverse-and-reposted so 6100/2100 always match
          // the record; a paid record never reaches this branch.
          const reversals = await BeeStore.posting.reverseDocument(tx, 'PAYROLL', id, {
            description: 'تعديل استحقاق راتب — عكس القيد السابق',
          }, { allowClosedDay: true });
          if (reversals.length > 0) BeeStore.posting.linkAll([updated], reversals);
          const entry = await BeeStore.posting.payrollAccrual(tx, updated);
          if (entry) BeeStore.posting.link(updated, entry);
          tx.put('payroll', updated);
        }
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
        await BeeStore.periods.assertDayOpen(tx, payDate);
        const settings = await tx.get('meta', 'settings') || {};
        const resolvedAccountId = accountId || BeeStore.settings.resolvePaymentAccount(settings, method || 'cash');

        const salaryExpense = p.baseMinor + p.bonusMinor + p.overtimeMinor - p.deductionsMinor;
        const withholding = Math.max(0, rounded(p.withholdingMinor));
        if (withholding > salaryExpense) {
          throw BeeStore.errors.err('VALIDATION',
            'الاستقطاعات أكبر من إجمالي الراتب — راجع مكونات الراتب');
        }
        const accrued = salaryExpense - withholding;
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

        const net = accrued - appliedTotal;
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
        p.advanceRepaymentMinor = appliedTotal;
        p.netMinor = net;
        p.updatedAt = BeeStore.dates.now();
        tx.put('payroll', p);
        if (BeeStore.posting) {
          // v5 §7: Dr 2100 gross / Cr 1150 applied advances / Cr money net.
          const entry = await BeeStore.posting.payrollPayment(tx, p);
          if (entry) {
            BeeStore.posting.link(p, entry);
            tx.put('payroll', p);
          }
        }
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
        const advanceDate = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, advanceDate);
        await BeeStore.periods.assertDayOpen(tx, advanceDate);
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
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.employeeAdvance(tx, advance);
          if (entry) {
            BeeStore.posting.link(advance, entry);
            tx.put('employeeAdvances', advance);
          }
        }
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
          const gross = (Number(p.baseMinor) || 0) + (Number(p.bonusMinor) || 0) +
            (Number(p.overtimeMinor) || 0) - (Number(p.deductionsMinor) || 0);
          const net = gross - (Number(p.withholdingMinor) || 0);
          total += net;
          perEmployee[p.employeeId] = (perEmployee[p.employeeId] || 0) + net;
        }
      }
      return { total, perEmployee };
    }

    /**
     * v5 §7.2/§7.3 liability balances as of a business date. Payroll accrual
     * is dated the first of the payroll month; liability payments reduce the
     * balance on their own date.
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{withholding:number,employer:number,endOfService:number,total:number,perEmployee:Object}>}
     */
    async liabilityBalancesAsOf(date) {
      const dm = String(date).slice(0, 7);
      const payroll = await this.repo.list('payroll',
        p => p.month && p.month <= dm);
      const balances = {
        withholding: 0, employer: 0, endOfService: 0,
        perEmployee: {},
      };
      for (const p of payroll) {
        const withholding = Number(p.withholdingMinor) || 0;
        const employer = Number(p.employerCostMinor) || 0;
        const eos = Number(p.endOfServiceMinor) || 0;
        balances.withholding += withholding;
        balances.employer += employer;
        balances.endOfService += eos;
        if (p.employeeId) {
          balances.perEmployee[p.employeeId] =
            (balances.perEmployee[p.employeeId] || 0) +
            withholding + employer + eos;
        }
      }
      const payments = await this.repo.list('payrollLiabilityPayments',
        p => !p.voided && p.date <= date);
      for (const payment of payments) {
        const amount = Number(payment.amountMinor) || 0;
        if (payment.type === 'withholding') balances.withholding -= amount;
        else if (payment.type === 'employer') balances.employer -= amount;
        else if (payment.type === 'end_of_service') balances.endOfService -= amount;
      }
      balances.total = balances.withholding + balances.employer +
        balances.endOfService;
      return balances;
    }

    /**
     * Lists payroll liability payments newest-first.
     * @param {object} [filters] {type,from,to}
     * @returns {Promise<object[]>} payment records
     */
    async listLiabilityPayments(filters) {
      const from = filters && filters.from;
      const to = filters && filters.to;
      let rows = (from || to)
        ? await this.repo.listRange('payrollLiabilityPayments', from, to)
        : await this.repo.list('payrollLiabilityPayments');
      if (filters && filters.type) rows = rows.filter(p => p.type === filters.type);
      if (!filters || !filters.includeVoided) rows = rows.filter(p => !p.voided);
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return rows;
    }

    /**
     * Pays one payroll liability (withholding, employer contribution or
     * end-of-service provision). Dr 2110/2120/2200, Cr Cash/Bank.
     * @param {object} data {type,amountMinor,date,method,accountId,note}
     * @returns {Promise<object>} payment record
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED when invalid or overpaid
     */
    async payLiabilities(data) {
      data = data || {};
      const type = String(data.type || '');
      if (!LIABILITY_ACCOUNTS[type]) {
        throw BeeStore.errors.err('VALIDATION',
          'نوع مستحقات الرواتب غير معروف: ' + (type || '(فارغ)'));
      }
      const amount = BeeStore.money.roundMinor(data.amountMinor);
      if (amount <= 0) {
        throw BeeStore.errors.err('VALIDATION', 'مبلغ السداد يجب أن يكون أكبر من صفر');
      }
      const payment = await this.repo.transaction(async (tx) => {
        const date = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, date);
        await BeeStore.periods.assertDayOpen(tx, date);
        const balances = await this.liabilityBalancesTx(tx, date);
        const available = type === 'withholding' ? balances.withholding
          : type === 'employer' ? balances.employer : balances.endOfService;
        if (amount > available) {
          throw BeeStore.errors.err('VALIDATION',
            'مبلغ السداد أكبر من الرصيد المستحق (' + BeeStore.money.toMajor(available) + ')');
        }
        const settings = (await tx.get('meta', 'settings')) || {};
        const method = data.method || 'cash';
        const accountId = data.accountId ||
          BeeStore.settings.resolvePaymentAccount(settings, method);
        const record = {
          id: BeeStore.ids.randomId('plp'),
          date,
          type,
          label: LIABILITY_LABELS[type],
          amountMinor: amount,
          method,
          methodKind: data.methodKind ||
            BeeStore.settings.methodKind(settings, method),
          accountId,
          note: data.note || '',
          voided: false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('payrollLiabilityPayments', record);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.payrollLiabilityPayment(tx, record);
          if (entry) {
            BeeStore.posting.link(record, entry);
            tx.put('payrollLiabilityPayments', record);
          }
        }
        return record;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('pay', 'payrollLiabilityPayments', payment.id,
          'سداد ' + payment.label + ' بمبلغ ' + payment.amountMinor);
      }
      return payment;
    }

    /**
     * Voids a payroll liability payment and reverses its journal entry.
     * @param {string} id payment id
     * @param {string} [reason] void reason
     * @returns {Promise<object>} voided payment record
     */
    async voidLiabilityPayment(id, reason) {
      return this.repo.transaction(async (tx) => {
        const payment = await tx.get('payrollLiabilityPayments', id);
        if (!payment) throw BeeStore.errors.err('NOT_FOUND', 'سداد المستحقات غير موجود');
        if (payment.voided) throw BeeStore.errors.err('ALREADY_VOID', 'السداد ملغى مسبقاً');
        await BeeStore.periods.assertOpen(tx, payment.date);
        const reversals = await BeeStore.posting.reverseDocument(tx,
          'PAYROLL_LIABILITY', id,
          { description: 'إلغاء سداد ' + (payment.label || 'مستحقات رواتب') },
          { allowClosedDay: true });
        if (reversals.length > 0) BeeStore.posting.linkAll([payment], reversals);
        payment.voided = true;
        payment.voidReason = String(reason || '');
        payment.updatedAt = BeeStore.dates.now();
        tx.put('payrollLiabilityPayments', payment);
        return payment;
      });
    }

    async liabilityBalancesTx(tx, date) {
      const dm = String(date).slice(0, 7);
      const payroll = await tx.list('payroll', p => p.month && p.month <= dm);
      const balances = { withholding: 0, employer: 0, endOfService: 0 };
      for (const p of payroll) {
        balances.withholding += Number(p.withholdingMinor) || 0;
        balances.employer += Number(p.employerCostMinor) || 0;
        balances.endOfService += Number(p.endOfServiceMinor) || 0;
      }
      const payments = await tx.list('payrollLiabilityPayments',
        p => !p.voided && p.date <= date);
      for (const payment of payments) {
        const amount = Number(payment.amountMinor) || 0;
        if (payment.type === 'withholding') balances.withholding -= amount;
        else if (payment.type === 'employer') balances.employer -= amount;
        else if (payment.type === 'end_of_service') balances.endOfService -= amount;
      }
      return balances;
    }

    /** Advances outstanding as of date: given ≤ D minus repaid in paid payrolls ≤ D's month (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<number>} outstanding minor units
     */
    // v2 §8: advances given ≤ date minus repayments recognized in PAID
    // payrolls with month ≤ D's month.
    async advancesOutstandingAsOf(date) {
      const advances = await this.repo.list('employeeAdvances', a => a.date <= date);
      let given = 0;
      for (const a of advances) given += a.amountMinor;
      const payroll = await this.repo.list('payroll',
        p => p.status === 'paid' && p.paidDate && p.paidDate <= date);
      let repaid = 0;
      for (const p of payroll) repaid += p.advanceRepaymentMinor || 0;
      return given - repaid;
    }
  }

  BeeStore.payroll = new PayrollService(null);
  BeeStore.PayrollService = PayrollService;
  if (typeof module !== 'undefined') module.exports = PayrollService;
})(typeof window !== 'undefined' ? window : globalThis);
