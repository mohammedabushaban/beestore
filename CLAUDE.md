# BeeStore v5 — after A5 (Journal Reports & Accountant Controls)

## Active Task
None. Next in v5 §13 order: **A6** (see below).

## Current state (verified 2026-11-04)
- App `3.6.0-lite`, `schemaVersion` 10, `dbVersion` 10, summary `VERSION` 10.
- v5 A1–A4 done: chart of accounts, append-only journal, tracked inventory
  value, postings for every document, parity report/approval, card clearing +
  settlements + fees, unpaid expenses + payments (2020), payroll components +
  liability payments (2110/2120/2200), fixed assets (off by default) +
  capitalization warning, tax UI removed.
- Migrations up to 9→10 (8→9 = A4.3 collections; 9→10 = v4 M1/M2/M3/M7 item
  codes, search keys, list-price snapshots, overpayment modes, unlinked returns).
- v5 A5 done (2026-11-04): journal tabs on Reports (trial balance, general
  ledger, journal), "القيد" button via `js/ui/journalView.js`, accountant
  package sheets 19–25, `docs/ACCOUNTANT_REVIEW.md`, `docs/PARALLEL_RUN.md`.
  Not done in A5: direct cash-flow-by-source report from the journal (§10).
- v4 milestones done: M1, M2, M3, M7; M6 (R8 date+time) partly: `time` on new
  documents, date+time display everywhere via `formatDocDate`, `timeFormat`
  setting. Missing: backfill migration, editing time when back-dating, time on
  stock movements, sort by time.
- Invoices page shows overpayment (badge + view details).
- Node suite: 38 test files / 268 tests pass (`for t in tests/test-*.js; do node $t; done`).
- Browser suites: `tests/smoke.html`, `idb-lazy.html`, `ui-*.html`; offline
  verifier `tests/verify-offline.py` (needs `chromedriver --port=9515` and
  `/tmp/opencode/` for its screenshot). `ui-settlements`/`ui-unpaid-expenses`
  need a clean origin IndexedDB (they time out on the lock screen otherwise).
- After changing any shipped file run `node scripts/build-sw-list.js` to
  regenerate `sw.js`.

## Not yet done (v5 §13 build order)
- **A6**: Integrity Checker §9 journal checks (control accounts = sub-ledgers,
  gapless numbers, document↔journal, orphan entries), property/invariant
  tests, 50,000-invoice performance test.
- **v4 milestones**: M4 credit-sales presentation + write-off, M5 invoices
  table, M6 date-time (rest, see above), M8 statements + item card, M9 purchases, M10 recurring
  expenses + daily allocation, M11 migration/regression sweep, M12 (replaced
  by v5 journal).

## Notes
- `implementation-summary.md` is a stale A4.3 snapshot; trust this file and
  `docs/CHANGELOG.md`.
- Keep UI text Arabic (RTL). Update `CLAUDE.md`, `docs/MAP.md`,
  `docs/CHANGELOG.md` after each task.
