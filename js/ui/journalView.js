(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el, formatMoney, toast } = BeeStore.ui;

  // v5 §10: every document gets a "عرض القيد المحاسبي" button that shows its
  // journal entries. The journal is owner-only (the API refuses the cashier),
  // so the button is not offered to the cashier at all.

  function canView() {
    return !(BeeStore.auth && BeeStore.auth.isCashier && BeeStore.auth.isCashier());
  }

  function linkedIds(doc) {
    const ids = [];
    const add = (list) => { for (const id of (list || [])) if (id && ids.indexOf(id) < 0) ids.push(id); };
    if (!doc) return ids;
    add(doc.journalEntryIds);
    for (const p of (doc.payments || [])) add(p && p.journalEntryIds);
    return ids;
  }

  /**
   * @param {object|string} doc document (uses id + journalEntryIds) or id
   * @param {object} [options] {label, title, className}
   * @returns {HTMLElement|null} button, or null for the cashier
   */
  function button(doc, options) {
    if (!canView()) return null;
    const opts = options || {};
    const id = typeof doc === 'string' ? doc : (doc && doc.id);
    const ids = typeof doc === 'string' ? [] : linkedIds(doc);
    return el('button', {
      class: opts.className || 'btn btn-sm btn-ghost',
      title: 'عرض القيد المحاسبي',
      onclick: (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        show(id, ids, opts.title);
      },
    }, opts.label || 'القيد');
  }

  async function show(sourceId, entryIds, title) {
    const res = await BeeStore.api.journal.forDocument(sourceId, entryIds || []);
    if (!res.ok) { toast(res.error.message, 'error'); return; }
    const entries = res.data;
    const body = entries.length
      ? entries.map(entryCard)
      : [el('p', { class: 'empty-state' }, 'لا توجد قيود محاسبية لهذا المستند.')];
    BeeStore.dialogs.openDialog(title || 'القيد المحاسبي', body, null, { large: true });
  }

  function entryCard(entry) {
    let debit = 0;
    let credit = 0;
    const rows = entry.lines.map((line) => {
      debit += line.debitMinor || 0;
      credit += line.creditMinor || 0;
      return el('tr', {}, [
        el('td', {}, line.code || ''),
        el('td', {}, line.nameAr + (line.memo ? ' — ' + line.memo : '')),
        el('td', { class: 'num' }, line.debitMinor ? formatMoney(line.debitMinor) : ''),
        el('td', { class: 'num' }, line.creditMinor ? formatMoney(line.creditMinor) : ''),
      ]);
    });
    const badge = entry.reversalOf
      ? el('span', { class: 'badge badge-warning' }, 'قيد عكسي')
      : (entry.reversed ? el('span', { class: 'badge badge-muted' }, 'معكوس') : null);
    return el('div', { class: 'card' }, [
      el('h4', {}, [entry.number + ' · ' + BeeStore.dates.formatDocDateTime(entry) +
        ' · ' + (entry.sourceLabel || entry.sourceType) + ' ', badge]),
      entry.description ? el('p', { class: 'form-hint' }, entry.description) : null,
      el('div', { class: 'table-wrapper' },
        el('table', { class: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'الحساب'), el('th', {}, 'الاسم'),
            el('th', { class: 'num' }, 'مدين'), el('th', { class: 'num' }, 'دائن'),
          ])),
          el('tbody', {}, rows),
          el('tfoot', {}, el('tr', {}, [
            el('td', {}, ''), el('td', {}, debit === credit ? '✓ متوازن' : '⚠ غير متوازن'),
            el('td', { class: 'num' }, formatMoney(debit)), el('td', { class: 'num' }, formatMoney(credit)),
          ])),
        ])),
    ]);
  }

  BeeStore.journalView = { button, show, canView, linkedIds };
  if (typeof module !== 'undefined') module.exports = BeeStore.journalView;
})(typeof window !== 'undefined' ? window : globalThis);
