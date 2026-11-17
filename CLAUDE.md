# BeeStore v5 — after A6 (Integrity Checker, invariants, performance, year-end close)

## Active Task
None. v5 §13 build order A1–A6 is complete; remaining work is the v4 milestones below.

## Current state (verified 2026-11-17)
- App `3.6.0-lite`, `schemaVersion` 10, `dbVersion` 10, summary `VERSION` 10.
- Purchase invoices now search **products** by name/item code/barcode (not a
  flat size/colour variant list), load the chosen product's variants, prefill
  cost from the variant, and offer inline Quick Add. A product created there is
  selected immediately; its Quick Add opening quantity stays 0 so the purchase
  is the only stock receipt.
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
- Audit fixes (2026-11-17): change is taken from cash payments only;
  tax-inclusive totals no longer add tax twice (`sale.taxIncluded`); returns
  share the invoice discount and reverse output tax (`ret.taxMinor`, Dr 2300);
  profit⇄cash recon includes 2030/3030 and journal `activities`;
  `money.parseDecimal` handles `12,5` / `1,250`.
- v5 A6 done (2026-11-17): `js/services/journalIntegrity.js` (integrity
  check #17), `js/services/yearEnd.js` (YEAR_CLOSE → 3040 retained earnings,
  card on the month-closing page), undated TB/GL stop at today,
  `stock.valueAsOf` sums changes (back-dated movements), journal balance sheet
  nets customers, `MemoryRepository` is linear (50k invoices ≈ 65 s).
  `tests/test-a6-integrity.js` holds the property and performance tests
  (`BEESTORE_PERF=50000` for the full-size run).
- Sales tax removed (2026-11-17): new invoices never carry tax; tax keys are
  stripped from settings; legacy taxed invoices still report/return correctly.
- v4 M4 write-off done: `customers.writeOff` (customer payment with method
  `write_off`, Dr 6410/Cr 1100) and `customers.applyCredit` (Dr 2030/Cr 1100).
  Reports tab «ضوابط ومراجعة» = `auditReview.anomalies` + `historicalErrors`.
- Node suite: 43 test files / 303 tests pass
  (`node --test --test-concurrency=1 tests/*.js`).
- Browser suites: `tests/smoke.html`, `idb-lazy.html`, `ui-*.html` (including
  `ui-purchases.html` 4/4, `ui-audit-tools.html` 5/5); offline
  verifier `tests/verify-offline.py` (needs `chromedriver --port=9515` and
  `/tmp/opencode/` for its screenshot). `ui-settlements`/`ui-unpaid-expenses`
  need a clean origin IndexedDB (they time out on the lock screen otherwise).
- After changing any shipped file run `node scripts/build-sw-list.js` to
  regenerate `sw.js`.

## Not yet done
- **v4 milestones**: M4 credit-sales presentation (write-off done), M5 invoices
  table, M6 date-time (rest, see above), M8 statements + item card, M9 purchases, M10 recurring
  expenses + daily allocation, M11 migration/regression sweep, M12 (replaced
  by v5 journal).

## Notes
- `implementation-summary.md` is a stale A4.3 snapshot; trust this file and
  `docs/CHANGELOG.md`.
- Keep UI text Arabic (RTL). Update `CLAUDE.md`, `docs/MAP.md`,
  `docs/CHANGELOG.md` after each task.
