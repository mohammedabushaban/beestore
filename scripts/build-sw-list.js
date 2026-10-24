#!/usr/bin/env node
'use strict';

/**
 * Regenerates the service-worker precache list and its content hash.
 *
 * Run after any change to the app shell:
 *   node scripts/build-sw-list.js
 *
 * The list is deliberately explicit (committed inside sw.js). Only app files
 * are included: never docs/, tests/, scripts/, DB/ or files/.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ROOT_FILES = ['index.html', 'manifest.json', 'bee.jpg'];
const DIRS = ['css', 'js', 'vendor', 'icons'];
const ALLOWED_EXT = new Set(['.js', '.css', '.woff2', '.png', '.jpg', '.jpeg', '.svg', '.webp']);
const BEGIN_MARKER = '// >>> BEGIN GENERATED PRECACHE';
const END_MARKER = '// <<< END GENERATED PRECACHE';

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && ALLOWED_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

function collectFiles(root) {
  root = root || ROOT;
  const files = [];
  for (const name of ROOT_FILES) {
    const full = path.join(root, name);
    if (!fs.existsSync(full)) {
      throw new Error('Missing required app-shell file: ' + name);
    }
    files.push(full);
  }
  for (const dir of DIRS) {
    walk(path.join(root, dir), files);
  }

  const relative = files.map(function (full) {
    return './' + path.relative(root, full).split(path.sep).join('/');
  });
  return Array.from(new Set(relative)).sort();
}

function computeHash(root, files) {
  root = root || ROOT;
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file.slice(2))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function versionForHash(hash) {
  return 'beestore-v3-lite-' + hash.slice(0, 12);
}

function renderBlock(files, hash) {
  const lines = files.map(function (file) { return "  '" + file + "',"; }).join('\n');
  return "const CACHE_VERSION = '" + versionForHash(hash) + "';\n" +
    'const PRECACHE = [\n' + lines + '\n];';
}

function updateSwFile(root) {
  root = root || ROOT;
  const files = collectFiles(root);
  const hash = computeHash(root, files);
  const block = renderBlock(files, hash);
  const swPath = path.join(root, 'sw.js');
  const source = fs.readFileSync(swPath, 'utf8');
  const pattern = /(\/\/ >>> BEGIN GENERATED PRECACHE[^\n]*\n)[\s\S]*?(\n\/\/ <<< END GENERATED PRECACHE)/;
  if (!pattern.test(source)) {
    throw new Error('sw.js is missing the generated-precache markers');
  }
  const next = source.replace(pattern, '$1' + block + '$2');
  if (next !== source) fs.writeFileSync(swPath, next);
  return { files, hash, version: versionForHash(hash) };
}

if (require.main === module) {
  const result = updateSwFile(ROOT);
  const bytes = result.files.reduce(function (sum, file) {
    return sum + fs.statSync(path.join(ROOT, file.slice(2))).size;
  }, 0);
  console.log('Service worker precache updated:');
  console.log('  files:   ' + result.files.length);
  console.log('  bytes:   ' + bytes);
  console.log('  version: ' + result.version);
}

module.exports = {
  ROOT,
  ROOT_FILES,
  DIRS,
  collectFiles,
  computeHash,
  versionForHash,
  renderBlock,
  updateSwFile,
};
