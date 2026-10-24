const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const build = require('../scripts/build-sw-list.js');

function precacheFromSw(source) {
  const match = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(match, 'sw.js must contain an explicit PRECACHE array');
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map(function (m) { return m[1]; });
}

function cacheVersionFromSw(source) {
  const match = source.match(/const CACHE_VERSION = '([^']+)';/);
  assert.ok(match, 'sw.js must contain CACHE_VERSION');
  return match[1];
}

function pngSize(file) {
  const buffer = fs.readFileSync(path.join(ROOT, file));
  assert.strictEqual(buffer.slice(1, 4).toString('ascii'), 'PNG', file + ' must be a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* --------------------------------------------------------- generated list */

test('sw.js precache list matches the current app files', () => {
  const expected = build.collectFiles(ROOT);
  const listed = precacheFromSw(swSource);
  assert.deepStrictEqual(listed, expected);
  for (const file of listed) {
    assert.ok(file.startsWith('./'), file + ' must be a relative path');
    assert.ok(fs.existsSync(path.join(ROOT, file.slice(2))), file + ' must exist');
  }
});

test('sw.js cache version is the content hash (forces an update on any change)', () => {
  const files = build.collectFiles(ROOT);
  const hash = build.computeHash(ROOT, files);
  assert.strictEqual(cacheVersionFromSw(swSource), build.versionForHash(hash));
});

test('precache never includes docs, tests, scripts, DB or user files', () => {
  const listed = precacheFromSw(swSource);
  for (const file of listed) {
    assert.ok(!/^\.\/(docs|tests|scripts|DB|files)\//.test(file), file + ' must not be precached');
  }
  assert.ok(!listed.includes('./sw.js'), 'the worker itself is not a shell asset');
});

test('all local scripts/styles/manifest/icons referenced by index.html are precached', () => {
  const listed = precacheFromSw(swSource);
  const refs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
    .map(function (m) { return m[1]; })
    .filter(function (ref) { return !/^(https?:|data:|#|mailto:|javascript:)/.test(ref); });
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(listed.includes('./' + ref), ref + ' is referenced by index.html but not precached');
  }
});

test('index.html itself is precached for offline start', () => {
  assert.ok(precacheFromSw(swSource).includes('./index.html'));
});

test('the worker does not skipWaiting during install (updates wait for the user)', () => {
  const installStart = swSource.indexOf("addEventListener('install'");
  const activateStart = swSource.indexOf("addEventListener('activate'");
  assert.ok(installStart > -1 && activateStart > installStart);
  const installBlock = swSource.slice(installStart, activateStart);
  assert.ok(!/skipWaiting\s*\(/.test(installBlock), 'install must not activate a new version silently');
  assert.ok(swSource.includes("data.type === 'SKIP_WAITING'"), 'the page must be able to request activation');
});

test('sw.js is valid JavaScript', () => {
  assert.doesNotThrow(function () { new vm.Script(swSource, { filename: 'sw.js' }); });
});

/* ------------------------------------------------------------- manifest */

test('manifest is Arabic RTL standalone with relative scope and start_url', () => {
  assert.match(manifest.name, /بي ستور/);
  assert.strictEqual(manifest.short_name, 'بي ستور');
  assert.strictEqual(manifest.lang, 'ar');
  assert.strictEqual(manifest.dir, 'rtl');
  assert.strictEqual(manifest.start_url, './');
  assert.strictEqual(manifest.scope, './');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.theme_color, '#F5B700');
  assert.ok(manifest.icons && manifest.icons.length >= 3);
});

test('manifest icons are real PNGs with the declared dimensions, including maskable', () => {
  const required = [
    { src: 'icons/icon-192.png', size: 192, purpose: 'any' },
    { src: 'icons/icon-512.png', size: 512, purpose: 'any' },
    { src: 'icons/icon-maskable-512.png', size: 512, purpose: 'maskable' },
  ];
  for (const item of required) {
    const icon = manifest.icons.find(function (entry) { return entry.src === item.src; });
    assert.ok(icon, item.src + ' must be declared');
    assert.strictEqual(icon.sizes, item.size + 'x' + item.size);
    assert.ok(String(icon.purpose || '').includes(item.purpose));
    const actual = pngSize(item.src);
    assert.deepStrictEqual(actual, { width: item.size, height: item.size });
  }
  const apple = pngSize('icons/apple-touch-icon-180.png');
  assert.deepStrictEqual(apple, { width: 180, height: 180 });
});

/* ------------------------------------------------------------ CSP / HTML */

test('CSP allows self scripts only and no inline script execution', () => {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(match, 'index.html must contain a CSP meta tag');
  const csp = match[1];
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'scripts must not allow unsafe-inline');
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp), 'scripts must not allow unsafe-eval');
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /object-src 'none'/);
});

test('index.html has no inline event handlers and no inline script blocks', () => {
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handlers are blocked by CSP');
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>/gi));
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.match(script[1], /\bsrc=/, 'every script must be external');
  }
  assert.ok(html.includes('rel="manifest" href="manifest.json"'));
  assert.ok(html.includes('rel="apple-touch-icon"'));
});
