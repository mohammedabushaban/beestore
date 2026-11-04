(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, formatDate, formatDocDate, toast, table, emptyState } = BeeStore.ui;
  const { input, select, textarea, formField } = BeeStore.dialogs;

  async function render(container) {
    container.replaceChildren();
    container.appendChild(el('h2', { class: 'page-title' }, 'تسويات البطاقات والمحافظ'));
    const asOfInput = input('date', BeeStore.dates.today());
    const content = el('div');
    container.appendChild(el('div', { class: 'filter-row' }, [
      asOfInput,
      el('button', {
        class: 'btn btn-secondary',
        onclick: () => load(content, asOfInput.value || BeeStore.dates.today()),
      }, 'عرض'),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => openSettlement(asOfInput.value || BeeStore.dates.today(),
          () => load(content, asOfInput.value || BeeStore.dates.today())),
      }, '+ تسوية جديدة'),
    ]));
    container.appendChild(content);
    await load(content, asOfInput.value);
  }

  async function load(container, asOf) {
    container.replaceChildren(el('p', { class: 'form-hint' }, 'جاري تحميل أرصدة التسوية...'));
    const [overviewRes, historyRes, accountsRes] = await Promise.all([
      BeeStore.api.settlements.overview(asOf),
      BeeStore.api.settlements.list(),
      BeeStore.api.accounts.list(),
    ]);
    if (!overviewRes.ok) { container.replaceChildren(); toast(overviewRes.error.message, 'error'); return; }
    if (!historyRes.ok) { container.replaceChildren(); toast(historyRes.error.message, 'error'); return; }
    if (!accountsRes.ok) { container.replaceChildren(); toast(accountsRes.error.message, 'error'); return; }
    const accountNames = {};
    for (const account of accountsRes.data) accountNames[account.id] = account.name;
    container.replaceChildren();

    if (overviewRes.data.methods.length === 0) {
      container.appendChild(el('div', { class: 'alert alert-warning' },
        'لا توجد طرق دفع من نوع تسوية. اضبط نوع البطاقة أو المحفظة من إعدادات طرق الدفع.'));
    }
    for (const method of overviewRes.data.methods) {
      container.appendChild(methodCard(method));
    }

    container.appendChild(el('h3', {}, 'سجل التسويات'));
    const rows = historyRes.data.map(doc => [
      formatDocDate(doc),
      doc.number,
      doc.methodName || doc.method,
      formatMoney(doc.grossMinor),
      formatMoney(doc.expectedFeeMinor),
      formatMoney(doc.feeMinor),
      feeDifference(doc.feeDifferenceMinor),
      formatMoney(doc.netReceivedMinor),
      accountNames[doc.bankAccountId] || '—',
      doc.reference || '—',
      BeeStore.journalView.button(doc, { title: 'قيود التسوية ' + doc.number }) || '',
      doc.voided
        ? el('span', { class: 'badge badge-muted' }, 'ملغاة')
        : el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => openVoid(doc, () => load(container, asOf)),
        }, 'إلغاء'),
    ]);
    container.appendChild(rows.length
      ? table(['التاريخ', 'الرقم', 'الطريقة', 'الإجمالي', 'العمولة المتوقعة',
        'العمولة الفعلية', 'الفرق', 'الصافي', 'البنك', 'المرجع', 'القيد', ''], rows)
      : emptyState('لا توجد تسويات مسجلة'));
  }

  function methodCard(method) {
    const children = [
      el('h3', {}, method.methodName),
      el('div', { class: 'cards-grid' }, [
        stat('الرصيد غير المسوّى', formatMoney(method.unsettledMinor),
          method.reconciled ? 'مطابق لتفاصيل الإيصالات' : 'يوجد فرق يحتاج مراجعة'),
        stat('عمولات هذا الشهر', formatMoney(method.feesMonthMinor),
          'المتوقع: ' + formatMoney(method.expectedFeesMonthMinor)),
        stat('فرق العمولة هذا الشهر', formatMoney(method.feeDifferenceMonthMinor),
          'الفعلي − المتوقع'),
        stat('معدل العمولة الفعلي', (method.effectiveFeeBasisPoints / 100).toFixed(2) + '٪',
          'على تسويات بقيمة ' + formatMoney(method.settledMonthMinor)),
      ]),
      el('p', {
        class: 'alert ' + (method.reconciled ? 'alert-success' : 'alert-danger'),
      }, method.reconciled
        ? 'حساب التسوية مطابق للإيصالات غير المسوّاة.'
        : 'حساب التسوية لا يطابق تفاصيل الإيصالات. راجع القيود قبل الاعتماد على الكشف.'),
    ];
    if (method.receipts.length) {
      children.push(el('h4', {}, 'الإيصالات غير المسوّاة والأعمار'));
      children.push(table(['المصدر', 'التاريخ', 'العمر بالأيام', 'الأصل', 'المتبقي'],
        method.receipts.map(receipt => [
          receipt.number || (receipt.sourceType === 'CUSTOMER_PAYMENT' ? 'تحصيل زبون' : receipt.sourceId),
          formatDate(receipt.date),
          String(receipt.ageDays),
          formatMoney(receipt.grossMinor),
          formatMoney(receipt.remainingMinor),
        ])));
    } else {
      children.push(el('p', { class: 'empty-state' }, 'لا توجد إيصالات غير مسوّاة لهذه الطريقة'));
    }
    return el('section', { class: 'card' }, children);
  }

  function stat(title, value, sub) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-title' }, title),
      el('div', { class: 'stat-value' }, value),
      el('div', { class: 'stat-sub' }, sub),
    ]);
  }

  function feeDifference(minor) {
    const value = Number(minor) || 0;
    return el('span', { class: value === 0 ? '' : (value > 0 ? 'text-danger' : 'text-warning') },
      (value > 0 ? '+' : '') + formatMoney(value));
  }

  async function openSettlement(defaultDate, onSaved) {
    const [settingsRes, accountsRes] = await Promise.all([
      BeeStore.api.settings.get(),
      BeeStore.api.accounts.list(),
    ]);
    if (!settingsRes.ok) { toast(settingsRes.error.message, 'error'); return; }
    if (!accountsRes.ok) { toast(accountsRes.error.message, 'error'); return; }
    const methods = (settingsRes.data.paymentMethods || [])
      .filter(method => BeeStore.settings.methodKind(settingsRes.data, method.id) === 'clearing');
    const banks = accountsRes.data.filter(account => account.type === 'bank' && account.active !== false);
    if (!methods.length) { toast('لا توجد طريقة دفع من نوع تسوية', 'error'); return; }
    if (!banks.length) { toast('أضف حساباً بنكياً فعالاً أولاً', 'error'); return; }

    const methodSelect = select(methods.map(method => ({ value: method.id, label: method.name })), methods[0].id);
    const bankSelect = select(banks.map(account => ({ value: account.id, label: account.name })),
      settingsRes.data.defaultBankAccountId || banks[0].id);
    const dateInput = input('date', defaultDate || BeeStore.dates.today());
    const grossInput = input('number', '', { min: 0, step: '0.01', required: true });
    const feeInput = input('number', '', { min: 0, step: '0.01', required: true });
    const netInput = input('number', '', { min: 0, step: '0.01', required: true });
    const referenceInput = input('text', '', { placeholder: 'رقم كشف شركة الدفع' });
    const noteInput = textarea('', { placeholder: 'ملاحظات اختيارية' });
    const quoteBox = el('div', { class: 'alert alert-info', role: 'status' }, 'اختر الطريقة والتاريخ لعرض الرصيد والعمولة المتوقعة.');
    let quote = null;
    let requestSerial = 0;

    async function refreshQuote(setAmounts) {
      const serial = ++requestSerial;
      const grossMinor = BeeStore.money.fromMajor(grossInput.value || '0');
      const res = await BeeStore.api.settlements.quote(methodSelect.value, {
        date: dateInput.value || BeeStore.dates.today(),
        grossMinor: setAmounts ? undefined : grossMinor,
        feeMinor: setAmounts ? undefined : BeeStore.money.fromMajor(feeInput.value || '0'),
      });
      if (serial !== requestSerial) return;
      if (!res.ok) { quote = null; quoteBox.textContent = res.error.message; quoteBox.className = 'alert alert-danger'; return; }
      quote = res.data;
      if (setAmounts) {
        grossInput.value = BeeStore.money.toMajor(quote.grossMinor);
        feeInput.value = BeeStore.money.toMajor(quote.expectedFeeMinor);
        netInput.value = BeeStore.money.toMajor(quote.suggestedNetMinor);
      }
      updateQuoteBox();
    }

    function updateQuoteBox() {
      if (!quote) return;
      const grossMinor = BeeStore.money.fromMajor(grossInput.value || '0');
      const actualFeeMinor = BeeStore.money.fromMajor(feeInput.value || '0');
      const differenceMinor = actualFeeMinor - quote.expectedFeeMinor;
      quoteBox.replaceChildren(
        el('div', {}, 'غير المسوّى: ' + formatMoney(quote.unsettledMinor) +
          ' | العمولة المتوقعة: ' + formatMoney(quote.expectedFeeMinor)),
        el('div', {}, 'فرق العمولة (الفعلي − المتوقع): ' +
          (differenceMinor > 0 ? '+' : '') + formatMoney(differenceMinor)),
      );
      quoteBox.className = 'alert ' + (grossMinor > Math.max(0, quote.unsettledMinor)
        ? 'alert-warning' : 'alert-info');
      if (grossMinor > Math.max(0, quote.unsettledMinor)) {
        quoteBox.appendChild(el('div', {}, 'القيمة تتجاوز الرصيد غير المسوّى وستحتاج تأكيداً صريحاً من المالك.'));
      }
    }

    function feeChanged() {
      const grossMinor = BeeStore.money.fromMajor(grossInput.value || '0');
      const feeMinor = BeeStore.money.fromMajor(feeInput.value || '0');
      netInput.value = BeeStore.money.toMajor(Math.max(0, grossMinor - feeMinor));
      updateQuoteBox();
    }

    function netChanged() {
      const grossMinor = BeeStore.money.fromMajor(grossInput.value || '0');
      const netMinor = BeeStore.money.fromMajor(netInput.value || '0');
      feeInput.value = BeeStore.money.toMajor(Math.max(0, grossMinor - netMinor));
      updateQuoteBox();
    }

    methodSelect.addEventListener('change', () => refreshQuote(true));
    dateInput.addEventListener('change', () => refreshQuote(true));
    grossInput.addEventListener('change', () => refreshQuote(false));
    feeInput.addEventListener('input', feeChanged);
    netInput.addEventListener('input', netChanged);

    const saveButton = el('button', { class: 'btn btn-primary' }, 'حفظ التسوية');
    const { overlay } = BeeStore.dialogs.openDialog('تسوية بطاقة أو محفظة', [
      formField('طريقة الدفع', methodSelect, true),
      formField('التاريخ', dateInput, true),
      formField('الحساب البنكي المستلم', bankSelect, true),
      quoteBox,
      formField('الإجمالي من كشف شركة الدفع', grossInput, true),
      formField('العمولة الفعلية', feeInput, true),
      formField('الصافي المستلم في البنك', netInput, true),
      formField('المرجع', referenceInput),
      formField('ملاحظات', noteInput),
      saveButton,
    ], null, { large: true });

    saveButton.addEventListener('click', async () => {
      const data = {
        method: methodSelect.value,
        date: dateInput.value || BeeStore.dates.today(),
        bankAccountId: bankSelect.value,
        grossMinor: BeeStore.money.fromMajor(grossInput.value || '0'),
        feeMinor: BeeStore.money.fromMajor(feeInput.value || '0'),
        netReceivedMinor: BeeStore.money.fromMajor(netInput.value || '0'),
        reference: referenceInput.value.trim(),
        note: noteInput.value.trim(),
      };
      if (data.grossMinor <= 0 || data.feeMinor < 0 || data.netReceivedMinor < 0) {
        toast('أدخل مبالغ تسوية صحيحة', 'error'); return;
      }
      if (data.grossMinor !== data.feeMinor + data.netReceivedMinor) {
        toast('الإجمالي يجب أن يساوي العمولة + الصافي المستلم', 'error'); return;
      }
      saveButton.disabled = true;
      const save = async overSettlementFlag => {
        const res = await BeeStore.api.settlements.create({
          ...data, overSettlementFlag: overSettlementFlag || null,
        });
        if (res.ok) {
          overlay.remove();
          toast('تم حفظ التسوية ' + res.data.number);
          if (onSaved) await onSaved();
          return;
        }
        saveButton.disabled = false;
        if (res.error.code === 'OVER_SETTLED') {
          BeeStore.ui.confirmDialog('تأكيد تسوية تتجاوز الرصيد',
            'الإجمالي يتجاوز الرصيد غير المسوّى. هل يراجع المالك كشف شركة الدفع ويؤكد تسجيل الفرق دون إخفائه؟',
            () => save('OVER_SETTLED'),
            { confirmText: 'تأكيد المالك والحفظ' });
        } else {
          toast(res.error.message, 'error');
        }
      };
      await save(null);
    });
    await refreshQuote(true);
  }

  function openVoid(doc, onVoided) {
    const reasonInput = textarea('', { placeholder: 'سبب الإلغاء', required: true });
    const saveButton = el('button', { class: 'btn btn-danger' }, 'تأكيد الإلغاء');
    const { overlay } = BeeStore.dialogs.openDialog('إلغاء التسوية ' + doc.number, [
      el('p', {}, 'سيُضاف قيد عكسي مطابق، ويبقى المستند ظاهراً في السجل.'),
      formField('سبب الإلغاء', reasonInput, true),
      saveButton,
    ]);
    saveButton.addEventListener('click', async () => {
      if (!reasonInput.value.trim()) { toast('سبب الإلغاء مطلوب', 'error'); return; }
      saveButton.disabled = true;
      const res = await BeeStore.api.settlements.void(doc.id, reasonInput.value.trim());
      if (!res.ok) {
        saveButton.disabled = false;
        toast(res.error.message, 'error');
        return;
      }
      overlay.remove();
      toast('تم إلغاء التسوية وعكس قيدها');
      if (onVoided) await onVoided();
    });
  }

  BeeStore.pages = BeeStore.pages || {};
  BeeStore.pages.settlements = { render };
  if (typeof module !== 'undefined') module.exports = { render };
})(typeof window !== 'undefined' ? window : globalThis);
