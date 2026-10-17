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
      let returns = await this.repo.list('salesReturns');
      if (filters) {
        if (filters.from) returns = returns.filter(r => r.date >= filters.from);
        if (filters.to) returns = returns.filter(r => r.date <= filters.to);
      }
      const sales = await this.repo.list('sales');
      const saleMap = new Map(sales.map(s => [s.id, s]));
      for (const r of returns) {
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
    async create(data) {
      const ret = await this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        const sale = await tx.get('sales', data.saleId);
        if (!sale) throw BeeStore.errors.err('NOT_FOUND', 'الفاتورة غير موجودة');
        if (sale.status === 'void') throw BeeStore.errors.err('SALE_VOID', 'لا يمكن إرجاع فاتورة ملغاة');

        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.returnPrefix || 'RET') + '-' + String(await tx.nextCounter('return')).padStart(6, '0');

        const lines = [];
        let refundMinor = 0;
        for (const line of data.lines) {
          const saleLine = sale.lines[line.saleLineIndex];
          if (!saleLine) throw BeeStore.errors.err('INVALID_LINE', 'بند غير صالح');
          const alreadyReturned = saleLine.returnedQty || 0;
          const maxReturn = saleLine.qty - alreadyReturned;
          if (line.qty > maxReturn) {
            throw BeeStore.errors.err('EXCEEDS_SOLD', 'كمية المرتجع تتجاوز الكمية المباعة المتبقية');
          }
          const unitPriceMinor = saleLine.unitPriceMinor;
          const proportionalDiscount = saleLine.lineDiscountMinor > 0 ?
            Math.round(saleLine.lineDiscountMinor * line.qty / saleLine.qty) : 0;
          const lineRefund = BeeStore.money.mul(unitPriceMinor, line.qty) - proportionalDiscount;
          refundMinor += lineRefund;
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
          refundMode: data.refundMode || 'cash_refund',
          refundMethod: data.refundMode === 'cash_refund'
            ? (data.refundMethod || BeeStore.settings.resolvePaymentAccount(settings, 'cash'))
            : (data.refundMethod || null),
          reason: data.reason || '',
          exchangeSaleId: null,
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };

        tx.put('salesReturns', ret);

        for (const line of lines) {
          const saleLine = sale.lines[line.saleLineIndex];
          saleLine.returnedQty = (saleLine.returnedQty || 0) + line.qty;
          if (line.restock) {
            const variant = await tx.get('variants', line.variantId);
            let newAvg = line.unitCostMinor;
            if (variant) {
              newAvg = BeeStore.stock.blendCost(
                variant.quantity, variant.costMinor, line.qty, line.unitCostMinor);
              variant.quantity += line.qty;
              variant.costMinor = newAvg;
              variant.updatedAt = BeeStore.dates.now();
              tx.put('variants', variant);
            }
            tx.put('stockMovements', {
              id: BeeStore.ids.randomId('stm'),
              variantId: line.variantId,
              date: ret.date,
              type: 'sale_return',
              qtyChange: line.qty,
              unitCostMinor: line.unitCostMinor,
              avgCostAfterMinor: newAvg,
              refType: 'sale_return',
              refId: ret.id,
              note: 'مرتجع ' + ret.number,
              balanceAfter: variant ? variant.quantity : 0,
              createdAt: BeeStore.dates.now(),
            });
          }
        }

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
        createdAt: BeeStore.dates.now(),
        updatedAt: BeeStore.dates.now(),
      };
      tx.put('sales', sale);
      for (const line of lines) {
        const variant = await tx.get('variants', line.variantId);
        variant.quantity -= line.qty;
        variant.updatedAt = BeeStore.dates.now();
        tx.put('variants', variant);
        tx.put('stockMovements', {
          id: BeeStore.ids.randomId('stm'),
          variantId: line.variantId,
          date: sale.date,
          type: 'sale',
          qtyChange: -line.qty,
          unitCostMinor: line.unitCostMinor,
          avgCostAfterMinor: variant.costMinor,
          refType: 'sale',
          refId: sale.id,
          note: 'فاتورة استبدال ' + sale.number,
          balanceAfter: variant.quantity,
          createdAt: BeeStore.dates.now(),
        });
      }
      return sale;
    }
  }

  BeeStore.returns = new ReturnsService(null);
  BeeStore.ReturnsService = ReturnsService;
  if (typeof module !== 'undefined') module.exports = ReturnsService;
})(typeof window !== 'undefined' ? window : globalThis);
