(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function printInvoice(saleId) {
    BeeStore.api.sales.printData(saleId).then(res => {
      if (!res.ok) { BeeStore.ui.toast(res.error.message, 'error'); return; }
      const { sale, settings, customer, payments } = res.data;
      const paperSize = settings.invoicePaperSize || 'A4';
      const html = buildInvoiceHtml(sale, settings, customer, paperSize, payments);
      openPrintWindow(html, paperSize);
    });
  }

  function buildInvoiceHtml(sale, settings, customer, paperSize, payments) {
    const esc = BeeStore.ui.escapeHtml;
    const is80mm = paperSize === '80mm';
    const width = is80mm ? '80mm' : '210mm';
    const fontSize = is80mm ? '10px' : '14px';

    let html = '<html dir="rtl"><head><meta charset="UTF-8"><title>فاتورة ' + esc(sale.number) + '</title>';
    html += '<style>';
    html += '@page { size: ' + width + ' auto; margin: ' + (is80mm ? '2mm' : '10mm') + '; }';
    html += 'body { font-family: "Cairo", Arial, sans-serif; font-size: ' + fontSize + '; margin: 0; padding: 0; }';
    html += '.header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 10px; }';
    html += '.store-name { font-size: ' + (is80mm ? '14px' : '20px') + '; font-weight: bold; }';
    html += '.store-info { font-size: ' + (is80mm ? '9px' : '12px') + '; color: #666; }';
    html += '.invoice-title { font-size: ' + (is80mm ? '12px' : '16px') + '; font-weight: bold; margin: 10px 0; }';
    html += '.info-row { display: flex; justify-content: space-between; margin-bottom: 5px; }';
    html += 'table { width: 100%; border-collapse: collapse; margin: 10px 0; page-break-inside: auto; }';
    html += 'tr { page-break-inside: avoid; }';
    html += 'th, td { border: 1px solid #ddd; padding: ' + (is80mm ? '3px' : '6px') + '; text-align: right; word-break: break-word; overflow-wrap: anywhere; }';
    html += 'th { background: #f5f5f5; }';
    html += '.totals { margin-top: 10px; text-align: left; }';
    html += '.totals div { display: flex; justify-content: space-between; padding: 3px 0; }';
    html += '.total-final { font-weight: bold; font-size: ' + (is80mm ? '12px' : '16px') + '; border-top: 2px solid #333; padding-top: 5px; }';
    html += '.footer { text-align: center; margin-top: 20px; font-size: ' + (is80mm ? '9px' : '12px') + '; color: #666; border-top: 1px solid #ddd; padding-top: 10px; }';
    html += '.installment-table { margin-top: 10px; font-size: ' + (is80mm ? '8px' : '11px') + '; }';
    html += '@media print { body { margin: 0; } }';
    html += '</style></head><body>';

    html += '<div class="header">';
    html += '<div class="store-name">' + esc((settings && (settings.storeNameAr || settings.storeName)) || 'Bee Store') + '</div>';
    if (settings.phone) html += '<div class="store-info">هاتف: ' + esc(settings.phone) + '</div>';
    if (settings.address) html += '<div class="store-info">' + esc(settings.address) + '</div>';
    html += '</div>';

    html += '<div class="invoice-title">فاتورة بيع</div>';
    html += '<div class="info-row"><span>الرقم: ' + esc(sale.number) + '</span><span>التاريخ: ' + esc(BeeStore.dates.formatDate(sale.date)) + '</span></div>';
    if (customer) html += '<div class="info-row"><span>الزبون: ' + esc(customer.name) + '</span><span>الهاتف: ' + esc(customer.phone || sale.contactPhone || '-') + '</span></div>';
    else if (sale.contactPhone) html += '<div class="info-row"><span>الجوال: ' + esc(sale.contactPhone) + '</span></div>';
    if (sale.payerName) html += '<div class="info-row"><span>اسم المحوِّل: ' + esc(sale.payerName) + '</span></div>';

    html += '<table><thead><tr>';
    html += '<th>المنتج</th><th>المقاس</th><th>اللون</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th>';
    html += '</tr></thead><tbody>';
    for (const line of sale.lines) {
      html += '<tr>';
      html += '<td>' + esc(line.productName) + '</td>';
      html += '<td>' + esc(line.size) + '</td>';
      html += '<td>' + esc(line.color) + '</td>';
      html += '<td>' + esc(line.qty) + '</td>';
      html += '<td>' + esc(BeeStore.money.format(line.unitPriceMinor)) + '</td>';
      html += '<td>' + esc(BeeStore.money.format(line.lineTotalMinor)) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    html += '<div class="totals">';
    html += '<div><span>المجموع الفرعي:</span><span>' + BeeStore.money.format(sale.subtotalMinor) + '</span></div>';
    if (sale.discountMinor > 0) html += '<div><span>الخصم:</span><span>-' + BeeStore.money.format(sale.discountMinor) + '</span></div>';
    if (sale.taxMinor > 0) html += '<div><span>الضريبة:</span><span>' + BeeStore.money.format(sale.taxMinor) + '</span></div>';
    html += '<div class="total-final"><span>الإجمالي:</span><span>' + BeeStore.money.format(sale.totalMinor) + '</span></div>';
    html += '<div><span>المدفوع:</span><span>' + BeeStore.money.format(sale.paidMinor) + '</span></div>';
    html += '<div><span>المتبقي:</span><span>' + BeeStore.money.format(sale.dueMinor) + '</span></div>';
    html += '</div>';

    if (payments && payments.length) {
      html += '<div class="installment-table">';
      html += '<h4>الدفعات</h4>';
      html += '<table><thead><tr><th>التاريخ</th><th>طريقة الدفع</th><th>المبلغ</th><th>المحوِّل</th><th>الجوال</th></tr></thead><tbody>';
      for (const p of payments) {
        const method = (BeeStore.settings && BeeStore.settings.methodLabel) ? BeeStore.settings.methodLabel(settings || {}, p.method) : p.method;
        html += '<tr><td>' + esc(BeeStore.dates.formatDate(p.date)) + '</td><td>' + esc(method) + '</td><td>' + BeeStore.money.format(p.amountMinor) + '</td><td>' + esc(p.payerName || '-') + '</td><td>' + esc(p.payerPhone || '-') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (sale.installmentPlan) {
      html += '<div class="installment-table">';
      html += '<h4>خطة الأقساط</h4>';
      html += '<table><thead><tr><th>#</th><th>تاريخ الاستحقاق</th><th>المبلغ</th><th>المدفوع</th><th>الحالة</th></tr></thead><tbody>';
      for (const inst of sale.installmentPlan.schedule) {
        const status = inst.status === 'paid' ? 'مدفوع' : inst.status === 'overdue' ? 'متأخر' : 'معلق';
        html += '<tr><td>' + inst.n + '</td><td>' + inst.dueDate + '</td><td>' + BeeStore.money.format(inst.amountMinor) + '</td><td>' + BeeStore.money.format(inst.paidMinor) + '</td><td>' + status + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (settings.invoiceFooter) {
      html += '<div class="footer">' + esc(settings.invoiceFooter) + '</div>';
    }

    html += '</body></html>';
    return html;
  }

  function openPrintWindow(html, paperSize) {
    const win = window.open('', '_blank');
    if (!win) { BeeStore.ui.toast('يرجى السماح بالنوافذ المنبثقة', 'error'); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 500);
  }

  // Pure builder (testable in Node): getBarcodeImg(barcode) -> dataURL|string|null.
  function buildLabelSheetHtml(variants, settings, getBarcodeImg) {
    const esc = BeeStore.ui.escapeHtml;
    const labelSize = (settings && settings.labelSize) || '50x30';
    const parts = String(labelSize).split('x').map(Number);
    const w = parts[0] || 50, h = parts[1] || 30;
    const storeName = (settings && (settings.storeNameAr || settings.storeName)) || 'Bee Store';

    let html = '<html dir="rtl"><head><meta charset="UTF-8"><title>ملصقات</title>';
    html += '<style>';
    html += '@page { size: ' + w + 'mm ' + h + 'mm; margin: 2mm; }';
    html += 'body { font-family: "Cairo", Arial, sans-serif; margin: 0; padding: 0; }';
    html += '.label { width: ' + w + 'mm; height: ' + h + 'mm; border: 1px solid #ccc; padding: 2mm; box-sizing: border-box; page-break-after: always; text-align: center; display: flex; flex-direction: column; justify-content: center; }';
    html += '.store-name { font-size: 10px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }';
    html += '.product-name { font-size: 9px; margin: 1mm 0; word-break: break-word; overflow-wrap: anywhere; overflow: hidden; max-height: 7mm; }';
    html += '.price { font-size: 12px; font-weight: bold; color: #F5B700; }';
    html += '.barcode-img { max-width: 100%; height: 12mm; margin-top: 1mm; }';
    html += '.barcode-text { font-size: 8px; margin-top: 1mm; font-family: monospace; }';
    html += '@media print { body { margin: 0; } }';
    html += '</style></head><body>';

    for (const v of variants) {
      let img = null;
      if (getBarcodeImg) {
        try { img = getBarcodeImg(v.barcode); } catch (e) { img = null; }
      }
      html += '<div class="label">';
      html += '<div class="store-name">' + esc(storeName) + '</div>';
      html += '<div class="product-name">' + esc(v.productName) + ' - ' + esc(v.size) + ' / ' + esc(v.color) + '</div>';
      html += '<div class="price">' + esc(BeeStore.money.format(v.priceMinor)) + '</div>';
      if (img) {
        html += '<img class="barcode-img" src="' + esc(img) + '" alt="' + esc(v.barcode) + '">';
      }
      html += '<div class="barcode-text">' + esc(v.barcode) + '</div>';
      html += '</div>';
    }

    html += '</body></html>';
    return html;
  }

  function printLabelSheet(variants, settings) {
    // Render Code128 in THIS window (canvas) and embed as dataURL images, so
    // the print window needs no libraries (spec §8.6).
    const getImg = (BeeStore.barcode && BeeStore.barcode.generate)
      ? (text) => BeeStore.barcode.generate(text, { height: 40 })
      : null;
    openPrintWindow(buildLabelSheetHtml(variants, settings, getImg), 'label');
  }

  function printDailyClosing(date) {
    BeeStore.api.reports.dailyClosing(date).then(res => {
      if (!res.ok) { BeeStore.ui.toast(res.error.message, 'error'); return; }
      const d = res.data;
      const esc = BeeStore.ui.escapeHtml;
      let html = '<html dir="rtl"><head><meta charset="UTF-8"><title>إغلاق اليوم</title>';
      html += '<style>body { font-family: "Cairo", Arial, sans-serif; padding: 20px; } table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: 8px; text-align: right; } th { background: #f5f5f5; }</style>';
      html += '</head><body>';
      html += '<h2>إغلاق اليوم - ' + esc(date) + '</h2>';
      html += '<table><tr><th>البند</th><th>المبلغ</th></tr>';
      for (const [method, amount] of Object.entries(d.salesByMethod)) {
        html += '<tr><td>مبيعات (' + esc(method) + ')</td><td>' + esc(BeeStore.money.format(amount)) + '</td></tr>';
      }
      html += '<tr><td>إجمالي المبيعات</td><td>' + esc(BeeStore.money.format(d.totalSales)) + '</td></tr>';
      html += '<tr><td>المصاريف</td><td>' + esc(BeeStore.money.format(d.totalExpenses)) + '</td></tr>';
      html += '</table></body></html>';
      openPrintWindow(html, 'A4');
    });
  }

  // v3-Lite §4.4: printable Day Report. Arabic is rendered by the browser's
  // HTML engine (never by a PDF text API), so shaping and RTL are correct.
  function buildDayReportHtml(report, settings, size) {
    const esc = BeeStore.ui.escapeHtml;
    const money = (v) => BeeStore.money.format(v || 0);
    const is80 = size === '80mm';
    const width = is80 ? '80mm' : '210mm';
    const fontSize = is80 ? '10px' : '13px';
    const s = settings || {};
    const storeName = s.storeNameAr || s.storeName || 'Bee Store';
    const methodLabel = (id) => (BeeStore.settings && BeeStore.settings.methodLabel)
      ? BeeStore.settings.methodLabel(s, id) : id;
    const dateLabel = BeeStore.dates.formatDate(report.date);

    let html = '<html dir="rtl"><head><meta charset="UTF-8"><title>تقرير يوم ' + esc(dateLabel) + '</title>';
    html += '<style>';
    html += '@page { size: ' + width + ' auto; margin: ' + (is80 ? '3mm' : '10mm') + '; }';
    html += 'body { font-family: "Cairo", Arial, sans-serif; font-size: ' + fontSize + '; margin: 0; color: #111; }';
    html += '.header { text-align:center; border-bottom:2px solid #333; padding-bottom:8px; margin-bottom:10px; }';
    html += '.store-name { font-size:' + (is80 ? '15px' : '21px') + '; font-weight:700; }';
    html += '.store-info { font-size:' + (is80 ? '9px' : '11px') + '; color:#555; }';
    html += '.report-title { font-size:' + (is80 ? '13px' : '17px') + '; font-weight:700; margin:8px 0; }';
    html += '.status { display:inline-block; padding:2px 8px; border:1px solid #999; border-radius:10px; font-size:' + (is80 ? '9px' : '11px') + '; }';
    html += 'h3 { font-size:' + (is80 ? '11px' : '13px') + '; margin:12px 0 4px; border-bottom:1px solid #ddd; padding-bottom:2px; }';
    html += 'table { width:100%; border-collapse:collapse; margin:4px 0 8px; }';
    html += 'th, td { border:1px solid #ddd; padding:' + (is80 ? '2px 3px' : '5px 6px') + '; text-align:right; vertical-align:top; }';
    html += 'th { background:#f4f4f4; }';
    html += '.num { font-variant-numeric: tabular-nums; white-space:nowrap; }';
    html += '.short { color:#b91c1c; font-weight:700; } .over { color:#15803d; font-weight:700; }';
    html += '.note { border:1px dashed #999; padding:6px; min-height:28px; }';
    html += '.signature { display:flex; justify-content:space-between; gap:20px; margin-top:24px; font-size:' + (is80 ? '9px' : '11px') + '; }';
    html += '.signature span { border-top:1px solid #333; padding-top:4px; min-width:45%; }';
    html += '@media print { body { margin:0; } }';
    html += '</style></head><body>';

    html += '<div class="header">';
    html += '<div class="store-name">' + esc(storeName) + '</div>';
    if (s.phone) html += '<div class="store-info">هاتف: ' + esc(s.phone) + '</div>';
    if (s.address) html += '<div class="store-info">' + esc(s.address) + '</div>';
    html += '</div>';
    html += '<div class="report-title">تقرير اليوم — ' + esc(dateLabel) + '</div>';
    html += '<div class="status">' + (report.status === 'closed' ? 'مُقفل' : 'مفتوح')
      + (report.noCount ? ' — بدون جرد نقدي' : '') + '</div>';
    if (report.closedAt) html += '<div class="store-info">وقت الإقفال: ' + esc(BeeStore.dates.formatDateTime(report.closedAt)) + '</div>';

    html += '<h3>المبيعات</h3>';
    html += '<table><tbody>';
    html += '<tr><td>عدد الفواتير</td><td class="num">' + esc(report.invoicesCount || 0) + '</td></tr>';
    html += '<tr><td>إجمالي المبيعات</td><td class="num">' + esc(money(report.totalSalesMinor)) + '</td></tr>';
    html += '<tr><td>متوسط الفاتورة</td><td class="num">' + esc(money(report.averageInvoiceMinor)) + '</td></tr>';
    for (const [method, amount] of Object.entries(report.salesByMethod || {})) {
      html += '<tr><td>مبيعات ' + esc(methodLabel(method)) + ' (صافي)</td><td class="num">' + esc(money(amount)) + '</td></tr>';
    }
    html += '<tr><td>مرتجعات نقدية</td><td class="num">' + esc(money(report.returnsCashRefundMinor)) + '</td></tr>';
    html += '<tr><td>ديون جديدة اليوم</td><td class="num">' + esc(money(report.openCreditMinor)) + '</td></tr>';
    html += '</tbody></table>';

    if (report.expenses && report.expenses.length > 0) {
      html += '<h3>المصاريف (' + esc(report.expenses.length) + ')</h3><table><thead><tr><th>البيان</th><th>المبلغ</th></tr></thead><tbody>';
      for (const e of report.expenses) {
        html += '<tr><td>' + esc(e.description) + '</td><td class="num">' + esc(money(e.amountMinor)) + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    if (report.returns && report.returns.length > 0) {
      html += '<h3>المرتجعات (' + esc(report.returns.length) + ')</h3><table><thead><tr><th>الرقم</th><th>المبلغ</th><th>السبب</th></tr></thead><tbody>';
      for (const r of report.returns) {
        html += '<tr><td>' + esc(r.number || '') + '</td><td class="num">' + esc(money(r.refundMinor)) + '</td><td>' + esc(r.reason || '') + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    html += '<h3>مطابقة الصندوق</h3>';
    html += '<table><tbody>';
    html += '<tr><td>رصيد افتتاحي</td><td class="num">' + esc(money(report.openingCashMinor)) + '</td></tr>';
    html += '<tr><td>+ مبيعات نقدية</td><td class="num">' + esc(money(report.cashSalesMinor)) + '</td></tr>';
    html += '<tr><td>+ تحصيلات نقدية</td><td class="num">' + esc(money(report.customerCollectionsCashMinor)) + '</td></tr>';
    html += '<tr><td>+ حركات نقدية أخرى</td><td class="num">' + esc(money(report.cashInOtherMinor)) + '</td></tr>';
    html += '<tr><td>− مرتجعات من الصندوق</td><td class="num">' + esc(money(report.returnsCashRefundMinor)) + '</td></tr>';
    html += '<tr><td>− مدفوعات موردين من الصندوق</td><td class="num">' + esc(money(report.supplierCashPaymentsMinor)) + '</td></tr>';
    html += '<tr><td>− مصاريف من الصندوق</td><td class="num">' + esc(money(report.cashExpensesMinor)) + '</td></tr>';
    html += '<tr><td>− حركات نقدية أخرى</td><td class="num">' + esc(money(report.cashOutOtherMinor)) + '</td></tr>';
    html += '<tr><td><strong>المتوقع في الصندوق</strong></td><td class="num"><strong>' + esc(money(report.expectedCashMinor)) + '</strong></td></tr>';
    if (report.status === 'closed' || report.countedCashMinor !== null && report.countedCashMinor !== undefined) {
      html += '<tr><td>المعدود</td><td class="num">' + esc(money(report.countedCashMinor)) + '</td></tr>';
      const diff = report.differenceMinor || 0;
      html += '<tr><td>الفرق (معدود − متوقع)</td><td class="num ' + (diff < 0 ? 'short' : (diff > 0 ? 'over' : '')) + '">'
        + esc(money(diff)) + '</td></tr>';
      html += '<tr><td>المُخرج (بنك/سحب)</td><td class="num">' + esc(money(report.takenOutMinor)) + '</td></tr>';
      html += '<tr><td><strong>الصندوق المتبقي</strong></td><td class="num"><strong>' + esc(money(report.retainedFloatMinor)) + '</strong></td></tr>';
    }
    html += '</tbody></table>';

    if (report.externalWarnings && report.externalWarnings.length > 0) {
      html += '<h3>تنبيهات الأجهزة الخارجية</h3><ul>';
      for (const w of report.externalWarnings) {
        html += '<li>' + esc(methodLabel(w.method)) + ': فرق ' + esc(money(w.differenceMinor)) + ' (لم يُسجّل أي قيد)</li>';
      }
      html += '</ul>';
    }

    if (report.topItems && report.topItems.length > 0) {
      html += '<h3>أعلى الأصناف مبيعاً</h3><table><thead><tr><th>الصنف</th><th>الكمية</th><th>الإيراد</th></tr></thead><tbody>';
      for (const item of report.topItems) {
        html += '<tr><td>' + esc(item.productName || '') + ' ' + esc(item.size || '') + ' ' + esc(item.color || '')
          + '</td><td class="num">' + esc(item.qty) + '</td><td class="num">' + esc(money(item.revenueMinor)) + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    if (report.lowStock && report.lowStock.length > 0) {
      html += '<h3>مخزون منخفض (أصناف بيعت اليوم)</h3><ul>';
      for (const v of report.lowStock) {
        html += '<li>' + esc(v.size || '') + ' / ' + esc(v.color || '') + ' — المتبقي: ' + esc(v.quantity) + '</li>';
      }
      html += '</ul>';
    }

    html += '<h3>ملاحظات</h3><div class="note">' + esc(report.note || '') + '</div>';
    html += '<div class="signature"><span>توقيع المسؤول</span><span>التاريخ: ' + esc(dateLabel) + '</span></div>';
    html += '</body></html>';
    return html;
  }

  function printDayReport(report, settings, size) {
    if (!report) { BeeStore.ui.toast('لا يوجد تقرير للطباعة', 'error'); return; }
    openPrintWindow(buildDayReportHtml(report, settings, size), size || 'A4');
  }

  BeeStore.print = {
    printInvoice, printLabelSheet, printDailyClosing, printDayReport,
    buildInvoiceHtml, buildLabelSheetHtml, buildDayReportHtml,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.print;
})(typeof window !== 'undefined' ? window : globalThis);
