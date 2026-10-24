const { test } = require('node:test');
const assert = require('node:assert');

const pwa = require('../js/services/pwa.js');

/* ------------------------------------------------------- safe update gate */

test('safe update: only an idle POS with no dialog may reload', () => {
  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 0, saving: false, dialogOpen: false, closing: false }), true);
  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 0, saving: false, dialogOpen: false }), true);

  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 1, saving: false, dialogOpen: false }), false,
    'an in-progress invoice must never be lost');
  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 0, saving: true, dialogOpen: false }), false,
    'a save in flight must not be interrupted');
  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 0, saving: false, dialogOpen: true }), false,
    'an open dialog/wizard blocks the update');
  assert.strictEqual(pwa.isSafeToUpdate({ cartItems: 0, saving: false, dialogOpen: false, closing: true }), false,
    'a daily closing in progress blocks the update');
});

test('collectAppState reads the POS and any open modal', () => {
  const idle = pwa.collectAppState({
    document: { querySelector: () => null },
    navigator: {},
  });
  assert.deepStrictEqual(idle, { cartItems: 0, saving: false, dialogOpen: false, closing: false });

  const busy = pwa.collectAppState({
    document: { querySelector: () => ({}) },
    navigator: {},
  });
  assert.strictEqual(busy.dialogOpen, true);

  // The finished first-run wizard stays in the DOM with display:none. It must
  // not block updates forever; a genuinely visible overlay still must.
  const hidden = { hidden: false };
  const visible = { hidden: false };
  const styleFor = (node) => node === hidden
    ? { display: 'none', visibility: 'visible' }
    : { display: 'block', visibility: 'visible' };
  const mixed = pwa.collectAppState({
    document: {
      querySelectorAll: () => [hidden, visible],
      defaultView: { getComputedStyle: styleFor },
    },
    navigator: {},
  });
  assert.strictEqual(mixed.dialogOpen, true);
  const allHidden = pwa.collectAppState({
    document: {
      querySelectorAll: () => [hidden],
      defaultView: { getComputedStyle: styleFor },
    },
    navigator: {},
  });
  assert.strictEqual(allHidden.dialogOpen, false);
});

/* --------------------------------------------------- environment guards */

test('service worker is only used on http(s), never file://', () => {
  const nav = { serviceWorker: {} };
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'https:' }, navigator: nav }), true);
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'http:' }, navigator: nav }), true);
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'http:' }, navigator: nav, isSecureContext: true }), true);
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'http:' }, navigator: nav, isSecureContext: false }), false,
    'LAN http is not a secure context');
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'file:' }, navigator: nav }), false);
  assert.strictEqual(pwa.canUseServiceWorker({ location: { protocol: 'https:' }, navigator: {} }), false);
  assert.strictEqual(pwa.canUseServiceWorker({ navigator: nav }), false);
});

test('standalone detection supports display-mode and iOS navigator.standalone', () => {
  assert.strictEqual(pwa.isStandalone({
    matchMedia: () => ({ matches: true }),
    navigator: {},
  }), true);
  assert.strictEqual(pwa.isStandalone({
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: true },
  }), true);
  assert.strictEqual(pwa.isStandalone({
    matchMedia: () => ({ matches: false }),
    navigator: {},
  }), false);
});

/* ------------------------------------------------------ storage status */

test('storage status reports persistence and usage', async () => {
  const result = await pwa.storageStatus({
    navigator: {
      storage: {
        persisted: async () => true,
        estimate: async () => ({ usage: 2048, quota: 4096 }),
      },
    },
  });
  assert.deepStrictEqual(result, {
    supported: true, persisted: true, usage: 2048, quota: 4096,
  });

  const unsupported = await pwa.storageStatus({ navigator: {} });
  assert.deepStrictEqual(unsupported, {
    supported: false, persisted: false, usage: null, quota: null,
  });
});
