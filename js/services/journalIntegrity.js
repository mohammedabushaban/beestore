(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * v5 §9 (A6) journal integrity checks. Read-only: never modifies data.
   *
   *  1. Journal invariants (`JournalService.verify`): balanced entries and
   *     months, gapless unique numbers, valid lines, exact reversals.
   *  2. Control accounts = party sub-ledgers inside the journal: AR, AP,
   *     customer credits, employee advances and accrued salaries carry a
   *     party on every line that leaves a balance.
   *  3. Journal party balances = document sub-ledgers (customers and
   *     suppliers), when the journal holds the full history.
   *  4. Document ↔ journal: every posted, non-void document has live
   *     entries; every voided document has none.
   *  5. Orphan entries: every entry's source document exists.
   *  6. Balances that must never go negative: cash drawer, inventory.
   *  7. Closed fiscal years: revenue and expense accounts are zero after the
   *     year-end closing entry.
   */

  // sourceType → collection holding the source document.
  const SOURCE_COLLECTIONS = {
    SALE: 'sales',
    SALE_RETURN: 'salesReturns',
    CUSTOMER_PAYMENT: 'customerPayments',
    CARD_SETTLEMENT: 'cardSettlements',
    PURCHASE: 'purchases',
    PURCHASE_RETURN: 'purchaseReturns',
    SUPPLIER_PAYMENT: 'supplierPayments',
    EXPENSE: 'expenses',
    EXPENSE_PAYMENT: 'expensePayments',
    PAYROLL: 'payroll',
    PAYROLL_LIABILITY: 'payrollLiabilityPayments',
    EMPLOYEE_ADVANCE: 'employeeAdvances',
    FIXED_ASSET: 'fixedAssets',
    FIXED_ASSET_PAYMENT: 'fixedAssetPayments',
    OWNER_TRANSACTION: 'ownerTransactions',
    TRANSFER: 'transfers',
    CASH_ADJUSTMENT: 'cashAdjustments',
    STOCK_ADJUSTMENT: 'stockMovements',
    STOCK_EQUITY_RECLASS: 'stockMovements',
    REVALUATION: 'stockMovements',
  };

  const n = (v) => Math.round(Number(v) || 0);
  const isVoid = (doc) => !!(doc && (doc.voided || doc.status === 'void'));

  // Which documents must carry live journal entries (amount > 0, not void).
  const DOCUMENT_RULES = [
    { collection: 'sales', sourceType: 'SALE', label: 'فاتورة بيع', amount: d => n(d.totalMinor) },
    { collection: 'salesReturns', sourceType: 'SALE_RETURN', label: 'مرتجع بيع', amount: d => n(d.refundMinor) + n(d.restockCostMinor) },
    { collection: 'purchases', sourceType: 'PURCHASE', label: 'فاتورة شراء', amount: d => n(d.totalMinor) },
    { collection: 'purchaseReturns', sourceType: 'PURCHASE_RETURN', label: 'مرتجع شراء', amount: d => n(d.totalMinor) },
    { collection: 'customerPayments', sourceType: 'CUSTOMER_PAYMENT', label: 'تحصيل زبون', amount: d => n(d.amountMinor) },
    { collection: 'supplierPayments', sourceType: 'SUPPLIER_PAYMENT', label: 'دفعة مورد', amount: d => n(d.amountMinor) },
    {
      collection: 'expenses', sourceType: 'EXPENSE', label: 'مصروف',
      // Payroll-generated net-pay records are posted by the payroll itself.
      amount: d => (d.categoryName === 'رواتب' ? 0 : n(d.amountMinor)),
    },
    { collection: 'expensePayments', sourceType: 'EXPENSE_PAYMENT', label: 'دفعة مصروف', amount: d => n(d.amountMinor) },
    { collection: 'employeeAdvances', sourceType: 'EMPLOYEE_ADVANCE', label: 'سلفة موظف', amount: d => n(d.amountMinor) },
    { collection: 'payrollLiabilityPayments', sourceType: 'PAYROLL_LIABILITY', label: 'سداد مستحقات رواتب', amount: d => n(d.amountMinor) },
    { collection: 'fixedAssets', sourceType: 'FIXED_ASSET', label: 'أصل ثابت', amount: d => n(d.costMinor) },
    { collection: 'fixedAssetPayments', sourceType: 'FIXED_ASSET_PAYMENT', label: 'دفعة أصل ثابت', amount: d => n(d.amountMinor) },
    { collection: 'ownerTransactions', sourceType: 'OWNER_TRANSACTION', label: 'حركة مالك', amount: d => n(d.amountMinor) },
    { collection: 'transfers', sourceType: 'TRANSFER', label: 'تحويل', amount: d => n(d.amountMinor) },
    { collection: 'cashAdjustments', sourceType: 'CASH_ADJUSTMENT', label: 'تسوية صندوق', amount: d => Math.abs(n(d.amountMinor)) },
    { collection: 'cardSettlements', sourceType: 'CARD_SETTLEMENT', label: 'تسوية بطاقات', amount: d => n(d.grossMinor) },
  ];

  // Control accounts whose every balance must belong to a party.
  const CONTROL_ACCOUNTS = [
    { key: 'ar', code: '1100', party: 'customer', label: 'الذمم المدينة' },
    { key: 'customer_credits', code: '2030', party: 'customer', label: 'أرصدة الزبائن الدائنة' },
    { key: 'ap', code: '2010', party: 'supplier', label: 'الذمم الدائنة' },
    { key: 'employee_advances', code: '1150', party: 'employee', label: 'سلف الموظفين' },
    { key: 'accrued_salaries', code: '2100', party: 'employee', label: 'الرواتب المستحقة' },
  ];

  function accountFor(chart, key, code) {
    return chart.find(a => a.systemKey === key) ||
      chart.find(a => String(a.code) === String(code)) || null;
  }

  class JournalIntegrityService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * True when every document is represented in the journal: no historical
     * replay is pending and the last replay had no errors.
     * @param {object} meta meta record
     * @returns {boolean}
     */
    journalComplete(meta) {
      const replay = meta && meta.journalReplay;
      if (replay && replay.needed) return false;
      if (replay && replay.ok === false) return false;
      return !!(BeeStore.posting && BeeStore.posting.available && BeeStore.posting.available());
    }

    /**
     * Runs every journal check.
     * @param {object} [options] {asOf}
     * @returns {Promise<object>} {errors, warnings, checked, skipped}
     */
    async check(options) {
      options = options || {};
      const errors = [];
      const warnings = [];
      const skipped = [];
      const err = (check, message, entityType, entityId) =>
        errors.push({ check, message, entityType: entityType || null, entityId: entityId || null });
      const warn = (check, message, entityType, entityId) =>
        warnings.push({ check, message, entityType: entityType || null, entityId: entityId || null });

      const [entries, chart, meta, settings] = await Promise.all([
        this.repo.list('journalEntries'),
        this.repo.list('chartOfAccounts'),
        this.repo.get('meta', 'meta'),
        this.repo.get('meta', 'settings'),
      ]);
      const asOf = options.asOf || BeeStore.dates.today();
      const checked = { entries: entries.length, documents: 0, parties: 0 };
      if (entries.length === 0 && chart.length === 0) {
        return { errors, warnings, checked, skipped: ['no-journal'] };
      }
      const byAccountId = new Map(chart.map(a => [a.id, a]));

      // 1. Journal invariants.
      if (BeeStore.journal && BeeStore.JournalService) {
        const verifier = new BeeStore.JournalService(this.repo);
        const verify = await verifier.verify();
        for (const e of verify.errors) {
          err('journal-' + e.code, e.message + (e.number ? ' (' + e.number + ')' : ''),
            'journal-entry', e.entryId);
        }
      }

      // Live entries per source and balances (as of `asOf`, so pre-posted
      // scheduled entries in future months do not count yet).
      const reversed = new Set(entries.filter(e => e.reversalOf).map(e => e.reversalOf));
      const liveBySource = new Map();
      const balances = new Map();
      const partyBalances = new Map();
      for (const entry of entries) {
        if (!entry.reversalOf && !reversed.has(entry.id) && entry.sourceId) {
          const key = entry.sourceType + '\u0000' + entry.sourceId;
          liveBySource.set(key, (liveBySource.get(key) || 0) + 1);
        }
        if (String(entry.date) > asOf) continue;
        for (const line of (entry.lines || [])) {
          const amount = n(line.debitMinor) - n(line.creditMinor);
          if (!amount) continue;
          balances.set(line.accountId, (balances.get(line.accountId) || 0) + amount);
          if (line.partyType && line.partyId) {
            const key = line.accountId + '\u0000' + line.partyType + '\u0000' + line.partyId;
            partyBalances.set(key, (partyBalances.get(key) || 0) + amount);
          }
        }
      }
      const balanceOf = (account) => (account ? (balances.get(account.id) || 0) : 0);

      // 2. Control account = Σ party balances on that account.
      for (const spec of CONTROL_ACCOUNTS) {
        const account = accountFor(chart, spec.key, spec.code);
        if (!account) continue;
        let partyTotal = 0;
        for (const [key, amount] of partyBalances) {
          const parts = key.split('\u0000');
          if (parts[0] === account.id && parts[1] === spec.party) partyTotal += amount;
        }
        const total = balanceOf(account);
        if (total !== partyTotal) {
          err('control-subledger', 'رصيد ' + spec.label + ' (' + account.code + ') = ' + total +
            ' لا يساوي مجموع أرصدة الأطراف = ' + partyTotal + ' — يوجد رصيد بلا طرف',
            'account', account.id);
        }
      }

      const complete = this.journalComplete(meta);
      if (!complete) {
        skipped.push('document-links', 'document-subledgers');
        warn('journal-incomplete',
          'فحوص ربط المستندات بالقيود مؤجلة حتى اكتمال ترحيل السجل التاريخي للقيود', null, null);
      }

      // 3. Journal party balances = document sub-ledgers.
      if (complete) {
        const ar = accountFor(chart, 'ar', '1100');
        const credits = accountFor(chart, 'customer_credits', '2030');
        const ap = accountFor(chart, 'ap', '2010');
        const partyOf = (account, type, id) => account
          ? (partyBalances.get(account.id + '\u0000' + type + '\u0000' + id) || 0) : 0;
        if (BeeStore.customers && BeeStore.customers.balance) {
          for (const c of await this.repo.list('customers')) {
            checked.parties++;
            const journal = partyOf(ar, 'customer', c.id) + partyOf(credits, 'customer', c.id);
            const document = n(await BeeStore.customers.balance(c.id, asOf));
            if (journal !== document) {
              err('customer-subledger', 'رصيد الزبون «' + (c.name || c.id) + '» في القيود ' + journal +
                ' يختلف عن كشف حسابه ' + document, 'customer', c.id);
            }
          }
        }
        if (BeeStore.suppliers && BeeStore.suppliers.balance) {
          for (const s of await this.repo.list('suppliers')) {
            checked.parties++;
            const journal = -partyOf(ap, 'supplier', s.id);
            const document = n(await BeeStore.suppliers.balance(s.id, asOf));
            if (journal !== document) {
              err('supplier-subledger', 'رصيد المورد «' + (s.name || s.id) + '» في القيود ' + journal +
                ' يختلف عن كشف حسابه ' + document, 'supplier', s.id);
            }
          }
        }
      }

      // 4. Document ↔ journal.
      if (complete) {
        for (const rule of DOCUMENT_RULES) {
          let docs = [];
          try {
            docs = await this.repo.list(rule.collection);
          } catch (e) {
            continue;
          }
          for (const doc of docs) {
            checked.documents++;
            const live = liveBySource.get(rule.sourceType + '\u0000' + doc.id) || 0;
            const name = rule.label + ' ' + (doc.number || doc.date || doc.id);
            if (isVoid(doc)) {
              if (live > 0) {
                err('document-journal', name + ' ملغى لكن قيوده ما زالت فعّالة', rule.collection, doc.id);
              }
            } else if (rule.amount(doc) > 0 && live === 0) {
              err('document-journal', name + ' بلا قيد محاسبي فعّال', rule.collection, doc.id);
            }
          }
        }
      }

      // 5. Orphan entries: the source document must exist.
      const existing = new Map();
      const exists = async (collection, id) => {
        if (!existing.has(collection)) {
          let ids = new Set();
          try {
            ids = new Set((await this.repo.list(collection)).map(d => d.id));
          } catch (e) { /* unknown collection */ }
          existing.set(collection, ids);
        }
        return existing.get(collection).has(id);
      };
      for (const entry of entries) {
        const collection = SOURCE_COLLECTIONS[entry.sourceType];
        if (!collection || !entry.sourceId) continue;
        if (!(await exists(collection, entry.sourceId))) {
          err('orphan-entry', 'القيد ' + entry.number + ' يشير إلى مستند غير موجود (' +
            BeeStore.journal.sourceLabel(entry.sourceType) + ')', 'journal-entry', entry.id);
        }
      }

      // 6. Balances that must not be negative.
      for (const account of chart) {
        const balance = balanceOf(account);
        if (balance >= 0) continue;
        const isCash = account.systemKey === 'cash' ||
          (account.legacyAccountId && !account.clearing && account.type === 'asset');
        if (isCash) {
          err('negative-cash', 'رصيد ' + account.nameAr + ' سالب (' + balance + ') حتى ' + asOf,
            'account', account.id);
        } else if (account.clearing) {
          warn('negative-clearing', 'رصيد ' + account.nameAr + ' سالب (' + balance +
            ') — تسوية أكبر من المقبوضات المسجلة', 'account', account.id);
        }
      }
      const inventory = accountFor(chart, 'inventory', '1200');
      if (inventory && balanceOf(inventory) < 0) {
        const message = 'قيمة المخزون (1200) سالبة (' + balanceOf(inventory) + ')';
        if (settings && settings.allowNegativeStock) warn('negative-inventory', message, 'account', inventory.id);
        else err('negative-inventory', message, 'account', inventory.id);
      }

      // 7. Closed fiscal years: P&L accounts are zero through year end.
      const closedYears = entries
        .filter(e => e.sourceType === 'YEAR_CLOSE' && !e.reversalOf && !reversed.has(e.id))
        .map(e => String(e.date).slice(0, 4));
      for (const year of closedYears) {
        const end = year + '-12-31';
        const pnl = new Map();
        for (const entry of entries) {
          if (String(entry.date) > end) continue;
          for (const line of (entry.lines || [])) {
            const account = byAccountId.get(line.accountId);
            if (!account || (account.type !== 'revenue' && account.type !== 'expense')) continue;
            pnl.set(account.id, (pnl.get(account.id) || 0) + n(line.debitMinor) - n(line.creditMinor));
          }
        }
        for (const [id, amount] of pnl) {
          if (amount !== 0) {
            const account = byAccountId.get(id);
            err('closed-year', 'السنة ' + year + ' مقفلة لكن رصيد ' + account.nameAr +
              ' حتى نهايتها ' + amount + ' — قيد بعد الإقفال؟', 'account', id);
          }
        }
      }

      return { errors, warnings, checked, skipped };
    }
  }

  JournalIntegrityService.SOURCE_COLLECTIONS = SOURCE_COLLECTIONS;
  BeeStore.journalIntegrity = new JournalIntegrityService(null);
  BeeStore.JournalIntegrityService = JournalIntegrityService;
  if (typeof module !== 'undefined') module.exports = JournalIntegrityService;
})(typeof window !== 'undefined' ? window : globalThis);
