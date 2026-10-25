(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function roundMinor(v) { return BeeStore.money.roundMinor(v); }
  function dayOf(v) { return v ? String(v).slice(0, 10) : ''; }
  function addTo(map, key, amount) {
    if (!key || !amount) return;
    map[key] = (map[key] || 0) + amount;
  }
  function cleanMap(map) {
    const out = {};
    for (const key of Object.keys(map || {})) {
      const value = roundMinor(map[key]);
      if (value) out[key] = value;
    }
    return out;
  }

  /**
   * v3-Lite §4: daily cash control on top of the monthly accounting periods.
   * A closing freezes the day's figures, reconciles the cash drawer, and
   * creates the adjustment/transfer/withdrawal documents atomically.
   */
  class DailyClosingService {
    constructor(repo) {
      this.repo = repo;
    }

    _validateDate(date) {
      if (!DATE_RE.test(String(date || ''))) {
        throw BeeStore.errors.err('VALIDATION', 'تاريخ اليوم غير صالح: ' + date);
      }
      return String(date);
    }

    _reader(tx) { return tx || this.repo; }

    async _resolveAccounts(reader) {
      const settings = (await reader.get('meta', 'settings')) || {};
      const accounts = await reader.list('accounts');
      let drawerId = settings.cashDrawerAccountId;
      let drawer = accounts.find(a => a.id === drawerId && a.active !== false);
      if (!drawer) drawer = accounts.find(a => a.type === 'cash' && a.active !== false) ||
        accounts.find(a => a.type === 'cash');
      let bankId = settings.defaultBankAccountId;
      let bank = accounts.find(a => a.id === bankId && a.active !== false);
      if (!bank) bank = accounts.find(a => a.type === 'bank' && a.active !== false) ||
        accounts.find(a => a.type === 'bank');
      return {
        settings,
        accounts,
        drawer: drawer ? drawer.id : null,
        drawerName: drawer ? drawer.name : '',
        bank: bank ? bank.id : null,
        bankName: bank ? bank.name : '',
      };
    }

    _methodForAccount(settings, accountId, drawerId) {
      // Refund documents store an account, not a payment-method id.
      if (drawerId && accountId === drawerId) return 'cash';
      const methods = (settings && settings.paymentMethods) || [];
      const found = methods.find(m => m.accountId && m.accountId === accountId);
      return found ? found.id : (accountId || 'cash');
    }

    _activityCollections() {
      return [
        'sales', 'salesReturns', 'customerPayments', 'supplierPayments',
        'purchases', 'purchaseReturns', 'expenses', 'employeeAdvances',
        'ownerTransactions', 'transfers',
      ];
    }

    async _activityDates(reader, from, to) {
      const dates = new Set();
      for (const coll of this._activityCollections()) {
        const docs = await reader.listRange(coll, from, to);
        for (const doc of docs) {
          if (doc.voided) continue;
          if (doc.status === 'void') continue;
          const d = dayOf(doc.date);
          if (d && d >= from && d <= to) dates.add(d);
        }
      }
      return Array.from(dates).sort();
    }

    async _isMonthClosed(reader, date) {
      const month = String(date).slice(0, 7);
      const rows = await reader.list('periodClosings',
        c => c.month === month && c.status === 'closed');
      return rows.length > 0;
    }

    async _assertCloseOrder(tx, date) {
      const closed = (await tx.list('dailyClosings', c => c.status === 'closed'))
        .map(c => c.date)
        .filter(Boolean)
        .sort();
      if (closed.indexOf(date) >= 0) {
        throw BeeStore.errors.err('CONFLICT', 'يوم ' + date + ' مُقفل مسبقاً');
      }
      const later = closed.filter(d => d > date);
      if (later.length > 0) {
        throw BeeStore.errors.err('CONFLICT',
          'لا يمكن إقفال يوم أقدم بعد إقفال يوم أحدث (' + later[0] + ') — أعد فتح الأيام الأحدث أولاً');
      }
      // Bootstrapping: before the first daily closing ever, only the current
      // month is checked so owners adopting L4 are not forced to catch up on
      // years of legacy data. After that, every active day since the latest
      // closing is checked, across month boundaries.
      const latest = closed.length ? closed[closed.length - 1] : null;
      const from = latest ? BeeStore.dates.addDays(latest, 1)
        : BeeStore.dates.startOfMonth(date);
      const to = BeeStore.dates.addDays(date, -1);
      if (from > to) return;
      const closedSet = new Set(closed);
      const active = (await this._activityDates(tx, from, to))
        .filter(d => !closedSet.has(d));
      if (active.length > 0) {
        throw BeeStore.errors.err('CONFLICT',
          'أقفل الأيام السابقة أولاً (يمكن الإقفال بدون جرد): ' + active.join('، '));
      }
    }

    async _latestClosedDate(reader) {
      const rows = await reader.list('dailyClosings', c => c.status === 'closed');
      const dates = rows.map(c => c.date).filter(Boolean).sort();
      return dates.length ? dates[dates.length - 1] : null;
    }

    /**
     * Computes every figure needed by the wizard and Day Report.
     * Expected cash comes from the cash-drawer account balance at the end of
     * the day (derived from all documents), which is exactly opening + cash
     * inflows − cash outflows. Closing's own generated documents are excluded
     * while a day is being prepared/reopened.
     */
    async _figures(reader, date, options) {
      const opts = options || {};
      const acc = await this._resolveAccounts(reader);
      if (!acc.drawer) {
        throw BeeStore.errors.err('VALIDATION',
          'لا يوجد حساب صندوق. أنشئ حساباً نقدياً من صفحة الحسابات ثم أعد المحاولة');
      }
      const previous = BeeStore.dates.addDays(date, -1);
      const opening = await BeeStore.accounts.balanceAsOf(acc.drawer, previous);
      const expectedBook = await BeeStore.accounts.balanceAsOf(acc.drawer, date);

      const load = async (coll) => {
        const docs = await reader.listRange(coll, date, date);
        return docs.filter(d => !opts.excludeClosingId || d.closingId !== opts.excludeClosingId);
      };
      const sales = (await load('sales')).filter(s => s.status !== 'void');
      const returns = await load('salesReturns');
      const collections = await load('customerPayments');
      const supplierPayments = await load('supplierPayments');
      const expenses = (await load('expenses')).filter(e => !e.voided);
      const purchases = (await load('purchases')).filter(p => p.status !== 'void');
      const purchaseReturns = (await load('purchaseReturns')).filter(r => !r.voided);
      const advances = await load('employeeAdvances');
      const ownerTx = (await load('ownerTransactions')).filter(t => !t.voided);
      const transfers = (await load('transfers')).filter(t => !t.voided);
      const adjustments = (await load('cashAdjustments')).filter(a => !a.voided);
      const settings = acc.settings;

      const salesByMethod = {};
      let totalSalesMinor = 0;
      let cashSalesMinor = 0;
      for (const sale of sales) {
        totalSalesMinor += Number(sale.totalMinor) || 0;
        for (const p of (sale.payments || [])) {
          const amount = Number(p.amountMinor) || 0;
          if (amount <= 0) continue;
          // The report groups the invoice's payments by method. Expected cash
          // only counts payments actually dated this day.
          addTo(salesByMethod, p.method || 'cash', amount);
          if ((p.date || sale.date) === date && p.accountId === acc.drawer) {
            cashSalesMinor += amount;
          }
        }
      }

      let returnsCashRefundMinor = 0;
      for (const r of returns) {
        if (r.refundMode !== 'cash_refund') continue;
        const amount = Number(r.refundMinor) || 0;
        // §4.1: salesByMethod is net of refunds by method. The drawer-line
        // refund total only includes money actually paid from the drawer.
        if (!r.refundMethod || r.refundMethod === acc.drawer) {
          returnsCashRefundMinor += amount;
        }
        const method = this._methodForAccount(settings, r.refundMethod, acc.drawer);
        addTo(salesByMethod, method, -amount);
      }
      for (const key of Object.keys(salesByMethod)) {
        if (!salesByMethod[key]) delete salesByMethod[key];
      }

      const collectionsByMethod = {};
      let collectionsCashMinor = 0;
      for (const p of collections) {
        const amount = Number(p.amountMinor) || 0;
        addTo(collectionsByMethod, p.method || 'cash', amount);
        if (p.accountId === acc.drawer) collectionsCashMinor += amount;
      }

      let supplierCashPaymentsMinor = 0;
      for (const p of supplierPayments) {
        if (p.accountId === acc.drawer) supplierCashPaymentsMinor += Number(p.amountMinor) || 0;
      }
      for (const p of purchases) {
        for (const pay of (p.payments || [])) {
          if ((pay.date || p.date) === date && pay.accountId === acc.drawer) {
            supplierCashPaymentsMinor += Number(pay.amountMinor) || 0;
          }
        }
      }

      let cashExpensesMinor = 0;
      for (const e of expenses) {
        if (e.accountId === acc.drawer) cashExpensesMinor += Number(e.amountMinor) || 0;
      }

      let cashInOtherMinor = 0;
      let cashOutOtherMinor = 0;
      for (const r of purchaseReturns) {
        if (r.mode === 'cash_refund' && r.accountId === acc.drawer) {
          cashInOtherMinor += Number(r.totalMinor) || 0;
        }
      }
      for (const t of ownerTx) {
        if (t.accountId !== acc.drawer) continue;
        if (t.type === 'capital_in') cashInOtherMinor += Number(t.amountMinor) || 0;
        else cashOutOtherMinor += Number(t.amountMinor) || 0;
      }
      for (const t of transfers) {
        if (t.fromAccountId === acc.drawer) cashOutOtherMinor += Number(t.amountMinor) || 0;
        if (t.toAccountId === acc.drawer) cashInOtherMinor += Number(t.amountMinor) || 0;
      }
      for (const a of advances) {
        if (a.accountId === acc.drawer) cashOutOtherMinor += Number(a.amountMinor) || 0;
      }
      for (const a of adjustments) {
        const amount = Number(a.amountMinor) || 0;
        if (a.accountId !== acc.drawer) continue;
        if (amount >= 0) cashInOtherMinor += amount;
        else cashOutOtherMinor += -amount;
      }

      // Any movement not covered above (e.g. a sale-time payment dated apart
      // from the invoice) is folded into "other" so the printed reconciliation
      // always adds up to the ledger's expected cash.
      const computed = opening + cashSalesMinor + collectionsCashMinor +
        cashInOtherMinor - returnsCashRefundMinor - supplierCashPaymentsMinor -
        cashExpensesMinor - cashOutOtherMinor;
      const residual = expectedBook - computed;
      if (residual > 0) cashInOtherMinor += residual;
      else if (residual < 0) cashOutOtherMinor += -residual;

      const externalTotals = {};
      for (const key of Object.keys(opts.externalTotals || {})) {
        externalTotals[key] = roundMinor(opts.externalTotals[key]);
      }
      const externalDifferences = {};
      for (const key of Object.keys(externalTotals)) {
        const recorded = (salesByMethod[key] || 0) + (collectionsByMethod[key] || 0);
        const diff = externalTotals[key] - recorded;
        if (diff !== 0) externalDifferences[key] = diff;
      }

      return {
        date,
        status: 'open',
        cashDrawerAccountId: acc.drawer,
        cashDrawerAccountName: acc.drawerName,
        bankAccountId: acc.bank,
        bankAccountName: acc.bankName,
        openingCashMinor: roundMinor(opening),
        salesByMethod: cleanMap(salesByMethod),
        invoicesCount: sales.length,
        totalSalesMinor: roundMinor(totalSalesMinor),
        averageInvoiceMinor: sales.length ? Math.round(totalSalesMinor / sales.length) : 0,
        returnsCashRefundMinor: roundMinor(returnsCashRefundMinor),
        customerCollectionsByMethod: cleanMap(collectionsByMethod),
        supplierCashPaymentsMinor: roundMinor(supplierCashPaymentsMinor),
        cashExpensesMinor: roundMinor(cashExpensesMinor),
        cashSalesMinor: roundMinor(cashSalesMinor),
        customerCollectionsCashMinor: roundMinor(collectionsCashMinor),
        cashInOtherMinor: roundMinor(cashInOtherMinor),
        cashOutOtherMinor: roundMinor(cashOutOtherMinor),
        expectedCashMinor: roundMinor(expectedBook),
        countedCashMinor: null,
        differenceMinor: 0,
        externalTotals: cleanMap(externalTotals),
        externalDifferences: cleanMap(externalDifferences),
        takenOutMinor: 0,
        takenOutMode: 'none',
        retainedFloatMinor: null,
        noCount: false,
        note: '',
      };
    }

    /**
     * Live preview for the closing wizard. A closed day returns its frozen
     * snapshot instead of recalculating (the closing's own records would
     * otherwise disturb the expected cash).
     * @param {string} date YYYY-MM-DD
     * @returns {Promise<object>} figures
     */
    async preview(date) {
      const d = this._validateDate(date);
      const existing = await this.get(d);
      if (existing && existing.status === 'closed') return { ...existing, status: 'closed' };
      return this._figures(this.repo, d, {});
    }

    /**
     * Returns the most recent dailyClosings record for a date (closed or
     * reopened), or null.
     * @param {string} date YYYY-MM-DD
     * @returns {Promise<object|null>}
     */
    async get(date) {
      const d = this._validateDate(date);
      const rows = await this.repo.list('dailyClosings', c => c.date === d);
      return rows.length ? rows[0] : null;
    }

    /**
     * Daily closings in a range, newest first.
     * @param {string} [from]
     * @param {string} [to]
     * @returns {Promise<Array>}
     */
    async list(from, to) {
      const rows = (from || to)
        ? await this.repo.listRange('dailyClosings', from, to)
        : await this.repo.list('dailyClosings');
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return rows;
    }

    /**
     * Closes one business day in a single transaction. The month must be
     * open; earlier active days must already be closed. Cash difference,
     * bank transfer / owner withdrawal, audit, and the snapshot all commit
     * together or not at all.
     * @param {object} data {date,countedCashMinor,denominationsCount,
     *   externalTotals,takenOutMinor,takenOutMode,bankAccountId,noCount,note}
     * @returns {Promise<object>} the closed record
     */
    async close(data) {
      const d = this._validateDate(data && data.date);
      const noCount = !!(data && data.noCount);
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, d);
        const existing = (await tx.list('dailyClosings', c => c.date === d))[0] || null;
        if (existing && existing.status === 'closed') {
          throw BeeStore.errors.err('CONFLICT', 'يوم ' + d + ' مُقفل مسبقاً');
        }
        await this._assertCloseOrder(tx, d);

        const figures = await this._figures(tx, d, {
          externalTotals: data.externalTotals || {},
          excludeClosingId: existing ? existing.id : null,
        });
        let counted;
        if (noCount) {
          counted = figures.expectedCashMinor;
        } else {
          if (data.countedCashMinor === undefined || data.countedCashMinor === null ||
            data.countedCashMinor === '') {
            throw BeeStore.errors.err('VALIDATION', 'أدخل النقد المعدود أو اختر «إقفال بدون جرد»');
          }
          counted = roundMinor(data.countedCashMinor);
        }
        if (counted < 0) throw BeeStore.errors.err('VALIDATION', 'النقد المعدود لا يمكن أن يكون سالباً');
        const difference = counted - figures.expectedCashMinor;
        const takenOutMode = data.takenOutMode || 'none';
        if (['none', 'bank_deposit', 'owner_withdrawal'].indexOf(takenOutMode) < 0) {
          throw BeeStore.errors.err('VALIDATION', 'طريقة إخراج النقد غير صالحة');
        }
        const takenOut = roundMinor(data.takenOutMinor || 0);
        if (takenOut < 0) throw BeeStore.errors.err('VALIDATION', 'المبلغ المُخرج لا يمكن أن يكون سالباً');
        if (takenOut > counted) {
          throw BeeStore.errors.err('VALIDATION', 'المبلغ المُخرج يتجاوز النقد المعدود');
        }
        if (takenOut > 0 && takenOutMode === 'none') {
          throw BeeStore.errors.err('VALIDATION', 'اختر «إيداع بالبنك» أو «سحب شخصي» عند إخراج نقد');
        }
        if (takenOutMode === 'bank_deposit' && !figures.bankAccountId) {
          throw BeeStore.errors.err('VALIDATION', 'لا يوجد حساب بنكي. أضف حساباً بنكياً أو اختر «بدون»');
        }

        const now = BeeStore.dates.now();
        const closingId = existing ? existing.id : BeeStore.ids.randomId('clo');
        const generated = [];
        if (difference !== 0) {
          const adj = {
            id: BeeStore.ids.randomId('cad'),
            date: d,
            accountId: figures.cashDrawerAccountId,
            amountMinor: roundMinor(difference),
            sourceType: 'cash_difference',
            closingId,
            voided: false,
            note: difference < 0 ? 'نقص صندوق إغلاق ' + d : 'زيادة صندوق إغلاق ' + d,
            createdAt: now,
            updatedAt: now,
          };
          tx.put('cashAdjustments', adj);
          generated.push(adj.id);
        }
        if (takenOut > 0 && takenOutMode === 'bank_deposit') {
          const transfer = {
            id: BeeStore.ids.randomId('trf'),
            date: d,
            fromAccountId: figures.cashDrawerAccountId,
            toAccountId: data.bankAccountId || figures.bankAccountId,
            amountMinor: takenOut,
            closingId,
            voided: false,
            note: 'إيداع نقد إغلاق يوم ' + d,
            createdAt: now,
            updatedAt: now,
          };
          tx.put('transfers', transfer);
          generated.push(transfer.id);
        } else if (takenOut > 0 && takenOutMode === 'owner_withdrawal') {
          const withdrawal = {
            id: BeeStore.ids.randomId('own'),
            date: d,
            type: 'withdrawal',
            amountMinor: takenOut,
            accountId: figures.cashDrawerAccountId,
            closingId,
            voided: false,
            note: 'سحب شخصي من إغلاق يوم ' + d,
            createdAt: now,
            updatedAt: now,
          };
          tx.put('ownerTransactions', withdrawal);
          generated.push(withdrawal.id);
        }

        const externalTotals = cleanMap(data.externalTotals || {});
        const externalDifferences = {};
        for (const key of Object.keys(externalTotals)) {
          const recorded = (figures.salesByMethod[key] || 0) +
            (figures.customerCollectionsByMethod[key] || 0);
          const diff = externalTotals[key] - recorded;
          if (diff !== 0) externalDifferences[key] = diff;
        }

        const record = {
          ...(existing || {}),
          id: closingId,
          date: d,
          status: 'closed',
          openingCashMinor: figures.openingCashMinor,
          salesByMethod: figures.salesByMethod,
          invoicesCount: figures.invoicesCount,
          totalSalesMinor: figures.totalSalesMinor,
          averageInvoiceMinor: figures.averageInvoiceMinor,
          returnsCashRefundMinor: figures.returnsCashRefundMinor,
          customerCollectionsByMethod: figures.customerCollectionsByMethod,
          supplierCashPaymentsMinor: figures.supplierCashPaymentsMinor,
          cashExpensesMinor: figures.cashExpensesMinor,
          cashSalesMinor: figures.cashSalesMinor,
          customerCollectionsCashMinor: figures.customerCollectionsCashMinor,
          cashInOtherMinor: figures.cashInOtherMinor,
          cashOutOtherMinor: figures.cashOutOtherMinor,
          expectedCashMinor: figures.expectedCashMinor,
          countedCashMinor: roundMinor(counted),
          differenceMinor: roundMinor(difference),
          denominationsCount: data.denominationsCount || null,
          externalTotals: externalTotals,
          externalDifferences: externalDifferences,
          takenOutMinor: takenOut,
          takenOutMode,
          retainedFloatMinor: roundMinor(counted - takenOut),
          noCount,
          note: data.note || '',
          closedAt: now,
          closedBy: data.closedBy || null,
          generatedRecordIds: generated,
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        };
        tx.put('dailyClosings', record);
        tx.put('auditLog', {
          id: BeeStore.ids.randomId('aud'),
          timestamp: now,
          action: 'day_close',
          entityType: 'day',
          entityId: d,
          summary: 'إقفال يوم ' + d + ' — متوقع ' + figures.expectedCashMinor +
            '، معدود ' + counted + '، فرق ' + difference + (noCount ? ' (بدون جرد)' : ''),
        });
        return record;
      });
    }

    /**
     * Reopens only the most recent closed day, and only while its month is
     * open. Generated cash-adjustment/transfer/withdrawal records are
     * soft-voided (never deleted) and audited.
     * @param {string} date YYYY-MM-DD
     * @param {object} [options] {note}
     * @returns {Promise<object>} {record, voidedCount}
     */
    async reopen(date, options) {
      const d = this._validateDate(date);
      const opts = options || {};
      return this.repo.transaction(async (tx) => {
        const rows = await tx.list('dailyClosings', c => c.date === d);
        const rec = rows[0] || null;
        if (!rec || rec.status !== 'closed') {
          throw BeeStore.errors.err('NOT_FOUND', 'لا يوجد إغلاق مُقفل لهذا اليوم');
        }
        await BeeStore.periods.assertOpen(tx, d);
        const latest = await this._latestClosedDate(tx);
        if (latest !== d) {
          throw BeeStore.errors.err('CONFLICT',
            'يمكن إعادة فتح آخر يوم مُقفل فقط (' + (latest || '—') + ')');
        }
        const now = BeeStore.dates.now();
        let voidedCount = 0;
        for (const coll of ['cashAdjustments', 'transfers', 'ownerTransactions']) {
          const docs = await tx.list(coll, x => x.closingId === rec.id && !x.voided);
          for (const doc of docs) {
            doc.voided = true;
            doc.voidReason = 'إعادة فتح يوم ' + d + (opts.note ? ' - ' + opts.note : '');
            doc.voidedAt = now;
            doc.updatedAt = now;
            tx.put(coll, doc);
            voidedCount++;
          }
        }
        rec.status = 'reopened';
        rec.reopenedAt = now;
        rec.reopenHistory = rec.reopenHistory || [];
        rec.reopenHistory.push({ reopenedAt: now, note: opts.note || '', voidedCount });
        rec.updatedAt = now;
        tx.put('dailyClosings', rec);
        tx.put('auditLog', {
          id: BeeStore.ids.randomId('aud'),
          timestamp: now,
          action: 'day_reopen',
          entityType: 'day',
          entityId: d,
          summary: 'إعادة فتح يوم ' + d + ' — إلغاء ' + voidedCount + ' سجل مولّد' +
            (opts.note ? ' - ' + opts.note : ''),
        });
        return { record: rec, voidedCount };
      });
    }

    /**
     * Per-day rows for the Days page and Month Review. One indexed read per
     * collection for the whole month, not thirty separate scans.
     * @param {string} month YYYY-MM
     * @returns {Promise<{month:string,days:Array,counts:Object,totalDifferenceMinor:number}>}
     */
    async daysInMonth(month) {
      if (!MONTH_RE.test(String(month || ''))) {
        throw BeeStore.errors.err('VALIDATION', 'شهر غير صالح: ' + month);
      }
      const { from, to } = BeeStore.dates.monthRange(month);
      const acc = await this._resolveAccounts(this.repo);
      const settings = acc.settings;
      const closings = await this.repo.listRange('dailyClosings', from, to);
      const closeMap = {};
      for (const c of closings) closeMap[c.date] = c;

      const byDay = {};
      const ensure = (date) => {
        if (!byDay[date]) {
          byDay[date] = {
            date, salesMinor: 0, invoicesCount: 0, returnsMinor: 0,
            expensesMinor: 0, cashInMinor: 0, cashOutMinor: 0, activity: false,
          };
        }
        return byDay[date];
      };
      for (let i = 1; i <= BeeStore.dates.daysInMonth(month); i++) {
        ensure(month + '-' + BeeStore.dates.pad(i));
      }

      const sales = await this.repo.listRange('sales', from, to, s => s.status !== 'void');
      for (const s of sales) {
        const row = ensure(s.date);
        row.activity = true;
        row.salesMinor += Number(s.totalMinor) || 0;
        row.invoicesCount++;
        for (const p of (s.payments || [])) {
          if ((p.date || s.date) === s.date && p.accountId === acc.drawer) {
            row.cashInMinor += Number(p.amountMinor) || 0;
          }
        }
      }
      const returns = await this.repo.listRange('salesReturns', from, to);
      for (const r of returns) {
        const row = ensure(r.date);
        row.activity = true;
        row.returnsMinor += Number(r.refundMinor) || 0;
        if (r.refundMode === 'cash_refund' && r.refundMethod === acc.drawer) {
          row.cashOutMinor += Number(r.refundMinor) || 0;
        }
      }
      const expenses = await this.repo.listRange('expenses', from, to, e => !e.voided);
      for (const e of expenses) {
        const row = ensure(e.date);
        row.activity = true;
        row.expensesMinor += Number(e.amountMinor) || 0;
        if (e.accountId === acc.drawer) row.cashOutMinor += Number(e.amountMinor) || 0;
      }
      const collections = await this.repo.listRange('customerPayments', from, to);
      for (const p of collections) {
        const row = ensure(p.date);
        row.activity = true;
        if (p.accountId === acc.drawer) row.cashInMinor += Number(p.amountMinor) || 0;
      }
      const supplierPayments = await this.repo.listRange('supplierPayments', from, to);
      for (const p of supplierPayments) {
        const row = ensure(p.date);
        row.activity = true;
        if (p.accountId === acc.drawer) row.cashOutMinor += Number(p.amountMinor) || 0;
      }
      const purchases = await this.repo.listRange('purchases', from, to, p => p.status !== 'void');
      for (const p of purchases) {
        const row = ensure(p.date);
        row.activity = true;
        for (const pay of (p.payments || [])) {
          const pd = pay.date || p.date;
          if (pd !== p.date) continue;
          if (pay.accountId === acc.drawer) row.cashOutMinor += Number(pay.amountMinor) || 0;
        }
      }
      const purchaseReturns = await this.repo.listRange('purchaseReturns', from, to, r => !r.voided);
      for (const r of purchaseReturns) {
        const row = ensure(r.date);
        row.activity = true;
        if (r.mode === 'cash_refund' && r.accountId === acc.drawer) {
          row.cashInMinor += Number(r.totalMinor) || 0;
        }
      }
      const owner = await this.repo.listRange('ownerTransactions', from, to, t => !t.voided);
      for (const t of owner) {
        const row = ensure(t.date);
        row.activity = true;
        if (t.accountId === acc.drawer) {
          if (t.type === 'capital_in') row.cashInMinor += Number(t.amountMinor) || 0;
          else row.cashOutMinor += Number(t.amountMinor) || 0;
        }
      }
      const transfers = await this.repo.listRange('transfers', from, to, t => !t.voided);
      for (const t of transfers) {
        const row = ensure(t.date);
        row.activity = true;
        if (t.fromAccountId === acc.drawer) row.cashOutMinor += Number(t.amountMinor) || 0;
        if (t.toAccountId === acc.drawer) row.cashInMinor += Number(t.amountMinor) || 0;
      }
      const advances = await this.repo.listRange('employeeAdvances', from, to);
      for (const a of advances) {
        const row = ensure(a.date);
        row.activity = true;
        if (a.accountId === acc.drawer) row.cashOutMinor += Number(a.amountMinor) || 0;
      }
      const adjustments = await this.repo.listRange('cashAdjustments', from, to, a => !a.voided);
      for (const a of adjustments) {
        const row = ensure(a.date);
        row.activity = true;
        if (a.accountId !== acc.drawer) continue;
        if (a.amountMinor >= 0) row.cashInMinor += Number(a.amountMinor) || 0;
        else row.cashOutMinor += -Number(a.amountMinor);
      }

      const days = Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));
      let closedCount = 0;
      let totalDifferenceMinor = 0;
      for (const row of days) {
        const c = closeMap[row.date];
        row.status = c && c.status === 'closed' ? 'closed' : 'open';
        row.closingId = c ? c.id : null;
        row.differenceMinor = c && c.status === 'closed' ? c.differenceMinor || 0 : 0;
        row.expectedCashMinor = c && c.status === 'closed' ? c.expectedCashMinor || 0 : null;
        row.countedCashMinor = c && c.status === 'closed' ? c.countedCashMinor : null;
        row.noCount = !!(c && c.status === 'closed' && c.noCount);
        row.netCashMinor = row.cashInMinor - row.cashOutMinor;
        if (row.status === 'closed') {
          closedCount++;
          totalDifferenceMinor += row.differenceMinor;
        }
      }
      const activeDays = days.filter(d => d.activity);
      const unclosedActive = activeDays.filter(d => d.status !== 'closed').length;
      return {
        month, from, to, days,
        counts: {
          closed: closedCount,
          unclosed: days.length - closedCount,
          active: activeDays.length,
          unclosedActive,
          total: days.length,
        },
        totalDifferenceMinor: roundMinor(totalDifferenceMinor),
      };
    }

    /**
     * Days with activity but no closed record, newest first. Today is excluded:
     * it is normally still open and not a warning.
     * @param {object} [options] {days:30}
     * @returns {Promise<Array>}
     */
    async unclosedDays(options) {
      const opts = options || {};
      const span = Math.max(1, Math.min(366, Number(opts.days) || 30));
      const today = BeeStore.dates.today();
      const from = BeeStore.dates.addDays(today, -span);
      const to = BeeStore.dates.addDays(today, -1);
      const active = await this._activityDates(this.repo, from, to);
      const closed = new Set((await this.repo.list('dailyClosings',
        c => c.status === 'closed' && c.date >= from && c.date <= to)).map(c => c.date));
      const days = await this.daysInMonth(from.slice(0, 7));
      const rows = new Map(days.days.map(d => [d.date, d]));
      const out = [];
      for (const d of active) {
        if (closed.has(d)) continue;
        const row = rows.get(d) || {};
        out.push({
          date: d,
          salesMinor: row.salesMinor || 0,
          invoicesCount: row.invoicesCount || 0,
          expensesMinor: row.expensesMinor || 0,
        });
      }
      if (from.slice(0, 7) !== to.slice(0, 7)) {
        const second = await this.daysInMonth(to.slice(0, 7));
        for (const row of second.days) {
          if (!active.includes(row.date) || closed.has(row.date)) continue;
          if (out.some(x => x.date === row.date)) continue;
          out.push({
            date: row.date,
            salesMinor: row.salesMinor || 0,
            invoicesCount: row.invoicesCount || 0,
            expensesMinor: row.expensesMinor || 0,
          });
        }
      }
      out.sort((a, b) => b.date.localeCompare(a.date));
      return out;
    }

    /**
     * Compact status used by the dashboard.
     * @returns {Promise<object>} today/yesterday + unclosed warning list
     */
    async status() {
      const today = BeeStore.dates.today();
      const yesterday = BeeStore.dates.addDays(today, -1);
      const [todayRec, yRec, unclosed] = await Promise.all([
        this.get(today), this.get(yesterday), this.unclosedDays({ days: 30 }),
      ]);
      let todayData;
      if (todayRec && todayRec.status === 'closed') {
        todayData = { ...todayRec, status: 'closed' };
      } else {
        try { todayData = await this.preview(today); }
        catch (e) {
          todayData = { date: today, status: 'open', totalSalesMinor: 0, invoicesCount: 0, expectedCashMinor: 0 };
        }
      }
      let yData;
      if (yRec && yRec.status === 'closed') yData = { ...yRec, status: 'closed' };
      else {
        yData = {
          date: yesterday,
          status: 'open',
          differenceMinor: null,
          totalSalesMinor: 0,
          expectedCashMinor: null,
        };
      }
      return { today: todayData, yesterday: yData, unclosed };
    }

    /**
     * Printable/shareable Day Report. Closed days use their frozen figures;
     * open days show a live preview. Item/expense lists are read live.
     * @param {string} date YYYY-MM-DD
     * @returns {Promise<object>} report
     */
    async report(date) {
      const d = this._validateDate(date);
      const rec = await this.get(d);
      const closed = !!(rec && rec.status === 'closed');
      const figures = closed ? { ...rec, status: 'closed' } : await this._figures(this.repo, d, {});
      const settings = (await this.repo.get('meta', 'settings')) || {};

      const sales = await this.repo.listRange('sales', d, d, s => s.status !== 'void');
      const returns = await this.repo.listRange('salesReturns', d, d);
      const expenses = await this.repo.listRange('expenses', d, d, e => !e.voided);
      const topMap = {};
      let newCreditMinor = 0;
      const touchedVariantIds = new Set();
      for (const s of sales) {
        newCreditMinor += Number(s.dueMinor) || 0;
        for (const l of (s.lines || [])) {
          touchedVariantIds.add(l.variantId);
          const key = l.variantId;
          if (!topMap[key]) {
            topMap[key] = {
              variantId: key, productName: l.productName, size: l.size,
              color: l.color, qty: 0, revenueMinor: 0,
            };
          }
          topMap[key].qty += Number(l.qty) || 0;
          topMap[key].revenueMinor += Number(l.lineTotalMinor) || 0;
        }
      }
      const topItems = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

      const variants = await this.repo.list('variants');
      const threshold = Number(settings.defaultLowStockThreshold) || 3;
      const lowStock = variants.filter(v => touchedVariantIds.has(v.id) &&
        v.quantity <= (v.lowStockThreshold || threshold)).map(v => ({
        variantId: v.id, size: v.size, color: v.color, quantity: v.quantity,
      }));

      return {
        ...figures,
        date: d,
        status: closed ? 'closed' : 'open',
        noCount: closed ? !!rec.noCount : !!(figures.noCount),
        closedAt: closed ? rec.closedAt : null,
        note: closed ? (rec.note || '') : '',
        salesByMethod: figures.salesByMethod || {},
        invoicesCount: figures.invoicesCount || 0,
        totalSalesMinor: figures.totalSalesMinor || 0,
        averageInvoiceMinor: figures.averageInvoiceMinor || 0,
        returnsCashRefundMinor: figures.returnsCashRefundMinor || 0,
        expenses: expenses.map(e => ({
          id: e.id, description: e.description || e.categoryName || 'مصروف',
          amountMinor: e.amountMinor, method: e.method,
        })).sort((a, b) => b.amountMinor - a.amountMinor),
        returns: returns.map(r => ({
          id: r.id, number: r.number, refundMinor: r.refundMinor,
          refundMode: r.refundMode, reason: r.reason || '',
        })),
        topItems,
        lowStock,
        openCreditMinor: roundMinor(newCreditMinor),
        externalWarnings: Object.keys(figures.externalDifferences || {})
          .map(method => ({ method, differenceMinor: figures.externalDifferences[method] })),
      };
    }

    /**
     * Short WhatsApp-style Arabic text summary for sharing.
     * @param {object} report result of report(date)
     * @returns {string}
     */
    buildTextSummary(report) {
      const money = (v) => BeeStore.money.toMajor(v || 0);
      const lines = [];
      lines.push('تقرير يوم ' + report.date);
      lines.push('الحالة: ' + (report.status === 'closed' ? 'مُقفل' : 'مفتوح') +
        (report.noCount ? ' — بدون جرد نقدي' : ''));
      lines.push('المبيعات: ' + money(report.totalSalesMinor) + ' (' + report.invoicesCount + ' فاتورة)');
      const methods = Object.keys(report.salesByMethod || {});
      for (const m of methods) {
        const label = BeeStore.settings && BeeStore.settings.methodLabel
          ? BeeStore.settings.methodLabel({}, m) : m;
        lines.push('  ' + (label || m) + ': ' + money(report.salesByMethod[m]));
      }
      lines.push('المرتجعات النقدية: ' + money(report.returnsCashRefundMinor));
      lines.push('افتتاحي: ' + money(report.openingCashMinor) +
        ' | متوقع: ' + money(report.expectedCashMinor));
      if (report.status === 'closed') {
        lines.push('معدود: ' + money(report.countedCashMinor) +
          ' | فرق: ' + money(report.differenceMinor));
        lines.push('أُخرج: ' + money(report.takenOutMinor) +
          ' | الصندوق المتبقي: ' + money(report.retainedFloatMinor));
      }
      if (report.note) lines.push('ملاحظة: ' + report.note);
      return lines.join('\n');
    }
  }

  BeeStore.dailyClosing = new DailyClosingService(null);
  BeeStore.DailyClosingService = DailyClosingService;
  if (typeof module !== 'undefined') module.exports = DailyClosingService;
})(typeof window !== 'undefined' ? window : globalThis);
