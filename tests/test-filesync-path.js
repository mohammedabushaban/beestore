const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
require('../js/core/config.js');
require('../js/storage/fileSync.js');
const BeeStore = global.window.BeeStore;
const FileSync = BeeStore.FileSync;

test('getStatus exposes the data file name and the folder/file path', () => {
  const fileSync = new FileSync({});
  const before = fileSync.getStatus();
  assert.strictEqual(before.fileName, 'db.json');
  assert.strictEqual(before.backupDir, 'backups');
  assert.strictEqual(before.folderName, null);
  assert.strictEqual(before.relativePath, null, 'no folder linked yet');
  assert.strictEqual(before.storage, 'browser');
  assert.strictEqual(before.hasHandle, false);

  fileSync.dirHandle = { name: 'BeeStore-Data' };
  const linked = fileSync.getStatus();
  assert.strictEqual(linked.folderName, 'BeeStore-Data');
  assert.strictEqual(linked.fileName, 'db.json');
  assert.strictEqual(linked.relativePath, 'BeeStore-Data/db.json');
  assert.strictEqual(linked.storage, 'file');
  assert.strictEqual(linked.hasHandle, true);
});

test('getFileInfo returns the size and last-modified of the data file', async () => {
  const fileSync = new FileSync({});
  assert.strictEqual(await fileSync.getFileInfo(), null, 'no folder → null');

  fileSync.dirHandle = {
    name: 'BeeStore-Data',
    getFileHandle: async (name) => ({
      getFile: async () => ({ name, size: 2048, lastModified: 1700000000000 }),
    }),
  };
  const info = await fileSync.getFileInfo();
  assert.deepStrictEqual(info, { name: 'db.json', size: 2048, lastModified: 1700000000000 });
});

test('getFileInfo returns null when the data file does not exist yet', async () => {
  const fileSync = new FileSync({});
  fileSync.dirHandle = {
    name: 'BeeStore-Data',
    getFileHandle: async () => { throw new Error('NotFoundError'); },
  };
  assert.strictEqual(await fileSync.getFileInfo(), null);
});
