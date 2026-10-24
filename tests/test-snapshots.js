const { test } = require('node:test');
const assert = require('node:assert');

const snapshots = require('../js/services/snapshots.js');

test('snapshots keep the newest N records and expire the oldest', () => {
  const records = [
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'newest', createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'middle', createdAt: '2026-02-01T00:00:00.000Z' },
  ];
  assert.deepStrictEqual(snapshots.sortNewest(records).map(function (r) { return r.id; }),
    ['newest', 'middle', 'old']);
  assert.deepStrictEqual(snapshots.pickExpired(records, 2), ['old']);
  assert.deepStrictEqual(snapshots.pickExpired(records, 10), []);
  assert.deepStrictEqual(snapshots.pickExpired(records, 0), ['newest', 'middle', 'old']);
});

test('snapshot metadata counts all collection documents', () => {
  assert.strictEqual(snapshots.countDocuments({
    collections: { sales: [{}, {}], products: [{}], settings: null },
  }), 3);
  assert.strictEqual(snapshots.countDocuments({}), 0);
});
