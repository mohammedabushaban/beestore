(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Arabic-safe Month Review PDF (v3-Lite §4.4 / §8.1). Arabic text is never
   * sent to PDF text operators (shaping/bidi would break). Instead the review
   * is drawn on a canvas with the browser's own Arabic shaping, exported as
   * JPEG, and each page image is embedded in a tiny PDF (DCTDecode).
   */

  const A4 = { width: 595, height: 842 };
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

  function monthLabel(month) {
    const parts = String(month || '').split('-');
    const idx = Number(parts[1]) - 1;
    return (MONTHS_AR[idx] || parts[1] || '') + ' ' + (parts[0] || '');
  }

  class PdfBytes {
    constructor() { this.chunks = []; this.length = 0; }
    ascii(text) {
      const s = String(text);
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xFF;
      this.chunks.push(bytes); this.length += bytes.length; return this;
    }
    binary(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.chunks.push(data); this.length += data.length; return this;
    }
    toUint8Array() {
      const out = new Uint8Array(this.length);
      let offset = 0;
      for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
      return out;
    }
  }

  /**
   * Builds a minimal PDF whose pages are full-size JPEG images.
   * @param {Array<{bytes:Uint8Array,width:number,height:number}>} images
   * @param {object} [options] {width,height,title,createdAt}
   * @returns {Uint8Array} PDF bytes
   */
  function buildPdf(images, options) {
    const opts = options || {};
    const list = (images || []).filter(img => img && img.bytes && img.bytes.length);
    if (!list.length) throw new Error('لا توجد صفحات PDF');
    const pageW = Number(opts.width) || A4.width;
    const pageH = Number(opts.height) || A4.height;
    const pageCount = list.length;
    const out = new PdfBytes();
    const offsets = {};
    out.ascii('%PDF-1.4\n');
    out.binary([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
    const addObject = (num, build) => {
      offsets[num] = out.length;
      out.ascii(num + ' 0 obj\n');
      build();
      out.ascii('\nendobj\n');
    };

    addObject(1, () => out.ascii('<< /Type /Catalog /Pages 2 0 R >>'));
    addObject(2, () => {
      const kids = list.map((_, i) => (4 + i * 3) + ' 0 R').join(' ');
      out.ascii('<< /Type /Pages /Kids [' + kids + '] /Count ' + pageCount + ' >>');
    });
    const created = opts.createdAt ? new Date(opts.createdAt) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = created.getFullYear() + pad(created.getMonth() + 1) + pad(created.getDate()) +
      pad(created.getHours()) + pad(created.getMinutes()) + pad(created.getSeconds());
    addObject(3, () => out.ascii(
      '<< /Title (' + String(opts.title || 'BeeStore Month Review').replace(/[()\\]/g, '') +
      ') /Producer (BeeStore v3-Lite) /CreationDate (D:' + stamp + ') >>'));

    for (let i = 0; i < pageCount; i++) {
      const img = list[i];
      const pageObj = 4 + i * 3;
      const contentObj = 5 + i * 3;
      const imageObj = 6 + i * 3;
      addObject(pageObj, () => out.ascii(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] ' +
        '/Resources << /XObject << /Im0 ' + imageObj + ' 0 R >> >> ' +
        '/Contents ' + contentObj + ' 0 R >>'));
      const content = 'q\n' + pageW + ' 0 0 ' + pageH + ' 0 0 cm\n/Im0 Do\nQ\n';
      addObject(contentObj, () => {
        out.ascii('<< /Length ' + content.length + ' >>\nstream\n');
        out.ascii(content);
        out.ascii('endstream');
      });
      addObject(imageObj, () => {
        out.ascii('<< /Type /XObject /Subtype /Image /Width ' + Math.round(img.width) +
          ' /Height ' + Math.round(img.height) + ' /ColorSpace /DeviceRGB ' +
          '/BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\nstream\n');
        out.binary(img.bytes);
        out.ascii('endstream');
      });
    }

    const size = 4 + pageCount * 3;
    const xrefStart = out.length;
    out.ascii('xref\n0 ' + size + '\n');
    out.ascii('0000000000 65535 f \n');
    for (let i = 1; i < size; i++) {
      out.ascii(String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n');
    }
    out.ascii('trailer\n<< /Size ' + size + ' /Root 1 0 R /Info 3 0 R >>\n');
    out.ascii('startxref\n' + xrefStart + '\n%%EOF\n');
    return out.toUint8Array();
  }

  function jpegFromCanvas(canvas) {
    const url = canvas.toDataURL('image/jpeg', 0.9);
    const base64 = String(url).split(',')[1] || '';
    const bin = root.atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function formatMoney(minor) {
    if (BeeStore.money && BeeStore.money.format) return BeeStore.money.format(Number(minor) || 0);
    return ((Number(minor) || 0) / 100).toFixed(2);
  }

  function pct(value) {
    return value == null || value === '' ? '—' : (Number(value) > 0 ? '+' : '') + Number(value) + '%';
  }

  /**
   * Draws the review on A4-canvas pages (150 dpi). Uses the browser's Arabic
   * shaping; no HTML-to-image library is needed.
   * @param {object} review result of reports.monthReview
   * @param {object} [options] {storeName, generatedAt}
   * @returns {Promise<{images:Array, pageCount:number}>}
   */
  async function renderMonthly(review, options) {
    if (!root.document || !root.document.createElement) {
      throw new Error('رسم PDF يحتاج إلى متصفح');
    }
    const opts = options || {};
    if (root.document.fonts && root.document.fonts.load) {
      try { await root.document.fonts.load('16px Cairo'); } catch (e) { /* fallback font */ }
    }
    if (root.document.fonts && root.document.fonts.ready) {
      try { await root.document.fonts.ready; } catch (e) { /* ignore */ }
    }

    const W = 1240, H = 1754, M = 84;
    const pages = [];
    let canvas = null, ctx = null, y = 0, pageNo = 0;
    const isOpen = !review.closed;

    function startPage(first) {
      canvas = root.document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      ctx = canvas.getContext('2d');
      ctx.textBaseline = 'alphabetic';
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      pageNo++;
      if (!first) pages.push(canvas);
      y = M;
      if (first) {
        ctx.fillStyle = '#1b2740';
        ctx.fillRect(0, 0, W, 190);
        ctx.fillStyle = '#f5b700';
        ctx.fillRect(0, 190, W, 10);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 46px Cairo, Arial';
        ctx.fillText(opts.storeName || 'بي ستور', W - M, 92);
        ctx.font = '24px Cairo, Arial';
        ctx.fillStyle = '#d7deea';
        ctx.fillText('تقرير شهري للمحاسب — ' + monthLabel(review.month), W - M, 140);
        y = 250;
      }
      if (isOpen) {
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(-Math.PI / 6);
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = '#b91c1c';
        ctx.font = 'bold 64px Cairo, Arial';
        ctx.textAlign = 'center';
        ctx.fillText('غير نهائي — الشهر مفتوح', 0, 0);
        ctx.restore();
        ctx.textAlign = 'right';
        ctx.globalAlpha = 1;
      }
    }

    function ensure(height) {
      if (y + height > H - 100) {
        finishPage();
        startPage(false);
      }
    }

    function finishPage() {
      const footerY = H - 54;
      ctx.strokeStyle = '#d7deea';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M, footerY - 24);
      ctx.lineTo(W - M, footerY - 24);
      ctx.stroke();
      ctx.font = '18px Cairo, Arial';
      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.fillText('صفحة ' + pageNo, W / 2, footerY);
      ctx.textAlign = 'right';
      ctx.fillText('بي ستور — ' + monthLabel(review.month), W - M, footerY);
      ctx.textAlign = 'left';
      ctx.fillText('تم الإنشاء: ' + String(opts.generatedAt || new Date().toISOString()).slice(0, 16)
        .replace('T', ' '), M, footerY);
      ctx.textAlign = 'right';
      pages.push(canvas);
    }

    function text(value, size, color, bold, x, yPos, align) {
      ctx.font = (bold ? 'bold ' : '') + size + 'px Cairo, Arial';
      ctx.fillStyle = color || '#1b2740';
      ctx.textAlign = align || 'right';
      ctx.fillText(String(value == null ? '' : value), x == null ? W - M : x, yPos);
      ctx.textAlign = 'right';
    }

    function wrap(value, maxWidth) {
      const words = String(value == null ? '' : value).split(/\s+/);
      const lines = [];
      let line = '';
      for (const word of words) {
        const candidate = line ? line + ' ' + word : word;
        if (ctx.measureText(candidate).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
      return lines;
    }

    function paragraph(value, size, color, bold, lineHeight) {
      ctx.font = (bold ? 'bold ' : '') + size + 'px Cairo, Arial';
      const lines = wrap(value, W - M * 2);
      for (const line of lines) {
        ensure(lineHeight);
        text(line, size, color, bold, W - M, y);
        y += lineHeight;
      }
    }

    function section(title) {
      ensure(86);
      y += 20;
      ctx.fillStyle = '#f5b700';
      ctx.fillRect(W - M - 7, y - 25, 7, 32);
      text(title, 30, '#1b2740', true, W - M - 20, y);
      y += 30;
      ctx.strokeStyle = '#e5e7eb';
      ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
      y += 20;
    }

    function kvRows(rows, labelWidth) {
      const lw = labelWidth || 430;
      const valueX = W - M - lw;
      for (const row of rows) {
        ensure(38);
        text(row[0], 21, '#374151', false, W - M, y);
        text(row[1], 21, row[2] || '#111827', true, valueX, y, 'right');
        y += 34;
      }
      y += 6;
    }

    function table(headers, rows, widths, footer) {
      const total = widths.reduce((a, b) => a + b, 0);
      const xs = [];
      let x = W - M;
      for (const w of widths) {
        xs.push(x);
        x -= (w / total) * (W - M * 2);
      }
      const drawHeader = () => {
        ensure(48);
        ctx.fillStyle = '#1b2740';
        ctx.fillRect(M, y - 26, W - M * 2, 40);
        ctx.font = 'bold 20px Cairo, Arial';
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < headers.length; i++) {
          ctx.textAlign = 'right';
          ctx.fillText(String(headers[i]), xs[i] - 8, y);
        }
        y += 42;
      };
      drawHeader();
      for (let r = 0; r < rows.length; r++) {
        ensure(36);
        if (r % 2 === 0) {
          ctx.fillStyle = '#f9fafb';
          ctx.fillRect(M, y - 24, W - M * 2, 34);
        }
        ctx.font = '20px Cairo, Arial';
        ctx.fillStyle = '#111827';
        for (let i = 0; i < rows[r].length; i++) {
          let value = rows[r][i];
          ctx.font = '20px Cairo, Arial';
          ctx.textAlign = 'right';
          const max = (widths[i] / total) * (W - M * 2) - 14;
          let s = String(value == null ? '' : value);
          while (s.length > 2 && ctx.measureText(s).width > max) s = s.slice(0, -2);
          if (s !== String(value == null ? '' : value)) s = s.slice(0, -1) + '…';
          ctx.fillText(s, xs[i] - 8, y);
        }
        y += 34;
      }
      if (footer) {
        ensure(42);
        ctx.fillStyle = '#fef3c7';
        ctx.fillRect(M, y - 26, W - M * 2, 38);
        ctx.font = 'bold 21px Cairo, Arial';
        ctx.fillStyle = '#92400e';
        for (let i = 0; i < footer.length; i++) {
          ctx.textAlign = 'right';
          ctx.fillText(String(footer[i] == null ? '' : footer[i]), xs[i] - 8, y);
        }
        y += 42;
      }
      y += 14;
    }

    startPage(true);
    // Status.
    if (isOpen) {
      ctx.fillStyle = '#fef2f2';
      ctx.fillRect(M, y - 20, W - M * 2, 58);
      text('⚠ غير نهائي — الشهر مفتوح. قد تتغير الأرقام حتى إقفال الشهر.', 23, '#b91c1c', true,
        W - M - 16, y + 18);
      y += 80;
    } else {
      ctx.fillStyle = '#ecfdf5';
      ctx.fillRect(M, y - 20, W - M * 2, 52);
      text('✓ شهر مُقفل — هذه الأرقام نهائية.', 23, '#047857', true, W - M - 16, y + 14);
      y += 74;
    }

    // KPI cards.
    const k = review.kpis || {};
    const cards = [
      ['صافي المبيعات', formatMoney(k.netSales)],
      ['تكلفة البضاعة', formatMoney(k.cogs)],
      ['مجمل الربح', formatMoney(k.grossProfit)],
      ['المصاريف', formatMoney(k.expenses)],
      ['صافي الربح', formatMoney(k.netProfit)],
      ['عدد الفواتير', String(k.invoices || 0)],
    ];
    const cardW = (W - M * 2 - 30) / 3;
    for (let i = 0; i < cards.length; i += 3) {
      ensure(150);
      for (let j = 0; j < 3 && i + j < cards.length; j++) {
        const cx = W - M - (j + 1) * cardW - j * 15;
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1.5;
        if (ctx.roundRect) {
          ctx.beginPath(); ctx.roundRect(cx, y, cardW, 118, 14); ctx.fill(); ctx.stroke();
        } else {
          ctx.fillRect(cx, y, cardW, 118); ctx.strokeRect(cx, y, cardW, 118);
        }
        text(cards[i + j][0], 20, '#6b7280', false, cx + cardW - 18, y + 40);
        text(cards[i + j][1], 30, '#1b2740', true, cx + cardW - 18, y + 88);
      }
      y += 140;
    }

    section('قائمة الأرباح والخسائر');
    const cur = (review.pnl && review.pnl.current) || {};
    const prev = (review.pnl && review.pnl.previous) || {};
    const last = (review.pnl && review.pnl.lastYear) || {};
    table(['البند', 'الشهر الحالي', 'الشهر السابق', 'نفس الشهر العام الماضي'], [
      ['صافي المبيعات', formatMoney(cur.netSales), formatMoney(prev.netSales), formatMoney(last.netSales)],
      ['تكلفة البضاعة المباعة', formatMoney(cur.cogs), formatMoney(prev.cogs), formatMoney(last.cogs)],
      ['مجمل الربح', formatMoney(cur.grossProfit), formatMoney(prev.grossProfit), formatMoney(last.grossProfit)],
      ['هامش الربح', String(cur.margin || 0) + '%', String(prev.margin || 0) + '%', String(last.margin || 0) + '%'],
      ['المصاريف التشغيلية', formatMoney(cur.operatingExpenses), formatMoney(prev.operatingExpenses), formatMoney(last.operatingExpenses)],
      ['الرواتب', formatMoney(cur.salaryExpense), formatMoney(prev.salaryExpense), formatMoney(last.salaryExpense)],
      ['فروقات المخزون', formatMoney(cur.stockLosses), formatMoney(prev.stockLosses), formatMoney(last.stockLosses)],
      ['فروقات الصندوق', formatMoney(cur.cashDifference), formatMoney(prev.cashDifference), formatMoney(last.cashDifference)],
      ['صافي الربح', formatMoney(cur.netProfit), formatMoney(prev.netProfit), formatMoney(last.netProfit)],
    ], [38, 22, 20, 20], ['صافي الربح', formatMoney(cur.netProfit), '', '']);

    section('ملخص المبيعات');
    const paymentRows = Object.keys(review.sales && review.sales.byPayment || {})
      .map(method => [method, formatMoney(review.sales.byPayment[method])]);
    kvRows([
      ['عدد الفواتير', String(k.invoices || 0)],
      ['عدد القطع', String(k.units || 0)],
      ['متوسط الفاتورة', formatMoney(k.avgInvoice)],
      ['التغير في صافي المبيعات', pct(review.pnl && review.pnl.changePct && review.pnl.changePct.netSales)],
      ['التغير في صافي الربح', pct(review.pnl && review.pnl.changePct && review.pnl.changePct.netProfit)],
      ...paymentRows,
    ], 430);

    if (review.sales && review.sales.topByQty && review.sales.topByQty.length) {
      section('الأصناف الأكثر بيعاً');
      table(['الصنف', 'المقاس', 'اللون', 'الكمية', 'الإيراد', 'الربح'],
        review.sales.topByQty.slice(0, 10).map(p => [
          p.name || '—', p.size || '—', p.color || '—', String(p.qty),
          formatMoney(p.revenue), formatMoney(p.profit),
        ]), [36, 12, 14, 10, 14, 14]);
    }

    section('المصاريف حسب التصنيف');
    const expRows = Object.keys(review.expenses && review.expenses.byCategory || {})
      .sort((a, b) => review.expenses.byCategory[b] - review.expenses.byCategory[a])
      .map(cat => [cat, formatMoney(review.expenses.byCategory[cat])]);
    if (!expRows.length) expRows.push(['لا توجد مصاريف مسجلة', formatMoney(0)]);
    table(['التصنيف', 'المبلغ'], expRows, [70, 30],
      ['الإجمالي', formatMoney(cur.operatingExpenses)]);

    section('حركة النقدية');
    const cf = review.cashflow || { opening: {}, inflows: {}, outflows: {}, closing: {} };
    const accountNames = Array.from(new Set([
      ...Object.keys(cf.opening || {}), ...Object.keys(cf.closing || {}),
    ]));
    if (accountNames.length) {
      table(['الحساب', 'رصيد أول الشهر', 'وارد', 'صادر', 'رصيد آخر الشهر'],
        accountNames.map(name => [
          name,
          formatMoney(cf.opening[name] || 0),
          formatMoney((cf.inflows && cf.inflows[name]) || 0),
          formatMoney((cf.outflows && cf.outflows[name]) || 0),
          formatMoney(cf.closing[name] || 0),
        ]), [30, 17, 17, 17, 19],
        ['الإجمالي', formatMoney(cf.openTotal), '', '', formatMoney(cf.closeTotal)]);
    }

    section('الأرصدة والالتزامات');
    const b = review.balances || {};
    const pair = (label, arr) => [label, formatMoney((arr || [0, 0])[0]), formatMoney((arr || [0, 0])[1])];
    table(['البند', 'أول الشهر', 'آخر الشهر'], [
      pair('المخزون', b.inventory),
      pair('ذمم الزبائن', b.receivables),
      pair('ذمم الموردين', b.payables),
      pair('مصاريف مدفوعة مقدماً', b.prepaid),
      pair('رواتب مستحقة', b.accrued),
      pair('سلف الموظفين', b.advances),
    ], [50, 25, 25]);

    section('الزبائن والموظفون والمخزون');
    const customers = review.customers || {};
    const payroll = review.payroll || [];
    const payrollTotal = payroll.reduce((sum, p) => sum + (p.netMinor || 0), 0);
    kvRows([
      ['ائتمان جديد هذا الشهر', formatMoney(customers.newCredit)],
      ['تحصيلات من الزبائن', formatMoney(customers.collected)],
      ['أقساط متأخرة', formatMoney((customers.overdue || []).reduce((s, x) => s + (x.amountMinor || 0), 0))],
      ['قيمة المخزون آخر الشهر', formatMoney((review.inventory || {}).closingValue)],
      ['سجلات الرواتب', String(payroll.length) + ' — صافي ' + formatMoney(payrollTotal)],
      ['وحدات مشتراة', String((review.inventory || {}).purchasedUnits || 0)],
      ['وحدات مباعة', String((review.inventory || {}).soldUnits || 0)],
    ], 430);

    y += 30;
    ensure(90);
    ctx.strokeStyle = '#9ca3af';
    ctx.beginPath(); ctx.moveTo(W - M - 370, y + 30); ctx.lineTo(W - M, y + 30); ctx.stroke();
    text('توقيع المالك', 20, '#6b7280', false, W - M, y + 62);
    y += 100;

    finishPage();
    const images = pages.map(canvas => ({
      bytes: jpegFromCanvas(canvas),
      width: canvas.width,
      height: canvas.height,
    }));
    return { images, pageCount: images.length };
  }

  async function makePdf(review, options) {
    const opts = options || {};
    const rendered = opts.images
      ? { images: opts.images, pageCount: opts.images.length }
      : await renderMonthly(review, opts);
    const bytes = buildPdf(rendered.images, {
      title: 'BeeStore Month Review ' + review.month,
      createdAt: opts.generatedAt,
    });
    return { bytes, pageCount: rendered.pageCount, images: rendered.images };
  }

  BeeStore.monthReviewPdf = { buildPdf, renderMonthly, makePdf, monthLabel, A4 };
  if (typeof module !== 'undefined') module.exports = BeeStore.monthReviewPdf;
})(typeof window !== 'undefined' ? window : globalThis);
