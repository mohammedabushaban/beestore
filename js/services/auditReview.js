(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const n = (v) => Math.round(Number(v) || 0);

  /**
   * Read-only review reports for the owner and the accountant.
   *
   * historicalErrors(): quantifies the effect, on data recorded before the
   *   2026-11-17 audit fixes, of three errors that are now fixed for new
   *   documents. Nothing is changed: each finding comes with the treatment
   *   the accountant should decide on.
   *
   * anomalies(): v5 §9 controls — possible duplicate invoices, large
   *   discounts, sales below cost, voids / invoice-less returns by profile,
   *   cash shortages and negative stock.
   */
  class AuditReviewService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * @returns {Promise<object>} {discountReturns, mixedChange, legacyTax, totals}
     */
    async historicalErrors() {
      const [sales, returns, closings] = await Promise.all([
        this.repo.list('sales'),
        this.repo.list('salesReturns'),
        this.repo.list('dailyClosings'),
      ]);
      const salesById = new Map(sales.map(s => [s.id, s]));

      // 1. Returns from invoices with an invoice-level discount, recorded
      //    before returns shared that discount: the customer got the
      //    pre-discount price back.
      const discountReturns = [];
      // 3. Returns from historical taxed invoices recorded before returns
      //    reversed the output tax: tax stayed payable and was not refunded.
      const legacyTax = [];
      for (const ret of returns) {
        const sale = ret.saleId ? salesById.get(ret.saleId) : null;
        if (!sale) continue;
        const shares = BeeStore.returns && BeeStore.returns.invoiceShares
          ? BeeStore.returns.invoiceShares(sale) : [];
        let overRefund = 0;
        let taxKept = 0;
        for (const line of (ret.lines || [])) {
          if (line.saleLineIndex === null || line.saleLineIndex === undefined) continue;
          const saleLine = sale.lines[line.saleLineIndex];
          const share = shares[line.saleLineIndex];
          if (!saleLine || !share || !(saleLine.qty > 0)) continue;
          const portion = (total) => Math.round(total * (Number(line.qty) || 0) / saleLine.qty);
          if (line.invoiceDiscountMinor === undefined && share.invoiceDiscountMinor > 0) {
            overRefund += portion(share.invoiceDiscountMinor);
          }
          if (line.taxMinor === undefined && share.taxMinor > 0 && !(n(ret.taxMinor) > 0)) {
            taxKept += portion(share.taxMinor);
          }
        }
        if (overRefund > 0) {
          discountReturns.push({
            returnId: ret.id, returnNumber: ret.number, date: ret.date,
            saleId: sale.id, saleNumber: sale.number,
            customerId: ret.customerId || null, customerName: ret.customerName || sale.customerName || null,
            refundMode: ret.refundMode, refundMinor: n(ret.refundMinor), overRefundMinor: overRefund,
          });
        }
        if (taxKept > 0) {
          legacyTax.push({
            returnId: ret.id, returnNumber: ret.number, date: ret.date,
            saleNumber: sale.number, taxNotReversedMinor: taxKept,
          });
        }
      }

      // 2. Change handed back in cash but recorded against a card / bank /
      //    wallet receipt: the drawer was overstated (often booked later as a
      //    cash shortage) and the clearing account understated.
      const closingByDate = new Map();
      for (const c of closings) {
        if (c.status === 'closed') closingByDate.set(c.date, c);
      }
      const mixedChange = [];
      for (const sale of sales) {
        if (sale.status === 'void') continue;
        for (const p of (sale.payments || [])) {
          const kind = p.methodKind || 'cash';
          if (kind === 'cash' || !(n(p.changeMinor) > 0)) continue;
          const day = p.date || sale.date;
          const closing = closingByDate.get(day);
          mixedChange.push({
            saleId: sale.id, saleNumber: sale.number, date: day,
            method: p.method, methodKind: kind, changeMinor: n(p.changeMinor),
            dayClosed: !!closing,
            dayShortageMinor: closing && n(closing.differenceMinor) < 0 ? -n(closing.differenceMinor) : 0,
          });
        }
      }

      const sum = (rows, key) => rows.reduce((acc, r) => acc + r[key], 0);
      return {
        discountReturns,
        mixedChange,
        legacyTax,
        totals: {
          overRefundMinor: sum(discountReturns, 'overRefundMinor'),
          misattributedChangeMinor: sum(mixedChange, 'changeMinor'),
          taxNotReversedMinor: sum(legacyTax, 'taxNotReversedMinor'),
          findings: discountReturns.length + mixedChange.length + legacyTax.length,
        },
        guidance: {
          discountReturns: 'المبلغ الزائد خرج فعلاً من الصندوق أو رصيد الزبون، فالدفاتر تعكس الواقع. ' +
            'القرار للمالك: مطالبة الزبون بالفرق، أو اعتباره خسارة (هو مُسجَّل حالياً ضمن مردودات المبيعات).',
          mixedChange: 'الصندوق في القيود كان أعلى من الفعلي بمقدار الباقي، وحساب تسوية البطاقة أقل منه. ' +
            'إن ظهر عجز في إقفال ذلك اليوم فسببه هذا الخطأ لا الكاشير. بعد تسوية البطاقة يبقى حساب التسوية سالباً بالمبلغ نفسه: ' +
            'يعالجه المحاسب بقيد تصحيح (مدين تسوية البطاقة / دائن عجز الصندوق أو الصندوق).',
          legacyTax: 'ضريبة فواتير قديمة لم تُعكس عند الإرجاع: التزام 2300 مبالغ فيه، والزبون لم يسترد الضريبة. ' +
            'يقرر المحاسب رد المبلغ للزبون أو تسويته مع حساب الضريبة.',
        },
      };
    }

    /**
     * v5 §9 anomaly and fraud-control report for a date range.
     * @param {object} [options] {from,to,discountPercent,duplicateMinutes}
     * @returns {Promise<object>} sections and counts
     */
    async anomalies(options) {
      options = options || {};
      const to = options.to || BeeStore.dates.today();
      const from = options.from || BeeStore.dates.addDays(to, -30);
      const discountLimit = Math.max(1, Number(options.discountPercent) || 20);
      const windowMinutes = Math.max(1, Number(options.duplicateMinutes) || 10);

      const [sales, returns, closings, variants, products] = await Promise.all([
        this.repo.listRange('sales', from, to),
        this.repo.listRange('salesReturns', from, to),
        this.repo.listRange('dailyClosings', from, to),
        this.repo.list('variants'),
        this.repo.list('products'),
      ]);
      const productName = new Map(products.map(p => [p.id, p.name]));
      const minutes = (doc) => {
        const t = String(doc.time || '00:00').split(':');
        return (Number(t[0]) || 0) * 60 + (Number(t[1]) || 0);
      };
      const profileOf = (doc) => doc.createdByProfile || 'owner';

      // Possible duplicates: same day, customer, total and items within the
      // time window (a double tap that slipped past the client key).
      const live = sales.filter(s => s.status !== 'void');
      const signature = (s) => [s.date, s.customerId || '', n(s.totalMinor),
        (s.lines || []).map(l => l.variantId + 'x' + l.qty).sort().join(',')].join('|');
      const groups = new Map();
      for (const s of live) {
        const key = signature(s);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      const duplicates = [];
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => minutes(a) - minutes(b));
        for (let i = 1; i < list.length; i++) {
          if (minutes(list[i]) - minutes(list[i - 1]) <= windowMinutes) {
            duplicates.push({
              date: list[i].date, totalMinor: n(list[i].totalMinor),
              first: list[i - 1].number, second: list[i].number,
              firstId: list[i - 1].id, secondId: list[i].id,
              minutesApart: minutes(list[i]) - minutes(list[i - 1]),
              profile: profileOf(list[i]),
            });
          }
        }
      }

      // Large discounts (line + invoice discount against the list price).
      const largeDiscounts = [];
      const belowCost = [];
      for (const s of live) {
        const list = (s.lines || []).reduce((acc, l) =>
          acc + n(l.listPriceMinor != null ? l.listPriceMinor : l.unitPriceMinor) * (Number(l.qty) || 0), 0);
        const totalNet = n(s.totalMinor);
        if (list > 0) {
          const percent = Math.round((list - totalNet) * 1000 / list) / 10;
          if (percent >= discountLimit) {
            largeDiscounts.push({
              saleId: s.id, number: s.number, date: s.date, listMinor: list,
              totalMinor: totalNet, discountPercent: percent, profile: profileOf(s),
            });
          }
        }
        const shares = BeeStore.returns && BeeStore.returns.invoiceShares
          ? BeeStore.returns.invoiceShares(s) : [];
        (s.lines || []).forEach((l, i) => {
          const qty = Number(l.qty) || 0;
          if (qty <= 0) return;
          const revenue = n(l.lineTotalMinor) - (shares[i] ? shares[i].invoiceDiscountMinor : 0);
          const cost = l.cogsMinor != null ? n(l.cogsMinor) : n(l.unitCostMinor) * qty;
          if (cost > 0 && revenue < cost) {
            belowCost.push({
              saleId: s.id, number: s.number, date: s.date,
              item: [l.productName, l.size, l.color].filter(Boolean).join(' / '),
              qty, revenueMinor: revenue, costMinor: cost, lossMinor: cost - revenue,
              profile: profileOf(s),
            });
          }
        });
      }

      // Voids and invoice-less returns per profile.
      const byProfile = {};
      const bump = (profile, key, amount) => {
        const row = byProfile[profile] || (byProfile[profile] = {
          profile, voids: 0, voidMinor: 0, unlinkedReturns: 0, unlinkedMinor: 0, returns: 0, returnMinor: 0,
        });
        row[key] += 1;
        row[key === 'voids' ? 'voidMinor' : key === 'unlinkedReturns' ? 'unlinkedMinor' : 'returnMinor'] += amount;
      };
      for (const s of sales) {
        if (s.status === 'void') bump(profileOf(s), 'voids', n(s.totalMinor));
      }
      for (const r of returns) {
        bump(profileOf(r), 'returns', n(r.refundMinor));
        if (!r.saleId || (r.flags || []).indexOf('NO_REFERENCE') >= 0) {
          bump(profileOf(r), 'unlinkedReturns', n(r.refundMinor));
        }
      }

      const shortages = closings
        .filter(c => c.status === 'closed' && n(c.differenceMinor) < 0)
        .map(c => ({ date: c.date, shortageMinor: -n(c.differenceMinor), profile: c.closedByProfile || c.createdByProfile || null }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

      const negativeStock = variants
        .filter(v => v.active !== false && (Number(v.quantity) || 0) < 0)
        .map(v => ({
          variantId: v.id, item: [productName.get(v.productId), v.size, v.color].filter(Boolean).join(' / '),
          quantity: Number(v.quantity) || 0,
        }));

      return {
        from, to, discountPercent: discountLimit, duplicateMinutes: windowMinutes,
        duplicates, largeDiscounts, belowCost,
        byProfile: Object.values(byProfile),
        shortages, negativeStock,
        counts: {
          duplicates: duplicates.length,
          largeDiscounts: largeDiscounts.length,
          belowCost: belowCost.length,
          shortages: shortages.length,
          negativeStock: negativeStock.length,
        },
      };
    }
  }

  BeeStore.auditReview = new AuditReviewService(null);
  BeeStore.AuditReviewService = AuditReviewService;
  if (typeof module !== 'undefined') module.exports = AuditReviewService;
})(typeof window !== 'undefined' ? window : globalThis);
