const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;

['config', 'money', 'dates', 'ids', 'validate', 'errors'].forEach(f => require('../js/core/' + f + '.js'));
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');

BeeStore.dates.setClock(() => '2026-10-15');

test('a thrown transaction rolls back every staged write', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  await assert.rejects(
    repo.transaction(async (tx) => {
      tx.put('accounts', { id: 'acc_rollback', name: 'مؤقت', type: 'cash' });
      tx.remove('meta', 'nonexistent');
      throw new Error('boom');
    }),
    /boom/
  );
  assert.strictEqual(await repo.get('accounts', 'acc_x'), null);
  assert.strictEqual(await repo.get('accounts', 'acc_rollback'), null);
  assert.deepStrictEqual(await repo.list('accounts'), []);
  assert.strictEqual(repo.revision, 0, 'revision unchanged');
});

test('a successful transaction commits all staged writes', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  const r = await repo.transaction(async (tx) => {
    tx.put('accounts', { id: 'acc_ok', name: 'ok', type: 'cash' });
    return 42;
  });
  assert.strictEqual(r, 42);
  assert.ok(await repo.get('accounts', 'acc_ok'));
  assert.strictEqual(repo.revision, 1);
});

test('a later failure in a multi-step transaction leaves no partial data', async () => {
  const repo = new MemoryRepository();
  await repo.open();
  await assert.rejects(repo.transaction(async (tx) => {
    tx.put('categories', { id: 'cat_a', name: 'A' });
    tx.put('categories', { id: 'cat_b', name: 'B' });
    if ((await tx.list('categories')).length < 0) throw new Error('never');
    throw new Error('late failure');
  }), /late failure/);
  assert.deepStrictEqual(await repo.list('categories'), []);
});
