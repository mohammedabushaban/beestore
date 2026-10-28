(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Accountant package (v3-Lite §8): one offline ZIP per month containing a
   * bilingual README, the Arabic-safe Month Review PDF, accounting.xlsx,
   * BOM-prefixed CSV copies of every table, and a checksummed manifest.
   *
   * The package is always generated from the same documents the app reports
   * from. It never writes to the database and is owner-only in the facade.
   * Cross-checks are included in manifest.json and in the Integrity sheet; a
   * failed check is reported, not silently hidden.
   */

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

  function fail(code, message) {
    if (BeeStore.errors && BeeStore.errors.err) return BeeStore.errors.err(code, message);
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function monthLabel(month) {
    const parts = String(month || '').split('-');
    const idx = Number(parts[1]) - 1;
    return (MONTHS_AR[idx] || parts[1] || '') + ' ' + (parts[0] || '');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data);
    throw fail('VALIDATION', 'محتوى ملف الحزمة غير صالح');
  }

  function major(minor) {
    return Math.round(Number(minor) || 0) / 100;
  }

  function percent(value) {
    if (value === null || value === undefined || value === '') return '—';
    return (Number(value) > 0 ? '+' : '') + Number(value) + '%';
  }

  function ratio(value) { return Number(value) || 0; }

  function boolAr(value) { return value ? 'نعم' : 'لا'; }

  function saleStatusAr(sale) {
    if (!sale || sale.status === 'void') return 'ملغاة';
    if (sale.status === 'paid') return 'مدفوعة';
    if (sale.status === 'partial') return 'جزئية';
    return 'غير مدفوعة';
  }

  function purchaseStatusAr(purchase) {
    if (!purchase || purchase.status === 'void') return 'ملغاة';
    if (purchase.status === 'paid') return 'مدفوعة';
    if (purchase.status === 'partial') return 'جزئية';
    return 'غير مدفوعة';
  }

  function profileAr(profile) {
    if (!profile) return '—';
    return profile === 'cashier' ? 'الكاشير' : 'المالك';
  }

  function methodLabel(method, settings) {
    if (!method) return '—';
    const list = (settings && settings.paymentMethods) || [];
    const found = list.find(m => m.id === method);
    return found ? (found.name || method) : method;
  }

  function dayOf(iso) {
    if (!iso) return '';
    return String(iso).slice(0, 10);
  }

  function localMonthOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 7);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function buildRange(month, to) {
    if (BeeStore.dates && BeeStore.dates.monthRange) {
      const res = BeeStore.dates.monthRange(month);
      return { from: res.from, to: to || res.to };
    }
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    return { from: month + '-01', to: to || month + '-' + pad2(days) };
  }

  function addDays(date, count) {
    if (BeeStore.dates && BeeStore.dates.addDays) return BeeStore.dates.addDays(date, count);
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + count);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // ---------------------------------------------------------------------
  // SHA-256 (pure JS, synchronous). crypto.subtle needs a secure context;
  // the accountant package must also work from a local file in an emergency.
  // ---------------------------------------------------------------------
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Bytes(input) {
    const bytes = toBytes(input);
    const length = bytes.length;
    const paddedLength = ((length + 9 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = length * 8;
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(v => v.toString(16).padStart(8, '0')).join('');
  }

  // ---------------------------------------------------------------------
  // CSV: UTF-8 BOM, CRLF, quoted text, formula-injection prefixes escaped.
  // ---------------------------------------------------------------------
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? '1' : '0';
    let text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Excel/LibreOffice execute a cell beginning with these characters.
    // Prefixing an apostrophe keeps the literal text visible and inert.
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function csvText(rows) {
    const body = (rows || []).map(row => (row || []).map(csvCell).join(',')).join('\r\n');
    return '\uFEFF' + body + (body ? '\r\n' : '');
  }

  function table(name, file, headers, rows, options) {
    const opts = options || {};
    return {
      name,
      file,
      headers,
      rows: rows || [],
      footer: opts.footer || [],
      widths: opts.widths || [],
      moneyColumns: opts.moneyColumns || null,
    };
  }

  function matrix(t) {
    return [t.headers, ...t.rows, ...(t.footer || [])];
  }

  function xlsxSheet(t) {
    const rows = matrix(t).map((row, r) => row.map((value, c) => {
      if (r > 0 && t.moneyColumns && t.moneyColumns.indexOf(c) !== -1 &&
        typeof value === 'number') {
        return { minor: Math.round(value * 100) };
      }
      return value;
    }));
    return { name: t.name, rows, widths: t.widths, freezeHeader: true };
  }

  function toNumberOrZero(value) { return Number(value) || 0; }

  function minimum(values) {
    return values.reduce((best, v) => (best === null || v < best ? v : best), null);
  }

  // ---------------------------------------------------------------------
  // Package service.
  // ---------------------------------------------------------------------
  class AccountingPackageService {
    constructor(repo) {
      this.repo = repo;
      this._reports = null;
    }

    _report(name) {
      const svc = BeeStore[name];
      if (!svc) throw fail('UNAVAILABLE', 'خدمة التقارير غير محمّلة: ' + name);
      svc.repo = this.repo;
      return svc;
    }

    _acc(name) {
      const svc = BeeStore[name];
      if (!svc) return null;
      svc.repo = this.repo;
      return svc;
    }

    async _settings() {
      const settings = this._acc('settings');
      if (settings) return settings.get();
      return (await this.repo.get('meta', 'settings')) || {};
    }

    /** @param {string} month @returns {Promise<object>} package identity/status */
    async info(month) {
      this._validateMonth(month);
      const settings = await this._settings();
      const closed = BeeStore.periods
        ? await BeeStore.periods.isClosed(month)
        : false;
      return {
        month,
        monthLabel: monthLabel(month),
        status: closed ? 'closed' : 'open',
        closed,
        filename: this.filename(month),
        pdfFilename: '01-Month-Review.pdf',
        storeName: settings.storeNameAr || settings.storeName || 'Bee Store',
        currency: {
          code: settings.currencyCode || 'ILS',
          symbol: settings.currencySymbol || '₪',
        },
      };
    }

    _validateMonth(month) {
      if (!MONTH_RE.test(String(month || ''))) {
        throw fail('VALIDATION', 'شهر غير صالح: ' + month);
      }
      return String(month);
    }

    /** @param {string} month @returns {string} the required ZIP filename */
    filename(month) {
      this._validateMonth(month);
      return 'BeeStore-' + month + '-Accountant-Package.zip';
    }

    async _resolveAccounts(settings) {
      const accounts = await this.repo.list('accounts');
      const active = accounts.filter(a => a.active !== false);
      const drawer = active.find(a => a.id === settings.cashDrawerAccountId) ||
        active.find(a => a.type === 'cash') ||
        active.find(a => /صندوق|نقد/.test(a.name || '')) ||
        null;
      const bank = active.find(a => a.id === settings.defaultBankAccountId) ||
        active.find(a => a.type === 'bank') || null;
      return { accounts: active, drawer, bank };
    }

    /**
     * Aggregated ageing as of the month end. Totals use the service balances;
     * buckets allocate payments FIFO to invoices so the sum is defensible.
     * Any opening balance / unapplied credit is shown separately.
     */
    async _aging(kind, asOf, from) {
      const isCustomer = kind === 'customer';
      const parties = await this.repo.list(isCustomer ? 'customers' : 'suppliers');
      const rows = [];
      const totals = {
        opening: 0, invoiced: 0, collected: 0, closing: 0,
        positiveClosing: 0, current: 0, d31: 0, d61: 0, d90: 0, adjustment: 0,
      };
      const balanceOf = async (id, date) => {
        if (isCustomer) {
          const svc = this._acc('customers');
          return svc ? svc.balance(id, date) : 0;
        }
        const svc = this._acc('suppliers');
        return svc ? svc.balance(id, date) : 0;
      };
      for (const party of parties) {
        const opening = await balanceOf(party.id, addDays(from, -1));
        const closing = await balanceOf(party.id, asOf);
        const docs = (await this.repo.query(isCustomer ? 'sales' : 'purchases',
          isCustomer ? 'customerId' : 'supplierId', party.id))
          .filter(d => (isCustomer ? d.status !== 'void' : d.status !== 'void') && d.date <= asOf);
        docs.sort((a, b) => (a.date + (a.number || '')).localeCompare(b.date + (b.number || '')));
        const monthDocs = docs.filter(d => d.date >= from);
        const invoiced = monthDocs.reduce((sum, d) => sum + (Number(d.totalMinor) || 0), 0);
        const payments = [];
        for (const d of docs) {
          for (const p of (d.payments || [])) {
            if ((p.date || d.date) <= asOf) payments.push(Number(p.amountMinor) || 0);
          }
        }
        const later = await this.repo.list(isCustomer ? 'customerPayments' : 'supplierPayments');
        for (const p of later) {
          const partyId = isCustomer ? p.customerId : p.supplierId;
          if (partyId !== party.id || p.date > asOf) continue;
          payments.push(Number(p.amountMinor) || 0);
        }
        const returns = await this.repo.query(isCustomer ? 'salesReturns' : 'purchaseReturns',
          isCustomer ? 'customerId' : 'supplierId', party.id);
        for (const r of returns) {
          if (r.date > asOf) continue;
          if (isCustomer) {
            if (r.refundMode === 'customer_credit') payments.push(Number(r.refundMinor) || 0);
          } else {
            payments.push(Number(r.totalMinor) || 0);
          }
        }
        let pool = payments.reduce((a, b) => a + b, 0);
        const openingMinor = Number(party.openingBalanceMinor) || 0;
        if (openingMinor < 0) pool += -openingMinor;
        const buckets = { current: 0, d31: 0, d61: 0, d90: 0 };
        for (const d of docs) {
          let remaining = Number(d.totalMinor) || 0;
          const applied = Math.min(pool, remaining);
          pool -= applied;
          remaining -= applied;
          if (remaining <= 0) continue;
          const days = BeeStore.dates.diffDays(d.date, asOf);
          if (days <= 30) buckets.current += remaining;
          else if (days <= 60) buckets.d31 += remaining;
          else if (days <= 90) buckets.d61 += remaining;
          else buckets.d90 += remaining;
        }
        const bucketTotal = buckets.current + buckets.d31 + buckets.d61 + buckets.d90;
        const adjustment = closing - bucketTotal;
        const hasActivity = opening !== 0 || closing !== 0 || invoiced !== 0 ||
          monthDocs.length > 0;
        if (!hasActivity && bucketTotal === 0) continue;
        const collected = opening + invoiced - closing;
        rows.push({
          party, opening, invoiced, collected, closing, bucketTotal, adjustment,
          buckets,
        });
        totals.opening += opening;
        totals.invoiced += invoiced;
        totals.collected += collected;
        totals.closing += closing;
        totals.positiveClosing += closing > 0 ? closing : 0;
        totals.current += buckets.current;
        totals.d31 += buckets.d31;
        totals.d61 += buckets.d61;
        totals.d90 += buckets.d90;
        totals.adjustment += adjustment;
      }
      rows.sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));
      return { rows, totals };
    }

    async _renderPdf(review, options) {
      const opts = options || {};
      if (opts.pdfBytes || opts.pdf) {
        const raw = opts.pdfBytes || opts.pdf;
        return {
          bytes: toBytes(raw),
          pageCount: Number(opts.pdfPageCount) || 0,
          synthetic: true,
        };
      }
      if (typeof opts.pdfRenderer === 'function') {
        const rendered = await opts.pdfRenderer(review, {
          storeName: opts.storeName,
          generatedAt: opts.generatedAt,
        });
        if (rendered && rendered.bytes) {
          return {
            bytes: toBytes(rendered.bytes),
            pageCount: Number(rendered.pageCount) || 0,
          };
        }
        return { bytes: toBytes(rendered), pageCount: 0 };
      }
      const pdf = BeeStore.monthReviewPdf;
      if (!pdf) throw fail('UNAVAILABLE', 'مولّد PDF غير محمّل');
      return pdf.makePdf(review, {
        storeName: opts.storeName,
        generatedAt: opts.generatedAt,
      });
    }

    _readme(info, review, counts, options) {
      const opts = options || {};
      const currency = info.currency.code + ' (' + info.currency.symbol + ')';
      const statusAr = review.closed
        ? 'شهر مُقفل — هذه الأرقام نهائية.'
        : 'غير نهائي — الشهر مفتوح. قد تتغير الأرقام حتى إقفال الشهر.';
      const statusEn = review.closed
        ? 'Closed month - these figures are final.'
        : 'NOT FINAL - the month is still open. Figures may change until the month is closed.';
      const lines = [
        'بي ستور — حزمة المحاسب',
        'BeeStore — Accountant Package',
        '============================================================',
        'المتجر / Store: ' + (opts.storeName || 'Bee Store'),
        'الشهر / Month: ' + info.month + ' — ' + monthLabel(info.month),
        'الحالة / Status: ' + statusAr,
        'Status (EN): ' + statusEn,
        'العملة / Currency: ' + currency,
        'تاريخ الإنشاء / Generated at: ' + opts.generatedAt,
        'إصدار التطبيق / App version: ' + opts.appVersion,
        'إصدار المخطط / Schema version: ' + opts.schemaVersion,
        '',
        'المحتويات / Contents',
        '------------------------------------------------------------',
        '00-README.txt              هذا الملف / this file.',
        '01-Month-Review.pdf        تقرير الشهر بالعربية (صفحات صور آمنة للعربية).',
        'accounting.xlsx            18 ورقة محاسبية / 18 accounting sheets.',
        'csv/                       نفس الجداول بترميز UTF-8 مع BOM.',
        'manifest.json              قائمة الملفات وبصمات SHA-256 ونتائج التحقق.',
        '',
        'الأوراق / Sheets',
        '------------------------------------------------------------',
        '1.  Summary-PL — قائمة الأرباح والخسائر (الشهر الحالي، السابق، نفس الشهر العام الماضي).',
        '2.  Sales Journal — كل فاتورة بيع في الشهر.',
        '3.  Sales Lines — كل بند مع التكلفة والهامش (نسخة المالك فقط).',
        '4.  Returns — مرتجعات البيع.',
        '5.  Purchases Journal — فواتير الشراء.',
        '6.  Expenses — المصاريف التشغيلية وتوزيع المصاريف الممتدة (بدون الرواتب).',
        '7.  Payroll — الرواتب والخصومات وسداد السلف.',
        '8.  Cash Book — كشف الصندوق: رصيد افتتاحي، حركات، رصيد ختامي.',
        '9.  Bank-Wallet — كشوف البنك والمحافظ.',
        '10. Receivables Aging — أعمار ديون الزبائن وأرصدتهم آخر الشهر.',
        '11. Payables Aging — أعمار ديون الموردين وأرصدتهم آخر الشهر.',
        '12. Inventory Valuation — تقييم المخزون آخر الشهر بمتوسط التكلفة.',
        '13. Stock Movements — ملخص حركات المخزون.',
        '14. Balance Snapshot — صورة الميزانية (أصول، التزامات، حقوق ملكية).',
        '15. Profit-Cash Recon — لماذا يختلف صافي الربح عن تغير النقدية.',
        '16. Daily Closings — إقفالات الأيام: متوقع، معدود، فرق.',
        '17. Adjustments-Voids — تسويات الصندوق ومقتطف التدقيق والإلغاءات.',
        '18. Integrity Check — نتيجة فحص سلامة البيانات.',
        '',
        'تعريفات / Definitions',
        '------------------------------------------------------------',
        'صافي المبيعات = إجمالي الفواتير بعد استبعاد الضريبة، ناقص مرتجعات البيع.',
        'Net sales = invoice totals excluding tax, minus sales returns.',
        'تكلفة البضاعة المباعة (COGS) = تكلفة الأصناف المباعة بالمتوسط المرجح.',
        'مجمل الربح = صافي المبيعات − تكلفة البضاعة المباعة.',
        'المصاريف التشغيلية = المصاريف + الرواتب + فروقات المخزون − فروقات الصندوق.',
        'صافي الربح = مجمل الربح − المصاريف التشغيلية.',
        'فرق الصندوق: السالب نقص يزيد المصاريف، والموجب زيادة يخفضها.',
        'كل المبالغ بالوحدات الكبرى للعملة، ومخزّنة داخلياً كأعداد صحيحة من الأغورة.',
        '',
        'ملاحظات / Notes',
        '------------------------------------------------------------',
        '• الحزمة للقراءة فقط؛ المحاسب لا يعدّل قاعدة البيانات. أي تصحيح يتم من التطبيق.',
        '• ورقة Sales Lines تتضمن التكلفة والربح، وهي لمالك المتجر فقط.',
        '• جميع الملفات مولّدة محلياً داخل المتصفح؛ لا يوجد رفع سحابي مباشر.',
        '• تحقق من manifest.json: كل ملف له بصمة SHA-256.',
        '• الشهر المفتوح يحمل علامة «غير نهائي» في PDF وفي هذه القراءة وفي البيان.',
        '',
        'العدادات / Row counts',
        '------------------------------------------------------------',
        'فواتير البيع / Sales: ' + counts.sales,
        'بنود البيع / Sales lines: ' + counts.salesLines,
        'المرتجعات / Returns: ' + counts.returns,
        'المشتريات / Purchases: ' + counts.purchases,
        'المصاريف / Expenses: ' + counts.expenses,
        'الرواتب / Payroll: ' + counts.payroll,
        'إقفالات الأيام / Daily closings: ' + counts.closings,
        '',
        'بي ستور v3-Lite — بيانات محلية على هاتف واحد. لا حسابات سحابية ولا مزامنة.',
        'BeeStore v3-Lite — local data on one phone. No cloud accounts and no sync.',
        '',
      ];
      return lines.join('\n');
    }

    /**
     * Builds the complete package in memory.
     * @param {string} month YYYY-MM
     * @param {object} [options] {pdfBytes|pdfRenderer, generatedAt, env}
     * @returns {Promise<object>} {filename,status,bytes,blob,manifest,files,checks}
     */
    async build(month, options) {
      this._validateMonth(month);
      const opts = options || {};
      const settings = await this._settings();
      if (!BeeStore.zip || !BeeStore.xlsx) {
        throw fail('UNAVAILABLE', 'مكتبات ZIP/XLSX غير محمّلة');
      }
      const reports = this._report('reports');
      const accountsSvc = this._report('accounts');
      const review = await reports.monthReview(month);
      const { from, to } = buildRange(month);
      const info = {
        month,
        monthLabel: monthLabel(month),
        closed: !!review.closed,
        status: review.closed ? 'closed' : 'open',
        storeName: settings.storeNameAr || settings.storeName || 'Bee Store',
        currency: {
          code: settings.currencyCode || 'ILS',
          symbol: settings.currencySymbol || '₪',
        },
      };
      const generatedAt = opts.generatedAt || (BeeStore.dates && BeeStore.dates.now
        ? BeeStore.dates.now() : new Date().toISOString());

      const [salesAll, returns, purchasesAll, purchaseReturns, expensesAll, payroll,
        customers, suppliers, accountsInfo, snapClose, closings, cashAdjustments,
        auditAll] = await Promise.all([
        this.repo.listRange('sales', from, to),
        this.repo.listRange('salesReturns', from, to),
        this.repo.listRange('purchases', from, to),
        this.repo.listRange('purchaseReturns', from, to),
        this.repo.list('expenses'),
        this.repo.listRange('payroll', month, month),
        this.repo.list('customers'),
        this.repo.list('suppliers'),
        this._resolveAccounts(settings),
        reports.balanceSnapshot(to),
        this._acc('dailyClosing') ? this._acc('dailyClosing').list(from, to) : [],
        this.repo.listRange('cashAdjustments', from, to),
        this.repo.list('auditLog'),
      ]);
      const sales = salesAll.filter(s => s.status !== 'void');
      const purchases = purchasesAll.filter(p => p.status !== 'void');
      const drawer = accountsInfo.drawer;
      const currencySymbol = info.currency.symbol;
      const moneyHeader = (label) => label + ' (' + currencySymbol + ')';

      // -----------------------------------------------------------------
      // Master data maps
      // -----------------------------------------------------------------
      const variants = await this.repo.list('variants');
      const products = await this.repo.list('products');
      const vMap = {};
      for (const v of variants) vMap[v.id] = v;
      const pMap = {};
      for (const p of products) pMap[p.id] = p;
      const customerMap = {};
      for (const c of customers) customerMap[c.id] = c;
      const supplierMap = {};
      for (const s of suppliers) supplierMap[s.id] = s;

      // -----------------------------------------------------------------
      // 1) Summary / P&L
      // -----------------------------------------------------------------
      const pnl = review.pnl.current;
      const prev = review.pnl.previous;
      const lastYear = review.pnl.lastYear;
      const pnlRows = [
        ['ملخص الشهر / Month summary'],
        ['المتجر / Store', info.storeName],
        ['الشهر / Month', month + ' — ' + info.monthLabel],
        ['العملة / Currency', info.currency.code + ' (' + currencySymbol + ')'],
        ['الحالة / Status', review.closed ? 'مُقفل / Closed — نهائي' : 'مفتوح / Open — غير نهائي'],
        ['تاريخ الإنشاء / Generated at', generatedAt],
        [],
        ['البند / Item', 'الشهر الحالي / Current', 'الشهر السابق / Previous',
          'نفس الشهر العام الماضي / Same month last year'],
        ['صافي المبيعات / Net sales', major(pnl.netSales), major(prev.netSales), major(lastYear.netSales)],
        ['تكلفة البضاعة المباعة / COGS', major(pnl.cogs), major(prev.cogs), major(lastYear.cogs)],
        ['مجمل الربح / Gross profit', major(pnl.grossProfit), major(prev.grossProfit), major(lastYear.grossProfit)],
        ['هامش الربح / Margin %', ratio(pnl.margin), ratio(prev.margin), ratio(lastYear.margin)],
        ['المصاريف التشغيلية / Operating expenses', major(pnl.operatingExpenses),
          major(prev.operatingExpenses), major(lastYear.operatingExpenses)],
        ['الرواتب / Salaries', major(pnl.salaryExpense), major(prev.salaryExpense), major(lastYear.salaryExpense)],
        ['فروقات المخزون / Stock losses', major(pnl.stockLosses), major(prev.stockLosses), major(lastYear.stockLosses)],
        ['تسوية تكلفة المخزون / Inventory revaluation', major(pnl.stockRevaluation),
          major(prev.stockRevaluation), major(lastYear.stockRevaluation)],
        ['فروقات الصندوق / Cash over-short', major(pnl.cashDifference),
          major(prev.cashDifference), major(lastYear.cashDifference)],
        ['صافي الربح / Net profit', major(pnl.netProfit), major(prev.netProfit), major(lastYear.netProfit)],
        [],
        ['مؤشرات الشهر / Month KPIs'],
        ['عدد الفواتير / Invoices', review.kpis.invoices],
        ['عدد القطع / Units', review.kpis.units],
        ['متوسط الفاتورة / Average invoice', major(review.kpis.avgInvoice)],
        ['التغير في صافي المبيعات / Net sales change', percent(review.pnl.changePct.netSales)],
        ['التغير في صافي الربح / Net profit change', percent(review.pnl.changePct.netProfit)],
      ];
      const summaryTable = table('Summary-PL', 'csv/01-summary-pl.csv',
        ['البند / Item', 'القيمة / Value 1', 'القيمة / Value 2', 'القيمة / Value 3'],
        pnlRows, { widths: [48, 18, 18, 18] });

      // -----------------------------------------------------------------
      // 2) Sales Journal (per invoice)
      // -----------------------------------------------------------------
      const salesJournalRows = sales.map(s => {
        const methods = Array.from(new Set((s.payments || []).map(p => methodLabel(p.method, settings))));
        const netOfTax = (Number(s.totalMinor) || 0) - (Number(s.taxMinor) || 0);
        return [
          s.number, s.date, s.customerName || 'نقدي / Cash',
          methods.join('، ') || '—',
          major(s.subtotalMinor), major(s.discountMinor), major(s.taxMinor),
          major(s.totalMinor), major(s.paidMinor), major(s.dueMinor),
          saleStatusAr(s), profileAr(s.createdByProfile),
        ];
      });
      const journalTotals = sales.reduce((acc, s) => {
        acc.subtotal += Number(s.subtotalMinor) || 0;
        acc.discount += Number(s.discountMinor) || 0;
        acc.tax += Number(s.taxMinor) || 0;
        acc.total += Number(s.totalMinor) || 0;
        acc.paid += Number(s.paidMinor) || 0;
        acc.due += Number(s.dueMinor) || 0;
        return acc;
      }, { subtotal: 0, discount: 0, tax: 0, total: 0, paid: 0, due: 0 });
      const returnsTotal = returns.reduce((sum, r) => sum + (Number(r.refundMinor) || 0), 0);
      const journalNetOfTax = journalTotals.total - journalTotals.tax;
      const salesJournalTable = table('Sales Journal', 'csv/02-sales-journal.csv',
        ['رقم الفاتورة / Invoice', 'التاريخ / Date', 'الزبون / Customer',
          'طريقة الدفع / Payment', moneyHeader('قبل الضريبة / Before tax'),
          moneyHeader('الخصم / Discount'), moneyHeader('الضريبة / Tax'),
          moneyHeader('الإجمالي / Total'), moneyHeader('المدفوع / Paid'),
          moneyHeader('المتبقي / Due'), 'الحالة / Status', 'أنشأها / Profile'],
        salesJournalRows,
        {
          widths: [14, 11, 22, 15, 13, 12, 11, 13, 12, 12, 12, 10],
          moneyColumns: [4, 5, 6, 7, 8, 9],
          footer: [
            ['الإجمالي / Total', '', '', '', major(journalTotals.subtotal),
              major(journalTotals.discount), major(journalTotals.tax),
              major(journalTotals.total), major(journalTotals.paid), major(journalTotals.due), '', ''],
            ['مرتجعات الشهر / Returns', '', '', '', '', '', '', major(returnsTotal), '', '', '', ''],
            ['صافي المبيعات بعد المرتجعات / Net sales', '', '', '', '', '', '',
              major(journalNetOfTax - returnsTotal), '', '', '', ''],
          ],
        });

      // -----------------------------------------------------------------
      // 3) Sales Lines (cost and margin; owner version only)
      // -----------------------------------------------------------------
      const salesLinesRows = [];
      let lineRevenue = 0, lineCost = 0;
      for (const s of sales) {
        for (const l of (s.lines || [])) {
          const revenue = Number(l.lineTotalMinor) || 0;
          const cost = l.cogsMinor != null
            ? Math.round(Number(l.cogsMinor) || 0)
            : (Number(l.unitCostMinor) || 0) * (Number(l.qty) || 0);
          lineRevenue += revenue;
          lineCost += cost;
          const profit = revenue - cost;
          salesLinesRows.push([
            s.number, s.date, l.productName || '', l.size || '', l.color || '',
            l.barcode || '', Number(l.qty) || 0, major(l.unitPriceMinor),
            major(l.lineDiscountMinor), major(revenue), major(cost), major(profit),
            revenue ? Number(((profit / revenue) * 100).toFixed(1)) : 0,
            profileAr(s.createdByProfile),
          ]);
        }
      }
      const salesLinesTable = table('Sales Lines', 'csv/03-sales-lines.csv',
        ['رقم الفاتورة / Invoice', 'التاريخ / Date', 'الصنف / Product',
          'المقاس / Size', 'اللون / Color', 'الباركود / Barcode',
          'الكمية / Qty', moneyHeader('سعر الوحدة / Unit price'),
          moneyHeader('خصم البند / Line discount'), moneyHeader('الإيراد / Revenue'),
          moneyHeader('التكلفة / Cost'), moneyHeader('الربح / Profit'),
          'الهامش % / Margin', 'أنشأها / Profile'],
        salesLinesRows,
        {
          widths: [14, 11, 22, 9, 11, 15, 8, 12, 12, 12, 12, 12, 9, 10],
          moneyColumns: [7, 8, 9, 10, 11],
          footer: [['الإجمالي / Total', '', '', '', '', '', '', '', '', major(lineRevenue),
            major(lineCost), major(lineRevenue - lineCost), '', '']],
        });

      // -----------------------------------------------------------------
      // 4) Returns
      // -----------------------------------------------------------------
      const returnsRows = returns.map(r => {
        const sale = salesAll.find(s => s.id === r.saleId) || null;
        const qty = (r.lines || []).reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
        return [
          r.number, r.date, sale ? sale.number : '', r.customerId ? (customerMap[r.customerId] || {}).name || '' : '',
          qty, major(r.refundMinor),
          r.refundMode === 'cash_refund' ? 'استرداد نقدي / Cash refund'
            : (r.refundMode === 'customer_credit' ? 'رصيد زبون / Customer credit' : 'استبدال / Exchange'),
          r.refundMethod || '—', r.reason || '',
        ];
      });
      const returnsTable = table('Returns', 'csv/04-returns.csv',
        ['رقم المرتجع / Return', 'التاريخ / Date', 'رقم الفاتورة / Invoice',
          'الزبون / Customer', 'الكمية / Qty', moneyHeader('المبلغ / Amount'),
          'طريقة الاسترداد / Refund mode', 'الحساب / Account', 'السبب / Reason'],
        returnsRows,
        {
          widths: [14, 11, 14, 22, 8, 13, 20, 18, 20],
          moneyColumns: [5],
          footer: [['الإجمالي / Total', '', '', '', '', major(returnsTotal), '', '', '']],
        });

      // -----------------------------------------------------------------
      // 5) Purchases Journal
      // -----------------------------------------------------------------
      const purchasesRows = purchases.map(p => [
        p.number, p.date, p.supplierName || (supplierMap[p.supplierId] || {}).name || '',
        major(p.subtotalMinor), major(p.discountMinor), major(p.totalMinor),
        major(p.paidMinor), major(p.dueMinor), purchaseStatusAr(p),
      ]);
      const purchasesTotal = purchases.reduce((sum, p) => sum + (Number(p.totalMinor) || 0), 0);
      const purchasesTable = table('Purchases Journal', 'csv/05-purchases-journal.csv',
        ['رقم المشتريات / Purchase', 'التاريخ / Date', 'المورد / Supplier',
          moneyHeader('قبل الخصم / Before discount'), moneyHeader('الخصم / Discount'),
          moneyHeader('الإجمالي / Total'), moneyHeader('المدفوع / Paid'),
          moneyHeader('المتبقي / Due'), 'الحالة / Status'],
        purchasesRows,
        {
          widths: [14, 11, 22, 14, 12, 13, 12, 12, 12],
          moneyColumns: [3, 4, 5, 6, 7],
          footer: [['الإجمالي / Total', '', '', '', '', major(purchasesTotal), '', '', '']],
        });

      // -----------------------------------------------------------------
      // 6) Expenses (operating, excluding salaries; spread shares)
      // -----------------------------------------------------------------
      const expenseRows = [];
      let operatingExpenseTotal = 0;
      for (const e of expensesAll) {
        if (e.voided) continue;
        const isSalary = e.categoryName === 'رواتب';
        if (isSalary) continue;
        if ((e.allocation || {}).mode === 'spread') {
          const share = (BeeStore.expenses.spreadShares(e) || [])
            .filter(s => s.month === month)
            .reduce((sum, s) => sum + (Number(s.amountMinor) || 0), 0);
          if (!share) continue;
          operatingExpenseTotal += share;
          expenseRows.push([
            e.date, month, e.categoryName || '', e.description || '',
            major(e.amountMinor), methodLabel(e.method, settings), e.accountId || '',
            'موزّع / Spread (' + (e.allocation.months || 0) + ' شهور)', major(share),
            e.recurringId ? 'نعم / Yes' : 'لا / No',
          ]);
        } else if (e.date >= from && e.date <= to) {
          operatingExpenseTotal += Number(e.amountMinor) || 0;
          expenseRows.push([
            e.date, String(e.date).slice(0, 7), e.categoryName || '', e.description || '',
            major(e.amountMinor), methodLabel(e.method, settings), e.accountId || '',
            'مصروف واحد / Single', major(e.amountMinor),
            e.recurringId ? 'نعم / Yes' : 'لا / No',
          ]);
        }
      }
      expenseRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const expensesTable = table('Expenses', 'csv/06-expenses.csv',
        ['التاريخ / Date', 'الشهر المحاسبي / Month', 'التصنيف / Category',
          'الوصف / Description', moneyHeader('المبلغ / Amount'),
          'طريقة الدفع / Method', 'الحساب / Account', 'التوزيع / Allocation',
          moneyHeader('حصة الشهر / Month share'), 'متكرر / Recurring'],
        expenseRows,
        {
          widths: [11, 11, 18, 28, 13, 14, 18, 20, 14, 11],
          moneyColumns: [4, 8],
          footer: [
            ['إجمالي المصاريف / Expenses total', '', '', '', '', '', '', '', major(operatingExpenseTotal), ''],
            ['الرواتب / Salaries (Payroll sheet)', '', '', '', '', '', '', '',
              major(pnl.salaryExpense), ''],
            ['فروقات المخزون / Stock losses', '', '', '', '', '', '', '', major(pnl.stockLosses), ''],
            ['تسوية تكلفة المخزون / Inventory revaluation', '', '', '', '', '', '', '',
              major(pnl.stockRevaluation), ''],
            ['فروقات الصندوق / Cash over-short', '', '', '', '', '', '', '', major(pnl.cashDifference), ''],
            ['المصاريف التشغيلية / Operating expenses', '', '', '', '', '', '', '',
              major(pnl.operatingExpenses), ''],
          ],
        });

      // -----------------------------------------------------------------
      // 7) Payroll
      // -----------------------------------------------------------------
      let payrollGross = 0, payrollNet = 0;
      const payrollRows = payroll.map(p => {
        const gross = (Number(p.baseMinor) || 0) + (Number(p.bonusMinor) || 0) +
          (Number(p.overtimeMinor) || 0) - (Number(p.deductionsMinor) || 0);
        payrollGross += gross;
        payrollNet += Number(p.netMinor) || 0;
        return [
          p.month, p.employeeName, major(p.baseMinor), major(p.bonusMinor),
          major(p.overtimeMinor), major(p.deductionsMinor), major(p.advanceRepaymentMinor),
          major(p.netMinor), p.status === 'paid' ? 'مدفوع / Paid' : 'مسودة / Draft',
          p.paidDate || '', methodLabel(p.method, settings), p.note || '',
        ];
      });
      const payrollTable = table('Payroll', 'csv/07-payroll.csv',
        ['الشهر / Month', 'الموظف / Employee', moneyHeader('الأساسي / Base'),
          moneyHeader('إضافي / Bonus'), moneyHeader('عمل إضافي / Overtime'),
          moneyHeader('خصومات / Deductions'), moneyHeader('سداد سلف / Advance'),
          moneyHeader('الصافي / Net'), 'الحالة / Status', 'تاريخ الدفع / Paid date',
          'الطريقة / Method', 'ملاحظات / Notes'],
        payrollRows,
        {
          widths: [10, 22, 12, 12, 12, 12, 12, 12, 12, 12, 12, 20],
          moneyColumns: [2, 3, 4, 5, 6, 7],
          footer: [
            ['الإجمالي / Total', '', '', '', '', '', '', major(payrollNet), '', '', '', ''],
            ['الراتب المحاسبي / Salary expense', '', '', '', '', '', '', major(payrollGross), '', '', '', ''],
          ],
        });

      // -----------------------------------------------------------------
      // 8) Cash Book
      // -----------------------------------------------------------------
      let cashOpening = 0;
      let cashClosing = 0;
      let cashLedger = [];
      if (drawer) {
        cashOpening = await accountsSvc.balanceAsOf(drawer.id, addDays(from, -1));
        cashLedger = await accountsSvc.getLedger(drawer.id, { from, to });
        cashClosing = await accountsSvc.balanceAsOf(drawer.id, to);
      }
      let runningCash = cashOpening;
      const cashRows = [];
      cashRows.push(['رصيد افتتاحي / Opening', '', '', '', '', '', major(cashOpening)]);
      for (const m of cashLedger) {
        runningCash += Number(m.amountMinor) || 0;
        cashRows.push([
          m.date, m.type, m.refNumber || m.refId || '', m.description || '',
          m.amountMinor > 0 ? major(m.amountMinor) : '',
          m.amountMinor < 0 ? major(-m.amountMinor) : '',
          major(runningCash),
        ]);
      }
      const cashBookTable = table('Cash Book', 'csv/08-cash-book.csv',
        ['التاريخ / Date', 'النوع / Type', 'المرجع / Reference', 'الوصف / Description',
          moneyHeader('وارد / In'), moneyHeader('صادر / Out'), moneyHeader('الرصيد / Balance')],
        cashRows,
        {
          widths: [11, 18, 18, 30, 13, 13, 14],
          moneyColumns: [4, 5, 6],
          footer: [
            ['رصيد ختامي / Closing', '', '', '', '', '', major(cashClosing)],
            ['الحساب / Account', drawer ? drawer.name : 'لا يوجد صندوق / No cash drawer', '', '', '', '', ''],
          ],
        });

      // -----------------------------------------------------------------
      // 9) Bank & Wallet ledgers
      // -----------------------------------------------------------------
      const bankRows = [];
      const otherAccounts = accountsInfo.accounts.filter(a => !drawer || a.id !== drawer.id);
      for (const a of otherAccounts) {
        const opening = await accountsSvc.balanceAsOf(a.id, addDays(from, -1));
        const ledger = await accountsSvc.getLedger(a.id, { from, to });
        const closing = await accountsSvc.balanceAsOf(a.id, to);
        let running = opening;
        bankRows.push([a.name, a.type, 'رصيد افتتاحي / Opening', '', '', '', '', major(opening)]);
        for (const m of ledger) {
          running += Number(m.amountMinor) || 0;
          bankRows.push([
            a.name, a.type, m.date, m.type, m.refNumber || m.refId || '', m.description || '',
            m.amountMinor > 0 ? major(m.amountMinor) : '',
            m.amountMinor < 0 ? major(-m.amountMinor) : '',
            major(running),
          ]);
        }
        bankRows.push([a.name, a.type, 'رصيد ختامي / Closing', '', '', '', '', '', major(closing)]);
      }
      const bankTable = table('Bank-Wallet', 'csv/09-bank-wallet.csv',
        ['الحساب / Account', 'النوع / Type', 'التاريخ / Date', 'الحركة / Movement',
          'المرجع / Reference', 'الوصف / Description', moneyHeader('وارد / In'),
          moneyHeader('صادر / Out'), moneyHeader('الرصيد / Balance')],
        bankRows,
        { widths: [20, 10, 11, 18, 16, 26, 12, 12, 13], moneyColumns: [6, 7, 8] });

      // -----------------------------------------------------------------
      // 10 & 11) Ageing
      // -----------------------------------------------------------------
      const receivableAging = await this._aging('customer', to, from);
      const payableAging = await this._aging('supplier', to, from);

      const agingRows = (res, partyTitle) => {
        const rows = res.rows.map(r => [
          r.party.name || '', r.party.phone || '',
          major(r.opening), major(r.invoiced), major(r.collected), major(r.closing),
          major(r.buckets.current), major(r.buckets.d31), major(r.buckets.d61),
          major(r.buckets.d90), major(r.adjustment),
        ]);
        const t = res.totals;
        rows.push([
          'الإجمالي / Total', '', major(t.opening), major(t.invoiced), major(t.collected),
          major(t.closing), major(t.current), major(t.d31), major(t.d61), major(t.d90),
          major(t.adjustment),
        ]);
        return table(partyTitle, partyTitle === 'Receivables Aging'
          ? 'csv/10-receivables-aging.csv' : 'csv/11-payables-aging.csv',
        ['الاسم / Name', 'الهاتف / Phone', moneyHeader('افتتاحي / Opening'),
          moneyHeader('حركة الشهر / Month invoiced'), moneyHeader('تحصيل/دفع / Settled'),
          moneyHeader('الرصيد / Balance'), moneyHeader('0-30'), moneyHeader('31-60'),
          moneyHeader('61-90'), moneyHeader('+90'),
          moneyHeader('افتتاحي/تسويات / Opening-adjustments')],
        rows, {
          widths: [24, 15, 13, 15, 14, 13, 11, 11, 11, 11, 17],
          moneyColumns: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        });
      };
      const receivablesTable = agingRows(receivableAging, 'Receivables Aging');
      const payablesTable = agingRows(payableAging, 'Payables Aging');

      // -----------------------------------------------------------------
      // 12) Inventory valuation
      // -----------------------------------------------------------------
      const valuation = await this._report('stock').valueAsOf(to);
      const inventoryRows = valuation.lines
        .filter(line => line.qty !== 0 || line.valueMinor !== 0)
        .sort((a, b) => b.valueMinor - a.valueMinor)
        .map(line => {
          const variant = vMap[line.variantId] || {};
          const product = pMap[variant.productId] || {};
          return [
            product.name || '', variant.size || '', variant.color || '',
            variant.barcode || '', line.qty, major(line.avgCostMinor),
            major(line.valueMinor),
          ];
        });
      const inventoryTotal = valuation.lines.reduce((sum, l) => sum + (Number(l.valueMinor) || 0), 0);
      const inventoryTable = table('Inventory Valuation', 'csv/12-inventory-valuation.csv',
        ['الصنف / Product', 'المقاس / Size', 'اللون / Color', 'الباركود / Barcode',
          'الكمية / Qty', moneyHeader('متوسط التكلفة / Avg cost'),
          moneyHeader('القيمة / Value')],
        inventoryRows,
        {
          widths: [26, 10, 12, 16, 9, 15, 14],
          moneyColumns: [5, 6],
          footer: [['الإجمالي / Total', '', '', '', '', '', major(inventoryTotal)]],
        });

      // -----------------------------------------------------------------
      // 13) Stock movements summary
      // -----------------------------------------------------------------
      const stockMoves = await this.repo.listRange('stockMovements', from, to);
      const moveGroups = {};
      for (const m of stockMoves) {
        const type = m.type || 'other';
        if (!moveGroups[type]) {
          moveGroups[type] = { type, count: 0, inQty: 0, outQty: 0, netQty: 0, cost: 0 };
        }
        const g = moveGroups[type];
        const qty = Number(m.qtyChange) || 0;
        g.count++;
        if (qty > 0) g.inQty += qty;
        if (qty < 0) g.outQty += -qty;
        g.netQty += qty;
        g.cost += m.valueChangeMinor != null
          ? Math.abs(Number(m.valueChangeMinor) || 0)
          : Math.abs(qty) * (Number(m.unitCostMinor) || 0);
      }
      const stockRows = Object.values(moveGroups)
        .sort((a, b) => a.type.localeCompare(b.type))
        .map(g => [g.type, g.count, g.inQty, g.outQty, g.netQty, major(g.cost)]);
      const stockTotals = Object.values(moveGroups).reduce((acc, g) => {
        acc.count += g.count; acc.inQty += g.inQty; acc.outQty += g.outQty;
        acc.netQty += g.netQty; acc.cost += g.cost;
        return acc;
      }, { count: 0, inQty: 0, outQty: 0, netQty: 0, cost: 0 });
      const stockTable = table('Stock Movements', 'csv/13-stock-movements.csv',
        ['نوع الحركة / Type', 'عدد الحركات / Count', 'وحدات داخلة / In qty',
          'وحدات خارجة / Out qty', 'صافي الوحدات / Net qty',
          moneyHeader('قيمة التكلفة / Cost value')],
        stockRows,
        {
          widths: [22, 14, 14, 14, 14, 16], moneyColumns: [5],
          footer: [['الإجمالي / Total', stockTotals.count, stockTotals.inQty,
            stockTotals.outQty, stockTotals.netQty, major(stockTotals.cost)]],
        });

      // -----------------------------------------------------------------
      // 14) Balance snapshot
      // -----------------------------------------------------------------
      const snap = snapClose;
      const balanceRows = [
        ['الأصول / Assets'],
        ['النقدية / Cash', major(snap.assets.cashBalance)],
        ['المخزون / Inventory', major(snap.assets.inventoryValue)],
        ['ذمم الزبائن / Receivables', major(snap.assets.receivables)],
        ['مصاريف مدفوعة مقدماً / Prepaid', major(snap.assets.prepaid)],
        ['سلف الموظفين / Employee advances', major(snap.assets.advancesOutstanding)],
        ['إجمالي الأصول / Total assets', major(snap.assets.total)],
        [],
        ['الالتزامات / Liabilities'],
        ['ذمم الموردين / Payables', major(snap.liabilities.payables)],
        ['أرصدة دائنة للزبائن / Customer credits', major(snap.liabilities.customerCredits)],
        ['رواتب مستحقة / Accrued salaries', major(snap.liabilities.accruedSalaries)],
        ['ضريبة مستحقة / Tax payable', major(snap.liabilities.taxPayable)],
        ['إجمالي الالتزامات / Total liabilities', major(snap.liabilities.total)],
        [],
        ['حقوق الملكية / Equity'],
        ['رأس المال الافتتاحي / Opening equity', major(snap.equity.openingEquity)],
        ['رأس مال مضاف / Capital in', major(snap.equity.capitalIn)],
        ['مسحوبات / Withdrawals', major(snap.equity.withdrawals)],
        ['أرباح محتجزة / Retained earnings', major(snap.equity.retained)],
        ['إجمالي حقوق الملكية / Total equity', major(snap.equity.total)],
        [],
        ['التحقق / Verification'],
        ['الالتزامات + حقوق الملكية / Liabilities + equity',
          major(snap.liabilities.total + snap.equity.total)],
        ['الفرق / Difference', major(snap.assets.total - (snap.liabilities.total + snap.equity.total))],
        ['متوازن؟ / Balanced', snap.balanced ? 'نعم / Yes' : 'لا / No'],
        ['كما في / As of', to],
      ];
      const balanceTable = table('Balance Snapshot', 'csv/14-balance-snapshot.csv',
        ['البند / Item', moneyHeader('القيمة / Value')], balanceRows,
        { widths: [48, 18], moneyColumns: [1] });

      // -----------------------------------------------------------------
      // 15) Profit ⇄ Cash reconciliation
      // -----------------------------------------------------------------
      const rec = await reports.profitCashReconciliation(month);
      const d = rec.deltas || {};
      const reconRows = [
        ['صافي الربح / Net profit', major(rec.netProfit)],
        ['التغير في المخزون / Inventory change', major(d.inventory)],
        ['التغير في ذمم الزبائن / Receivables change', major(d.receivables)],
        ['التغير في المصاريف المدفوعة مقدماً / Prepaid change', major(d.prepaid)],
        ['التغير في ذمم الموردين / Payables change', major(d.payables)],
        ['التغير في الرواتب المستحقة / Accrued salaries change', major(d.accrued)],
        ['التغير في سلف الموظفين / Advances change', major(d.advances)],
        ['التغير في الضريبة / Tax change', major(d.tax)],
        ['النقد من العمليات / Cash from operations', major(rec.cashFromOperations)],
        ['رأس مال مضاف / Capital in', major(rec.capitalIn)],
        ['مسحوبات / Withdrawals', major(-rec.withdrawals)],
        ['التغير النقدي المتوقع / Expected cash change', major(rec.cashChange)],
        ['التغير النقدي الفعلي / Actual cash change', major(rec.actualCashChange)],
        ['مطابق؟ / Matches', rec.matches ? 'نعم / Yes' : 'لا / No'],
      ];
      const reconTable = table('Profit-Cash Recon', 'csv/15-profit-cash-recon.csv',
        ['البند / Item', moneyHeader('القيمة / Value')], reconRows,
        { widths: [52, 18], moneyColumns: [1] });

      // -----------------------------------------------------------------
      // 16) Daily closings
      // -----------------------------------------------------------------
      const closingRows = closings.map(c => [
        c.date, c.status === 'closed' ? 'مقفل / Closed' : 'أعيد فتحه / Reopened',
        c.invoicesCount || 0, major(c.totalSalesMinor), major(c.expectedCashMinor),
        c.countedCashMinor === null || c.countedCashMinor === undefined
          ? '' : major(c.countedCashMinor),
        major(c.differenceMinor), major(c.takenOutMinor), major(c.retainedFloatMinor),
        boolAr(c.noCount), c.note || '',
      ]);
      const closedClosings = closings.filter(c => c.status === 'closed');
      const closingDiffTotal = closedClosings.reduce((sum, c) => sum + (Number(c.differenceMinor) || 0), 0);
      const closingTable = table('Daily Closings', 'csv/16-daily-closings.csv',
        ['التاريخ / Date', 'الحالة / Status', 'الفواتير / Invoices',
          moneyHeader('المبيعات / Sales'), moneyHeader('المتوقع / Expected'),
          moneyHeader('المعدود / Counted'), moneyHeader('الفرق / Difference'),
          moneyHeader('المُخرج / Taken out'), moneyHeader('المتبقي / Retained'),
          'بدون جرد / No count', 'ملاحظات / Notes'],
        closingRows,
        {
          widths: [11, 14, 10, 13, 13, 13, 12, 13, 13, 11, 24],
          moneyColumns: [3, 4, 5, 6, 7, 8],
          footer: [
            ['إجمالي فروقات الأيام المغلقة / Closed-day differences', '', '', '', '', '', major(closingDiffTotal), '', '', '', ''],
            ['فرق الصندوق في قائمة الأرباح / P&L cash over-short', '', '', '', '', '', major(pnl.cashDifference), '', '', '', ''],
          ],
        });

      // -----------------------------------------------------------------
      // 17) Adjustments & voids (audit extract)
      // -----------------------------------------------------------------
      const adjustmentRows = [];
      for (const a of cashAdjustments) {
        const account = accountsInfo.accounts.find(x => x.id === a.accountId);
        adjustmentRows.push([
          'تسوية صندوق / Cash adjustment', a.date, a.id,
          (a.voided ? 'ملغاة / Voided' : 'نشطة / Active') + ' — ' + (account ? account.name : ''),
          major(a.amountMinor), a.note || '', a.closingId || '',
        ]);
      }
      const voidedDocs = [
        ...salesAll.filter(s => s.status === 'void').map(s => ({
          type: 'فاتورة بيع ملغاة / Void sale', date: s.date, id: s.id,
          summary: s.number, amount: s.totalMinor,
        })),
        ...purchasesAll.filter(p => p.status === 'void').map(p => ({
          type: 'مشتريات ملغاة / Void purchase', date: p.date, id: p.id,
          summary: p.number, amount: p.totalMinor,
        })),
        ...expensesAll.filter(e => e.voided).map(e => ({
          type: 'مصروف ملغي / Void expense', date: e.date, id: e.id,
          summary: e.description || e.categoryName || '', amount: e.amountMinor,
        })),
      ];
      for (const v of voidedDocs) {
        if (v.date < from || v.date > to) continue;
        adjustmentRows.push([v.type, v.date, v.id, 'ملغى / Voided',
          major(v.amount), v.summary || '', '']);
      }
      const auditMonth = auditAll.filter(e => localMonthOf(e.timestamp) === month);
      for (const e of auditMonth) {
        if (!e.action) continue;
        adjustmentRows.push([
          'تدقيق / Audit', dayOf(e.timestamp), e.entityId || '',
          e.summary || e.action, '', profileAr(e.profile), e.action,
        ]);
      }
      adjustmentRows.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      const adjustmentsTable = table('Adjustments-Voids', 'csv/17-adjustments-voids.csv',
        ['النوع / Type', 'التاريخ / Date', 'المرجع / Reference',
          'الوصف / Description', moneyHeader('المبلغ / Amount'),
          'الملف الشخصي / Profile', 'الفاتورة/الإجراء / Ref action'],
        adjustmentRows,
        { widths: [24, 11, 22, 36, 13, 12, 18], moneyColumns: [4] });

      // -----------------------------------------------------------------
      // 18) Integrity check
      // -----------------------------------------------------------------
      let integrity = { errors: [], warnings: [], checks: 0 };
      if (BeeStore.maintenance) {
        BeeStore.maintenance.repo = this.repo;
        integrity = await BeeStore.maintenance.integrityCheck();
      }
      const integrityRows = [];
      for (const e of (integrity.errors || [])) {
        integrityRows.push(['خطأ / Error', e.check || '', e.message || '', e.entityType || '', e.entityId || '']);
      }
      for (const w of (integrity.warnings || [])) {
        integrityRows.push(['تحذير / Warning', w.check || '', w.message || '', w.entityType || '', w.entityId || '']);
      }
      const integrityTable = table('Integrity Check', 'csv/18-integrity-check.csv',
        ['المستوى / Level', 'الفحص / Check', 'الرسالة / Message',
          'النوع / Entity', 'المعرف / Id'],
        integrityRows,
        {
          widths: [14, 18, 60, 14, 20],
          footer: [
            ['النتيجة / Result', (integrity.errors || []).length ? 'فشل / Failed' : 'سليم / OK',
              'أخطاء: ' + (integrity.errors || []).length + ' — تحذيرات: ' +
              (integrity.warnings || []).length, '', ''],
            ['عدد الفحوصات / Checks', String(integrity.checks || 0), '', '', ''],
          ],
        });

      const tables = [
        summaryTable, salesJournalTable, salesLinesTable, returnsTable, purchasesTable,
        expensesTable, payrollTable, cashBookTable, bankTable, receivablesTable,
        payablesTable, inventoryTable, stockTable, balanceTable, reconTable,
        closingTable, adjustmentsTable, integrityTable,
      ];

      // -----------------------------------------------------------------
      // Files
      // -----------------------------------------------------------------
      const generatedDate = new Date(generatedAt);
      const zipDate = isNaN(generatedDate.getTime()) ? new Date() : generatedDate;
      const pdf = await this._renderPdf(review, {
        ...opts, storeName: info.storeName, generatedAt,
      });
      const pdfFilename = '01-Month-Review.pdf';
      const appVersion = BeeStore.version || '3.0.0-lite';
      const schemaVersion = this.repo.schemaVersion || BeeStore.schemaVersion || 3;
      const counts = {
        sales: sales.length,
        salesLines: salesLinesRows.length,
        returns: returns.length,
        purchases: purchases.length,
        expenses: expenseRows.length,
        payroll: payroll.length,
        closings: closings.length,
      };
      const readme = this._readme(info, review, counts, {
        storeName: info.storeName,
        generatedAt,
        appVersion,
        schemaVersion,
      });

      const xlsxBytes = BeeStore.xlsx.buildWorkbook(tables.map(xlsxSheet), {
        date: zipDate,
        comment: 'BeeStore accountant package ' + month,
      });
      const files = [];
      const addFile = (path, data, role) => {
        files.push({ path, data: toBytes(data), role });
      };
      addFile('00-README.txt', readme, 'readme');
      addFile(pdfFilename, pdf.bytes, 'month-review-pdf');
      addFile('accounting.xlsx', xlsxBytes, 'spreadsheet');
      for (const t of tables) {
        const csv = csvText(matrix(t));
        addFile(t.file, new TextEncoder().encode(csv), 'csv');
      }

      // Cross-checks (v3-Lite §8.1). Keep raw minor values for exactness.
      const checks = [];
      const addCheck = (id, name, expected, actual, tolerance) => {
        const tol = tolerance === undefined ? 0 : tolerance;
        const ok = typeof expected === 'boolean'
          ? expected === actual
          : Math.abs((Number(actual) || 0) - (Number(expected) || 0)) <= tol;
        checks.push({
          id, name,
          expected: typeof expected === 'boolean' ? expected : Number(expected) || 0,
          actual: typeof actual === 'boolean' ? actual : Number(actual) || 0,
          difference: typeof expected === 'number' && typeof actual === 'number'
            ? (Number(actual) || 0) - (Number(expected) || 0) : 0,
          tolerance: typeof expected === 'number' ? tol : 0,
          ok,
        });
      };

      addCheck('pnl_sheet_equals_month_review',
        'قائمة الأرباح في الحزمة تساوي تقرير الشهر',
        true,
        ['netSales', 'cogs', 'grossProfit', 'operatingExpenses', 'netProfit']
          .every(k => pnl[k] === review.pnl.current[k]));

      const expectedNetSales = review.pnl.current.netSales;
      addCheck('sales_journal_matches_net_sales',
        'مجموع يومية المبيعات ناقص المرتجعات يساوي صافي المبيعات',
        expectedNetSales, journalNetOfTax - returnsTotal);
      addCheck('sales_journal_tax_identity',
        'إجمالي الفواتير = صافي قبل الضريبة + الضريبة',
        journalTotals.total, journalNetOfTax + journalTotals.tax);

      addCheck('cash_book_closing_matches_cash_balance',
        'رصيد الصندوق الختامي في كشف النقدية يساوي رصيد الحساب',
        cashClosing, cashOpening + cashLedger.reduce((sum, m) => sum + (Number(m.amountMinor) || 0), 0));
      addCheck('cash_book_matches_snapshot',
        'رصيد الصندوق الختامي يساوي النقدية في صورة الميزانية',
        snap.assets.cashByAccount && drawer ? (snap.assets.cashByAccount[drawer.id] || 0) : 0,
        cashClosing);

      addCheck('inventory_valuation_matches_snapshot',
        'تقييم المخزون يساوي المخزون في صورة الميزانية',
        snap.assets.inventoryValue, inventoryTotal);

      addCheck('daily_closing_differences_match_pnl',
        'مجموع فروقات إقفال الأيام يساوي فرق الصندوق في قائمة الأرباح',
        review.pnl.current.cashDifference, closingDiffTotal);

      addCheck('payroll_total_matches_pnl',
        'إجمالي الرواتب في ورقة الرواتب يساوي مصروف الرواتب',
        review.pnl.current.salaryExpense, payrollGross);

      addCheck('expenses_reconcile_operating',
        'المصاريف + الرواتب + فروقات المخزون + تسوية التكلفة − فروقات الصندوق = المصاريف التشغيلية',
        review.pnl.current.operatingExpenses,
        operatingExpenseTotal + review.pnl.current.salaryExpense +
        review.pnl.current.stockLosses + review.pnl.current.stockRevaluation -
        review.pnl.current.cashDifference);

      addCheck('receivables_aging_matches_snapshot',
        'أرصدة الزبائن الموجبة تساوي ذمم الزبائن في صورة الميزانية',
        snap.assets.receivables, receivableAging.totals.positiveClosing);
      addCheck('payables_aging_matches_snapshot',
        'أرصدة الموردين تساوي ذمم الموردين في صورة الميزانية',
        snap.liabilities.payables, payableAging.totals.closing);

      addCheck('balance_snapshot_is_balanced',
        'صورة الميزانية متوازنة (الأصول = الالتزامات + حقوق الملكية)',
        true, !!snap.balanced);

      const integrityOk = (integrity.errors || []).length === 0;
      addCheck('integrity_check_has_no_errors',
        'فحص سلامة البيانات بلا أخطاء',
        true, integrityOk);

      // Verify the checksums before the manifest is written. This is the exact
      // check the accountant can repeat with any SHA-256 tool.
      const checksumEntries = files.map(f => ({
        path: f.path,
        bytes: f.data.length,
        sha256: sha256Bytes(f.data),
        role: f.role,
      }));
      const checksumFailures = checksumEntries.filter((entry, i) =>
        sha256Bytes(files[i].data) !== entry.sha256);
      addCheck('manifest_checksums_verify',
        'بصمات SHA-256 لكل ملفات الحزمة صحيحة',
        files.length, files.length - checksumFailures.length);

      const manifest = {
        format: 'beestore-accountant-package',
        formatVersion: 1,
        storeName: info.storeName,
        month,
        monthLabel: info.monthLabel,
        status: review.closed ? 'closed' : 'open',
        statusLabel: review.closed ? 'مُقفل / Closed' : 'غير نهائي — الشهر مفتوح / NOT FINAL',
        generatedAt,
        appVersion,
        schemaVersion,
        currency: info.currency,
        counts,
        files: checksumEntries,
        checks,
        totals: {
          netSales: review.pnl.current.netSales,
          grossProfit: review.pnl.current.grossProfit,
          operatingExpenses: review.pnl.current.operatingExpenses,
          netProfit: review.pnl.current.netProfit,
          cashClosing,
          inventoryValue: inventoryTotal,
          cashDifference: review.pnl.current.cashDifference,
          salesTotal: journalTotals.total,
          returnsTotal,
        },
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      const zipFiles = files.map(f => ({ name: f.path, data: f.data, date: zipDate }));
      zipFiles.push({ name: 'manifest.json', data: manifestBytes, date: zipDate });
      const bytes = BeeStore.zip.create(zipFiles, {
        date: zipDate,
        comment: 'BeeStore accountant package ' + month + ' — ' + appVersion,
      });
      const blob = new Blob([bytes], { type: 'application/zip' });
      return {
        month,
        status: review.closed ? 'closed' : 'open',
        closed: !!review.closed,
        filename: this.filename(month),
        bytes,
        blob,
        manifest,
        files,
        checks,
        review,
      };
    }

    /** Builds only the Month Review PDF (v3-Lite §8: PDF alone is shareable). */
    async pdf(month, options) {
      this._validateMonth(month);
      const opts = options || {};
      const settings = await this._settings();
      const report = this._report('reports');
      const review = await report.monthReview(month);
      const pdf = await this._renderPdf(review, {
        ...opts,
        storeName: opts.storeName || settings.storeNameAr || settings.storeName || 'Bee Store',
        generatedAt: opts.generatedAt || (BeeStore.dates ? BeeStore.dates.now() : new Date().toISOString()),
      });
      return {
        month,
        closed: !!review.closed,
        status: review.closed ? 'closed' : 'open',
        filename: 'BeeStore-' + month + '-Month-Review.pdf',
        bytes: pdf.bytes,
        pageCount: pdf.pageCount || 0,
        blob: new Blob([pdf.bytes], { type: 'application/pdf' }),
      };
    }

    _deliverer() {
      if (BeeStore.cloudTarget && BeeStore.cloudTarget.shareOrDownload) {
        return BeeStore.cloudTarget.shareOrDownload;
      }
      if (BeeStore.backupFile && BeeStore.backupFile.shareOrDownload) {
        return BeeStore.backupFile.shareOrDownload;
      }
      throw fail('UNAVAILABLE', 'خدمة المشاركة/التنزيل غير محمّلة');
    }

    /** Shares the package (share sheet → download fallback). */
    async share(month, options) {
      const opts = options || {};
      const pkg = await this.build(month, opts);
      const result = await this._deliverer()(pkg.blob, pkg.filename, {
        env: opts.env,
        mimeType: 'application/zip',
        title: 'حزمة المحاسب — ' + monthLabel(month),
        text: 'حزمة محاسب شهر ' + monthLabel(month) + ' من بي ستور (للقراءة فقط).',
        prefer: opts.prefer,
      });
      return { ...result, filename: pkg.filename, month, status: pkg.status };
    }

    /** Downloads the package without trying the share sheet. */
    async download(month, options) {
      return this.share(month, { ...(options || {}), prefer: 'download' });
    }

    /** Shares the Month Review PDF alone. */
    async sharePdf(month, options) {
      const opts = options || {};
      const doc = await this.pdf(month, opts);
      const result = await this._deliverer()(doc.blob, doc.filename, {
        env: opts.env,
        mimeType: 'application/pdf',
        title: 'تقرير شهر ' + monthLabel(month) + ' — بي ستور',
        text: 'تقرير الشهر (PDF) من بي ستور.',
        prefer: opts.prefer,
      });
      return { ...result, filename: doc.filename, month, status: doc.status };
    }

    async downloadPdf(month, options) {
      return this.sharePdf(month, { ...(options || {}), prefer: 'download' });
    }
  }

  BeeStore.AccountingPackageService = AccountingPackageService;
  BeeStore.accountingPackage = new AccountingPackageService(null);
  BeeStore.sha256Hex = sha256Bytes;
  BeeStore.accountingPackageUtils = {
    csvCell, csvText, sha256Bytes, monthLabel, major, matrix,
  };
  if (typeof module !== 'undefined') module.exports = AccountingPackageService;
})(typeof window !== 'undefined' ? window : globalThis);
