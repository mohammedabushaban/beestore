const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;
require('../js/core/dates.js');
const D = BeeStore.dates;

// v2 §13.1.1: monthRange for every month of a leap and a non-leap year.
test('V2 monthRange covers leap + non-leap years', async () => {
  const dim2024 = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dim2025 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const r24 = D.monthRange('2024-' + mm);
    const r25 = D.monthRange('2025-' + mm);
    assert.strictEqual(r24.from, '2024-' + mm + '-01');
    assert.strictEqual(r24.to, '2024-' + mm + '-' + dim2024[m - 1]);
    assert.strictEqual(r25.from, '2025-' + mm + '-01');
    assert.strictEqual(r25.to, '2025-' + mm + '-' + dim2025[m - 1]);
    assert.strictEqual(D.daysInMonth('2024-' + mm), dim2024[m - 1]);
    assert.strictEqual(D.daysInMonth('2025-' + mm), dim2025[m - 1]);
  }
});

// v2 §13.1.1: Dec→Jan rollover and negative steps, string-only math.
test('V2 addMonths rolls over Dec->Jan without Date objects', async () => {
  assert.strictEqual(D.addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(D.addMonths('2027-01', -1), '2026-12');
  assert.strictEqual(D.addMonths('2026-10', 3), '2027-01');
  assert.strictEqual(D.addMonths('2026-01', -13), '2024-12');
  assert.strictEqual(D.addMonths('2026-10', 0), '2026-10');
  assert.strictEqual(D.addMonths('2026-10', 14), '2027-12');
  // Legacy full-date behavior untouched (installments).
  assert.strictEqual(D.addMonths('2026-01-31', 1), '2026-02-28');
});

// v2 §13.1.1: today() with injected clock (midnight safety).
test('V2 today() honors injected clock', async () => {
  D.setClock(() => '2026-10-31');
  try {
    assert.strictEqual(D.today(), '2026-10-31');
    assert.strictEqual(D.monthKey(), '2026-10');
    assert.strictEqual(D.monthOf(D.today()), '2026-10');
  } finally {
    D.resetClock();
  }
  assert.match(D.today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('V2 monthOf/isSameMonth/compare', async () => {
  assert.strictEqual(D.monthOf('2026-10-31'), '2026-10');
  assert.strictEqual(D.monthOf('2026-11-01'), '2026-11');
  assert.strictEqual(D.isSameMonth('2026-10-01', '2026-10-31'), true);
  assert.strictEqual(D.isSameMonth('2026-10-31', '2026-11-01'), false);
  assert.strictEqual(D.compare('2026-10-31', '2026-11-01'), -1);
  assert.strictEqual(D.compare('2026-11-01', '2026-10-31'), 1);
  assert.strictEqual(D.compare('2026-10', '2026-10'), 0);
});

// v2 §12.1.1: day arithmetic across month/year ends and leap day.
test('V2 addDays crosses month/year ends and leap day', async () => {
  assert.strictEqual(D.addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(D.addDays('2027-01-01', -1), '2026-12-31');
  assert.strictEqual(D.addDays('2025-02-28', 1), '2025-03-01');
  assert.strictEqual(D.addDays('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(D.addDays('2024-02-29', 1), '2024-03-01');
  assert.strictEqual(D.monthRange('2026-12').to, '2026-12-31');
  assert.strictEqual(D.monthRange('2027-01').from, '2027-01-01');
});

// v2 §12.1.1: today() is the LOCAL date, never the UTC date (midnight safety).
// Fixed instant 2026-10-14T21:30Z = Oct 15 in UTC+14, Oct 14 in UTC-4.
test('V2 today() follows local timezone, not UTC', async () => {
  const RealDate = Date;
  const fixed = new RealDate('2026-10-14T21:30:00Z').getTime();
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  const prevTZ = process.env.TZ;
  global.Date = FixedDate;
  try {
    D.resetClock();
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    assert.strictEqual(D.today(), '2026-10-15');
    process.env.TZ = 'America/New_York'; // UTC-4 (October)
    assert.strictEqual(D.today(), '2026-10-14');
  } finally {
    global.Date = RealDate;
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  }
});
