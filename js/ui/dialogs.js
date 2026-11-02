(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  const { el } = BeeStore.ui;

  function openDialog(title, content, onSave, options = {}) {
    const id = 'dialog-' + Math.random().toString(36).slice(2);
    const overlay = el('div', { class: 'dialog-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title' });
    const dialog = el('div', { class: 'dialog' + (options.large ? ' dialog-lg' : '') }, [
      el('div', { class: 'dialog-header' }, [
        el('h3', { id: id + '-title' }, title),
        el('button', { class: 'btn-close', onclick: () => overlay.remove(), 'aria-label': 'إغلاق' }, '×'),
      ]),
      el('div', { class: 'dialog-body' }, content),
      options.footer ? el('div', { class: 'dialog-actions' }, options.footer) : null,
    ]);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    const firstInput = dialog.querySelector('input, select, textarea, button');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
    
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
      if (e.key === 'Tab') _trapFocus(e, dialog);
    });
    
    return { overlay, dialog, close: () => overlay.remove() };
  }

  function _trapFocus(e, dialog) {
    const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function formField(label, input, required, helpText, action) {
    const id = 'field-' + Math.random().toString(36).slice(2);
    if (input && !input.id) input.id = id;
    const labelEl = el('label', { class: 'form-label', for: id }, label + (required ? ' *' : ''));
    const items = [labelEl];
    // Optional trailing action (e.g. a barcode scan button) next to the input.
    items.push(action ? el('div', { class: 'field-with-action' }, [input, action]) : input);
    if (helpText) items.push(el('p', { class: 'form-hint', id: id + '-help' }, helpText));
    if (input) input.setAttribute('aria-describedby', id + '-help');
    return el('div', { class: 'form-group' }, items);
  }

  function input(type, value, attrs) {
    return el('input', Object.assign({ type: type || 'text', value: value || '', class: 'form-input' }, attrs || {}));
  }

  function select(options, value, attrs) {
    const s = el('select', Object.assign({ class: 'form-input' }, attrs || {}));
    for (const opt of options) {
      const o = el('option', { value: opt.value }, opt.label);
      if (String(opt.value) === String(value)) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  function textarea(value, attrs) {
    return el('textarea', Object.assign({ class: 'form-input', rows: 3 }, attrs || {}), value || '');
  }

  function checkbox(label, checked, attrs) {
    const id = 'chk-' + Math.random().toString(36).slice(2);
    const input = el('input', Object.assign({ type: 'checkbox', id, class: 'form-checkbox' }, attrs || {}));
    input.checked = !!checked;
    const labelEl = el('label', { for: id, style: 'cursor: pointer; display: flex; align-items: center; gap: 8px;' }, [input, document.createTextNode(' ' + label)]);
    return el('div', { class: 'form-group', style: 'display: flex; align-items: center;' }, labelEl);
  }

  function radioGroup(name, options, value, attrs) {
    const group = el('div', { class: 'form-group', role: 'radiogroup', 'aria-label': attrs?.label });
    for (const opt of options) {
      const id = name + '-' + opt.value;
      const input = el('input', Object.assign({ type: 'radio', name, id, value: opt.value, class: 'form-radio' }, attrs || {}));
      input.checked = String(opt.value) === String(value);
      const labelEl = el('label', { for: id, style: 'cursor: pointer; margin-left: 8px; margin-right: 16px;' }, opt.label);
      group.appendChild(el('div', { style: 'display: inline-flex; align-items: center;' }, [input, labelEl]));
    }
    return group;
  }

  function fileInput(accept, attrs) {
    return el('input', Object.assign({ type: 'file', class: 'form-input', accept }, attrs || {}));
  }

  function numberInput(value, attrs) {
    return input('number', value, Object.assign({ min: 0, step: 'any' }, attrs));
  }

  function dateInput(value, attrs) {
    return input('date', value, attrs);
  }

  function hiddenInput(name, value) {
    return input('hidden', value, { name });
  }

  /**
   * Open a void/cancel dialog for a document.
   * Posts a reversing entry via the posting service, marks the document as voided,
   * and never deletes the original. Reason is mandatory.
   * @param {string} title dialog title
   * @param {string} itemDesc description of the item being voided (for display)
   * @param {function} voidFn async function({id, reason}) → Promise<object> the voided record
   * @param {object} [options] {existingReason} pre-filled reason
   * @returns {object} {overlay, dialog, close}
   */
  function voidDialog(title, itemDesc, voidFn, options = {}) {
    const { overlay, dialog, close } = openDialog(
      title,
      [
        el('p', {}, `هل تريد إلغاء ${itemDesc}؟`),
        el('p', { class: 'form-hint' },
          'سيتم عكس القيد الأصلي وتوثيق الإلغاء. لا يمكن التراجع بعد الحفظ.'),
        formField('سبب الإلغاء', input('text', options.existingReason || ''), true),
      ],
      null,
      { large: true }
    );

    const reasonInput = dialog.querySelector('input');
    if (reasonInput) reasonInput.focus();

    // Add save/cancel buttons
    const actions = el('div', { class: 'dialog-actions' }, [
      el('button', {
        class: 'btn btn-secondary',
        onclick: () => { close(); },
      }, 'إلغاء'),
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const reason = reasonInput.value.trim();
          if (!reason) {
            toast('يجب إدخال سبب الإلغاء', 'error');
            return;
          }
          close();
          try {
            const res = await voidFn({ id: dialog.dataset.id, reason });
            toast('تم إلغاء ' + itemDesc);
            // Refresh the page/state if possible
            if (window.BeeStore && window.BeeStore.router) {
              window.BeeStore.router.navigate(location.hash || '#');
            }
          } catch (e) {
            toast(e.message || 'فشل الإلغاء', 'error');
          }
        },
      }, 'تأكيد الإلغاء'),
    ]);
    dialog.appendChild(actions);

    // Store id on dialog for the onclick handler
    dialog.dataset.id = options.id || '';

    return { overlay, dialog, close };
  }

  BeeStore.dialogs = { openDialog, formField, input, select, textarea, checkbox, radioGroup, fileInput, numberInput, dateInput, hiddenInput, voidDialog };
  if (typeof module !== 'undefined') module.exports = BeeStore.dialogs;
})(typeof window !== 'undefined' ? window : globalThis);
