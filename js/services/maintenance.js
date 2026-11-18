(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function roundMinor(value) {
    if (BeeStore.money && BeeStore.money.roundMinor) return BeeStore.money.roundMinor(value);
    return Math.round(Number(value) || 0);
  }

  function sameMinor(a, b) {
    return roundMinor(a) === roundMinor(b);
  }

  function canonicalMap(map) {
    const out = {};
    for (const key of Object.keys(map || {}).sort()) {
      const value = roundMinor(map[key]);
      if (value) out[key] = value;
    }
    return JSON.stringify(out);
  }

  function sameMap(a, b) {
    return canonicalMap(a) === canonicalMap(b);
  }

  function ageDays(timestamp, nowMs) {
    if (!timestamp) return null;
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return null;
    return Math.max(0, (Number(nowMs) - time) / (24 * 60 * 60 * 1000));
  }

  // Initial-stock corrections are entered through «تعديل الكمية» with this
  // reason. They change inventory value but their offset belongs to opening
  // equity (3030), not to stock P&L (5020/5030).
  const EQUITY_CORRECTION_NOTE = 'تصحيح';

  function trackedValue(movement) {
    if (!movement) return 0;
    if (movement.valueChangeMinor != null) {
      return roundMinor(movement.valueChangeMinor);
    }
    const qty = Number(movement.qtyChange) || 0;
    const unit = movement.avgCostAfterMinor != null
      ? Number(movement.avgCostAfterMinor) : (Number(movement.unitCostMinor) || 0);
    return roundMinor(qty * unit);
  }

  function isEquityCorrectionType(movement) {
    return !!movement &&
      (movement.type === 'adjustment' || movement.type === 'stocktake');
  }

  class MaintenanceService {
    constructor(repo) {
      this.repo = repo;
    }

    async recalculateStock() {
      return this.repo.transaction(async (tx) => {
        const allVariants = await tx.list('variants');
        const allMovements = await tx.list('stockMovements');
        const totals = {};
        for (const m of allMovements) {
          totals[m.variantId] = (totals[m.variantId] || 0) + m.qtyChange;
        }
        const updates = [];
        for (const v of allVariants) {
          const correctQty = totals[v.id] || 0;
          if (v.quantity !== correctQty) {
            const oldQty = v.quantity;
            v.quantity = correctQty;
            v.updatedAt = BeeStore.dates.now();
            tx.put('variants', v);
            updates.push({ id: v.id, old: oldQty, new: correctQty });
          }
        }
        return updates;
      });
    }

    /**
     * Read-only preview of initial-stock corrections that still sit in stock
     * P&L. By default it selects adjustment/stocktake movements whose reason
     * is «تصحيح»; pass {movementIds:[...]} to target explicit records.
     * @param {object} [options] {movementIds?:string[],note?:string}
     * @returns {Promise<object>} candidates, already reclassified, totals
     */
    async previewStockEquityReclassification(options) {
      options = options || {};
      const selectedIds = Array.isArray(options.movementIds)
        ? new Set(options.movementIds.map(String)) : null;
      const note = options.note != null
        ? String(options.note).trim() : EQUITY_CORRECTION_NOTE;
      const [movements, variants, products, journalEntries] = await Promise.all([
        this.repo.list('stockMovements'),
        this.repo.list('variants'),
        this.repo.list('products'),
        this.repo.list('journalEntries'),
      ]);
      const variantMap = new Map(variants.map(v => [v.id, v]));
      const productMap = new Map(products.map(p => [p.id, p]));
      const entriesBySource = new Map();
      for (const entry of journalEntries) {
        if (!entry || !entry.sourceId) continue;
        const key = String(entry.sourceType || '') + '\u0000' + String(entry.sourceId);
        const list = entriesBySource.get(key) || [];
        list.push(entry);
        entriesBySource.set(key, list);
      }
      const activeEntries = (movement) => {
        const all = [];
        for (const sourceType of ['STOCK_ADJUSTMENT', 'REVALUATION', 'STOCK_EQUITY_RECLASS']) {
          const rows = entriesBySource.get(sourceType + '\u0000' + movement.id) || [];
          for (const row of rows) all.push(row);
        }
        const reversed = new Set(all.filter(e => e.reversalOf).map(e => e.reversalOf));
        return all.filter(e => !e.reversalOf && !reversed.has(e.id));
      };
      const describe = (movement) => {
        const variant = variantMap.get(movement.variantId);
        const product = variant ? productMap.get(variant.productId) : null;
        const active = activeEntries(movement);
        const hasReclass = active.some(e => e.event === 'STOCK_EQUITY_RECLASS');
        const hasOriginal = active.some(e => e.event !== 'STOCK_EQUITY_RECLASS');
        return {
          id: movement.id,
          date: movement.date,
          type: movement.type,
          variantId: movement.variantId,
          itemCode: (variant && variant.itemCode) || (product && product.itemCode) || '',
          productName: (product && product.name) || '',
          size: (variant && variant.size) || '',
          color: (variant && variant.color) || '',
          qtyChange: Number(movement.qtyChange) || 0,
          valueChangeMinor: trackedValue(movement),
          note: movement.note || '',
          journalState: hasReclass ? 'reclassified' : (hasOriginal ? 'posted' : 'unposted'),
          journalNumbers: active.map(e => e.number).filter(Boolean),
        };
      };

      const candidates = [];
      const already = [];
      let totalMinor = 0;
      let alreadyMinor = 0;
      for (const movement of movements) {
        if (!isEquityCorrectionType(movement)) continue;
        const flagged = movement.pnlTreatment === 'equity';
        const selected = selectedIds
          ? selectedIds.has(String(movement.id))
          : String(movement.note || '').trim() === note;
        if (!flagged && !selected) continue;
        const value = trackedValue(movement);
        if (!flagged && value === 0) continue;
        const row = describe(movement);
        if (flagged) {
          already.push(row);
          alreadyMinor += value;
        } else {
          candidates.push(row);
          totalMinor += value;
        }
      }
      candidates.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.id).localeCompare(String(b.id)));
      already.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
        String(a.id).localeCompare(String(b.id)));
      return {
        note,
        candidates,
        already,
        count: candidates.length,
        totalMinor,
        alreadyCount: already.length,
        alreadyMinor,
      };
    }

    /**
     * Reclassifies initial-stock corrections from stock P&L to opening equity.
     * The journal stays append-only: a balanced reclassification entry is
     * appended for already-posted movements, and the movement is flagged
     * pnlTreatment='equity' so every report route excludes it. Idempotent.
     * @param {object} [options] {movementIds?:string[],note?:string}
     * @returns {Promise<object>} applied/skipped rows and the net amount
     */
    async reclassifyStockEquity(options) {
      options = options || {};
      if (!BeeStore.posting || !BeeStore.posting.available() ||
        !BeeStore.journal || !BeeStore.journal.activeForSourceTx) {
        throw BeeStore.errors.err('VALIDATION', 'خدمة الترحيل المحاسبي غير محمّلة');
      }
      const selectedIds = Array.isArray(options.movementIds)
        ? new Set(options.movementIds.map(String)) : null;
      const note = options.note != null
        ? String(options.note).trim() : EQUITY_CORRECTION_NOTE;
      const applied = [];
      const skipped = [];
      let totalMinor = 0;

      await this.repo.transaction(async (tx) => {
        const movements = await tx.list('stockMovements');
        for (const movement of movements) {
          if (!isEquityCorrectionType(movement)) continue;
          const selected = selectedIds
            ? selectedIds.has(String(movement.id))
            : String(movement.note || '').trim() === note;
          if (!selected) continue;
          if (movement.pnlTreatment === 'equity') {
            skipped.push({ id: movement.id, reason: 'already' });
            continue;
          }
          const value = trackedValue(movement);
          if (value === 0) {
            skipped.push({ id: movement.id, reason: 'zero' });
            continue;
          }

          let original = [];
          let reclass = [];
          for (const sourceType of ['STOCK_ADJUSTMENT', 'REVALUATION', 'STOCK_EQUITY_RECLASS']) {
            const active = await BeeStore.journal.activeForSourceTx(tx, sourceType, movement.id);
            for (const entry of active) {
              if (entry.event === 'STOCK_EQUITY_RECLASS') reclass.push(entry);
              else original.push(entry);
            }
          }

          let entry = null;
          if (reclass.length === 0) {
            entry = original.length > 0
              ? await BeeStore.posting.stockEquityReclass(tx, movement, value)
              : await BeeStore.posting.stockEquityAdjustment(tx, movement, value, {
                replay: true,
              });
            if (entry) BeeStore.posting.link(movement, entry);
          }

          movement.pnlTreatment = 'equity';
          movement.equityReclassifiedAt = BeeStore.dates.now();
          const reclassEntry = reclass[0] || entry;
          if (reclassEntry) movement.equityReclassEntryId = reclassEntry.id;
          tx.put('stockMovements', movement);

          applied.push({
            id: movement.id,
            valueChangeMinor: value,
            entryNumber: reclassEntry ? reclassEntry.number : null,
          });
          totalMinor += value;
        }
      });

      if (BeeStore.audit && applied.length > 0) {
        BeeStore.audit.record('stock_equity_reclass', 'stock', null,
          'تصنيف ' + applied.length + ' تسوية مخزون كرصيد افتتاحي بمقدار ' + totalMinor);
      }
      return { applied, skipped, totalMinor, count: applied.length };
    }

    async resetAll() {
      await this.repo.clearAll();
      return true;
    }

    /**
     * Data Integrity Checker, read-only (v2 §12.2). Blocking errors refuse
     * month closing; warnings are informational.
     * @returns {Promise<{errors:Array<{check:string,message:string,entityType:string,entityId:string|null}>,warnings:Array,checks:number}>}
     * @sideEffects none (reads only)
     */
    async integrityCheck() {
      const errors = [], warnings = [];
      const err = (check, message, entityType, entityId) =>
        errors.push({ check, message, entityType, entityId: entityId || null });
      const warn = (check, message, entityType, entityId) =>
        warnings.push({ check, message, entityType, entityId: entityId || null });
      const settings = (await this.repo.get('meta', 'settings')) || {};
      const meta = (await this.repo.get('meta', 'meta')) || {};
      const counters = (meta && meta.counters) || {};

      // 1. Stock ledger consistency.
      const variants = await this.repo.list('variants');
      const movements = await this.repo.list('stockMovements');
      const totals = {};
      for (const m of movements) {
        if (!m.variantId) continue;
        totals[m.variantId] = (totals[m.variantId] || 0) + (Number(m.qtyChange) || 0);
      }
      for (const v of variants) {
        if (v.quantity !== (totals[v.id] || 0)) {
          err('stock', 'مخزون "' + v.size + '/' + v.color + '" (' + v.quantity +
            ') لا يساوي مجموع الحركات (' + (totals[v.id] || 0) + ')', 'variant', v.id);
        }
        if (v.quantity < 0 && !settings.allowNegativeStock) {
          err('stock', 'مخزون سالب غير مسموح لصنف ' + v.size + '/' + v.color, 'variant', v.id);
        } else if (v.quantity < 0) {
          warn('stock', 'مخزون سالب لصنف ' + v.size + '/' + v.color, 'variant', v.id);
        }
      }

      // Existence maps for reference checks.
      const variantIds = new Set(variants.map(v => v.id));
      const productIds = new Set((await this.repo.list('products')).map(p => p.id));
      const customerIds = new Set((await this.repo.list('customers')).map(c => c.id));
      const supplierIds = new Set((await this.repo.list('suppliers')).map(s => s.id));
      const employeeIds = new Set((await this.repo.list('employees')).map(e => e.id));
      const accountList = await this.repo.list('accounts');
      const accountIds = new Set(accountList.map(a => a.id));

      // 2. Sale arithmetic + status coherence.
      const sales = await this.repo.list('sales');
      // Later collections live in customerPayments and cut dueMinor without
      // touching sale.payments; attribute the ones naming a sale so the paid
      // check below does not false-positive on installment-settled invoices.
      const linkedPaid = {};
      for (const p of await this.repo.list('customerPayments')) {
        if (p.saleId) linkedPaid[p.saleId] = (linkedPaid[p.saleId] || 0) + (BeeStore.money.roundMinor(p.amountMinor || 0) || 0);
      }
      const saleNumbers = new Set();
      for (const s of sales) {
        if (saleNumbers.has(s.number)) err('unique', 'رقم فاتورة مكرر: ' + s.number, 'sale', s.id);
        saleNumbers.add(s.number);
        if (s.status === 'void') continue;
        const lineSum = (s.lines || []).reduce((a, l) => a + (l.lineTotalMinor || 0), 0);
        const expectTotal = lineSum - (s.discountMinor || 0) + (s.taxMinor || 0);
        if (expectTotal !== s.totalMinor) {
          err('sale-math', 'فاتورة ' + s.number + ': المجموع لا يساوي البنود − الخصم + الضريبة', 'sale', s.id);
        }
        // v4 R2.2: only the part of each receipt applied to the invoice counts;
        // change handed back and overpayment kept as credit/income do not.
        const recordedPaid = (s.payments || []).reduce((a, p) => a + (BeeStore.money.roundMinor(
          p.appliedMinor != null ? p.appliedMinor : (p.amountMinor || 0)) || 0), 0);
        // paidMinor may legitimately exceed the sale-time payments once later
        // collections (customerPayments) are applied; flag only real drift:
        // negative, above total, or below what documents already recorded.
        if ((s.paidMinor || 0) < 0 || (s.paidMinor || 0) > s.totalMinor) {
          err('sale-math', 'فاتورة ' + s.number + ': المدفوع خارج النطاق الصحيح', 'sale', s.id);
        }
        if ((s.paidMinor || 0) < recordedPaid) {
          err('sale-math', 'فاتورة ' + s.number + ': المدفوع أقل من الدفعات المسجلة', 'sale', s.id);
        }
        if ((s.paidMinor || 0) < (linkedPaid[s.id] || 0)) {
          err('sale-math', 'فاتورة ' + s.number + ': المدفوع أقل من التحصيلات المرتبطة', 'sale', s.id);
        }
        if ((s.dueMinor || 0) !== s.totalMinor - (s.paidMinor || 0)) {
          err('sale-math', 'فاتورة ' + s.number + ': المتبقي غير متسق', 'sale', s.id);
        }
        const expectStatus = s.dueMinor <= 0 ? 'paid' : ((s.paidMinor || 0) > 0 ? 'partial' : 'unpaid');
        if (s.status !== expectStatus) {
          err('sale-math', 'فاتورة ' + s.number + ': الحالة يجب أن تكون ' + expectStatus, 'sale', s.id);
        }
        for (const l of (s.lines || [])) {
          if (!variantIds.has(l.variantId)) err('refs', 'فاتورة ' + s.number + ': صنف مفقود', 'sale', s.id);
          if ((l.returnedQty || 0) > l.qty) err('sale-math', 'فاتورة ' + s.number + ': المرتجع يتجاوز المباع', 'sale', s.id);
        }
        if (s.customerId && !customerIds.has(s.customerId)) err('refs', 'فاتورة ' + s.number + ': زبون مفقود', 'sale', s.id);
        for (const p of (s.payments || [])) {
          if (p.accountId && !accountIds.has(p.accountId)) err('refs', 'فاتورة ' + s.number + ': حساب دفع مفقود', 'sale', s.id);
        }
      }

      // 3. Purchases / returns / payroll coherence + refs.
      const purchases = await this.repo.list('purchases');
      const purNumbers = new Set();
      // Payable-reducing returns lower the invoice's remaining due (v5 §4
      // row 7); cash refunds leave it untouched.
      const payableReductions = {};
      for (const r of await this.repo.list('purchaseReturns')) {
        if (r.voided || r.mode === 'cash_refund' || !r.purchaseId) continue;
        payableReductions[r.purchaseId] = (payableReductions[r.purchaseId] || 0) +
          (Number(r.totalMinor) || 0);
      }
      for (const p of purchases) {
        if (purNumbers.has(p.number)) err('unique', 'رقم مشتريات مكرر: ' + p.number, 'purchase', p.id);
        purNumbers.add(p.number);
        if (p.status === 'void') continue;
        const sub = (p.lines || []).reduce((a, l) => a + (l.qty || 0) * (l.unitCostMinor || 0), 0);
        if (sub - (p.discountMinor || 0) !== p.totalMinor) {
          err('purchase-math', 'مشتريات ' + p.number + ': الإجمالي غير متسق', 'purchase', p.id);
        }
        if ((p.dueMinor || 0) !== p.totalMinor - (p.paidMinor || 0) - (payableReductions[p.id] || 0)) {
          err('purchase-math', 'مشتريات ' + p.number + ': المتبقي غير متسق', 'purchase', p.id);
        }
        if (p.supplierId && !supplierIds.has(p.supplierId)) err('refs', 'مشتريات ' + p.number + ': مورد مفقود', 'purchase', p.id);
        for (const l of (p.lines || [])) {
          if (!variantIds.has(l.variantId)) err('refs', 'مشتريات ' + p.number + ': صنف مفقود', 'purchase', p.id);
          if ((l.returnedQty || 0) > l.qty) err('purchase-math', 'مشتريات ' + p.number + ': المرتجع يتجاوز المشترى', 'purchase', p.id);
        }
      }
      const payroll = await this.repo.list('payroll');
      const seenEmpMonth = new Set();
      for (const p of payroll) {
        const key = p.employeeId + '|' + p.month;
        if (seenEmpMonth.has(key)) err('unique', 'راتب مكرر لموظف في ' + p.month, 'payroll', p.id);
        seenEmpMonth.add(key);
        const expectNet = (p.baseMinor || 0) + (p.bonusMinor || 0) + (p.overtimeMinor || 0) -
          (p.deductionsMinor || 0) - (p.withholdingMinor || 0) -
          (p.advanceRepaymentMinor || 0);
        if (p.status === 'paid' && p.netMinor !== expectNet) {
          err('payroll-math', 'راتب ' + p.employeeName + ' (' + p.month + '): الصافي غير متسق', 'payroll', p.id);
        }
        if (!employeeIds.has(p.employeeId)) err('refs', 'راتب (' + p.month + '): موظف مفقود', 'payroll', p.id);
      }

      // 4. Unique barcodes / SKUs.
      const seenCodes = {};
      for (const v of variants) {
        for (const field of ['barcode', 'sku']) {
          const code = v[field];
          if (!code) continue;
          if (seenCodes[field + ':' + code]) {
            err('unique', 'باركود/SKU مكرر: ' + code, 'variant', v.id);
          } else seenCodes[field + ':' + code] = true;
        }
        if (v.productId && !productIds.has(v.productId)) err('refs', 'صنف يشير لمنتج مفقود', 'variant', v.id);
      }

      // 5. Counters cover the highest used numbers.
      const maxSuffix = (rows) => {
        let max = 0;
        for (const r of (rows || [])) {
          const m = String(r.number || '').match(/-(\d+)$/);
          if (m) max = Math.max(max, Number(m[1]));
        }
        return max;
      };
      const counterNeeds = [
        ['invoice', sales], ['purchase', purchases],
        ['return', await this.repo.list('salesReturns')],
        ['purchaseReturn', await this.repo.list('purchaseReturns')],
      ];
      for (const [name, rows] of counterNeeds) {
        if ((counters[name] || 0) < maxSuffix(rows)) {
          err('counters', 'عداد ' + name + ' أقل من أعلى رقم مستخدم', 'meta', 'meta');
        }
      }

      // 6. Ledger running math + snapshot balances (today + closed months).
      for (const a of (await this.repo.list('accounts'))) {
        const ledger = await BeeStore.accounts.getLedger(a.id, null);
        let running = a.openingBalanceMinor || 0;
        for (const m of ledger) {
          running += m.amountMinor;
          if (running !== m.balanceAfter) {
            err('ledger', 'كشف حساب ' + a.name + ': رصيد مرحلي خاطئ بتاريخ ' + m.date, 'account', a.id);
            break;
          }
        }
      }
      const closings = await this.repo.list('periodClosings', c => c.status === 'closed');
      const monthEnds = closings.map(c => BeeStore.dates.monthRange(c.month).to);
      monthEnds.push(BeeStore.dates.today());
      for (const asOf of monthEnds) {
        const snap = await BeeStore.reports.balanceSnapshot(asOf);
        if (!snap.balanced) err('balance', 'الميزانية غير متوازنة بتاريخ ' + asOf, null, null);
      }

      // 7. Closed snapshots equal recomputation (headline figures).
      for (const c of closings) {
        const r = BeeStore.dates.monthRange(c.month);
        const pnl = await BeeStore.reports.profitAndLoss(r.from, r.to);
        const s = c.snapshot || {};
        for (const k of ['netSales', 'cogs', 'grossProfit', 'operatingExpenses', 'netProfit']) {
          if (s[k] !== pnl[k]) {
            err('snapshot', 'لقطة شهر ' + c.month + ' تختلف عن إعادة الحساب (' + k + ')', 'period', c.month);
            break;
          }
        }
      }

      // 8. Date rules: start bound, future bound, and documents that slipped
      // into a closed month AFTER it was locked (createdAt > closedAt).
      // Documents posted while the month was open are legitimate.
      const closedMonths = new Set(closings.map(c => c.month));
      const closedAt = {};
      for (const c of closings) closedAt[c.month] = c.closedAt;
      const datedChecks = [
        ['sales', 'sale'], ['salesReturns', 'sale-return'], ['purchases', 'purchase'],
        ['purchaseReturns', 'purchase-return'], ['customerPayments', 'customer-payment'],
        ['supplierPayments', 'supplier-payment'], ['expenses', 'expense'],
        ['expensePayments', 'expense-payment'],
        ['payrollLiabilityPayments', 'payroll-liability-payment'],
        ['fixedAssetPayments', 'fixed-asset-payment'],
        ['stockMovements', 'stock'], ['ownerTransactions', 'owner'],
        ['transfers', 'transfer'], ['dailyClosings', 'closing'],
        ['cashAdjustments', 'cash-adjustment'], ['cardSettlements', 'card-settlement'],
        ['employeeAdvances', 'advance'],
      ];
      for (const [coll] of datedChecks) {
        for (const r of (await this.repo.list(coll))) {
          if (!r.date) continue;
          if (settings.systemStartDate && r.date < settings.systemStartDate) {
            err('dates', 'مستند بتاريخ قبل بداية النظام: ' + r.date, coll, r.id);
          }
          if (settings.blockFutureDates !== false && r.date > BeeStore.dates.today()) {
            err('dates', 'مستند بتاريخ مستقبلي: ' + r.date, coll, r.id);
          }
          if (closedMonths.has(String(r.date).slice(0, 7))) {
            const lockTime = closedAt[String(r.date).slice(0, 7)] || '';
            if (r.createdAt && lockTime && r.createdAt > lockTime) {
              err('dates', 'مستند أُنشئ بعد إقفال شهره: ' + r.date, coll, r.id);
            }
          }
        }
      }
      for (const p of payroll) {
        if (closedMonths.has(p.month)) {
          warn('dates', 'سجل راتب لشهر مُقفل (مسموح الدفع فقط): ' + p.month, 'payroll', p.id);
        }
      }

      // 9. Spread shares sum; recurring (recurringId, month) unique.
      const seenRec = new Set();
      for (const e of (await this.repo.list('expenses'))) {
        if (e.voided) continue;
        if ((e.allocation || {}).mode === 'spread') {
          const shares = BeeStore.expenses.spreadShares(e);
          const sum = shares.reduce((a, s) => a + s.amountMinor, 0);
          if (sum !== e.amountMinor) err('spread', 'حصص التوزيع لا تساوي المبلغ', 'expense', e.id);
        }
        if (e.recurringId && e.month) {
          const key = e.recurringId + '|' + e.month;
          if (seenRec.has(key)) err('unique', 'مصروف متكرر مكرر لشهر ' + e.month, 'expense', e.id);
          seenRec.add(key);
        }
      }

      // 10. Every closed day must equal recomputation from its documents.
      // The closing's own adjustment / transfer / withdrawal are excluded so
      // the comparison is against the pre-closing day, not the frozen record.
      const dailyClosings = await this.repo.list('dailyClosings');
      const closedDays = dailyClosings
        .filter(c => c.status === 'closed' && c.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const closingById = {};
      for (const c of dailyClosings) closingById[c.id] = c;
      const fallbackDrawer = (settings.cashDrawerAccountId &&
        accountIds.has(settings.cashDrawerAccountId))
        ? settings.cashDrawerAccountId
        : ((accountList.find(a => a.type === 'cash') || {}).id || null);
      const drawerFor = (c) => (c && c.cashDrawerAccountId &&
        accountIds.has(c.cashDrawerAccountId))
        ? c.cashDrawerAccountId
        : fallbackDrawer;
      if (closedDays.length > 0 && !fallbackDrawer) {
        warn('drawer', 'لا يوجد حساب صندوق لتتبع إقفالات الأيام', null, null);
      }
      const closingFieldLabels = {
        openingCashMinor: 'الرصيد الافتتاحي',
        invoicesCount: 'عدد الفواتير',
        totalSalesMinor: 'إجمالي المبيعات',
        averageInvoiceMinor: 'متوسط الفاتورة',
        cashSalesMinor: 'المبيعات النقدية',
        customerCollectionsCashMinor: 'تحصيلات الزبائن النقدية',
        returnsCashRefundMinor: 'استردادات نقدية',
        supplierCashPaymentsMinor: 'مدفوعات الموردين النقدية',
        cashExpensesMinor: 'المصاريف النقدية',
        cashInOtherMinor: 'داخل نقدي آخر',
        cashOutOtherMinor: 'خارج نقدي آخر',
        expectedCashMinor: 'النقد المتوقع',
      };
      for (const c of closedDays) {
        const drawerId = drawerFor(c);
        if (!drawerId) continue;
        let figures;
        try {
          figures = await BeeStore.dailyClosing._figures(this.repo, c.date, {
            excludeClosingId: c.id,
            drawerAccountId: drawerId,
            externalTotals: c.externalTotals || {},
          });
        } catch (e) {
          err('closing-recompute', 'تعذّرت إعادة حساب إقفال يوم ' + c.date + ': ' +
            ((e && e.message) || e), 'daily-closing', c.id);
          continue;
        }
        const mismatched = [];
        for (const field of Object.keys(closingFieldLabels)) {
          const recorded = field === 'invoicesCount'
            ? (Number(c[field]) || 0)
            : roundMinor(c[field]);
          const recomputed = field === 'invoicesCount'
            ? (Number(figures[field]) || 0)
            : roundMinor(figures[field]);
          if (recorded !== recomputed) mismatched.push(closingFieldLabels[field]);
        }
        if (!sameMap(c.salesByMethod, figures.salesByMethod)) {
          mismatched.push('طرق دفع المبيعات');
        }
        if (!sameMap(c.customerCollectionsByMethod, figures.customerCollectionsByMethod)) {
          mismatched.push('طرق دفع التحصيلات');
        }
        if (!sameMinor(roundMinor(c.expectedCashMinor) + roundMinor(c.differenceMinor),
          c.countedCashMinor)) {
          mismatched.push('المعدود − المتوقع ≠ الفرق');
        }
        if (!sameMinor(roundMinor(c.countedCashMinor) - roundMinor(c.takenOutMinor),
          c.retainedFloatMinor)) {
          mismatched.push('المتبقي بعد الإخراج');
        }
        if (c.noCount && !sameMinor(c.differenceMinor, 0)) {
          mismatched.push('إقفال بدون جرد بفرق غير صفري');
        }
        if (mismatched.length > 0) {
          err('closing-recompute', 'إقفال يوم ' + c.date + ' لا يطابق إعادة الحساب (' +
            mismatched.join('، ') + ')', 'daily-closing', c.id);
        }
      }

      // 11. The drawer's current balance must equal the last closing's
      // retained float plus every later movement.
      let drawerCheck = null;
      if (closedDays.length > 0) {
        const last = closedDays[closedDays.length - 1];
        const drawerId = drawerFor(last);
        if (drawerId) {
          const retained = last.retainedFloatMinor === null ||
            last.retainedFloatMinor === undefined
            ? roundMinor(last.countedCashMinor) - roundMinor(last.takenOutMinor)
            : roundMinor(last.retainedFloatMinor);
          const today = BeeStore.dates.today();
          const from = BeeStore.dates.addDays(last.date, 1);
          const later = from <= today
            ? await BeeStore.accounts.getLedger(drawerId, { from, to: today })
            : [];
          const laterSum = later.reduce((sum, m) => sum + (Number(m.amountMinor) || 0), 0);
          const current = await BeeStore.accounts.balanceAsOf(drawerId, today);
          const expectedCurrent = retained + laterSum;
          drawerCheck = {
            date: last.date,
            drawerAccountId: drawerId,
            retainedFloatMinor: retained,
            laterMovementsMinor: laterSum,
            expectedMinor: expectedCurrent,
            actualMinor: roundMinor(current),
          };
          if (!sameMinor(current, expectedCurrent)) {
            err('drawer-balance',
              'رصيد الصندوق الحالي (' + roundMinor(current) + ') لا يساوي متبقي آخر إقفال (' +
              last.date + ': ' + retained + ') زائد الحركات اللاحقة (' + laterSum + ')',
              'account', drawerId);
          }
        }
      }

      // 12. cash_difference adjustments must match closed days exactly.
      const differenceAdjustments = await this.repo.list('cashAdjustments',
        a => !a.voided && a.sourceType === 'cash_difference');
      for (const a of differenceAdjustments) {
        const c = closingById[a.closingId];
        if (!c) {
          err('cash-adjustment', 'تسوية صندوق نشطة بلا إقفال مرتبط: ' + (a.date || ''), 'cash-adjustment', a.id);
          continue;
        }
        if (c.status !== 'closed') {
          err('cash-adjustment', 'تسوية صندوق نشطة لإقفال غير مُقفل (' + c.date + ')', 'cash-adjustment', a.id);
        }
        if (!sameMinor(a.amountMinor, c.differenceMinor)) {
          err('cash-adjustment', 'فرق تسوية الصندوق لا يطابق فرق إقفال يوم ' + c.date, 'cash-adjustment', a.id);
        }
        if (String(a.date) !== String(c.date)) {
          err('cash-adjustment', 'تاريخ تسوية الصندوق لا يطابق تاريخ إقفال يوم ' + c.date, 'cash-adjustment', a.id);
        }
        const drawerId = drawerFor(c);
        if (drawerId && a.accountId !== drawerId) {
          err('cash-adjustment', 'تسوية صندوق يوم ' + c.date + ' ليست على حساب الصندوق', 'cash-adjustment', a.id);
        }
      }
      for (const c of closedDays) {
        const linked = differenceAdjustments.filter(a => a.closingId === c.id);
        if (!sameMinor(c.differenceMinor, 0) && linked.length !== 1) {
          err('cash-adjustment', 'إقفال يوم ' + c.date + ' له فرق ' +
            roundMinor(c.differenceMinor) + ' لكن عدد تسويات الصندوق النشطة ' + linked.length,
            'daily-closing', c.id);
        }
        if (sameMinor(c.differenceMinor, 0) && linked.length > 0) {
          err('cash-adjustment', 'إقفال يوم ' + c.date + ' بلا فرق لكن توجد تسوية صندوق نشطة',
            'daily-closing', c.id);
        }
      }
      for (const month of closedMonths) {
        const closingSum = closedDays
          .filter(c => String(c.date).slice(0, 7) === month)
          .reduce((sum, c) => sum + roundMinor(c.differenceMinor), 0);
        const adjustmentSum = differenceAdjustments
          .filter(a => String(a.date).slice(0, 7) === month)
          .reduce((sum, a) => sum + roundMinor(a.amountMinor), 0);
        if (closingSum !== adjustmentSum) {
          err('cash-adjustment', 'مجموع فروقات إقفالات شهر ' + month + ' (' + closingSum +
            ') لا يساوي مجموع تسويات الصندوق (' + adjustmentSum + ')', 'period', month);
        }
      }

      // 13. Active days that stayed unclosed beyond the configured grace
      // period. This is a warning: the owner may still be catching up.
      const graceDays = Math.max(1, Number(settings.unclosedDayWarningDays || 3));
      const today = BeeStore.dates.today();
      let staleUnclosed = [];
      if (BeeStore.dailyClosing && BeeStore.dailyClosing._activityDates) {
        const latestClosed = closedDays.length ? closedDays[closedDays.length - 1].date : null;
        const from = latestClosed
          ? BeeStore.dates.addDays(latestClosed, 1)
          : BeeStore.dates.addDays(today, -60);
        const limit = BeeStore.dates.addDays(today, -graceDays);
        if (from <= today) {
          const activeDates = await BeeStore.dailyClosing._activityDates(this.repo, from, today);
          const closedSet = new Set(closedDays.map(c => c.date));
          staleUnclosed = activeDates.filter(d =>
            d < limit && !closedSet.has(d) && !closedMonths.has(String(d).slice(0, 7)));
          if (staleUnclosed.length > 0) {
            const shown = staleUnclosed.slice(0, 7).join('، ') +
              (staleUnclosed.length > 7 ? '، …' : '');
            warn('unclosed-days', staleUnclosed.length + ' يوم فيه حركة ولم يُقفل بعد (أقدم من ' +
              graceDays + ' أيام): ' + shown, null, null);
          }
        }
      }

      // 14. Backup freshness / off-device copy.
      let backup = null;
      const nowMs = new Date(BeeStore.dates.now()).getTime();
      if (BeeStore.backupFile && BeeStore.backupFile.backupStatus) {
        backup = BeeStore.backupFile.backupStatus(settings, meta, nowMs);
      } else {
        backup = {
          lastBackupAt: settings.lastBackupAt || settings.lastOffDeviceBackupAt || null,
          lastOffDeviceBackupAt: settings.lastOffDeviceBackupAt || null,
          ageDays: ageDays(settings.lastBackupAt || settings.lastOffDeviceBackupAt, nowMs),
          warnDays: Math.max(1, Number(settings.backupWarnDays || 2)),
          criticalDays: Math.max(1, Number(settings.backupCriticalDays || 7)),
        };
        backup.overdue = backup.ageDays !== null && backup.ageDays >= backup.warnDays;
        backup.critical = backup.ageDays !== null && backup.ageDays >= backup.criticalDays;
      }
      const hasBusinessData = sales.length > 0 || purchases.length > 0;
      if (hasBusinessData && backup) {
        if (backup.critical) {
          warn('backup', 'آخر نسخة احتياطية أقدم من ' + backup.criticalDays +
            ' أيام — أنشئ نسخة الآن', null, null);
        } else if (backup.overdue) {
          warn('backup', 'مرّ ' + Math.floor(backup.ageDays || 0) +
            ' يوم على آخر نسخة احتياطية (التنبيه بعد ' + backup.warnDays + ' أيام)', null, null);
        }
        const offAge = ageDays(backup.lastOffDeviceBackupAt, nowMs);
        if (!backup.lastOffDeviceBackupAt) {
          warn('backup-offsite', 'لا توجد نسخة احتياطية خارج الجهاز — شارك نسخة إلى Drive أو واتساب',
            null, null);
        } else if (offAge !== null && offAge >= backup.criticalDays) {
          warn('backup-offsite', 'آخر نسخة خارج الجهاز أقدم من ' + backup.criticalDays +
            ' أيام — شارك نسخة جديدة', null, null);
        }
      }

      // 15. Storage usage (the browser estimate; unsupported outside a browser).
      let storage = { supported: false, persisted: false, usage: null, quota: null };
      if (BeeStore.pwa && BeeStore.pwa.storageStatus) {
        try {
          storage = await BeeStore.pwa.storageStatus();
        } catch (e) { /* ignore */ }
      }
      if (storage && storage.quota) {
        const ratio = Number(storage.usage || 0) / Number(storage.quota);
        if (ratio >= 0.9) {
          warn('storage', 'مساحة المتصفح شبه ممتلئة (' + Math.round(ratio * 100) +
            '%) — صدّر نسخة احتياطية ونظّف الملفات القديمة', null, null);
        } else if (ratio >= 0.8) {
          warn('storage', 'مساحة المتصفح مستخدمة بنسبة ' + Math.round(ratio * 100) + '%',
            null, null);
        }
      }

      // 16. Clock anomaly state (the guard itself blocks posting; surface it
      // here so the month-closing checklist can show the reason).
      let clock = null;
      if (BeeStore.clockGuard && BeeStore.clockGuard.check) {
        try {
          clock = await BeeStore.clockGuard.check();
        } catch (e) { /* ignore */ }
        if (clock && clock.reasons && clock.reasons.length > 0) {
          warn('clock', 'تحذير وقت الهاتف: ' + clock.reasons.join(' '), null, null);
        }
      }

      // 17. v5 §9 journal integrity (A6): invariants, control accounts =
      // sub-ledgers, document ↔ journal, orphan entries, negative balances,
      // closed fiscal years.
      let journal = null;
      if (BeeStore.journalIntegrity && BeeStore.JournalIntegrityService) {
        const service = new BeeStore.JournalIntegrityService(this.repo);
        journal = await service.check();
        for (const e of journal.errors) err(e.check, e.message, e.entityType, e.entityId);
        for (const w of journal.warnings) warn(w.check, w.message, w.entityType, w.entityId);
      }

      return {
        errors, warnings, checks: 17,
        journal: journal ? { checked: journal.checked, skipped: journal.skipped } : null,
        backup,
        storage,
        clock,
        drawer: drawerCheck,
        unclosedDays: staleUnclosed,
      };
    }

    /**
     * Reviews how payment methods map to money accounts. Answers "where did the
     * money go?" after a method was deleted or re-pointed:
     * per method: account, usage counts, unsettled clearing balance;
     * plus orphan methods still holding money but missing from settings.
     * @returns {Promise<object>} {methods, orphans, totals, warnings}
     */
    async paymentAudit() {
      const settings = (await this.repo.get('meta', 'settings')) || {};
      const accounts = await this.repo.list('accounts');
      const summary = await this.repo.getSummary();
      const accountById = {};
      for (const a of accounts) accountById[a.id] = a;
      const methods = (settings.paymentMethods || []).map(m => m && m.id ? m : null)
        .filter(Boolean);
      const known = new Set(methods.map(m => m.id));
      const balances = await BeeStore.accounts.balances();
      const rows = [];
      for (const m of methods) {
        const account = m.accountId ? accountById[m.accountId] : null;
        const usage = await BeeStore.settings.usage(m.id);
        rows.push({
          id: m.id,
          name: m.name || m.id,
          kind: BeeStore.settings.methodKind(settings, m.id),
          active: m.active !== false,
          accountId: m.accountId || null,
          accountName: account ? account.name : '',
          accountActive: account ? account.active !== false : false,
          hasAccount: !!account,
          chartAccountId: m.chartAccountId || null,
          usage,
          unsettledMinor: BeeStore.summary.methodBalance(summary, m.id),
        });
      }
      // Money still held by a method that no longer exists in settings.
      const orphans = [];
      for (const id of Object.keys(summary.methodBalances || {})) {
        if (known.has(id)) continue;
        const amount = BeeStore.summary.methodBalance(summary, id);
        if (!amount) continue;
        const usage = await BeeStore.settings.usage(id);
        orphans.push({ id, unsettledMinor: amount, usage });
      }
      const activeBalances = balances;
      const totals = {
        accountsMinor: Object.keys(activeBalances)
          .reduce((sum, id) => sum + (activeBalances[id] || 0), 0),
        clearingMinor: Object.keys(summary.methodBalances || {})
          .reduce((sum, id) => sum + (summary.methodBalances[id] || 0), 0),
      };
      const warnings = [];
      for (const row of rows) {
        if (!row.hasAccount && row.kind !== 'customer_credit') {
          warnings.push({
            code: 'NO_ACCOUNT', methodId: row.id,
            message: 'طريقة الدفع «' + row.name + '» غير مرتبطة بأي حساب، لذلك لا يظهر رصيدها في صفحة الحسابات.',
          });
        }
        if (row.kind === 'clearing' && row.accountId &&
          row.accountActive === false) {
          warnings.push({
            code: 'INACTIVE_ACCOUNT', methodId: row.id,
            message: 'حساب طريقة الدفع «' + row.name + '» موقوف؛ المبالغ الجديدة لن تظهر في الحساب.',
          });
        }
      }
      for (const orphan of orphans) {
        warnings.push({
          code: 'DELETED_METHOD', methodId: orphan.id,
          message: 'طريقة الدفع «' + orphan.id + '» حُذفت من الإعدادات وما زال عليها ' +
            BeeStore.money.format(orphan.unsettledMinor) +
            '. أعد إضافتها بنفس المعرّف أو سوِّ مبلغها حتى لا يبقى الرصيد بلا حساب.',
        });
      }
      return { methods: rows, orphans, totals, warnings };
    }

    async isDatabaseEmpty() {
      const collections = [
        'products', 'variants', 'sales', 'salesReturns', 'customers', 'customerPayments',
        'suppliers', 'supplierPayments', 'purchases', 'expenses', 'expensePayments', 'expenseCategories',
        'employees', 'payroll', 'employeeAdvances', 'payrollLiabilityPayments',
        'fixedAssets', 'fixedAssetPayments', 'accounts', 'ownerTransactions',
        'transfers', 'recurringExpenses', 'stockMovements', 'cardSettlements',
      ];
      for (const name of collections) {
        const rows = await this.repo.list(name);
        if (rows.length > 0) return false;
      }
      return true;
    }
  }

  BeeStore.maintenance = new MaintenanceService(null);
  BeeStore.MaintenanceService = MaintenanceService;
  if (typeof module !== 'undefined') module.exports = MaintenanceService;
})(typeof window !== 'undefined' ? window : globalThis);
