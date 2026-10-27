(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (typeof v === 'boolean') {
          // Boolean HTML attributes (checked, disabled, selected...) must be
          // set as DOM properties. setAttribute('checked', false) would still
          // create checked="false", which browsers treat as checked.
          if (k in e) e[k] = v;
          else if (v) e.setAttribute(k, '');
          else e.removeAttribute(k);
        } else e.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        const isText = typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean';
        e.appendChild(isText ? document.createTextNode(String(c)) : c);
      }
    }
    return e;
  }

  /**
   * Short-lived notification.
   *
   * @param {string} message
   * @param {'success'|'error'|'info'|'warning'} [type]
   * @param {{actionText?:string, onAction?:Function, duration?:number}} [options]
   *   Optional action button (e.g. "إضافة صنف" after an unknown barcode).
   */
  function toast(message, type, options) {
    type = type || 'success';
    options = options || {};
    const container = document.getElementById('toast-container') || (() => {
      const c = el('div', { id: 'toast-container', class: 'toast-container', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(c);
      return c;
    })();
    const t = el('div', { class: 'toast toast-' + type, role: 'alert' }, message);
    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    };
    if (options.actionText && typeof options.onAction === 'function') {
      t.classList.add('toast-has-action');
      t.appendChild(el('button', {
        class: 'toast-action', type: 'button',
        onclick: () => { dismiss(); options.onAction(); },
      }, options.actionText));
    }
    container.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    timer = setTimeout(dismiss, options.duration || 3000);
  }

  function confirmDialog(title, message, onConfirm, options = {}) {
    const overlay = el('div', { class: 'dialog-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-message' });
    const dialog = el('div', { class: 'dialog' + (options.large ? ' dialog-lg' : '') }, [
      el('div', { class: 'dialog-header' }, [
        el('h3', { id: 'confirm-title' }, title),
        el('button', { class: 'btn-close', onclick: () => overlay.remove(), 'aria-label': 'إغلاق' }, '×'),
      ]),
      el('p', { id: 'confirm-message' }, message),
      el('div', { class: 'dialog-actions' }, [
        el('button', { class: 'btn btn-secondary', onclick: () => overlay.remove() }, options.cancelText || 'إلغاء'),
        el('button', { class: 'btn btn-danger', onclick: () => { overlay.remove(); onConfirm(); } }, options.confirmText || 'تأكيد'),
      ]),
    ]);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => dialog.querySelector('.btn-danger')?.focus(), 100);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
    });
  }

  function formatMoney(minor) {
    return BeeStore.money.format(minor);
  }

  // Central HTML escaper (spec v2 §12.1.6): use for EVERY user-supplied string
  // interpolated into HTML. DOM building via el()/textContent is safe already.
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(dateStr) {
    return BeeStore.dates.formatDate(dateStr);
  }

  function statusBadge(status) {
    const labels = {
      paid: 'مدفوع', partial: 'مدفوع جزئياً', unpaid: 'غير مدفوع', void: 'ملغي',
      draft: 'مسودة', active: 'نشط', inactive: 'غير نشط',
    };
    const classes = {
      paid: 'badge-success', partial: 'badge-warning', unpaid: 'badge-danger', void: 'badge-muted',
      draft: 'badge-muted', active: 'badge-success', inactive: 'badge-muted',
    };
    return el('span', { class: 'badge ' + (classes[status] || 'badge-muted') }, labels[status] || status);
  }

  function emptyState(message, actionText, onAction, icon) {
    return el('div', { class: 'empty-state' }, [
      icon ? el('div', { style: 'font-size: 48px; margin-bottom: 16px; opacity: 0.5;' }, icon) : null,
      el('p', { style: 'margin-bottom: 16px;' }, message),
      actionText ? el('button', { class: 'btn btn-primary', onclick: onAction }, actionText) : null,
    ]);
  }

  function table(headers, rows) {
    const thead = el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h))));
    const tbody = el('tbody', {}, rows.map(row =>
      el('tr', {}, row.map(cell => el('td', {}, cell)))
    ));
    return el('div', { class: 'table-wrapper' }, el('table', { class: 'data-table' }, [thead, tbody]));
  }

  function pagination(current, total, onPage) {
    const container = el('div', { class: 'pagination', role: 'navigation', 'aria-label': 'صفحات' });
    const pages = Math.ceil(total / 50);
    if (pages <= 1) return container;
    const start = Math.max(1, current - 4);
    const end = Math.min(pages, start + 8);
    for (let i = start; i <= end; i++) {
      container.appendChild(el('button', {
        class: 'btn btn-sm ' + (i === current ? 'btn-primary' : 'btn-secondary'),
        onclick: () => onPage(i),
        'aria-label': 'صفحة ' + i,
        'aria-current': i === current ? 'page' : undefined,
      }, String(i)));
    }
    return container;
  }

  function loadingSpinner(text) {
    return el('div', { class: 'loading-overlay', role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'loading-spinner' }),
      el('span', {}, text || 'جاري التحميل...'),
    ]);
  }

  function skeleton(type) {
    const classes = {
      text: 'skeleton skeleton-text',
      title: 'skeleton skeleton-title',
      card: 'skeleton skeleton-card',
      row: 'skeleton skeleton-table-row',
    };
    return el('div', { class: classes[type] || 'skeleton', 'aria-hidden': 'true' });
  }

  function dropdown(items, buttonText, buttonClass = 'btn btn-secondary') {
    const btnId = 'dropdown-' + Math.random().toString(36).slice(2);
    const menuId = btnId + '-menu';
    const btn = el('button', { class: buttonClass + ' dropdown-toggle', id: btnId, 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: (e) => _toggleDropdown(e, menuId) }, buttonText + ' ▼');
    const menu = el('div', { class: 'dropdown-menu', id: menuId, role: 'menu' }, items.map(item =>
      el('button', { class: 'dropdown-item', role: 'menuitem', onclick: () => { item.onClick(); _closeDropdown(menuId); } }, item.label)
    ));
    return el('div', { class: 'dropdown' }, [btn, menu]);
  }

  function _toggleDropdown(e, menuId) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    const btn = e.currentTarget;
    const isOpen = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
    btn.setAttribute('aria-expanded', !isOpen);
  }

  function _closeDropdown(menuId) {
    const menu = document.getElementById(menuId);
    if (menu) menu.classList.remove('show');
    const btn = document.querySelector('[aria-controls="' + menuId + '"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // Dismiss open dropdowns on outside click (browser only; guarded so the
  // module stays importable in Node for builder unit tests).
  if (typeof document !== 'undefined') {
    document.addEventListener('click', () => {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    });
  }

  // v2 §12.3 per-widget isolation: one failing widget shows a local error
  // box instead of breaking its siblings or the whole page.
  async function safeWidget(container, fn) {
    try {
      await fn();
    } catch (e) {
      try {
        if (BeeStore.errorLog) BeeStore.errorLog.capture('widget', (e && e.message) || String(e), e && e.stack);
      } catch (logErr) { /* ignore */ }
      container.appendChild(el('p', { class: 'alert alert-danger' }, 'تعذر عرض هذا الجزء'));
    }
  }

  BeeStore.ui = { el, toast, confirmDialog, formatMoney, formatDate, statusBadge, emptyState, table, pagination, loadingSpinner, skeleton, dropdown, escapeHtml, safeWidget };
  if (typeof module !== 'undefined') module.exports = BeeStore.ui;
})(typeof window !== 'undefined' ? window : globalThis);
