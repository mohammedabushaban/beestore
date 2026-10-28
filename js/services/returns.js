(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class ReturnsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * List sale returns enriched with sale number and customer name.
     * @param {object} [filters] {from?, to?}
     * @returns {Promise<object[]>} returns sorted newest-first
     */
    async list(filters) {
      const from = filters && filters.from;
      const to = filters && filters.to;
      const returns = (from || to)
        ? await this.repo.listRange('salesReturns', from, to)
        : await this.repo.list('salesReturns');
      // Only the small set of referenced sales is fetched (lazily for months
      // older than the memory window) instead of loading every invoice.
      const saleMap = new Map();
      for (const r of returns) {
        if (!saleMap.has(r.saleId)) {
          saleMap.set(r.saleId, await this.repo.get('sales', r.saleId));
        }
        const sale = saleMap.get(r.saleId);
        r.saleNumber = sale ? sale.number : '';
        r.customerName = sale ? (sale.customerName || '') : '';
      }
      returns.sort((a, b) => b.date.localeCompare(a.date));
      return returns;
    }

    /**
     * Get a sale return by id.
     * @param {string} id return id
     * @returns {Promise<object|null>} the return or null when missing
     */
    async get(id) {
      return this.repo.get('salesReturns', id);
    }

    /**
     * Post a sale return: restocks, updates returnedQty, refunds or exchanges.
     * @param {object} data {saleId, date?, lines[{saleLineIndex,qty}], refundMode?, exchangeLines?}
     * @returns {Promise<object>} the created return
     * @throws {BeeError} NOT_FOUND | SALE_VOID | INVALID_LINE | EXCEEDS_SOLD | INSUFFICIENT_STOCK | PERIOD_CLOSED
     */
    /**
     * Refund quote for one linked sale line (v5 §3.1): the line discount is
     * allocated across returned units with the remainder taken by the final
     * return, so the refunded discounts always sum exactly to the line
     * discount. Shared with the cashier preview so both paths agree.
     * @param {object} saleLine stored sale line
     * @param {number} qty quantity being returned
     * @returns {{discountMinor:number,refundMinor:number,alreadyDiscountMinor:number}}
     */
    quoteRefund(saleLine, qty) {
      const qtySold = Number(saleLine.qty) || 0;
      const requested = Math.floor(Number(qty) || 0);
      if (qtySold <= 0 || requested <= 0) {
        return { discountMinor: 0, refundMinor: 0, alreadyDiscountMinor: 0 };
      }
      const returnedQty = Number(saleLine.returnedQty) || 0;
      const remainingQty = Math.max(0, qtySold - returnedQty);
      const lineDiscount = Math.max(0,
        Math.round(Number(saleLine.lineDiscountMinor) || 0));
      const tracked = Number(saleLine.returnedDiscountMinor);
      const alreadyDiscount = Math.min(lineDiscount, Math.max(0,
        Number.isFinite(tracked) && saleLine.returnedDiscountMinor != null
          ? tracked
          : Math.round(lineDiscount * returnedQty / qtySold)));
      const remainingDiscount = lineDiscount - alreadyDiscount;
      const discountMinor = requested >= remainingQty
        ? remainingDiscount
        : Math.round(remainingDiscount * requested / remainingQty);
      return {
        discountMinor,
        refundMinor: BeeStore.money.mul(saleLine.unitPriceMinor, requested) - discountMinor,
        alreadyDiscountMinor: alreadyDiscount,
      };
    }

    async create(data) {
      const ret = await this.repo.transaction(async (tx) => {
        const returnDate = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, returnDate);
        await BeeStore.periods.assertDayOpen(tx, returnDate);
        const sale = await tx.get('sales', data.saleId);
        if (!sale) throw BeeStore.errors.err('NOT_FOUND', 'الفاتورة غير موجودة');
        if (sale.status === 'void') throw BeeStore.errors.err('SALE_VOID', 'لا يمكن إرجاع فاتورة ملغاة');

        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.returnPrefix || 'RET') + '-' + String(await tx.nextCounter('return')).padStart(6, '0');

        const lines = [];
        let refundMinor = 0;
        const seenLines = new Set();
        for (const line of data.lines) {
          const saleLine = sale.lines[line.saleLineIndex];
          if (!saleLine) throw BeeStore.errors.err('INVALID_LINE', 'بند غير صالح');
          if (seenLines.has(line.saleLineIndex)) {
            throw BeeStore.errors.err('INVALID_LINE', 'لا يمكن تكرار بند الفاتورة في المرتجع نفسه');
          }
          seenLines.add(line.saleLineIndex);
          const alreadyReturned = saleLine.returnedQty || 0;
          const maxReturn = saleLine.qty - alreadyReturned;
          if (line.qty > maxReturn) {
            throw BeeStore.errors.err('EXCEEDS_SOLD', 'كمية المرتجع تتجاوز الكمية المباعة المتبقية');
          }
          const unitPriceMinor = saleLine.unitPriceMinor;
          const quote = this.quoteRefund(saleLine, line.qty);
          const lineRefund = quote.refundMinor;
          refundMinor += lineRefund;
          saleLine.returnedDiscountMinor =
            quote.alreadyDiscountMinor + quote.discountMinor;
          // v5 §3.2: a returned unit comes back at the exact cost that was
          // charged to COGS when it sold. Track the already-returned cost so
          // the final return takes the remaining value exactly.
          const soldCost = saleLine.cogsMinor != null
            ? Math.round(Number(saleLine.cogsMinor) || 0)
            : BeeStore.money.mul(saleLine.unitCostMinor, saleLine.qty);
          const alreadyQty = Number(saleLine.returnedQty) || 0;
          const alreadyCost = Number(saleLine.returnedCostMinor) || 0;
          const remainingQty = saleLine.qty - alreadyQty;
          let returnedCostMinor;
          if (line.qty === remainingQty) {
            returnedCostMinor = soldCost - alreadyCost;
          } else if (alreadyQty === 0) {
            returnedCostMinor = Math.round(soldCost * line.qty / saleLine.qty);
          } else {
            returnedCostMinor = Math.round(
              (soldCost - alreadyCost) * line.qty / remainingQty);
          }
          saleLine.returnedCostMinor = alreadyCost + returnedCostMinor;
          lines.push({
            saleLineIndex: line.saleLineIndex,
            variantId: saleLine.variantId,
            productName: saleLine.productName,
            size: saleLine.size,
            color: saleLine.color,
            qty: line.qty,
            unitPriceMinor,
            unitCostMinor: saleLine.unitCostMinor,
            restock: line.restock !== false,
            lineRefundMinor: lineRefund,
            returnedCostMinor,
            restockCostMinor: line.restock !== false ? returnedCostMinor : 0,
            valueChangeMinor: 0,
          });
        }

        const ret = {
          id: BeeStore.ids.randomId('ret'),
          number,
          date: data.date || BeeStore.dates.today(),
          saleId: sale.id,
          customerId: sale.customerId,
          lines,
          refundMinor,
          restockCostMinor: 0,
          refundMode: data.refundMode || 'cash_refund',
          refundMethod: data.refundMode === 'cash_refund'
            ? (data.refundMethod || BeeStore.settings.resolvePaymentAccount(settings, 'cash'))
            : (data.refundMethod || null),
          reason: data.reason || '',
          exchangeSaleId: null,
          createdByProfile: data.createdByProfile || null,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };

        tx.put('salesReturns', ret);

        let restockCostMinor = 0;
        const returnMovements = [];
        for (const line of lines) {
          const saleLine = sale.lines[line.saleLineIndex];
          saleLine.returnedQty = (saleLine.returnedQty || 0) + line.qty;
          if (line.restock) {
            const variant = await tx.get('variants', line.variantId);
            let change = {
              valueChangeMinor: line.restockCostMinor,
              valueAfterMinor: 0,
              avgCostAfterMinor: line.unitCostMinor,
            };
            if (variant) {
              // Exact original COGS, not today's average (§3.2 / §4 row 3b).
              change = BeeStore.stock.restore(variant, line.qty, line.restockCostMinor);
              tx.put('variants', variant);
            }
            line.valueChangeMinor = change.valueChangeMinor;
            const movement = {
              id: BeeStore.ids.randomId('stm'),
              variantId: line.variantId,
              date: ret.date,
              type: 'sale_return',
              qtyChange: line.qty,
              unitCostMinor: line.qty > 0
                ? Math.round(line.restockCostMinor / line.qty)
                : line.unitCostMinor,
              valueChangeMinor: change.valueChangeMinor,
              valueAfterMinor: change.valueAfterMinor,
              avgCostAfterMinor: change.avgCostAfterMinor,
              refType: 'sale_return',
              refId: ret.id,
              note: 'مرتجع ' + ret.number,
              balanceAfter: variant ? variant.quantity : 0,
              journalEntryIds: [],
              createdAt: BeeStore.dates.now(),
            };
            tx.put('stockMovements', movement);
            returnMovements.push(movement);
            restockCostMinor += line.restockCostMinor;
          }
        }
        ret.restockCostMinor = restockCostMinor;

        if (BeeStore.posting) {
          const entry = await BeeStore.posting.saleReturnCost(tx, ret, restockCostMinor);
          if (entry) {
            BeeStore.posting.linkAll([ret].concat(returnMovements), entry);
            for (const movement of returnMovements) tx.put('stockMovements', movement);
          }
        }
        tx.put('salesReturns', ret);

        const totalReturned = sale.lines.reduce((sum, l) => sum + (l.returnedQty || 0), 0);
        const totalSold = sale.lines.reduce((sum, l) => sum + l.qty, 0);
        sale.returnStatus = totalReturned >= totalSold ? 'full' : 'partial';
        sale.updatedAt = BeeStore.dates.now();
        tx.put('sales', sale);

        if (data.refundMode === 'cash_refund' && data.refundMethod) {
          const account = await tx.get('accounts', data.refundMethod);
          if (account) {
            account.updatedAt = BeeStore.dates.now();
            tx.put('accounts', account);
          }
        }

        if (data.refundMode === 'exchange' && data.exchangeLines) {
          const exchangeSale = await this._createExchangeSale(tx, sale, data.exchangeLines, ret);
          ret.exchangeSaleId = exchangeSale.id;
          tx.put('salesReturns', ret);
        }

        return ret;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('return', 'sale', ret.saleId, 'مرتجع ' + ret.number + ' بمبلغ ' + ret.refundMinor + ' (' + ret.refundMode + ')');
      }
      return ret;
    }

    async _createExchangeSale(tx, originalSale, exchangeLines, ret) {
      const settings = await tx.get('meta', 'settings') || {};
      const number = (settings.invoicePrefix || 'INV') + '-' + String(await tx.nextCounter('invoice')).padStart(6, '0');
      const lines = [];
      for (const line of exchangeLines) {
        const variant = await tx.get('variants', line.variantId);
        if (!variant) continue;
        const product = await tx.get('products', variant.productId);
        const unitPriceMinor = BeeStore.money.roundMinor(line.unitPriceMinor);
        const qty = line.qty;
        if (!settings.allowNegativeStock && variant.quantity < qty) {
          throw BeeStore.errors.err('INSUFFICIENT_STOCK', 'الكمية المتوفرة من "' + (product ? product.name : '') + ' - ' + variant.size + ' - ' + variant.color + '" غير كافية. المتوفر: ' + variant.quantity);
        }
        lines.push({
          variantId: variant.id,
          productName: product ? product.name : '',
          size: variant.size,
          color: variant.color,
          barcode: variant.barcode,
          qty,
          unitPriceMinor,
          unitCostMinor: variant.costMinor,
          lineDiscountMinor: 0,
          lineTotalMinor: BeeStore.money.mul(unitPriceMinor, qty),
          returnedQty: 0,
          returnedCostMinor: 0,
          returnedDiscountMinor: 0,
          cogsMinor: 0,
          costEstimated: false,
          costFlag: null,
        });
      }
      if (lines.length === 0) {
        throw BeeStore.errors.err('INVALID_LINE', 'لا توجد أصناف للاستبدال');
      }
      const subtotalMinor = BeeStore.money.sum(lines.map(l => l.lineTotalMinor));
      const totalMinor = subtotalMinor;
      const creditMinor = Math.min(ret.refundMinor, totalMinor);
      const dueMinor = totalMinor - creditMinor;
      let status = 'paid';
      if (creditMinor === 0) status = originalSale.customerId ? 'unpaid' : 'paid';
      else if (creditMinor < totalMinor) status = 'partial';
      if ((status === 'unpaid' || status === 'partial') && !originalSale.customerId) {
        throw BeeStore.errors.err('CUSTOMER_REQUIRED', 'الاستبدال بقيمة أعلى من المرتجع يتطلب زبوناً');
      }
      const sale = {
        id: BeeStore.ids.randomId('sal'),
        number,
        date: ret.date,
        time: BeeStore.dates.nowTime(),
        customerId: originalSale.customerId,
        customerName: originalSale.customerName,
        soldByEmployeeId: null,
        lines,
        subtotalMinor,
        discount: null,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor,
        payments: [],
        paidMinor: creditMinor,
        dueMinor,
        status,
        returnStatus: 'none',
        installmentPlan: null,
        notes: 'استبدال من ' + ret.number,
        createdByProfile: ret.createdByProfile || originalSale.createdByProfile || null,
        cogsMinor: 0,
        costEstimated: false,
        costFlag: null,
        journalEntryIds: [],
        createdAt: BeeStore.dates.now(),
        updatedAt: BeeStore.dates.now(),
      };
      tx.put('sales', sale);
      let totalCogsMinor = 0;
      let costEstimated = false;
      const saleMovements = [];
      for (const line of lines) {
        const variant = await tx.get('variants', line.variantId);
        const change = BeeStore.stock.issue(variant, line.qty);
        line.cogsMinor = change.cogsMinor;
        line.costEstimated = change.estimated;
        line.costFlag = change.estimated ? 'COST_ESTIMATED' : null;
        totalCogsMinor += change.cogsMinor;
        if (change.estimated) costEstimated = true;
        tx.put('variants', variant);
        const movement = {
          id: BeeStore.ids.randomId('stm'),
          variantId: line.variantId,
          date: sale.date,
          type: 'sale',
          qtyChange: -line.qty,
          unitCostMinor: line.qty > 0
            ? Math.round(Math.abs(change.cogsMinor) / line.qty)
            : line.unitCostMinor,
          valueChangeMinor: change.valueChangeMinor,
          valueAfterMinor: change.valueAfterMinor,
          avgCostAfterMinor: change.avgCostAfterMinor,
          estimated: !!change.estimated,
          costFlag: change.estimated ? 'COST_ESTIMATED' : null,
          refType: 'sale',
          refId: sale.id,
          note: 'فاتورة استبدال ' + sale.number,
          balanceAfter: variant.quantity,
          journalEntryIds: [],
          createdAt: BeeStore.dates.now(),
        };
        tx.put('stockMovements', movement);
        saleMovements.push(movement);
      }
      sale.cogsMinor = totalCogsMinor;
      sale.costEstimated = costEstimated;
      sale.costFlag = costEstimated ? 'COST_ESTIMATED' : null;
      if (BeeStore.posting) {
        const entry = await BeeStore.posting.saleCost(tx, sale, totalCogsMinor);
        if (entry) {
          BeeStore.posting.linkAll([sale].concat(saleMovements), entry);
          for (const movement of saleMovements) tx.put('stockMovements', movement);
        }
      }
      tx.put('sales', sale);
      return sale;
    }
  }

  BeeStore.returns = new ReturnsService(null);
  BeeStore.ReturnsService = ReturnsService;
  if (typeof module !== 'undefined') module.exports = ReturnsService;
})(typeof window !== 'undefined' ? window : globalThis);
