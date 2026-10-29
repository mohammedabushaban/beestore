(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * v5 §4 posting helpers.
   *
   * Every helper runs inside the caller's document transaction and is a
   * no-op when the journal/chart services are not loaded (older unit tests and
   * non-accounting scripts still work). Amounts are always integer minor units
   * and every emitted entry is balanced by construction; a missing system
   * account is an error, never a silently skipped posting.
   *
   * Event tags make the historical replay idempotent: an A2 entry without an
   * event is recognised as the inventory-side posting and only the missing A3
   * events are appended.
   */
  const EVENTS = {
    SALE_REVENUE: 'SALE_REVENUE',
    SALE_COST: 'SALE_COST',
    SALE_PAYMENT: 'SALE_PAYMENT',
    SALE_RETURN: 'SALE_RETURN',
    SALE_RETURN_COST: 'SALE_RETURN_COST',
    CUSTOMER_PAYMENT: 'CUSTOMER_PAYMENT',
    PURCHASE_INVENTORY: 'PURCHASE_INVENTORY',
    PURCHASE_PAYMENT: 'PURCHASE_PAYMENT',
    PURCHASE_RETURN: 'PURCHASE_RETURN',
    PURCHASE_RETURN_RECLASS: 'PURCHASE_RETURN_RECLASS',
    SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
    EXPENSE: 'EXPENSE',
    EXPENSE_PREPAID: 'EXPENSE_PREPAID',
    EXPENSE_RELEASE: 'EXPENSE_RELEASE',
    PAYROLL_ACCRUAL: 'PAYROLL_ACCRUAL',
    PAYROLL_PAYMENT: 'PAYROLL_PAYMENT',
    EMPLOYEE_ADVANCE: 'EMPLOYEE_ADVANCE',
    OWNER_TRANSACTION: 'OWNER_TRANSACTION',
    TRANSFER: 'TRANSFER',
    CASH_DIFFERENCE: 'CASH_DIFFERENCE',
    OPENING_ACCOUNT: 'OPENING_ACCOUNT',
    OPENING_CUSTOMER: 'OPENING_CUSTOMER',
    OPENING_SUPPLIER: 'OPENING_SUPPLIER',
    OPENING_STOCK: 'OPENING_STOCK',
    STOCK_ADJUSTMENT: 'STOCK_ADJUSTMENT',
    REVALUATION: 'REVALUATION',
  };

  const SOURCE = {
    SALE: 'SALE',
    SALE_RETURN: 'SALE_RETURN',
    CUSTOMER_PAYMENT: 'CUSTOMER_PAYMENT',
    PURCHASE: 'PURCHASE',
    PURCHASE_RETURN: 'PURCHASE_RETURN',
    SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
    EXPENSE: 'EXPENSE',
    PAYROLL: 'PAYROLL',
    EMPLOYEE_ADVANCE: 'EMPLOYEE_ADVANCE',
    OWNER_TRANSACTION: 'OWNER_TRANSACTION',
    TRANSFER: 'TRANSFER',
    CASH_ADJUSTMENT: 'CASH_ADJUSTMENT',
    OPENING: 'OPENING',
    STOCK_ADJUSTMENT: 'STOCK_ADJUSTMENT',
    REVALUATION: 'REVALUATION',
  };

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function maxDate(a, b) {
    return String(a) > String(b) ? String(a) : String(b);
  }

  class PostingService {
    constructor(repo) {
      this.repo = repo;
      this._chartCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    }

    available() {
      return !!(BeeStore.journal && BeeStore.journal.post &&
        BeeStore.chart && BeeStore.chart.ensureSeededTx);
    }

    async chartMap(tx, options) {
      if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
        await BeeStore.chart.ensureSeededTx(tx, options || {});
      }
      if (this._chartCache) {
        const cached = this._chartCache.get(tx);
        if (cached) return cached;
      }
      const chart = await tx.list('chartOfAccounts');
      const byKey = new Map();
      for (const account of chart) {
        if (account.systemKey) byKey.set(account.systemKey, account);
      }
      if (this._chartCache) this._chartCache.set(tx, byKey);
      return byKey;
    }

    async _chartAccounts(tx, options) {
      if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
        await BeeStore.chart.ensureSeededTx(tx, options || {});
      }
      return tx.list('chartOfAccounts');
    }

    /**
     * Finds one active system account by its stable seed key.
     * @param {object} tx active transaction
     * @param {string} key chart seed key (inventory, cogs, ap, ...)
     * @param {object} [options] {taxPayable}
     * @returns {Promise<object>} chart account
     */
    async accountByKey(tx, key, options) {
      if (key === 'tax_payable') {
        await this._ensureTaxAccount(tx);
      }
      const byKey = await this.chartMap(tx, options);
      return this._account(byKey, key);
    }

    _account(byKey, key) {
      const account = byKey.get(key);
      if (!account) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي النظامي غير موجود: ' + key);
      }
      if (account.active === false) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي معطّل: ' + account.nameAr);
      }
      return account;
    }

    async _ensureTaxAccount(tx) {
      if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
        await BeeStore.chart.ensureSeededTx(tx, { taxPayable: true });
        if (this._chartCache) this._chartCache.delete(tx);
      }
    }

    async _settings(tx) {
      return (await tx.get('meta', 'settings')) || {};
    }

    async _systemStartDate(tx) {
      const settings = await this._settings(tx);
      return settings.systemStartDate || BeeStore.dates.today();
    }

    _findByLegacy(chart, legacyId) {
      return chart.find(a => a.legacyAccountId === legacyId) ||
        chart.find(a => a.id === legacyId) ||
        null;
    }

    /**
     * Resolves a document's money account to its chart account. Legacy
     * `accounts` ids win over a payment method's clearing account, matching
     * the document reports during the parity phase.
     * @param {object} tx active transaction
     * @param {object} [spec] {legacyAccountId,method,chartAccountId}
     * @returns {Promise<object>} chart account
     */
    async moneyAccount(tx, spec) {
      spec = spec || {};
      await this.chartMap(tx);
      const chart = await this._chartAccounts(tx);
      const settings = await this._settings(tx);

      if (spec.chartAccountId) {
        const direct = chart.find(a => a.id === spec.chartAccountId);
        if (direct) return direct;
      }
      if (spec.legacyAccountId) {
        const legacy = await tx.get('accounts', spec.legacyAccountId);
        if (legacy) {
          const linked = (legacy.chartAccountId &&
            chart.find(a => a.id === legacy.chartAccountId)) ||
            this._findByLegacy(chart, legacy.id);
          if (linked) return linked;
          throw BeeStore.errors.err('VALIDATION',
            'الحساب النقدي غير مرتبط بشجرة الحسابات: ' + (legacy.name || legacy.id));
        }
        const direct = this._findByLegacy(chart, spec.legacyAccountId);
        if (direct) return direct;
      }

      const methodId = spec.method;
      if (methodId) {
        const methods = settings.paymentMethods || [];
        const pm = methods.find(m => m.id === methodId);
        if (pm) {
          if (pm.chartAccountId) {
            const byMethod = chart.find(a => a.id === pm.chartAccountId);
            if (byMethod) return byMethod;
          }
          if (pm.accountId) {
            const legacy = await tx.get('accounts', pm.accountId);
            if (legacy) {
              const linked = (legacy.chartAccountId &&
                chart.find(a => a.id === legacy.chartAccountId)) ||
                this._findByLegacy(chart, legacy.id);
              if (linked) return linked;
            }
          }
          const byMethod = chart.find(a => a.paymentMethodId === pm.id);
          if (byMethod) return byMethod;
        }
      }

      const drawerLegacy = settings.cashDrawerAccountId;
      if (drawerLegacy) {
        const drawer = this._findByLegacy(chart, drawerLegacy);
        if (drawer) return drawer;
      }
      return this._account(await this.chartMap(tx), 'cash');
    }

    async isCashDrawerAccount(tx, account) {
      if (!account) return false;
      if (account.systemKey === 'cash') return true;
      const settings = await this._settings(tx);
      if (!settings.cashDrawerAccountId) return false;
      return account.legacyAccountId === settings.cashDrawerAccountId ||
        account.id === settings.cashDrawerAccountId;
    }

    /**
     * Resolves an expense document to its 6xxx chart account. Owner-created
     * categories are linked by `expenseCategoryId`; legacy free-text names
     * fall back to the matching account name and finally to 6095.
     */
    async expenseAccount(tx, expense) {
      const chart = await this._chartAccounts(tx);
      if (expense.chartAccountId) {
        const direct = chart.find(a => a.id === expense.chartAccountId);
        if (direct && direct.type === 'expense') return direct;
      }
      if (expense.categoryId) {
        const byCategory = chart.find(a => a.expenseCategoryId === expense.categoryId);
        if (byCategory) return byCategory;
      }
      const name = String(expense.categoryName || '').trim();
      if (name) {
        const byName = chart.find(a => a.type === 'expense' && a.nameAr === name);
        if (byName) return byName;
      }
      const other = chart.find(a => a.code === '6095') ||
        chart.find(a => a.type === 'expense' && a.nameAr === 'مصاريف أخرى');
      if (other) return other;
      throw BeeStore.errors.err('VALIDATION',
        'لا يوجد حساب مصروف مطابق: ' + (name || expense.categoryId || expense.id));
    }

    /**
     * Builds and appends one balanced entry from system-key parts.
     * @param {object} tx active transaction
     * @param {object} spec {date,sourceType,sourceId,event,description,parts[],
     *   allowClosedDay?,isScheduled?,replay?,taxPayable?}
     * @returns {Promise<object|null>} entry, or null for a zero-value event
     */
    async postParts(tx, spec) {
      if (!this.available()) return null;
      const taxNeeded = !!(spec.taxPayable ||
        (spec.parts || []).some(p => p && p.key === 'tax_payable'));
      if (taxNeeded) await this._ensureTaxAccount(tx);
      const byKey = await this.chartMap(tx);
      const lines = [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const part of (spec.parts || [])) {
        const debit = round(part.debit);
        const credit = round(part.credit);
        if (debit < 0 || credit < 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ الترحيل لا يمكن أن يكون سالباً');
        }
        if (debit === 0 && credit === 0) continue;
        if (debit > 0 && credit > 0) {
          throw BeeStore.errors.err('VALIDATION', 'سطر الترحيل لا يكون مديناً ودائناً معاً');
        }
        let account = null;
        if (part.accountId) {
          const chart = await this._chartAccounts(tx);
          account = chart.find(a => a.id === part.accountId) || null;
        } else {
          account = this._account(byKey, part.key);
        }
        if (!account) {
          throw BeeStore.errors.err('VALIDATION', 'حساب سطر الترحيل غير موجود');
        }
        if (account.active === false) {
          throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي معطّل: ' + account.nameAr);
        }
        lines.push({
          accountId: account.id,
          debitMinor: debit,
          creditMinor: credit,
          partyType: part.partyType || null,
          partyId: part.partyId || null,
          memo: part.memo || '',
        });
        totalDebit += debit;
        totalCredit += credit;
      }
      if (lines.length < 2) return null;
      if (totalDebit !== totalCredit) {
        throw BeeStore.errors.err('VALIDATION',
          'الترحيل غير متوازن — مدين ' + totalDebit + ' مقابل دائن ' + totalCredit);
      }
      return BeeStore.journal.post(tx, {
        date: spec.date,
        sourceType: spec.sourceType,
        sourceId: spec.sourceId === undefined ? null : spec.sourceId,
        event: spec.event || null,
        description: spec.description,
        lines,
        isScheduled: !!spec.isScheduled,
      }, {
        allowClosedDay: spec.allowClosedDay === true,
        replay: !!spec.replay,
      });
    }

    // ---------------------------------------------------------------------
    // Inventory side (A2 rules; kept event-tagged for replay).
    // ---------------------------------------------------------------------

    /**
     * Sale cost entry: Dr 5010 COGS / Cr 1200 Inventory.
     * @param {object} tx active transaction
     * @param {object} sale posted sale
     * @param {number} totalCogsMinor exact §3.2 cost of the sold units
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async saleCost(tx, sale, totalCogsMinor, options) {
      const amount = round(totalCogsMinor);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: sale.date,
        sourceType: SOURCE.SALE,
        sourceId: sale.id,
        event: EVENTS.SALE_COST,
        description: 'تكلفة مبيعات ' + sale.number,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: amount > 0
          ? [{ key: 'cogs', debit: amount }, { key: 'inventory', credit: amount }]
          : [{ key: 'inventory', debit: -amount }, { key: 'cogs', credit: -amount }],
      });
    }

    /**
     * Restocked sale return: Dr 1200 Inventory / Cr 5010 COGS.
     * Damaged returns are not posted here because their cost stays in COGS.
     * @param {object} tx active transaction
     * @param {object} ret sale return
     * @param {number} restockCostMinor exact original cost of restocked units
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async saleReturnCost(tx, ret, restockCostMinor, options) {
      const amount = round(restockCostMinor);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: ret.date,
        sourceType: SOURCE.SALE_RETURN,
        sourceId: ret.id,
        event: EVENTS.SALE_RETURN_COST,
        description: 'تكلفة مرتجع مبيعات ' + ret.number,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: amount > 0
          ? [{ key: 'inventory', debit: amount }, { key: 'cogs', credit: amount }]
          : [{ key: 'cogs', debit: -amount }, { key: 'inventory', credit: -amount }],
      });
    }

    /**
     * Purchase invoice inventory side: Dr 1200 Inventory / Cr 2010 AP.
     * @param {object} tx active transaction
     * @param {object} purchase posted purchase
     * @param {number} inventoryValueMinor lines net of allocated discount
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async purchase(tx, purchase, inventoryValueMinor, options) {
      const amount = round(inventoryValueMinor);
      if (amount === 0) return null;
      const ap = await this.accountByKey(tx, 'ap');
      return this.postParts(tx, {
        date: purchase.date,
        sourceType: SOURCE.PURCHASE,
        sourceId: purchase.id,
        event: EVENTS.PURCHASE_INVENTORY,
        description: 'مشتريات ' + purchase.number,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: [
          { key: 'inventory', debit: amount },
          {
            key: 'ap', credit: amount,
            partyType: purchase.supplierId ? 'supplier' : null,
            partyId: purchase.supplierId || null,
            memo: ap.nameAr,
          },
        ],
      });
    }

    /**
     * Purchase return: Dr AP (payable reduction) or the money account (cash
     * refund), Cr Inventory (tracked value removed), with any difference to
     * 5030 (v5 §4 row 7). A refund above the removed carrying value is a
     * credit (gain); below is a debit (loss).
     * @param {object} tx active transaction
     * @param {object} ret purchase return
     * @param {number} refundValueMinor supplier refund / payable reduction
     * @param {number} removedValueMinor exact value removed from inventory
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async purchaseReturn(tx, ret, refundValueMinor, removedValueMinor, options) {
      const refund = round(refundValueMinor);
      const removed = round(removedValueMinor);
      if (refund === 0 && removed === 0) return null;
      const cashRefund = ret.mode === 'cash_refund';
      const parts = [
        cashRefund
          ? {
            accountId: (await this.moneyAccount(tx, {
              legacyAccountId: ret.accountId,
              method: ret.method || 'cash',
            })).id,
            debit: refund,
          }
          : {
            key: 'ap', debit: refund,
            partyType: ret.supplierId ? 'supplier' : null,
            partyId: ret.supplierId || null,
          },
        { key: 'inventory', credit: removed },
      ];
      if (refund > removed) {
        parts.push({ key: 'inventory_revaluation', credit: refund - removed });
      } else if (removed > refund) {
        parts.push({ key: 'inventory_revaluation', debit: removed - refund });
      }
      return this.postParts(tx, {
        date: ret.date,
        sourceType: SOURCE.PURCHASE_RETURN,
        sourceId: ret.id,
        event: EVENTS.PURCHASE_RETURN,
        description: 'مرتجع مشتريات ' + ret.number,
        allowClosedDay: !cashRefund,
        replay: options && options.replay,
        parts,
      });
    }

    /**
     * Legacy A2 cash-refund purchase returns debited AP even though cash was
     * received. The replay appends a reclassification instead of replacing
     * the append-only entry: Dr money / Cr AP.
     */
    async purchaseReturnReclass(tx, ret, options) {
      const amount = round(ret.totalMinor);
      if (amount === 0) return null;
      const money = await this.moneyAccount(tx, {
        legacyAccountId: ret.accountId,
        method: ret.method || 'cash',
      });
      return this.postParts(tx, {
        date: ret.date,
        sourceType: SOURCE.PURCHASE_RETURN,
        sourceId: ret.id,
        event: EVENTS.PURCHASE_RETURN_RECLASS,
        description: 'تصنيف استرداد نقدي لمرتجع ' + (ret.number || ''),
        replay: options && options.replay,
        parts: [
          { accountId: money.id, debit: amount },
          {
            key: 'ap', credit: amount,
            partyType: ret.supplierId ? 'supplier' : null,
            partyId: ret.supplierId || null,
          },
        ],
      });
    }

    /**
     * Stock adjustment/count: gain Dr 1200 / Cr 5020, loss Dr 5020 / Cr 1200.
     * @param {object} tx active transaction
     * @param {object} movement stock movement
     * @param {number} valueChangeMinor signed tracked-value change
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async stockAdjustment(tx, movement, valueChangeMinor, options) {
      const delta = round(valueChangeMinor);
      if (delta === 0) return null;
      return this.postParts(tx, {
        date: movement.date,
        sourceType: SOURCE.STOCK_ADJUSTMENT,
        sourceId: movement.id,
        event: EVENTS.STOCK_ADJUSTMENT,
        description: movement.type === 'stocktake' ? 'جرد مخزون ' + movement.date : 'تسوية مخزون ' + movement.date,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: delta > 0
          ? [{ key: 'inventory', debit: delta }, { key: 'inventory_loss', credit: delta }]
          : [{ key: 'inventory_loss', debit: -delta }, { key: 'inventory', credit: -delta }],
      });
    }

    /**
     * Cost revaluation (v4 R1): value delta between 1200 and 5030.
     * @param {object} tx active transaction
     * @param {object} movement revaluation movement
     * @param {number} valueChangeMinor signed tracked-value change
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async revaluation(tx, movement, valueChangeMinor, options) {
      const delta = round(valueChangeMinor);
      if (delta === 0) return null;
      return this.postParts(tx, {
        date: movement.date,
        sourceType: SOURCE.REVALUATION,
        sourceId: movement.id,
        event: EVENTS.REVALUATION,
        description: 'تسوية تكلفة مخزون ' + movement.date,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: delta > 0
          ? [{ key: 'inventory', debit: delta }, { key: 'inventory_revaluation', credit: delta }]
          : [{ key: 'inventory_revaluation', debit: -delta }, { key: 'inventory', credit: -delta }],
      });
    }

    /**
     * Opening stock contributed by the owner: Dr 1200 / Cr 3030.
     * @param {object} tx active transaction
     * @param {object} spec {date,sourceId?,description,valueMinor,replay?}
     * @returns {Promise<object|null>} entry
     */
    async openingStock(tx, spec) {
      const amount = round(spec.valueMinor);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: spec.date,
        sourceType: SOURCE.OPENING,
        sourceId: spec.sourceId || null,
        event: EVENTS.OPENING_STOCK,
        description: spec.description || 'مخزون افتتاحي',
        allowClosedDay: true,
        replay: spec.replay,
        parts: amount > 0
          ? [{ key: 'inventory', debit: amount }, { key: 'opening_equity', credit: amount }]
          : [{ key: 'opening_equity', debit: -amount }, { key: 'inventory', credit: -amount }],
      });
    }

    // ---------------------------------------------------------------------
    // A3 revenue / party / cash flows.
    // ---------------------------------------------------------------------

    /**
     * Sales invoice: Dr AR (customer) total / Cr 4010 net revenue / Cr 2300 tax.
     * Embedded receipts are posted separately on their own dates.
     * @param {object} tx active transaction
     * @param {object} sale posted sale
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async saleRevenue(tx, sale, options) {
      const total = round(sale.totalMinor);
      if (total === 0) return null;
      const tax = Math.max(0, Math.min(total, round(sale.taxMinor)));
      const revenue = total - tax;
      const parts = [{
        key: 'ar', debit: total,
        partyType: sale.customerId ? 'customer' : null,
        partyId: sale.customerId || null,
      }];
      if (revenue > 0) parts.push({ key: 'sales_revenue', credit: revenue });
      if (tax > 0) parts.push({ key: 'tax_payable', credit: tax });
      return this.postParts(tx, {
        date: sale.date,
        sourceType: SOURCE.SALE,
        sourceId: sale.id,
        event: EVENTS.SALE_REVENUE,
        description: 'فاتورة مبيعات ' + sale.number,
        taxPayable: tax > 0,
        replay: options && options.replay,
        parts,
      });
    }

    /**
     * Embedded sale receipts. Each receipt clears the invoice AR first; any
     * excess is kept as a customer credit in 2030 (v5 §4 rows 1/2).
     * @param {object} tx active transaction
     * @param {object} sale posted sale
     * @param {object} [options] {replay,skipIndexes?:Set}
     * @returns {Promise<object[]>} entries
     */
    async salePayments(tx, sale, options) {
      options = options || {};
      const out = [];
      let remaining = round(sale.totalMinor);
      const payments = sale.payments || [];
      for (let i = 0; i < payments.length; i++) {
        const p = payments[i] || {};
        const amount = round(p.amountMinor);
        if (amount <= 0) continue;
        const applied = Math.max(0, Math.min(amount, remaining));
        remaining -= applied;
        // Replay may skip an already-posted receipt, but it still consumed
        // invoice AR before later receipts. Advance the remainder without
        // emitting an entry so multi-payment invoices split correctly.
        if (options.skipIndexes && options.skipIndexes.has(i)) continue;
        const excess = amount - applied;
        const money = await this.moneyAccount(tx, {
          legacyAccountId: p.accountId,
          method: p.method,
        });
        const parts = [{ accountId: money.id, debit: amount }];
        if (applied > 0) {
          parts.push({
            key: 'ar', credit: applied,
            partyType: sale.customerId ? 'customer' : null,
            partyId: sale.customerId || null,
          });
        }
        if (excess > 0) {
          parts.push({
            key: 'customer_credits', credit: excess,
            partyType: sale.customerId ? 'customer' : null,
            partyId: sale.customerId || null,
          });
        }
        const entry = await this.postParts(tx, {
          date: p.date || sale.date,
          sourceType: SOURCE.SALE,
          sourceId: sale.id,
          event: EVENTS.SALE_PAYMENT + ':' + i,
          description: 'تحصيل فاتورة ' + sale.number,
          replay: options.replay,
          parts,
        });
        if (entry) out.push(entry);
      }
      return out;
    }

    /**
     * Customer collection: Dr money / Cr AR; excess becomes a 2030 credit.
     * @param {object} tx active transaction
     * @param {object} payment customerPayments record
     * @param {object} [options] {replay,appliedMinor}
     * @returns {Promise<object|null>} entry
     */
    async customerPayment(tx, payment, options) {
      options = options || {};
      const amount = round(payment.amountMinor);
      if (amount === 0) return null;
      const applied = options.appliedMinor !== undefined && options.appliedMinor !== null
        ? Math.max(0, Math.min(amount, round(options.appliedMinor)))
        : amount;
      const excess = amount - applied;
      const money = await this.moneyAccount(tx, {
        legacyAccountId: payment.accountId,
        method: payment.method,
      });
      const parts = [{ accountId: money.id, debit: amount }];
      if (applied > 0) {
        parts.push({
          key: 'ar', credit: applied,
          partyType: 'customer', partyId: payment.customerId,
        });
      }
      if (excess > 0) {
        parts.push({
          key: 'customer_credits', credit: excess,
          partyType: 'customer', partyId: payment.customerId,
        });
      }
      return this.postParts(tx, {
        date: payment.date,
        sourceType: SOURCE.CUSTOMER_PAYMENT,
        sourceId: payment.id,
        event: EVENTS.CUSTOMER_PAYMENT,
        description: 'تحصيل من زبون ' + (payment.payerName || payment.customerId),
        replay: options.replay,
        parts,
      });
    }

    /**
     * Sales return: Dr 4020 refund / Cr cash-bank-clearing, AR, or 2030.
     * @param {object} tx active transaction
     * @param {object} ret salesReturns record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async saleReturn(tx, ret, options) {
      const refund = round(ret.refundMinor);
      if (refund === 0) return null;
      const mode = ret.refundMode || 'cash_refund';
      const parts = [{ key: 'sales_returns', debit: refund }];
      if (mode === 'customer_credit') {
        parts.push({
          key: 'customer_credits', credit: refund,
          partyType: ret.customerId ? 'customer' : null,
          partyId: ret.customerId || null,
        });
      } else if (mode === 'exchange') {
        parts.push({
          key: 'ar', credit: refund,
          partyType: ret.customerId ? 'customer' : null,
          partyId: ret.customerId || null,
        });
      } else {
        const money = await this.moneyAccount(tx, {
          legacyAccountId: ret.refundMethod,
          method: 'cash',
        });
        parts.push({ accountId: money.id, credit: refund });
      }
      return this.postParts(tx, {
        date: ret.date,
        sourceType: SOURCE.SALE_RETURN,
        sourceId: ret.id,
        event: EVENTS.SALE_RETURN,
        description: 'مرتجع مبيعات ' + ret.number,
        replay: options && options.replay,
        parts,
      });
    }

    /**
     * Embedded purchase payments: Dr AP / Cr money (v5 §4 row 5).
     * @param {object} tx active transaction
     * @param {object} purchase posted purchase
     * @param {object} [options] {replay,skipIndexes?:Set}
     * @returns {Promise<object[]>} entries
     */
    async purchasePayments(tx, purchase, options) {
      options = options || {};
      const out = [];
      const payments = purchase.payments || [];
      for (let i = 0; i < payments.length; i++) {
        if (options.skipIndexes && options.skipIndexes.has(i)) continue;
        const p = payments[i] || {};
        const amount = round(p.amountMinor);
        if (amount <= 0) continue;
        const money = await this.moneyAccount(tx, {
          legacyAccountId: p.accountId,
          method: p.method,
        });
        const entry = await this.postParts(tx, {
          date: p.date || purchase.date,
          sourceType: SOURCE.PURCHASE,
          sourceId: purchase.id,
          event: EVENTS.PURCHASE_PAYMENT + ':' + i,
          description: 'دفعة مشتريات ' + purchase.number,
          replay: options.replay,
          parts: [
            {
              key: 'ap', debit: amount,
              partyType: purchase.supplierId ? 'supplier' : null,
              partyId: purchase.supplierId || null,
            },
            { accountId: money.id, credit: amount },
          ],
        });
        if (entry) out.push(entry);
      }
      return out;
    }

    /**
     * Supplier payment: Dr AP / Cr money (v5 §4 row 6).
     * @param {object} tx active transaction
     * @param {object} payment supplierPayments record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async supplierPayment(tx, payment, options) {
      const amount = round(payment.amountMinor);
      if (amount === 0) return null;
      const money = await this.moneyAccount(tx, {
        legacyAccountId: payment.accountId,
        method: payment.method,
      });
      return this.postParts(tx, {
        date: payment.date,
        sourceType: SOURCE.SUPPLIER_PAYMENT,
        sourceId: payment.id,
        event: EVENTS.SUPPLIER_PAYMENT,
        description: 'دفعة لمورد ' + (payment.payerName || payment.supplierId),
        replay: options && options.replay,
        parts: [
          {
            key: 'ap', debit: amount,
            partyType: 'supplier', partyId: payment.supplierId,
          },
          { accountId: money.id, credit: amount },
        ],
      });
    }

    // ---------------------------------------------------------------------
    // Expenses, payroll and owner flows.
    // ---------------------------------------------------------------------

    /**
     * Posts an expense. A spread expense first debits 1300 prepaid, then one
     * scheduled release per month (rule S). Payroll-generated net-pay records
     * are skipped because the payroll payment itself is the cash entry.
     * @param {object} tx active transaction
     * @param {object} expense expenses record
     * @param {object} [options] {replay}
     * @returns {Promise<object[]>} entries
     */
    async expense(tx, expense, options) {
      options = options || {};
      if (!expense || expense.voided) return [];
      if (expense.categoryName === 'رواتب') return [];
      const amount = round(expense.amountMinor);
      if (amount <= 0) return [];
      const money = await this.moneyAccount(tx, {
        legacyAccountId: expense.accountId,
        method: expense.method || 'cash',
      });
      const drawer = await this.isCashDrawerAccount(tx, money);
      const expenseAccount = await this.expenseAccount(tx, expense);
      const out = [];
      const spread = (expense.allocation || {}).mode === 'spread';
      if (!spread) {
        const entry = await this.postParts(tx, {
          date: expense.date,
          sourceType: SOURCE.EXPENSE,
          sourceId: expense.id,
          event: EVENTS.EXPENSE,
          description: 'مصروف ' + (expense.description || expense.categoryName || ''),
          allowClosedDay: !drawer,
          replay: options.replay,
          parts: [
            { accountId: expenseAccount.id, debit: amount },
            { accountId: money.id, credit: amount },
          ],
        });
        if (entry) out.push(entry);
        return out;
      }

      const prepaid = await this.postParts(tx, {
        date: expense.date,
        sourceType: SOURCE.EXPENSE,
        sourceId: expense.id,
        event: EVENTS.EXPENSE_PREPAID,
        description: 'مصروف مدفوع مقدماً ' + (expense.description || expense.categoryName || ''),
        allowClosedDay: !drawer,
        replay: options.replay,
        parts: [
          { key: 'prepaid', debit: amount },
          { accountId: money.id, credit: amount },
        ],
      });
      if (prepaid) out.push(prepaid);
      const shares = BeeStore.expenses && BeeStore.expenses.spreadShares
        ? BeeStore.expenses.spreadShares(expense)
        : [];
      for (let i = 0; i < shares.length; i++) {
        const share = shares[i];
        const shareAmount = round(share.amountMinor);
        if (shareAmount === 0) continue;
        const release = await this.postParts(tx, {
          date: maxDate(share.month + '-01', expense.date),
          sourceType: SOURCE.EXPENSE,
          sourceId: expense.id,
          event: EVENTS.EXPENSE_RELEASE + ':' + i,
          description: 'استهلاك مصروف ' + share.month + ' — ' + (expense.description || expense.categoryName || ''),
          isScheduled: true,
          allowClosedDay: true,
          replay: options.replay,
          parts: [
            { accountId: expenseAccount.id, debit: shareAmount },
            { key: 'prepaid', credit: shareAmount },
          ],
        });
        if (release) out.push(release);
      }
      return out;
    }

    /**
     * Payroll accrual at the payroll month start: Dr 6100 gross / Cr 2100.
     * @param {object} tx active transaction
     * @param {object} payroll payroll record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async payrollAccrual(tx, payroll, options) {
      const gross = round(payroll.baseMinor) + round(payroll.bonusMinor) +
        round(payroll.overtimeMinor) - round(payroll.deductionsMinor);
      if (gross <= 0) return null;
      return this.postParts(tx, {
        date: payroll.month + '-01',
        sourceType: SOURCE.PAYROLL,
        sourceId: payroll.id,
        event: EVENTS.PAYROLL_ACCRUAL,
        description: 'استحقاق راتب ' + payroll.employeeName + ' - ' + payroll.month,
        allowClosedDay: true,
        replay: options && options.replay,
        parts: [
          {
            key: 'salaries', debit: gross,
            partyType: payroll.employeeId ? 'employee' : null,
            partyId: payroll.employeeId || null,
          },
          {
            key: 'accrued_salaries', credit: gross,
            partyType: payroll.employeeId ? 'employee' : null,
            partyId: payroll.employeeId || null,
          },
        ],
      });
    }

    /**
     * Salary payment: Dr 2100 gross / Cr 1150 advances applied / Cr cash net.
     * @param {object} tx active transaction
     * @param {object} payroll paid payroll record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async payrollPayment(tx, payroll, options) {
      const gross = round(payroll.baseMinor) + round(payroll.bonusMinor) +
        round(payroll.overtimeMinor) - round(payroll.deductionsMinor);
      const applied = round(payroll.advanceRepaymentMinor);
      const net = payroll.netMinor != null ? round(payroll.netMinor) : gross - applied;
      if (gross <= 0) return null;
      if (net < 0 || applied < 0 || gross !== net + applied) {
        throw BeeStore.errors.err('VALIDATION',
          'دفع الراتب غير متوازن — الإجمالي ' + gross + '، السلف ' + applied + '، الصافي ' + net);
      }
      const money = await this.moneyAccount(tx, {
        legacyAccountId: payroll.accountId,
        method: payroll.method || 'cash',
      });
      const parts = [{
        key: 'accrued_salaries', debit: gross,
        partyType: payroll.employeeId ? 'employee' : null,
        partyId: payroll.employeeId || null,
      }];
      if (applied > 0) {
        parts.push({
          key: 'employee_advances', credit: applied,
          partyType: payroll.employeeId ? 'employee' : null,
          partyId: payroll.employeeId || null,
        });
      }
      if (net > 0) parts.push({ accountId: money.id, credit: net });
      return this.postParts(tx, {
        date: payroll.paidDate,
        sourceType: SOURCE.PAYROLL,
        sourceId: payroll.id,
        event: EVENTS.PAYROLL_PAYMENT,
        description: 'دفع راتب ' + payroll.employeeName + ' - ' + payroll.month,
        replay: options && options.replay,
        parts,
      });
    }

    /**
     * Employee advance: Dr 1150 / Cr money (v5 §4 row 12).
     * @param {object} tx active transaction
     * @param {object} advance employeeAdvances record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async employeeAdvance(tx, advance, options) {
      const amount = round(advance.amountMinor);
      if (amount <= 0) return null;
      const money = await this.moneyAccount(tx, {
        legacyAccountId: advance.accountId,
        method: advance.method || 'cash',
      });
      return this.postParts(tx, {
        date: advance.date,
        sourceType: SOURCE.EMPLOYEE_ADVANCE,
        sourceId: advance.id,
        event: EVENTS.EMPLOYEE_ADVANCE,
        description: 'سلفة موظف',
        replay: options && options.replay,
        parts: [
          {
            key: 'employee_advances', debit: amount,
            partyType: advance.employeeId ? 'employee' : null,
            partyId: advance.employeeId || null,
          },
          { accountId: money.id, credit: amount },
        ],
      });
    }

    /**
     * Owner capital/drawings: Dr money-Cr 3010 or Dr 3020-Cr money.
     * @param {object} tx active transaction
     * @param {object} doc ownerTransactions record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async ownerTransaction(tx, doc, options) {
      const amount = round(doc.amountMinor);
      if (amount <= 0) return null;
      const money = await this.moneyAccount(tx, { legacyAccountId: doc.accountId });
      const capitalIn = doc.type === 'capital_in';
      return this.postParts(tx, {
        date: doc.date,
        sourceType: SOURCE.OWNER_TRANSACTION,
        sourceId: doc.id,
        event: EVENTS.OWNER_TRANSACTION,
        description: capitalIn ? 'إيداع رأس مال' : 'مسحوبات مالك',
        replay: options && options.replay,
        parts: capitalIn
          ? [{ accountId: money.id, debit: amount }, { key: 'capital', credit: amount }]
          : [{ key: 'drawings', debit: amount }, { accountId: money.id, credit: amount }],
      });
    }

    /**
     * Cash/bank transfer: Dr destination / Cr source.
     * @param {object} tx active transaction
     * @param {object} doc transfers record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async transfer(tx, doc, options) {
      const amount = round(doc.amountMinor);
      if (amount <= 0) return null;
      const from = await this.moneyAccount(tx, { legacyAccountId: doc.fromAccountId });
      const to = await this.moneyAccount(tx, { legacyAccountId: doc.toAccountId });
      return this.postParts(tx, {
        date: doc.date,
        sourceType: SOURCE.TRANSFER,
        sourceId: doc.id,
        event: EVENTS.TRANSFER,
        description: 'تحويل بين الحسابات',
        replay: options && options.replay,
        parts: [
          { accountId: to.id, debit: amount },
          { accountId: from.id, credit: amount },
        ],
      });
    }

    /**
     * Daily cash difference: shortage Dr 6400 / Cr cash; surplus Dr cash /
     * Cr 4100 (v5 §4 row 15).
     * @param {object} tx active transaction
     * @param {object} doc cashAdjustments record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async cashDifference(tx, doc, options) {
      const amount = round(doc.amountMinor);
      if (amount === 0) return null;
      const money = await this.moneyAccount(tx, { legacyAccountId: doc.accountId });
      return this.postParts(tx, {
        date: doc.date,
        sourceType: SOURCE.CASH_ADJUSTMENT,
        sourceId: doc.id,
        event: EVENTS.CASH_DIFFERENCE,
        description: amount < 0 ? 'عجز صندوق' : 'زيادة صندوق',
        replay: options && options.replay,
        parts: amount < 0
          ? [{ key: 'cash_shortage', debit: -amount }, { accountId: money.id, credit: -amount }]
          : [{ accountId: money.id, debit: amount }, { key: 'other_income', credit: amount }],
      });
    }

    // ---------------------------------------------------------------------
    // Opening balances (v5 §3.5).
    // ---------------------------------------------------------------------

    /**
     * Opening balance of a money account (and, on update, its correction).
     * @param {object} tx active transaction
     * @param {object} account legacy accounts record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async openingAccount(tx, account, options) {
      const amount = round(account.openingBalanceMinor);
      if (amount === 0) return null;
      const money = await this.moneyAccount(tx, { legacyAccountId: account.id });
      const date = await this._systemStartDate(tx);
      return this.postParts(tx, {
        date,
        sourceType: SOURCE.OPENING,
        sourceId: 'open:account:' + account.id,
        event: EVENTS.OPENING_ACCOUNT,
        description: 'رصيد افتتاحي — ' + (account.name || ''),
        allowClosedDay: true,
        replay: options && options.replay,
        parts: amount > 0
          ? [{ accountId: money.id, debit: amount }, { key: 'opening_equity', credit: amount }]
          : [{ key: 'opening_equity', debit: -amount }, { accountId: money.id, credit: -amount }],
      });
    }

    /**
     * Customer opening receivable: Dr 1100 / Cr 3030.
     * @param {object} tx active transaction
     * @param {object} customer customers record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async openingCustomer(tx, customer, options) {
      const amount = round(customer.openingBalanceMinor);
      if (amount === 0) return null;
      const date = await this._systemStartDate(tx);
      return this.postParts(tx, {
        date,
        sourceType: SOURCE.OPENING,
        sourceId: 'open:customer:' + customer.id,
        event: EVENTS.OPENING_CUSTOMER,
        description: 'رصيد افتتاحي — ' + (customer.name || ''),
        allowClosedDay: true,
        replay: options && options.replay,
        parts: amount > 0
          ? [
            { key: 'ar', debit: amount, partyType: 'customer', partyId: customer.id },
            { key: 'opening_equity', credit: amount },
          ]
          : [
            { key: 'opening_equity', debit: -amount },
            { key: 'ar', credit: -amount, partyType: 'customer', partyId: customer.id },
          ],
      });
    }

    /**
     * Supplier opening payable: Dr 3030 / Cr 2010.
     * @param {object} tx active transaction
     * @param {object} supplier suppliers record
     * @param {object} [options] {replay}
     * @returns {Promise<object|null>} entry
     */
    async openingSupplier(tx, supplier, options) {
      const amount = round(supplier.openingBalanceMinor);
      if (amount === 0) return null;
      const date = await this._systemStartDate(tx);
      return this.postParts(tx, {
        date,
        sourceType: SOURCE.OPENING,
        sourceId: 'open:supplier:' + supplier.id,
        event: EVENTS.OPENING_SUPPLIER,
        description: 'رصيد افتتاحي — ' + (supplier.name || ''),
        allowClosedDay: true,
        replay: options && options.replay,
        parts: amount > 0
          ? [
            { key: 'opening_equity', debit: amount },
            { key: 'ap', credit: amount, partyType: 'supplier', partyId: supplier.id },
          ]
          : [
            { key: 'ap', debit: -amount, partyType: 'supplier', partyId: supplier.id },
            { key: 'opening_equity', credit: -amount },
          ],
      });
    }

    // ---------------------------------------------------------------------
    // Linking, reversal and replay.
    // ---------------------------------------------------------------------

    /**
     * Appends one entry id to a document's journalEntryIds (idempotent).
     * @param {object} doc document or stock movement
     * @param {object} entry journal entry
     * @returns {object} the same document
     */
    link(doc, entry) {
      if (!doc || !entry) return doc;
      const ids = Array.isArray(doc.journalEntryIds) ? doc.journalEntryIds : [];
      if (ids.indexOf(entry.id) < 0) ids.push(entry.id);
      doc.journalEntryIds = ids;
      return doc;
    }

    /**
     * Links several documents/movements to one or more entries.
     * @param {object[]} docs documents
     * @param {object|object[]} entries one entry or an array
     * @returns {object[]} docs
     */
    linkAll(docs, entries) {
      const list = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      for (const doc of (docs || [])) {
        for (const entry of list) this.link(doc, entry);
      }
      return docs;
    }

    /**
     * Reverses every live entry of one source document inside its transaction.
     * Returns [] for legacy documents that have no journal entries yet.
     * @param {object} tx active transaction
     * @param {string} sourceType source type
     * @param {string} sourceId source id
     * @param {object} [meta] description/reason
     * @param {object} [options] {allowClosedDay}
     * @returns {Promise<object[]>} reversal entries
     */
    async reverseDocument(tx, sourceType, sourceId, meta, options) {
      if (!BeeStore.journal || !BeeStore.journal.reverseActiveSourceTx) return [];
      return BeeStore.journal.reverseActiveSourceTx(tx, sourceType, sourceId, meta, {
        allowClosedDay: options && options.allowClosedDay !== undefined
          ? options.allowClosedDay : true,
      });
    }

    _hasEvent(active, event) {
      return (active || []).some(e => e.event === event);
    }

    _hasEventPrefix(active, prefix) {
      return (active || []).some(e => String(e.event || '').indexOf(prefix + ':') === 0);
    }

    _paymentEvents(active, prefix) {
      const used = new Set();
      for (const entry of (active || [])) {
        const m = new RegExp('^' + prefix + ':(\\d+)$').exec(String(entry.event || ''));
        if (m) used.add(Number(m[1]));
      }
      return used;
    }

    async _sourceActive(tx, sourceType, sourceId) {
      if (!BeeStore.journal || !BeeStore.journal.activeForSourceTx) return [];
      return BeeStore.journal.activeForSourceTx(tx, sourceType, sourceId);
    }

    async _linkActive(tx, collection, doc, active) {
      if (!doc || !active || active.length === 0) return false;
      const before = (doc.journalEntryIds || []).length;
      this.linkAll([doc], active);
      if ((doc.journalEntryIds || []).length !== before) {
        tx.put(collection, doc);
        return true;
      }
      return false;
    }

    /**
     * Rebuilds every historical document into the journal, idempotently.
     * A2 entries without an event are kept; only missing A3 events are added,
     * and legacy cash-refund purchase returns receive a reclassification.
     * @param {object} [options] {force?:boolean,onProgress?:function}
     * @returns {Promise<object>} replay summary
     */
    async replayAll(options) {
      options = options || {};
      if (!this.available()) {
        throw BeeStore.errors.err('VALIDATION', 'خدمة الترحيل المحاسبي غير محمّلة');
      }
      if (!this.repo) {
        throw BeeStore.errors.err('VALIDATION', 'مستودع الترحيل غير مرتبط');
      }
      const startedAt = BeeStore.dates.now();
      const counts = {};
      const errors = [];
      const collections = [
        ['accounts', 'open:account:'],
        ['customers', 'open:customer:'],
        ['suppliers', 'open:supplier:'],
        ['purchases', null],
        ['purchaseReturns', null],
        ['sales', null],
        ['salesReturns', null],
        ['customerPayments', null],
        ['supplierPayments', null],
        ['expenses', null],
        ['employeeAdvances', null],
        ['payroll', null],
        ['ownerTransactions', null],
        ['transfers', null],
        ['cashAdjustments', null],
        ['stockMovements', null],
      ];
      for (const pair of collections) {
        const collection = pair[0];
        let docs = [];
        try {
          docs = await this.repo.list(collection);
        } catch (e) {
          errors.push({ collection, error: e.message || String(e) });
          continue;
        }
        counts[collection] = counts[collection] || { checked: 0, posted: 0, skipped: 0 };
        for (const doc of docs) {
          counts[collection].checked++;
          try {
            const posted = await this.repo.transaction(tx =>
              this._replayDocument(tx, collection, doc.id));
            if (posted > 0) counts[collection].posted += posted;
            else counts[collection].skipped++;
          } catch (e) {
            errors.push({
              collection,
              id: doc.id,
              error: e.message || String(e),
              code: e.code || null,
            });
            if (options.onProgress) options.onProgress({ collection, id: doc.id, error: e });
          }
        }
      }

      const summary = {
        startedAt,
        finishedAt: BeeStore.dates.now(),
        counts,
        errors,
        ok: errors.length === 0,
      };
      await this.repo.transaction(async (tx) => {
        const meta = (await tx.get('meta', 'meta')) || { id: 'meta' };
        meta.journalReplay = {
          ...(meta.journalReplay || {}),
          needed: false,
          version: 1,
          completedAt: summary.finishedAt,
          ok: summary.ok,
          errors: errors.length,
        };
        tx.put('meta', meta);
      });
      return summary;
    }

    async _replayDocument(tx, collection, id) {
      const doc = await tx.get(collection, id);
      if (!doc) return 0;
      let posted = 0;
      const add = (entry) => { if (entry) posted++; };
      const entries = (list) => {
        for (const entry of (list || [])) add(entry);
      };
      const reverseIfVoided = async (type, collection) => {
        if (!doc.voided && doc.status !== 'void') return false;
        const active = await this._sourceActive(tx, type, doc.id);
        if (active.length > 0) {
          await BeeStore.journal.reverseActiveSourceTx(tx, type, doc.id, {
            description: 'عكس مستند ملغي أثناء الترحيل',
          }, { allowClosedDay: true, replay: true });
          posted += active.length;
        }
        // Link the originals and their reversals onto the voided document so
        // the "عرض القيد" view remains complete even for replayed history.
        const all = await BeeStore.journal._forSourceTx(tx, type, doc.id);
        if (all.length > 0 && this._linkActive(tx, collection, doc, all)) posted++;
        return true;
      };

      switch (collection) {
        case 'accounts': {
          if (round(doc.openingBalanceMinor) === 0) return 0;
          const active = await this._sourceActive(tx, SOURCE.OPENING, 'open:account:' + doc.id);
          if (active.length === 0) add(await this.openingAccount(tx, doc, { replay: true }));
          return posted;
        }
        case 'customers': {
          if (round(doc.openingBalanceMinor) === 0) return 0;
          const active = await this._sourceActive(tx, SOURCE.OPENING, 'open:customer:' + doc.id);
          if (active.length === 0) add(await this.openingCustomer(tx, doc, { replay: true }));
          return posted;
        }
        case 'suppliers': {
          if (round(doc.openingBalanceMinor) === 0) return 0;
          const active = await this._sourceActive(tx, SOURCE.OPENING, 'open:supplier:' + doc.id);
          if (active.length === 0) add(await this.openingSupplier(tx, doc, { replay: true }));
          return posted;
        }
        case 'sales': {
          if (await reverseIfVoided(SOURCE.SALE, 'sales')) return posted;
          const active = await this._sourceActive(tx, SOURCE.SALE, doc.id);
          const hasCost = this._hasEvent(active, EVENTS.SALE_COST) ||
            active.some(e => !e.event);
          if (!hasCost) {
            let cogs = round(doc.cogsMinor);
            if (!cogs && Array.isArray(doc.lines)) {
              for (const line of doc.lines) {
                cogs += line.cogsMinor != null
                  ? round(line.cogsMinor) : round(line.unitCostMinor) * (Number(line.qty) || 0);
              }
            }
            add(await this.saleCost(tx, doc, cogs, { replay: true }));
          }
          if (!this._hasEvent(active, EVENTS.SALE_REVENUE)) {
            add(await this.saleRevenue(tx, doc, { replay: true }));
          }
          entries(await this.salePayments(tx, doc, {
            replay: true,
            skipIndexes: this._paymentEvents(active, EVENTS.SALE_PAYMENT),
          }));
          const nowActive = await this._sourceActive(tx, SOURCE.SALE, doc.id);
          await this._linkActive(tx, 'sales', doc, nowActive);
          return posted;
        }
        case 'salesReturns': {
          const active = await this._sourceActive(tx, SOURCE.SALE_RETURN, doc.id);
          const hasCost = this._hasEvent(active, EVENTS.SALE_RETURN_COST) ||
            active.some(e => !e.event);
          if (!hasCost) {
            add(await this.saleReturnCost(tx, doc, round(doc.restockCostMinor), { replay: true }));
          }
          if (!this._hasEvent(active, EVENTS.SALE_RETURN)) {
            add(await this.saleReturn(tx, doc, { replay: true }));
          }
          const nowActive = await this._sourceActive(tx, SOURCE.SALE_RETURN, doc.id);
          await this._linkActive(tx, 'salesReturns', doc, nowActive);
          return posted;
        }
        case 'customerPayments': {
          const active = await this._sourceActive(tx, SOURCE.CUSTOMER_PAYMENT, doc.id);
          if (active.length === 0) {
            add(await this.customerPayment(tx, doc, {
              replay: true,
              appliedMinor: doc.appliedMinor,
            }));
          }
          const nowActive = await this._sourceActive(tx, SOURCE.CUSTOMER_PAYMENT, doc.id);
          await this._linkActive(tx, 'customerPayments', doc, nowActive);
          return posted;
        }
        case 'purchases': {
          if (await reverseIfVoided(SOURCE.PURCHASE, 'purchases')) return posted;
          const active = await this._sourceActive(tx, SOURCE.PURCHASE, doc.id);
          const hasInventory = this._hasEvent(active, EVENTS.PURCHASE_INVENTORY) ||
            active.some(e => !e.event);
          if (!hasInventory) {
            const value = doc.inventoryValueMinor != null
              ? round(doc.inventoryValueMinor) : round(doc.totalMinor);
            add(await this.purchase(tx, doc, value, { replay: true }));
          }
          entries(await this.purchasePayments(tx, doc, {
            replay: true,
            skipIndexes: this._paymentEvents(active, EVENTS.PURCHASE_PAYMENT),
          }));
          const nowActive = await this._sourceActive(tx, SOURCE.PURCHASE, doc.id);
          await this._linkActive(tx, 'purchases', doc, nowActive);
          return posted;
        }
        case 'purchaseReturns': {
          if (await reverseIfVoided(SOURCE.PURCHASE_RETURN, 'purchaseReturns')) return posted;
          const active = await this._sourceActive(tx, SOURCE.PURCHASE_RETURN, doc.id);
          if (active.length === 0) {
            let removed = 0;
            for (const line of (doc.lines || [])) {
              removed += line.removedValueMinor != null
                ? round(line.removedValueMinor) : round(line.valueMinor);
            }
            add(await this.purchaseReturn(tx, doc, round(doc.totalMinor), removed, { replay: true }));
          } else if (doc.mode === 'cash_refund' &&
            !this._hasEvent(active, EVENTS.PURCHASE_RETURN_RECLASS) &&
            !this._hasEvent(active, EVENTS.PURCHASE_RETURN)) {
            add(await this.purchaseReturnReclass(tx, doc, { replay: true }));
          }
          const nowActive = await this._sourceActive(tx, SOURCE.PURCHASE_RETURN, doc.id);
          await this._linkActive(tx, 'purchaseReturns', doc, nowActive);
          return posted;
        }
        case 'supplierPayments': {
          const active = await this._sourceActive(tx, SOURCE.SUPPLIER_PAYMENT, doc.id);
          if (active.length === 0) add(await this.supplierPayment(tx, doc, { replay: true }));
          const nowActive = await this._sourceActive(tx, SOURCE.SUPPLIER_PAYMENT, doc.id);
          await this._linkActive(tx, 'supplierPayments', doc, nowActive);
          return posted;
        }
        case 'expenses': {
          if (await reverseIfVoided(SOURCE.EXPENSE, 'expenses')) return posted;
          if (doc.categoryName === 'رواتب') return 0;
          const active = await this._sourceActive(tx, SOURCE.EXPENSE, doc.id);
          if (active.length === 0) {
            entries(await this.expense(tx, doc, { replay: true }));
          }
          const nowActive = await this._sourceActive(tx, SOURCE.EXPENSE, doc.id);
          await this._linkActive(tx, 'expenses', doc, nowActive);
          return posted;
        }
        case 'employeeAdvances': {
          const active = await this._sourceActive(tx, SOURCE.EMPLOYEE_ADVANCE, doc.id);
          if (active.length === 0) add(await this.employeeAdvance(tx, doc, { replay: true }));
          const nowActive = await this._sourceActive(tx, SOURCE.EMPLOYEE_ADVANCE, doc.id);
          await this._linkActive(tx, 'employeeAdvances', doc, nowActive);
          return posted;
        }
        case 'payroll': {
          const active = await this._sourceActive(tx, SOURCE.PAYROLL, doc.id);
          if (!this._hasEvent(active, EVENTS.PAYROLL_ACCRUAL)) {
            add(await this.payrollAccrual(tx, doc, { replay: true }));
          }
          if (doc.status === 'paid' && doc.paidDate &&
            !this._hasEvent(active, EVENTS.PAYROLL_PAYMENT)) {
            add(await this.payrollPayment(tx, doc, { replay: true }));
          }
          const nowActive = await this._sourceActive(tx, SOURCE.PAYROLL, doc.id);
          await this._linkActive(tx, 'payroll', doc, nowActive);
          return posted;
        }
        case 'ownerTransactions': {
          if (await reverseIfVoided(SOURCE.OWNER_TRANSACTION, 'ownerTransactions')) return posted;
          const active = await this._sourceActive(tx, SOURCE.OWNER_TRANSACTION, doc.id);
          if (active.length === 0) add(await this.ownerTransaction(tx, doc, { replay: true }));
          const nowActive = await this._sourceActive(tx, SOURCE.OWNER_TRANSACTION, doc.id);
          await this._linkActive(tx, 'ownerTransactions', doc, nowActive);
          return posted;
        }
        case 'transfers': {
          if (await reverseIfVoided(SOURCE.TRANSFER, 'transfers')) return posted;
          const active = await this._sourceActive(tx, SOURCE.TRANSFER, doc.id);
          if (active.length === 0) add(await this.transfer(tx, doc, { replay: true }));
          const nowActive = await this._sourceActive(tx, SOURCE.TRANSFER, doc.id);
          await this._linkActive(tx, 'transfers', doc, nowActive);
          return posted;
        }
        case 'cashAdjustments': {
          if (await reverseIfVoided(SOURCE.CASH_ADJUSTMENT, 'cashAdjustments')) return posted;
          const active = await this._sourceActive(tx, SOURCE.CASH_ADJUSTMENT, doc.id);
          if (active.length === 0) add(await this.cashDifference(tx, doc, { replay: true }));
          const nowActive = await this._sourceActive(tx, SOURCE.CASH_ADJUSTMENT, doc.id);
          await this._linkActive(tx, 'cashAdjustments', doc, nowActive);
          return posted;
        }
        case 'stockMovements': {
          // Opening, adjustment/stocktake and revaluation movements are the
          // journal source. Sale/purchase/return movements are posted through
          // their documents and must never be posted twice here.
          if (doc.type !== 'opening' && doc.type !== 'adjustment' &&
            doc.type !== 'stocktake' && doc.type !== 'revaluation') return 0;
          const amount = doc.valueChangeMinor != null
            ? round(doc.valueChangeMinor) : round(doc.unitCostMinor) * (Number(doc.qtyChange) || 0);
          if (amount === 0) return 0;
          const linked = [];
          for (const entryId of (doc.journalEntryIds || [])) {
            const entry = await tx.get('journalEntries', entryId);
            if (entry && !entry.reversalOf) linked.push(entry);
          }
          if (linked.length > 0) return 0;
          if (doc.type === 'opening') {
            const active = await this._sourceActive(tx, SOURCE.OPENING, 'open:stock:' + doc.id);
            if (active.length > 0) {
              await this._linkActive(tx, 'stockMovements', doc, active);
              return 0;
            }
            add(await this.openingStock(tx, {
              date: doc.date,
              sourceId: 'open:stock:' + doc.id,
              description: 'مخزون افتتاحي ' + doc.date,
              valueMinor: amount,
              replay: true,
            }));
            const nowActive = await this._sourceActive(tx, SOURCE.OPENING, 'open:stock:' + doc.id);
            await this._linkActive(tx, 'stockMovements', doc, nowActive);
            return posted;
          }
          const sourceType = doc.type === 'revaluation'
            ? SOURCE.REVALUATION : SOURCE.STOCK_ADJUSTMENT;
          const active = await this._sourceActive(tx, sourceType, doc.id);
          if (active.length === 0) {
            add(doc.type === 'revaluation'
              ? await this.revaluation(tx, doc, amount, { replay: true })
              : await this.stockAdjustment(tx, doc, amount, { replay: true }));
          }
          const nowActive = await this._sourceActive(tx, sourceType, doc.id);
          await this._linkActive(tx, 'stockMovements', doc, nowActive);
          return posted;
        }
        default:
          return 0;
      }
    }
  }

  PostingService.EVENTS = EVENTS;
  PostingService.SOURCE = SOURCE;
  BeeStore.posting = new PostingService(null);
  BeeStore.PostingService = PostingService;
  if (typeof module !== 'undefined') module.exports = PostingService;
})(typeof window !== 'undefined' ? window : globalThis);
