const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

// The scanner module is browser-facing; its pure helpers must stay testable
// in Node (no DOM, no camera).
require('../js/ui/scanner.js');
const scanner = global.window.BeeStore.scanner;

/**
 * Runs `fn` with a stubbed browser environment, then restores it.
 * `window` is the Node global here, so `window.X` and `global.X` are the same.
 */
function withEnv(env, fn) {
  const saved = {
    secure: global.isSecureContext,
    navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
    detector: global.BarcodeDetector,
    zxing: global.ZXing,
  };
  if (env.secure !== undefined) global.isSecureContext = env.secure;
  // Node exposes `navigator` as a getter-only accessor — plain assignment is
  // silently ignored, so define the property instead.
  Object.defineProperty(global, 'navigator', {
    value: env.camera ? { mediaDevices: { getUserMedia: () => Promise.resolve({}) } } : undefined,
    configurable: true,
    writable: true,
  });
  global.BarcodeDetector = env.detector ? function () {} : undefined;
  global.ZXing = env.zxing ? { BrowserMultiFormatReader: function () {} } : undefined;
  try {
    return fn();
  } finally {
    global.isSecureContext = saved.secure;
    if (saved.navigator) Object.defineProperty(global, 'navigator', saved.navigator);
    global.BarcodeDetector = saved.detector;
    global.ZXing = saved.zxing;
  }
}

test('normalizeCode trims and collapses whitespace', () => {
  assert.strictEqual(scanner.normalizeCode('  6291234567890  '), '6291234567890');
  assert.strictEqual(scanner.normalizeCode('ABC 123\n456'), 'ABC 123 456');
  assert.strictEqual(scanner.normalizeCode(null), '');
  assert.strictEqual(scanner.normalizeCode(undefined), '');
  assert.strictEqual(scanner.normalizeCode(12345), '12345');
});

test('normalizeCode keeps zero-length codes empty', () => {
  assert.strictEqual(scanner.normalizeCode(''), '');
  assert.strictEqual(scanner.normalizeCode('   '), '');
});

test('insecure context blocks scanning even with a camera and a decoder', () => {
  withEnv({ secure: false, camera: true, detector: true }, () => {
    assert.strictEqual(scanner.unsupportedReason(), scanner.REASONS.INSECURE);
    assert.strictEqual(scanner.isSupported(), false);
  });
});

test('missing camera API blocks scanning', () => {
  withEnv({ secure: true, camera: false, detector: true }, () => {
    assert.strictEqual(scanner.unsupportedReason(), scanner.REASONS.NO_CAMERA_API);
  });
});

test('missing decoder blocks scanning', () => {
  withEnv({ secure: true, camera: true, detector: false, zxing: false }, () => {
    assert.strictEqual(scanner.unsupportedReason(), scanner.REASONS.NO_DECODER);
  });
});

test('native detector alone is enough to enable scanning', () => {
  withEnv({ secure: true, camera: true, detector: true }, () => {
    assert.strictEqual(scanner.unsupportedReason(), '');
    assert.strictEqual(scanner.isSupported(), true);
  });
});

test('ZXing fallback alone is enough to enable scanning', () => {
  withEnv({ secure: true, camera: true, detector: false, zxing: true }, () => {
    assert.strictEqual(scanner.unsupportedReason(), '');
    assert.strictEqual(scanner.isSupported(), true);
  });
});

test('reasonMessage explains every unsupported reason in Arabic', () => {
  for (const reason of Object.values(scanner.REASONS)) {
    const msg = scanner.reasonMessage(reason);
    assert.ok(typeof msg === 'string' && msg.length > 10, 'message for ' + reason);
    assert.ok(/[؀-ۿ]/.test(msg), 'Arabic message for ' + reason);
  }
  assert.ok(/https/.test(scanner.reasonMessage(scanner.REASONS.INSECURE)));
});

test('preferred formats include the retail codes the shop prints', () => {
  assert.ok(scanner.PREFERRED_FORMATS.includes('ean_13'));
  assert.ok(scanner.PREFERRED_FORMATS.includes('code_128'));
  assert.ok(scanner.PREFERRED_FORMATS.includes('qr_code'));
});

test('scanner API exposes the entry points the pages use', () => {
  assert.strictEqual(typeof scanner.scan, 'function');
  assert.strictEqual(typeof scanner.scanButton, 'function');
  assert.strictEqual(typeof scanner.isSupported, 'function');
  assert.strictEqual(typeof scanner.unsupportedReason, 'function');
  assert.strictEqual(typeof scanner.reasonMessage, 'function');
  assert.strictEqual(typeof scanner.normalizeCode, 'function');
});
