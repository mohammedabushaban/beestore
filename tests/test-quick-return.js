const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;
require('../js/ui/lock.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('quick invoice-less return is wired in the sidebar and router', () => {
  const html = read('index.html');
  assert.match(html, /href="#\/returns\/direct"[^>]*data-route="\/returns\/direct"/,
    'sidebar quick link is missing');
  assert.match(html, /data-route="\/returns\/direct"[^>]*data-reroute="true"/,
    'quick link must re-run its route when already open');

  const app = read('js/app.js');
  assert.match(app, /'\/returns\/direct': \{ title: 'مرتجع بدون فاتورة', render: BeeStore\.pages\.returns\.renderDirect \}/,
    'direct return route is not registered');

  const returns = read('js/pages/returns.js');
  assert.match(returns, /async function renderDirect\(container\)/,
    'renderDirect is missing');
  assert.match(returns, /BeeStore\.pages\.returns = \{ render, renderDirect \}/,
    'renderDirect is not exported');
});

test('the cashier may open the direct return route', () => {
  assert.ok(BeeStore.CASHIER_ROUTES.has('/returns'),
    'the regular returns route must stay available');
  assert.ok(BeeStore.CASHIER_ROUTES.has('/returns/direct'),
    'the direct return route must be available to the cashier');
});
