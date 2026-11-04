(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const DEFAULT_CATEGORIES = [
    'إيجار', 'كهرباء', 'ماء', 'إنترنت وهاتف', 'مواصلات',
    'تسويق وإعلان', 'تغليف وأكياس', 'صيانة', 'ضرائب ورسوم', 'مصاريف أخرى',
  ];

  // v2 §6.4: these names are reserved for their own flows (never expense cats).
  const RESERVED_CATEGORY_NAMES = [
    'رواتب', 'راتب', 'الرواتب', 'مشتريات', 'مخزون', 'المخزون',
    'سلفة', 'سلف', 'السلف', 'رأس مال', 'راس المال', 'مسحوبات', 'سحب شخصي', 'سحب',
  ];

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  class ExpensesService {
    constructor(repo) {
      this.repo = repo;
    }

    _initialPaid(expense) {
      const amount = Math.max(0, Math.round(Number(expense && expense.amountMinor) || 0));
      let paid = amount;
      if (expense && expense.initialPaidMinor != null) {
        paid = Math.round(Number(expense.initialPaidMinor) || 0);
      } else if (expense && expense.paidMinor != null) {
        paid = Math.round(Number(expense.paidMinor) || 0);
      }
      return Math.max(0, Math.min(amount, paid));
    }

    _status(paidMinor, amountMinor) {
      const amount = Math.max(0, Math.round(Number(amountMinor) || 0));
      const paid = Math.max(0, Math.min(amount, Math.round(Number(paidMinor) || 0)));
      if (paid >= amount) return 'paid';
      return paid > 0 ? 'partial' : 'unpaid';
    }

    async _activePayments(reader, expenseId) {
      return (reader || this.repo).list('expensePayments',
        p => p.expenseId === expenseId && !p.voided);
    }

    // Pure: monthly profit shares of an expense (v2 §6.3). Spread shares sum
    // exactly to the total; the last month absorbs the rounding remainder.
    spreadShares(expense) {
      const alloc = expense.allocation || { mode: 'single' };
      if (alloc.mode !== 'spread') {
        return [{ month: expense.month || String(expense.date).slice(0, 7), amountMinor: expense.amountMinor }];
      }
      const n = alloc.months;
      const out = [];
      const base = Math.floor(expense.amountMinor / n);
      let assigned = 0;
      for (let i = 0; i < n; i++) {
        const month = BeeStore.dates.addMonths(alloc.startMonth, i);
        const amountMinor = i === n - 1 ? expense.amountMinor - assigned : base;
        assigned += amountMinor;
        out.push({ month, amountMinor });
      }
      return out;
    }

    spreadMonths(expense) {
      return this.spreadShares(expense).map(s => s.month);
    }

    /** Prepaid spread remainder as of date (v2 §8).
     * @param {string} date YYYY-MM-DD as-of date
     * @returns {Promise<{total:number,byCategory:Object}>} unallocated future-month shares
     */
    // v2 §8: unallocated remainder of spread expenses paid ≤ date whose
    // months fall after the date's month (a prepaid asset).
    async prepaidAsOf(date) {
      const dm = String(date).slice(0, 7);
      const all = await this.repo.list('expenses',
        e => !e.voided && (e.allocation || {}).mode === 'spread' && e.date <= date);
      let total = 0;
      const byCategory = {};
      for (const e of all) {
        const key = e.categoryName || 'أخرى';
        for (const s of this.spreadShares(e)) {
          if (s.month > dm) {
            total += s.amountMinor;
            byCategory[key] = (byCategory[key] || 0) + s.amountMinor;
          }
        }
      }
      return { total, byCategory };
    }

    /** Lists expense categories.
     * @returns {Promise<Array>} all expense categories
     */
    async getCategories() {
      return this.repo.list('expenseCategories');
    }

    /** Creates an expense category (rejects reserved v2 §6.4 names).
     * @param {Object} data {name, active}
     * @returns {Promise<Object>} created category
     * @throws {BeeError} VALIDATION on empty/reserved name
     */
    async createCategory(data) {
      return this.repo.transaction(async (tx) => {
        const name = String((data && data.name) || '').trim();
        if (!name) throw BeeStore.errors.err('VALIDATION', 'اسم التصنيف مطلوب');
        if (RESERVED_CATEGORY_NAMES.includes(name)) {
          throw BeeStore.errors.err('VALIDATION',
            '«' + name + '» اسم مخصص: سجّل الرواتب من الموظفين والرواتب، والمشتريات من المشتريات، والسلف من سلف الموظفين، ومعاملات المالك من الحسابات');
        }
        const cat = {
          id: BeeStore.ids.randomId('ecat'),
          name,
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expenseCategories', cat);
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          await BeeStore.chart.ensureSeededTx(tx);
          return (await tx.get('expenseCategories', cat.id)) || cat;
        }
        return cat;
      });
    }

    /** Lists expenses newest-first (voided excluded by default).
     * @param {Object} [filters] {from,to,categoryId,includeVoided}
     * @returns {Promise<Array>} matching expenses
     */
    async list(filters) {
      const from = filters && filters.from;
      const to = filters && filters.to;
      let expenses = (from || to)
        ? await this.repo.listRange('expenses', from, to)
        : await this.repo.list('expenses');
      if (filters && filters.categoryId) {
        expenses = expenses.filter(e => e.categoryId === filters.categoryId);
      }
      if (!filters || !filters.includeVoided) expenses = expenses.filter(e => !e.voided);
      expenses.sort((a, b) => b.date.localeCompare(a.date));
      return expenses;
    }

    /** Creates an expense; supports spread allocation over N months (v2 §6.3).
     * @param {Object} data expense fields incl. allocation
     * @returns {Promise<Object>} created expense
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED on bad amount/month or closed period
     */
    async create(data) {
      data = data || {};
      return this.repo.transaction(async (tx) => {
        const settings = await tx.get('meta', 'settings') || {};
        const categories = await tx.list('expenseCategories');
        const catMap = {};
        for (const c of categories) catMap[c.id] = c.name;
        const method = data.method || 'cash';
        const date = data.date || BeeStore.dates.today();
        const accountId = data.accountId || BeeStore.settings.resolvePaymentAccount(settings, method);
        const methodKind = data.methodKind || BeeStore.settings.methodKind(settings, method);
        await BeeStore.periods.assertOpen(tx, date);
        // v2 §6.3 spread: one payment covering N months.
        let allocation = { mode: 'single' };
        let month = date.slice(0, 7);
        if (data.allocation && data.allocation.mode === 'spread') {
          const n = Math.floor(Number(data.allocation.months) || 0);
          const startMonth = data.allocation.startMonth || month;
          if (n < 2) throw BeeStore.errors.err('VALIDATION', 'التوزيع يحتاج شهرين على الأقل');
          if (!MONTH_RE.test(startMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر بداية التوزيع غير صالح');
          allocation = { mode: 'spread', months: n, startMonth };
          month = startMonth;
        }
        const amountMinor = BeeStore.money.roundMinor(data.amountMinor);
        if (amountMinor <= 0) throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');

        // A4.2 §7.1: paidMinor/initialPaidMinor describe money actually paid
        // at recording time. The unpaid remainder becomes the 2020 liability.
        let initialPaidMinor;
        if (data.paidMinor !== undefined && data.paidMinor !== null && data.paidMinor !== '') {
          initialPaidMinor = BeeStore.money.roundMinor(data.paidMinor);
        } else if (data.paymentStatus === 'unpaid') {
          initialPaidMinor = 0;
        } else if (data.paymentStatus === 'partial') {
          throw BeeStore.errors.err('VALIDATION',
            'المصروف المدفوع جزئياً يحتاج المبلغ المدفوع');
        } else {
          // Legacy API/UI behaviour: an expense without payment fields is paid
          // in full at recording time.
          initialPaidMinor = amountMinor;
        }
        if (initialPaidMinor < 0 || initialPaidMinor > amountMinor) {
          throw BeeStore.errors.err('VALIDATION',
            'المبلغ المدفوع يجب أن يكون بين صفر وإجمالي المصروف');
        }
        if (initialPaidMinor > 0) {
          // v3-Lite §4.5: only the cash-paid part is day-locked.
          await BeeStore.periods.assertCashDayOpen(tx, date, accountId);
        }
        const dueDate = data.dueDate == null || data.dueDate === ''
          ? null : String(data.dueDate);
        if (dueDate && !DATE_RE.test(dueDate)) {
          throw BeeStore.errors.err('VALIDATION', 'تاريخ الاستحقاق غير صالح');
        }
        const payee = String(data.payee || '').trim();
        const paymentStatus = this._status(initialPaidMinor, amountMinor);
        const expense = {
          id: BeeStore.ids.randomId('exp'),
          date,
          month,
          categoryId: data.categoryId,
          categoryName: data.categoryName || (data.categoryId ? (catMap[data.categoryId] || '') : '') || 'أخرى',
          amountMinor,
          method,
          methodKind,
          accountId,
          payee,
          payeeSupplierId: data.payeeSupplierId || data.supplierId || null,
          dueDate,
          paymentStatus,
          initialPaidMinor,
          paidMinor: initialPaidMinor,
          description: data.description || '',
          recurringId: data.recurringId || null,
          allocation,
          voided: false,
          voidReason: null,
          time: data.time || BeeStore.dates.nowTime(),
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expenses', expense);
        if (BeeStore.posting) {
          const entries = await BeeStore.posting.expense(tx, expense);
          if (entries.length > 0) {
            BeeStore.posting.linkAll([expense], entries);
            tx.put('expenses', expense);
          }
        }
        return expense;
      });
    }

    /** Updates an expense; spread needs all months open (v2 §6.3).
     * @param {string} id expense id
     * @param {Object} patch fields to merge
     * @returns {Promise<Object>} updated expense
     * @throws {BeeError} NOT_FOUND|ALREADY_VOID|PERIOD_CLOSED
     */
    async update(id, patch) {
      patch = patch || {};
      return this.repo.transaction(async (tx) => {
        const e = await tx.get('expenses', id);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        if (e.voided) throw BeeStore.errors.err('ALREADY_VOID', 'المصروف ملغي — لا يمكن تعديله');
        // A4.2: once later payments exist the document and its sub-ledger must
        // stay frozen; void the payments first if the whole expense is wrong.
        const payments = await this._activePayments(tx, id);
        if (payments.length > 0) {
          throw BeeStore.errors.err('VALIDATION',
            'لا يمكن تعديل مصروف له دفعات مسجلة — ألغِ الدفعات أولاً');
        }
        for (const key of ['paidMinor', 'initialPaidMinor', 'paymentStatus']) {
          if (patch[key] !== undefined) {
            throw BeeStore.errors.err('VALIDATION',
              'سجّل الدفعات من شاشة المدفوعات ولا تعدّل حالة الدفع مباشرة');
          }
        }
        await BeeStore.periods.assertOpen(tx, e.date);
        if (patch.date) await BeeStore.periods.assertOpen(tx, patch.date);
        const currentPaid = this._initialPaid(e);
        if (currentPaid > 0) {
          await BeeStore.periods.assertCashDayOpen(tx, e.date, e.accountId);
        }
        const nextAmount = patch.amountMinor !== undefined
          ? BeeStore.money.roundMinor(patch.amountMinor) : e.amountMinor;
        if (nextAmount <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');
        }
        if (nextAmount < currentPaid) {
          throw BeeStore.errors.err('VALIDATION',
            'لا يمكن أن يقل إجمالي المصروف عن المبلغ المدفوع');
        }
        const nextAccount = patch.accountId !== undefined ? patch.accountId : e.accountId;
        if (currentPaid > 0) {
          await BeeStore.periods.assertCashDayOpen(tx, patch.date || e.date, nextAccount);
        }
        // v2 §6.3: a spread expense can change only while ALL its months open.
        if ((e.allocation || {}).mode === 'spread') {
          await BeeStore.periods.assertMonthsOpen(tx, this.spreadMonths(e));
        }
        const updated = { ...e, ...patch, id, updatedAt: BeeStore.dates.now() };
        if (patch.date) updated.month = String(patch.date).slice(0, 7);
        if (patch.method && patch.methodKind === undefined) {
          const settings = await tx.get('meta', 'settings') || {};
          updated.methodKind = BeeStore.settings.methodKind(settings, patch.method);
        }
        updated.amountMinor = nextAmount;
        updated.initialPaidMinor = currentPaid;
        updated.paidMinor = currentPaid;
        updated.paymentStatus = this._status(currentPaid, nextAmount);
        updated.payee = patch.payee !== undefined ? String(patch.payee || '').trim() : (e.payee || '');
        if (patch.dueDate !== undefined) {
          if (patch.dueDate && !DATE_RE.test(String(patch.dueDate))) {
            throw BeeStore.errors.err('VALIDATION', 'تاريخ الاستحقاق غير صالح');
          }
          updated.dueDate = patch.dueDate || null;
        }
        tx.put('expenses', updated);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(tx, 'EXPENSE', id, {
            description: 'تعديل مصروف — عكس القيد السابق',
            reason: 'update',
          }, { allowClosedDay: true });
          if (reversals.length > 0) BeeStore.posting.linkAll([updated], reversals);
          const entries = await BeeStore.posting.expense(tx, updated);
          if (entries.length > 0) BeeStore.posting.linkAll([updated], entries);
          tx.put('expenses', updated);
        }
        return updated;
      });
    }

    /** Voids an expense, no hard deletes; spread needs all months open.
     * @param {string} id expense id
     * @param {string} reason mandatory void reason
     * @returns {Promise<Object>} voided expense
     * @throws {BeeError} NOT_FOUND|ALREADY_VOID|VALIDATION|PERIOD_CLOSED
     */
    async void(id, reason) {
      // No hard deletes (spec §4 rule 6): voiding keeps the record visible
      // but excludes it from all totals. Reason is mandatory.
      const expense = await this.repo.transaction(async (tx) => {
        const e = await tx.get('expenses', id);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        if (e.voided) throw BeeStore.errors.err('ALREADY_VOID', 'المصروف ملغي مسبقاً');
        if (!reason || !String(reason).trim()) {
          throw BeeStore.errors.err('VALIDATION', 'سبب الإلغاء مطلوب');
        }
        const payments = await this._activePayments(tx, id);
        if (payments.length > 0) {
          throw BeeStore.errors.err('VALIDATION',
            'لا يمكن إلغاء مصروف له دفعات مسجلة — ألغِ الدفعات أولاً');
        }
        await BeeStore.periods.assertOpen(tx, e.date);
        if (this._initialPaid(e) > 0) {
          await BeeStore.periods.assertCashDayOpen(tx, e.date, e.accountId);
        }
        if ((e.allocation || {}).mode === 'spread') {
          await BeeStore.periods.assertMonthsOpen(tx, this.spreadMonths(e));
        }
        e.voided = true;
        e.voidReason = String(reason).trim();
        e.updatedAt = BeeStore.dates.now();
        tx.put('expenses', e);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(tx, 'EXPENSE', id, {
            description: 'إلغاء مصروف — ' + e.voidReason,
            reason: e.voidReason,
          }, { allowClosedDay: true });
          if (reversals.length > 0) {
            BeeStore.posting.linkAll([e], reversals);
            tx.put('expenses', e);
          }
        }
        return e;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('void', 'expense', id, 'إلغاء مصروف بمبلغ ' + expense.amountMinor + ' - ' + reason);
      }
      return expense;
    }

    /**
     * Lists the payment records of one expense, oldest first.
     * @param {string} expenseId expense id
     * @returns {Promise<Array>} active and voided payments
     */
    async listPayments(expenseId) {
      const rows = await this.repo.list('expensePayments', p => p.expenseId === expenseId);
      rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      return rows;
    }

    /**
     * Records a later payment of a previously unpaid/partial expense:
     * v5 §4 rule 9 Dr 2020 / Cr Cash|Bank.
     * @param {string} expenseId expense id
     * @param {Object} data {amountMinor,date,method,accountId,note}
     * @returns {Promise<{payment:Object,expense:Object}>} payment + updated expense
     * @throws {BeeError} NOT_FOUND|VALIDATION|PERIOD_CLOSED|DAY_CLOSED
     */
    async pay(expenseId, data) {
      data = data || {};
      return this.repo.transaction(async (tx) => {
        const e = await tx.get('expenses', expenseId);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        if (e.voided) throw BeeStore.errors.err('ALREADY_VOID', 'المصروف ملغي — لا يمكن دفع مبلغ له');
        const amountMinor = BeeStore.money.roundMinor(data.amountMinor);
        if (amountMinor <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ الدفعة يجب أن يكون أكبر من صفر');
        }
        const paid = Math.round(Number(e.paidMinor) || 0);
        const remaining = Math.max(0, Math.round(Number(e.amountMinor) || 0) - paid);
        if (remaining <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'هذا المصروف مدفوع بالكامل');
        }
        if (amountMinor > remaining) {
          throw BeeStore.errors.err('VALIDATION',
            'الدفعة تتجاوز المتبقي (' + (remaining / 100).toFixed(2) + ')');
        }
        const date = data.date || BeeStore.dates.today();
        if (!DATE_RE.test(String(date))) {
          throw BeeStore.errors.err('VALIDATION', 'تاريخ الدفعة غير صالح');
        }
        if (date < e.date) {
          throw BeeStore.errors.err('VALIDATION', 'لا يمكن دفع المصروف قبل تاريخه');
        }
        await BeeStore.periods.assertOpen(tx, date);
        const settings = await tx.get('meta', 'settings') || {};
        const method = data.method || 'cash';
        const accountId = data.accountId ||
          BeeStore.settings.resolvePaymentAccount(settings, method);
        const methodKind = data.methodKind ||
          BeeStore.settings.methodKind(settings, method);
        await BeeStore.periods.assertCashDayOpen(tx, date, accountId);
        const payment = {
          id: BeeStore.ids.randomId('epay'),
          expenseId: e.id,
          date,
          time: BeeStore.dates.nowTime ? BeeStore.dates.nowTime() : '',
          amountMinor,
          method,
          methodKind,
          accountId,
          note: data.note || '',
          voided: false,
          voidReason: null,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('expensePayments', payment);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.expensePayment(tx, payment);
          if (entry) {
            BeeStore.posting.link(payment, entry);
            tx.put('expensePayments', payment);
          }
        }
        e.paidMinor = paid + amountMinor;
        e.paymentStatus = this._status(e.paidMinor, e.amountMinor);
        e.updatedAt = BeeStore.dates.now();
        tx.put('expenses', e);
        return { payment, expense: e };
      });
    }

    /**
     * Voids one later payment and reverses its exact journal entry.
     * The expense returns to partial/unpaid automatically.
     * @param {string} paymentId expense payment id
     * @param {string} reason mandatory reason
     * @returns {Promise<{payment:Object,expense:Object}>}
     */
    async voidPayment(paymentId, reason) {
      if (!reason || !String(reason).trim()) {
        throw BeeStore.errors.err('VALIDATION', 'سبب الإلغاء مطلوب');
      }
      return this.repo.transaction(async (tx) => {
        const payment = await tx.get('expensePayments', paymentId);
        if (!payment) throw BeeStore.errors.err('NOT_FOUND', 'الدفعة غير موجودة');
        if (payment.voided) throw BeeStore.errors.err('ALREADY_VOID', 'الدفعة ملغاة مسبقاً');
        const e = await tx.get('expenses', payment.expenseId);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'المصروف غير موجود');
        // The reversal mirrors the payment date, so that month/day must be
        // open. A cash-drawer payment is day-locked like the original payment.
        await BeeStore.periods.assertOpen(tx, payment.date);
        await BeeStore.periods.assertCashDayOpen(tx, payment.date, payment.accountId);
        payment.voided = true;
        payment.voidReason = String(reason).trim();
        payment.updatedAt = BeeStore.dates.now();
        tx.put('expensePayments', payment);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(tx, 'EXPENSE_PAYMENT', payment.id, {
            description: 'إلغاء دفعة مصروف — ' + payment.voidReason,
            reason: payment.voidReason,
          }, { allowClosedDay: true });
          if (reversals.length > 0) {
            BeeStore.posting.linkAll([payment], reversals);
            tx.put('expensePayments', payment);
          }
        }
        e.paidMinor = Math.max(0,
          Math.round(Number(e.paidMinor) || 0) - (Math.round(Number(payment.amountMinor) || 0)));
        e.paymentStatus = this._status(e.paidMinor, e.amountMinor);
        e.updatedAt = BeeStore.dates.now();
        tx.put('expenses', e);
        return { payment, expense: e };
      });
    }

    /**
     * Total unpaid expense liability as of a date (v5 §7.1 / §9).
     * Only payments dated on or before `asOf` reduce the liability.
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<number>} remaining payable in minor units
     */
    async unpaidAsOf(asOf) {
      const date = String(asOf);
      const expenses = await this.repo.list('expenses',
        e => !e.voided && e.date <= date);
      const payments = await this.repo.list('expensePayments',
        p => !p.voided && p.date <= date);
      const paidLater = {};
      for (const p of payments) {
        paidLater[p.expenseId] = (paidLater[p.expenseId] || 0) +
          (Math.round(Number(p.amountMinor) || 0));
      }
      let total = 0;
      for (const e of expenses) {
        const amount = Math.round(Number(e.amountMinor) || 0);
        total += amount - this._initialPaid(e) - (paidLater[e.id] || 0);
      }
      return BeeStore.money.roundMinor(total);
    }

    /**
     * Unpaid-expense rows with aging buckets for the reports/UI.
     * @param {string} [asOf] YYYY-MM-DD (defaults to today)
     * @returns {Promise<Array>} rows sorted by due date then document date
     */
    async unpaidList(asOf) {
      const date = asOf || BeeStore.dates.today();
      const expenses = await this.repo.list('expenses',
        e => !e.voided && e.date <= date);
      const payments = await this.repo.list('expensePayments',
        p => !p.voided && p.date <= date);
      const paidLater = {};
      for (const p of payments) {
        paidLater[p.expenseId] = (paidLater[p.expenseId] || 0) +
          (Math.round(Number(p.amountMinor) || 0));
      }
      const rows = [];
      for (const e of expenses) {
        const amount = Math.round(Number(e.amountMinor) || 0);
        const initial = this._initialPaid(e);
        const later = paidLater[e.id] || 0;
        const remaining = amount - initial - later;
        if (remaining <= 0) continue;
        const base = e.dueDate || e.date;
        const days = Math.max(0, BeeStore.dates.diffDays(base, date));
        const bucket = days <= 30 ? '0-30' : (days <= 60 ? '31-60' : (days <= 90 ? '61-90' : '90+'));
        rows.push({
          expenseId: e.id,
          date: e.date,
          dueDate: e.dueDate || null,
          categoryName: e.categoryName || 'أخرى',
          description: e.description || '',
          payee: e.payee || '',
          amountMinor: amount,
          paidMinor: initial + later,
          remainingMinor: remaining,
          daysPastDue: days,
          overdue: !!(e.dueDate && e.dueDate < date),
          bucket,
        });
      }
      rows.sort((a, b) => String(a.dueDate || a.date).localeCompare(String(b.dueDate || b.date)) ||
        String(a.date).localeCompare(String(b.date)) ||
        String(a.expenseId).localeCompare(String(b.expenseId)));
      return rows;
    }

    /**
     * Unpaid-expense aging totals.
     * @param {string} [asOf] YYYY-MM-DD
     * @returns {Promise<{asOf:string,rows:Array,buckets:Object,totalMinor:number}>}
     */
    async aging(asOf) {
      const date = asOf || BeeStore.dates.today();
      const rows = await this.unpaidList(date);
      const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
      let totalMinor = 0;
      for (const row of rows) {
        buckets[row.bucket] += row.remainingMinor;
        totalMinor += row.remainingMinor;
      }
      return { asOf: date, rows, buckets, totalMinor };
    }


    /**
     * Lists recurring expense templates.
     * @returns {Promise<Array>} all recurring templates
     */
    async getRecurring() {
      return this.repo.list('recurringExpenses');
    }

    /** Creates a recurring expense template (v2 §6.2).
     * @param {Object} data template fields
     * @returns {Promise<Object>} created template
     * @throws {BeeError} VALIDATION on bad amount/months
     */
    async createRecurring(data) {
      return this.repo.transaction(async (tx) => {
        const amountMinor = BeeStore.money.roundMinor(data.amountMinor);
        if (amountMinor <= 0) throw BeeStore.errors.err('VALIDATION', 'مبلغ المصروف يجب أن يكون أكبر من صفر');
        const dayOfMonth = data.dayOfMonth === 'last' ? 'last'
          : Math.min(28, Math.max(1, Math.floor(Number(BeeStore.money.normalizeDigits(data.dayOfMonth)) || 1)));
        const startMonth = data.startMonth || null;
        const endMonth = data.endMonth || null;
        if (startMonth && !MONTH_RE.test(startMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر البداية غير صالح');
        if (endMonth && !MONTH_RE.test(endMonth)) throw BeeStore.errors.err('VALIDATION', 'شهر النهاية غير صالح');
        if (startMonth && endMonth && endMonth < startMonth) {
          throw BeeStore.errors.err('VALIDATION', 'شهر النهاية قبل شهر البداية');
        }
        const rec = {
          id: BeeStore.ids.randomId('rec'),
          categoryId: data.categoryId || null,
          amountMinor,
          dayOfMonth,
          description: data.description || '',
          method: data.method || 'cash',
          accountId: data.accountId || null,
          startMonth, endMonth,
          lastGeneratedMonth: null,
          effectiveFrom: null,
          active: data.active !== false,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('recurringExpenses', rec);
        return rec;
      });
    }

    /** Updates a recurring template from effectiveFrom; past records untouched (v2 §6.2).
     * @param {string} id template id
     * @param {Object} patch fields to merge
     * @param {string} [effectiveFrom] YYYY-MM start month
     * @returns {Promise<Object>} updated template
     * @throws {BeeError} NOT_FOUND|VALIDATION
     */
    // v2 §6.2: template edits apply from effectiveFrom; past records untouched.
    async updateRecurring(id, patch, effectiveFrom) {
      return this.repo.transaction(async (tx) => {
        const r = await tx.get('recurringExpenses', id);
        if (!r) throw BeeStore.errors.err('NOT_FOUND', 'المصروف المتكرر غير موجود');
        const from = effectiveFrom || BeeStore.dates.monthKey(BeeStore.dates.today());
        if (!MONTH_RE.test(from)) throw BeeStore.errors.err('VALIDATION', 'شهر السريان غير صالح');
        const { lastGeneratedMonth, ...safePatch } = patch || {};
        void lastGeneratedMonth;
        const updated = {
          ...r, ...safePatch, id,
          effectiveFrom: from,
          lastGeneratedMonth: r.lastGeneratedMonth,
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('recurringExpenses', updated);
        return updated;
      });
    }

    _recurringApplies(r, month) {
      if (!month || !MONTH_RE.test(month)) return false;
      const start = r.startMonth || r.effectiveFrom || '0000-00';
      if (month < start) return false;
      if (r.endMonth && month > r.endMonth) return false;
      return true;
    }

    /** Generates recurring expenses for a month, idempotent per (recurringId, month) (v2 §6.2).
     * @param {string} [month] YYYY-MM target month
     * @returns {Promise<Array>} newly created expenses
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED
     */
    async generateRecurring(month) {
      return this.repo.transaction(async (tx) => {
        const ym = month || BeeStore.dates.monthKey(BeeStore.dates.today());
        if (!MONTH_RE.test(ym)) throw BeeStore.errors.err('VALIDATION', 'الشهر غير صالح: ' + ym);
        const recurring = await tx.list('recurringExpenses', r => r.active !== false);
        const created = [];
        // Idempotent on (recurringId, month) — v2 §6.2.
        const existing = await tx.list('expenses',
          e => !e.voided && e.recurringId && (e.month === ym || String(e.date).startsWith(ym)));
        const existingIds = new Set(existing.map(e => e.recurringId));
        const settings = await tx.get('meta', 'settings') || {};
        const categories = await tx.list('expenseCategories');
        const catMap = {};
        for (const c of categories) catMap[c.id] = c.name;
        const dim = BeeStore.dates.daysInMonth(ym);
        for (const r of recurring) {
          if (existingIds.has(r.id)) continue;
          if (!this._recurringApplies(r, ym)) continue;
          const day = r.dayOfMonth === 'last' ? dim : Math.min(Number(r.dayOfMonth) || 1, dim);
          const date = ym + '-' + String(day).padStart(2, '0');
          const method = r.method || 'cash';
          const accountId = r.accountId || BeeStore.settings.resolvePaymentAccount(settings, method);
          const methodKind = BeeStore.settings.methodKind(settings, method);
          await BeeStore.periods.assertOpen(tx, date);
          await BeeStore.periods.assertCashDayOpen(tx, date, accountId);
          const expense = {
            id: BeeStore.ids.randomId('exp'),
            date,
            month: ym,
            categoryId: r.categoryId,
            categoryName: (r.categoryId ? catMap[r.categoryId] : '') || r.description || 'دوري',
            amountMinor: r.amountMinor,
            method,
            methodKind,
            accountId,
            payee: '',
            payeeSupplierId: null,
            dueDate: null,
            paymentStatus: 'paid',
            initialPaidMinor: r.amountMinor,
            paidMinor: r.amountMinor,
            description: r.description || '',
            recurringId: r.id,
            allocation: { mode: 'single' },
            voided: false,
            voidReason: null,
            time: BeeStore.dates.nowTime(),
            createdAt: BeeStore.dates.now(),
            updatedAt: BeeStore.dates.now(),
          };
          tx.put('expenses', expense);
          if (BeeStore.posting) {
            const entries = await BeeStore.posting.expense(tx, expense);
            if (entries.length > 0) {
              BeeStore.posting.linkAll([expense], entries);
              tx.put('expenses', expense);
            }
          }
          created.push(expense);
          r.lastGeneratedMonth = (!r.lastGeneratedMonth || ym > r.lastGeneratedMonth) ? ym : r.lastGeneratedMonth;
          r.updatedAt = BeeStore.dates.now();
          tx.put('recurringExpenses', r);
        }
        return created;
      });
    }
  }

  BeeStore.expenses = new ExpensesService(null);
  BeeStore.ExpensesService = ExpensesService;
  BeeStore.DEFAULT_EXPENSE_CATEGORIES = DEFAULT_CATEGORIES;
  if (typeof module !== 'undefined') module.exports = ExpensesService;
})(typeof window !== 'undefined' ? window : globalThis);
