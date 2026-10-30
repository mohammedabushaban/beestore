(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  class SettlementsService {
    constructor(repo) {
      this.repo = repo;
    }

    async list(filters) {
      filters = filters || {};
      const rows = (filters.from || filters.to)
        ? await this.repo.listRange('cardSettlements', filters.from, filters.to)
        : await this.repo.list('cardSettlements');
      return rows
        .filter(row => !filters.method || row.method === filters.method)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) ||
          String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    async get(id) {
      return this.repo.get('cardSettlements', id);
    }

    async quote(method, options) {
      options = options || {};
      if (BeeStore.chart && BeeStore.chart.ensureSeeded) {
        await BeeStore.chart.ensureSeeded();
      }
      return this._quote(this.repo, method, options.date || BeeStore.dates.today(),
        options.grossMinor, options.feeMinor);
    }

    async _quote(reader, method, date, requestedGross, actualFee) {
      const settings = (await reader.get('meta', 'settings')) || {};
      const definition = BeeStore.settings.paymentMethod(settings, method);
      if (!definition || definition.kind !== 'clearing') {
        throw BeeStore.errors.err('VALIDATION', 'طريقة الدفع ليست بطاقة أو محفظة تسوية');
      }
      const chart = await reader.list('chartOfAccounts');
      const clearing = chart.find(a => a.id === definition.chartAccountId) ||
        chart.find(a => a.paymentMethodId === method);
      if (!clearing) {
        throw BeeStore.errors.err('VALIDATION', 'حساب التسوية غير موجود لطريقة الدفع');
      }

      const entries = await reader.listRange('journalEntries', undefined, date);
      let unsettledMinor = 0;
      for (const entry of entries) {
        for (const line of (entry.lines || [])) {
          if (line.accountId !== clearing.id) continue;
          unsettledMinor += round(line.debitMinor) - round(line.creditMinor);
        }
      }

      const receipts = [];
      const sales = await reader.listRange('sales', undefined, date,
        sale => sale.status !== 'void');
      for (const sale of sales) {
        const payments = sale.payments || [];
        for (let index = 0; index < payments.length; index++) {
          const payment = payments[index];
          const paymentDate = payment.date || sale.date;
          if (payment.method !== method || payment.methodKind !== 'clearing' ||
            !paymentDate || paymentDate > date) continue;
          const amount = round(payment.amountMinor);
          if (amount <= 0) continue;
          receipts.push({
            sourceType: 'SALE', sourceId: sale.id, paymentIndex: index,
            number: sale.number || '', date: paymentDate,
            createdAt: sale.createdAt || '', grossMinor: amount,
            remainingMinor: amount,
          });
        }
      }
      const collections = await reader.listRange('customerPayments', undefined, date);
      for (const payment of collections) {
        if (payment.method !== method || payment.methodKind !== 'clearing' ||
          !payment.date || payment.date > date) continue;
        const amount = round(payment.amountMinor);
        if (amount <= 0) continue;
        receipts.push({
          sourceType: 'CUSTOMER_PAYMENT', sourceId: payment.id, paymentIndex: 0,
          number: '', date: payment.date, createdAt: payment.createdAt || '',
          grossMinor: amount, remainingMinor: amount,
        });
      }
      receipts.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.createdAt).localeCompare(String(b.createdAt)) ||
        String(a.sourceId).localeCompare(String(b.sourceId)) ||
        a.paymentIndex - b.paymentIndex);

      const consume = (amount, sourceId) => {
        let remaining = Math.max(0, round(amount));
        const targeted = sourceId
          ? receipts.filter(receipt => receipt.sourceId === sourceId && receipt.remainingMinor > 0)
          : [];
        const ordered = targeted.concat(receipts.filter(receipt =>
          receipt.remainingMinor > 0 && targeted.indexOf(receipt) < 0));
        for (const receipt of ordered) {
          if (remaining <= 0) break;
          const applied = Math.min(remaining, receipt.remainingMinor);
          receipt.remainingMinor -= applied;
          remaining -= applied;
        }
      };

      const refunds = await reader.listRange('salesReturns', undefined, date);
      for (const ret of refunds) {
        if (ret.refundMode === 'cash_refund' && ret.refundPaymentMethod === method &&
          ret.refundMethodKind === 'clearing') {
          consume(ret.refundMinor, ret.saleId);
        }
      }
      const settlements = await reader.listRange('cardSettlements', undefined, date,
        doc => !doc.voided && doc.method === method);
      settlements.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      for (const settlement of settlements) consume(settlement.grossMinor);

      const outstanding = receipts.filter(receipt => receipt.remainingMinor > 0);
      const subledgerMinor = outstanding.reduce((sum, receipt) => sum + receipt.remainingMinor, 0);
      const grossMinor = requestedGross === undefined || requestedGross === null
        ? Math.max(0, unsettledMinor)
        : Math.max(0, round(requestedGross));
      let selectionRemaining = grossMinor;
      let expectedFeeMinor = 0;
      for (const receipt of outstanding) {
        if (selectionRemaining <= 0) break;
        const included = Math.min(selectionRemaining, receipt.remainingMinor);
        expectedFeeMinor += BeeStore.settings.expectedFee(settings, method, included).feeMinor;
        selectionRemaining -= included;
      }
      const actualFeeMinor = actualFee === undefined || actualFee === null
        ? null : Math.max(0, round(actualFee));
      return {
        method,
        methodName: definition.name,
        date,
        clearingAccountId: clearing.id,
        unsettledMinor,
        subledgerMinor,
        reconciled: unsettledMinor === subledgerMinor,
        grossMinor,
        expectedFeeMinor,
        suggestedNetMinor: grossMinor - expectedFeeMinor,
        actualFeeMinor,
        feeDifferenceMinor: actualFeeMinor === null ? null : actualFeeMinor - expectedFeeMinor,
        receipts: outstanding.map(receipt => ({
          sourceType: receipt.sourceType,
          sourceId: receipt.sourceId,
          number: receipt.number,
          date: receipt.date,
          grossMinor: receipt.grossMinor,
          remainingMinor: receipt.remainingMinor,
          ageDays: Math.max(0, BeeStore.dates.diffDays(receipt.date, date)),
        })),
      };
    }

    async create(data) {
      const settlement = await this.repo.transaction(async (tx) => {
        const date = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, date);
        await BeeStore.periods.assertDayOpen(tx, date);
        const grossMinor = round(data.grossMinor);
        const feeMinor = round(data.feeMinor);
        const netReceivedMinor = round(data.netReceivedMinor);
        if (grossMinor <= 0 || feeMinor < 0 || netReceivedMinor < 0) {
          throw BeeStore.errors.err('VALIDATION', 'أدخل مبالغ تسوية صحيحة');
        }
        if (grossMinor !== feeMinor + netReceivedMinor) {
          throw BeeStore.errors.err('UNBALANCED_SETTLEMENT',
            'إجمالي التسوية يجب أن يساوي العمولة + الصافي المستلم');
        }
        const settings = (await tx.get('meta', 'settings')) || {};
        const definition = BeeStore.settings.paymentMethod(settings, data.method);
        if (!definition || definition.kind !== 'clearing') {
          throw BeeStore.errors.err('VALIDATION', 'اختر بطاقة أو محفظة تسوية');
        }
        const bank = await tx.get('accounts', data.bankAccountId);
        if (!bank || bank.type !== 'bank' || bank.active === false) {
          throw BeeStore.errors.err('VALIDATION', 'اختر حساباً بنكياً فعالاً لاستلام صافي التسوية');
        }

        const quote = await this._quote(tx, data.method, date, grossMinor, feeMinor);
        const overSettled = grossMinor > Math.max(0, quote.unsettledMinor);
        if (overSettled) {
          const profile = BeeStore.auth && BeeStore.auth.profile
            ? BeeStore.auth.profile() : data.createdByProfile;
          if (data.overSettlementFlag !== 'OVER_SETTLED' || profile !== 'owner') {
            throw BeeStore.errors.err('OVER_SETTLED',
              'قيمة التسوية تتجاوز الرصيد غير المسوّى وتتطلب تأكيد المالك');
          }
        }

        const number = 'SET-' + String(await tx.nextCounter('cardSettlement')).padStart(6, '0');
        const doc = {
          id: BeeStore.ids.randomId('set'),
          number,
          method: data.method,
          methodName: definition.name,
          date,
          time: data.time || BeeStore.dates.nowTime(),
          grossMinor,
          feeMinor,
          netReceivedMinor,
          expectedFeeMinor: quote.expectedFeeMinor,
          feeDifferenceMinor: feeMinor - quote.expectedFeeMinor,
          bankAccountId: bank.id,
          reference: (data.reference || '').trim(),
          note: (data.note || '').trim(),
          overSettled,
          overSettlementFlag: overSettled ? 'OVER_SETTLED' : null,
          createdByProfile: BeeStore.auth && BeeStore.auth.profile
            ? BeeStore.auth.profile() : (data.createdByProfile || null),
          voided: false,
          voidReason: null,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('cardSettlements', doc);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.cardSettlement(tx, doc);
          if (entry) {
            BeeStore.posting.link(doc, entry);
            tx.put('cardSettlements', doc);
          }
        }
        return doc;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('settlement', 'card', settlement.id,
          'تسوية ' + settlement.number + ' بمبلغ ' + settlement.grossMinor +
          ' وعمولة ' + settlement.feeMinor);
      }
      return settlement;
    }

    async void(id, reason) {
      const settlement = await this.repo.transaction(async (tx) => {
        const doc = await tx.get('cardSettlements', id);
        if (!doc) throw BeeStore.errors.err('NOT_FOUND', 'التسوية غير موجودة');
        if (doc.voided) throw BeeStore.errors.err('ALREADY_VOID', 'التسوية ملغاة مسبقاً');
        await BeeStore.periods.assertOpen(tx, doc.date);
        await BeeStore.periods.assertOpen(tx, BeeStore.dates.today());
        await BeeStore.periods.assertDayOpen(tx, doc.date);
        if (BeeStore.posting) {
          const reversals = await BeeStore.posting.reverseDocument(
            tx, 'CARD_SETTLEMENT', doc.id,
            { description: 'إلغاء تسوية ' + doc.number, reason: reason || '' },
            { allowClosedDay: false });
          if (reversals.length > 0) BeeStore.posting.linkAll([doc], reversals);
        }
        doc.voided = true;
        doc.voidReason = reason || '';
        doc.voidedAt = BeeStore.dates.now();
        doc.updatedAt = BeeStore.dates.now();
        tx.put('cardSettlements', doc);
        return doc;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('void', 'card_settlement', settlement.id,
          'إلغاء تسوية ' + settlement.number + (reason ? ' — ' + reason : ''));
      }
      return settlement;
    }

    async overview(date) {
      const asOf = date || BeeStore.dates.today();
      const settings = await BeeStore.settings.get();
      const methods = (settings.paymentMethods || [])
        .filter(method => BeeStore.settings.methodKind(settings, method.id) === 'clearing');
      const rows = [];
      for (const method of methods) {
        const quote = await this.quote(method.id, { date: asOf });
        const month = asOf.slice(0, 7);
        const settlements = await this.repo.listRange('cardSettlements', month + '-01',
          BeeStore.dates.monthRange(month).to,
          doc => !doc.voided && doc.method === method.id);
        const feesMonthMinor = settlements.reduce((sum, doc) => sum + round(doc.feeMinor), 0);
        const expectedFeesMonthMinor = settlements.reduce((sum, doc) => sum + round(doc.expectedFeeMinor), 0);
        const settledMonthMinor = settlements.reduce((sum, doc) => sum + round(doc.grossMinor), 0);
        rows.push({
          ...quote,
          feesMonthMinor,
          expectedFeesMonthMinor,
          feeDifferenceMonthMinor: feesMonthMinor - expectedFeesMonthMinor,
          settledMonthMinor,
          effectiveFeeBasisPoints: settledMonthMinor > 0
            ? Math.round(feesMonthMinor * 10000 / settledMonthMinor) : 0,
        });
      }
      return { date: asOf, methods: rows };
    }
  }

  BeeStore.settlements = new SettlementsService(null);
  BeeStore.SettlementsService = SettlementsService;
  if (typeof module !== 'undefined') module.exports = SettlementsService;
})(typeof window !== 'undefined' ? window : globalThis);
