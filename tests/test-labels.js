const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.children = [];
    this.className = '';
    this.innerHTML = '';
    this.checked = false;
    this.disabled = false;
    this.value = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener() {}
}

global.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => ({ textContent: String(text) }),
  addEventListener() {},
  querySelectorAll() { return []; },
};

require('../js/core/namespace.js');
require('../js/core/money.js');
require('../js/ui/components.js');
const { el } = global.window.BeeStore.ui;

// Regression: labels search results used to render every checkbox checked,
// because setAttribute('checked', false) still sets the attribute.
test('el() treats boolean attributes as properties', () => {
  const unchecked = el('input', { type: 'checkbox', checked: false });
  assert.strictEqual(unchecked.checked, false);
  assert.strictEqual(unchecked.attributes.checked, undefined, 'no checked attribute when false');

  const checked = el('input', { type: 'checkbox', checked: true });
  assert.strictEqual(checked.checked, true);

  const enabled = el('button', { disabled: false }, 'x');
  assert.strictEqual(enabled.disabled, false);
  assert.strictEqual(enabled.attributes.disabled, undefined);

  const disabled = el('button', { disabled: true }, 'x');
  assert.strictEqual(disabled.disabled, true);
});
