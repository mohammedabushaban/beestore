(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class SalesService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * List sale invoices, optionally filtered by status/customer/date/search.
     * @param {object} [filters] {status?, customerId?, from?, to?, search?}
     * @returns {Promise<object[]>} sales sorted newest-first
     */
    async list(filters) {
      // L2 §5: month-scoped pages must not read years of invoices into memory.
      // listRange uses the IndexedDB date index for documents outside the
      // memory window; the memory repository filters the same way.
      const from = filters && filters.from;
      const to = filters && filters.to;
      let sales = (from || to)
        ? await this.repo.listRange('sales', from, to)
        : await this.repo.list('sales');
      if (filters) {
        if (filters.status) sales = sales.filter(s => s.status === filters.status);
        if (filters.customerId) sales = sales.filter(s => s.customerId === filters.customerId);
        if (filters.search) {
          const q = filters.search.toLowerCase();
          sales = sales.filter(s => s.number.toLowerCase().includes(q) ||
            (s.customerName || '').toLowerCase().includes(q));
        }
      }
      sales.sort((a, b) => (b.date + b.number).localeCompare(a.date + a.number));
      return sales;
    }

    /**
     * Get a sale invoice by id.
     * @param {string} id sale id
     * @returns {Promise<object|null>} the sale or null when missing
     */
    async get(id) {
      return this.repo.get('sales', id);
    }

    /**
     * Find a sale invoice by its human-readable number.
     * @param {string} number invoice number (e.g. INV-000123)
     * @returns {Promise<object|null>} the sale or null when not found
     */
    async getByNumber(number) {
      const results = await this.repo.query('sales', 'number', number);
      return results.length > 0 ? results[0] : null;
    }

    /**
     * Search posted sales for the returns dialog by number/customer/phone.
     * @param {string} query free-text search string
     * @returns {Promise<object[]>} matching sales sorted newest-first
     */
    async searchForReturn(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      let sales = await this.repo.list('sales');
      const customers = await this.repo.list('customers');
      const phoneMatchIds = new Set(
        customers.filter(c => (c.phone || '').toLowerCase().includes(q)).map(c => c.id)
      );
      sales = sales.filter(s =>
        (s.number || '').toLowerCase().includes(q) ||
        (s.customerName || '').toLowerCase().includes(q) ||
        (s.customerId && phoneMatchIds.has(s.customerId))
      );
      sales.sort((a, b) => (b.date + b.number).localeCompare(a.date + a.number));
      return sales;
    }

    /**
     * Post a sale invoice in one transaction: stock moves (avg cost), cash
     * ledger entries, customer debt, optional installments.
     * @param {object} data {date, lines[{variantId,qty,unitPriceMinor,...}], payments[], customerId?, discount?, installmentPlan?, clientKey?}
     * @returns {Promise<object>} the sale (with `duplicate:true` when a
     *   repeated clientKey echoes an already-posted invoice)
     * @throws {BeeError} VALIDATION | PERIOD_CLOSED | NOT_FOUND | INSUFFICIENT_STOCK | CUSTOMER_REQUIRED
     */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, data.date || BeeStore.dates.today());
        // v2 §12.1.3 double-submit: a clientKey identifies one user intent.
        // A repeated create with the same key returns the original invoice
        // instead of posting twice (checked inside the same transaction).
        if (data.clientKey) {
          // Indexed lookup instead of scanning every invoice: saving must stay
          // under the L2 100 ms budget even with 50k historical invoices.
          const dup = (await tx.query('sales', 'clientKey', data.clientKey))
            .filter(s => s.status !== 'void');
          if (dup.length > 0) return { ...dup[0], duplicate: true };
        }
        const settings = await tx.get('meta', 'settings') || {};
        const number = (settings.invoicePrefix || 'INV') + '-' + String(await tx.nextCounter('invoice')).padStart(6, '0');

        if (!Array.isArray(data.lines) || data.lines.length === 0) {
          throw BeeStore.errors.err('VALIDATION', 'الفاتورة يجب أن تحتوي على صنف واحد على الأقل');
        }
        const lines = [];
        for (const line of data.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (!variant) throw BeeStore.errors.err('NOT_FOUND', 'الصنف غير موجود: ' + line.variantId);
          const product = await tx.get('products', variant.productId);
          const qty = Number(BeeStore.money.normalizeDigits(line.qty));
          if (!Number.isInteger(qty) || qty <= 0) {
            throw BeeStore.errors.err('VALIDATION', 'الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر');
          }
          if (!settings.allowNegativeStock && variant.quantity < qty) {
            throw BeeStore.errors.err('INSUFFICIENT_STOCK', 'الكمية المتوفرة من "' + (product ? product.name : '') + ' - ' + variant.size + ' - ' + variant.color + '" غير كافية. المتوفر: ' + variant.quantity);
          }
          const unitPriceMinor = BeeStore.money.roundMinor(line.unitPriceMinor);
          if (unitPriceMinor < 0) {
            throw BeeStore.errors.err('VALIDATION', 'سعر الصنف لا يمكن أن يكون سالباً');
          }
          const lineDiscountMinor = BeeStore.money.roundMinor(line.lineDiscountMinor || 0);
          const grossMinor = BeeStore.money.mul(unitPriceMinor, qty);
          if (lineDiscountMinor < 0 || lineDiscountMinor > grossMinor) {
            throw BeeStore.errors.err('VALIDATION', 'خصم البند لا يمكن أن يتجاوز قيمته');
          }
          const lineTotalMinor = grossMinor - lineDiscountMinor;
          lines.push({
            variantId: variant.id,
            productName: product ? product.name : '',
            size: variant.size,
            color: variant.color,
            barcode: variant.barcode,
            qty,
            unitPriceMinor,
            unitCostMinor: variant.costMinor,
            lineDiscountMinor,
            lineTotalMinor,
            returnedQty: 0,
          });
        }

        const subtotalMinor = BeeStore.money.sum(lines.map(l => l.lineTotalMinor));
        let discountMinor = 0;
        if (data.discount) {
          if (data.discount.type === 'percent') {
            discountMinor = Math.round(subtotalMinor * data.discount.value / 100);
          } else {
            discountMinor = BeeStore.money.fromMajor(data.discount.value);
          }
          if (!isFinite(discountMinor) || discountMinor < 0) {
            throw BeeStore.errors.err('VALIDATION', 'قيمة الخصم غير صالحة');
          }
          if (discountMinor > subtotalMinor) discountMinor = subtotalMinor;
        }

        let taxMinor = 0;
        if (settings.taxEnabled && settings.taxRate > 0) {
          const taxable = subtotalMinor - discountMinor;
          if (settings.taxIncludedInPrices) {
            taxMinor = taxable - Math.round(taxable * 100 / (100 + settings.taxRate));
          } else {
            taxMinor = Math.round(taxable * settings.taxRate / 100);
          }
        }

        const totalMinor = subtotalMinor - discountMinor + taxMinor;

        if (totalMinor <= 0) {
          throw BeeStore.errors.err('INVALID', 'لا يمكن حفظ فاتورة بمبلغ صفر - تأكد من سعر الصُنف أو قيمة الخصم');
        }

        const payments = [];
        let paidMinor = 0;
        const payerName = (data.payerName || '').trim();
        const contactPhone = (data.contactPhone || '').trim();
        if (data.payments) {
          for (const p of data.payments) {
            const amt = BeeStore.money.roundMinor(p.amountMinor);
            if (!isFinite(amt) || amt < 0) {
              throw BeeStore.errors.err('VALIDATION', 'مبلغ الدفعة غير صالح');
            }
            const accountId = p.accountId || BeeStore.settings.resolvePaymentAccount(settings, p.method);
            const entry = {
              method: p.method,
              accountId: accountId,
              amountMinor: amt,
              date: p.date || data.date || BeeStore.dates.today(),
            };
            if (payerName) entry.payerName = payerName;
            if (contactPhone) entry.payerPhone = contactPhone;
            payments.push(entry);
            paidMinor += amt;
          }
        }
        if (paidMinor > totalMinor) paidMinor = totalMinor;
        const dueMinor = totalMinor - paidMinor;

        let status = 'paid';
        if (dueMinor > 0) status = paidMinor > 0 ? 'partial' : 'unpaid';

        if ((status === 'unpaid' || status === 'partial') && !data.customerId) {
          throw BeeStore.errors.err('CUSTOMER_REQUIRED', 'البيع الآجل أو الجزئي يتطلب اختيار زبون');
        }

        const sale = {
          id: BeeStore.ids.randomId('sal'),
          number,
          clientKey: data.clientKey || null,
          date: data.date || BeeStore.dates.today(),
          time: data.time || BeeStore.dates.nowTime(),
          customerId: data.customerId || null,
          customerName: data.customerName || null,
          contactPhone: (data.contactPhone || '').trim() || null,
          payerName: (data.payerName || '').trim() || null,
          soldByEmployeeId: data.soldByEmployeeId || null,
          lines,
          subtotalMinor,
          discount: data.discount || null,
          discountMinor,
          taxMinor,
          totalMinor,
          payments,
          paidMinor,
          dueMinor,
          status,
          returnStatus: 'none',
          installmentPlan: null,
          notes: data.notes || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };

        if (data.installmentPlan && data.customerId) {
          sale.installmentPlan = this._buildInstallmentPlan(data.installmentPlan, totalMinor, paidMinor, data.date || BeeStore.dates.today());
        }

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
            note: 'فاتورة ' + sale.number,
            balanceAfter: variant.quantity,
            createdAt: BeeStore.dates.now(),
          });
        }

        if (data.customerId) {
          const customer = await tx.get('customers', data.customerId);
          if (customer) {
            customer.updatedAt = BeeStore.dates.now();
            tx.put('customers', customer);
          }
        }

        return sale;
      });
    }

    _buildInstallmentPlan(plan, totalMinor, paidMinor, date) {
      const downPaymentMinor = paidMinor;
      const remaining = totalMinor - downPaymentMinor;
      const count = plan.count;
      const frequency = plan.frequency || 'monthly';
      const firstDueDate = plan.firstDueDate || BeeStore.dates.addMonths(date, 1);
      const schedule = [];
      const baseAmount = Math.floor(remaining / count);
      let allocated = 0;
      for (let i = 0; i < count; i++) {
        let dueDate;
        if (frequency === 'weekly') dueDate = BeeStore.dates.addDays(firstDueDate, i * 7);
        else if (frequency === 'biweekly') dueDate = BeeStore.dates.addDays(firstDueDate, i * 14);
        else dueDate = BeeStore.dates.addMonths(firstDueDate, i);
        const amountMinor = i === count - 1 ? remaining - allocated : baseAmount;
        allocated += amountMinor;
        schedule.push({
          n: i + 1,
          dueDate,
          amountMinor,
          paidMinor: 0,
          status: 'pending',
        });
      }
      return { downPaymentMinor, count, frequency, firstDueDate, schedule };
    }

    /**
     * Void a sale: restores stock and marks the invoice void.
     * @param {string} id sale id
     * @param {string} [reason] audit reason recorded in the audit log
     * @returns {Promise<object>} the voided sale
     * @throws {BeeError} NOT_FOUND | ALREADY_VOID | HAS_RETURNS | PERIOD_CLOSED
     */
    async void(id, reason) {
      const sale = await this.repo.transaction(async (tx) => {
        const s = await tx.get('sales', id);
        if (!s) throw BeeStore.errors.err('NOT_FOUND', 'الفاتورة غير موجودة');
        if (s.status === 'void') throw BeeStore.errors.err('ALREADY_VOID', 'الفاتورة ملغاة مسبقاً');
        if (s.returnStatus !== 'none') {
          throw BeeStore.errors.err('HAS_RETURNS', 'لا يمكن إلغاء فاتورة لها مرتجعات. قم بإلغاء المرتجعات أولاً');
        }
        // Voiding a closed-month invoice is forbidden — use a return dated today.
        await BeeStore.periods.assertOpen(tx, s.date);
        await BeeStore.periods.assertOpen(tx, BeeStore.dates.today());

        for (const line of s.lines) {
          const variant = await tx.get('variants', line.variantId);
          if (variant) {
            variant.quantity += line.qty;
            variant.updatedAt = BeeStore.dates.now();
            tx.put('variants', variant);
          }
          tx.put('stockMovements', {
            id: BeeStore.ids.randomId('stm'),
            variantId: line.variantId,
            date: BeeStore.dates.today(),
            type: 'void_sale',
            qtyChange: line.qty,
            unitCostMinor: line.unitCostMinor,
            avgCostAfterMinor: variant ? variant.costMinor : line.unitCostMinor,
            refType: 'void_sale',
            refId: s.id,
            note: 'إلغاء فاتورة ' + s.number,
            balanceAfter: variant ? variant.quantity : 0,
            createdAt: BeeStore.dates.now(),
          });
        }

        for (const p of s.payments) {
          tx.put('stockMovements', {
            id: BeeStore.ids.randomId('stm'),
            variantId: null,
            date: BeeStore.dates.today(),
            type: 'void_sale',
            qtyChange: 0,
            unitCostMinor: 0,
            avgCostAfterMinor: 0,
            refType: 'void_sale_payment',
            refId: s.id,
            note: 'عكس دفع فاتورة ' + s.number,
            balanceAfter: 0,
            createdAt: BeeStore.dates.now(),
          });
        }

        s.status = 'void';
        s.updatedAt = BeeStore.dates.now();
        tx.put('sales', s);
        return s;
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('void', 'sale', sale.id, 'إلغاء فاتورة ' + sale.number + (reason ? ' - ' + reason : ''));
      }
      return sale;
    }

    /**
     * Build print payload for a sale: settings, customer, merged payments,
     * and the sale's returns.
     * @param {string} id sale id
     * @returns {Promise<object|null>} {sale, settings, customer, payments, returns} or null
     */
    async printData(id) {
      const sale = await this.repo.get('sales', id);
      if (!sale) return null;
      const settings = await this.repo.get('meta', 'settings') || {};
      const customer = sale.customerId ? await this.repo.get('customers', sale.customerId) : null;
      const collections = await this.repo.list('customerPayments', p => p.saleId === id);
      const payments = [];
      for (const p of (sale.payments || [])) {
        payments.push({
          date: p.date || sale.date,
          method: p.method,
          amountMinor: p.amountMinor,
          payerName: p.payerName || '',
          payerPhone: p.payerPhone || '',
        });
      }
      for (const p of collections) {
        payments.push({
          date: p.date || sale.date,
          method: p.method,
          amountMinor: p.amountMinor,
          payerName: p.payerName || '',
          payerPhone: p.payerPhone || '',
        });
      }
      payments.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const returns = await this.repo.list('salesReturns', r => r.saleId === id);
      returns.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return { sale, settings, customer, payments, returns };
    }
  }

  BeeStore.sales = new SalesService(null);
  BeeStore.SalesService = SalesService;
  if (typeof module !== 'undefined') module.exports = SalesService;
})(typeof window !== 'undefined' ? window : globalThis);
