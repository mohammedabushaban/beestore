# BeeStore v5 A4.3 — Payroll Components & Fixed Assets

## Active Task
Implement A4.3 per v5 §§4, 7–9, 12.4–12.5, 13: payroll component settings/record fields/posting, liability payments, fixed-asset service/register/purchase/depreciation/disposal/payments, capitalization warning, UI pages/settings, reports/summary/parity, migration 8→9, schema/db/app/summary version bumps.

## Completed
- A1–A4.2 committed (HEAD at 3388356)
- A4.2 regression tests: test-unpaid-expenses.js 6/6, test-postings.js updated
- Full serialized Node suite 244/244
- Browser suites final (smoke 11/11, idb-lazy 18/18, ui-days 13/13, ui-package 11/11, ui-settlements 6/6, ui-unpaid-expenses 5/5)
- Offline verifier 10/10; sw.js regenerated: 103 files, 2,409,867 bytes, hash `beestore-v3-lite-36caae88f47a`
- CLAUDE.md, docs/MAP.md, docs/CHANGELOG.md updated after A4.2

## A4.3 Completed
- Payroll component settings added to `js/services/settings.js` (all optional, off by default)
- Payroll posting with components (`payrollAccrualWithComponents`, `payrollPaymentWithComponents`) in `js/services/posting.js`
- Fixed-asset posting functions (`fixedAssetPurchase`, `fixedAssetDepreciation`, `fixedAssetDisposal`, `fixedAssetPayment`) in `js/services/posting.js`
- Chart seed updated in `js/core/chartSeed.js` to handle components and fixed assets
- Capitalization warning threshold `capitalizationWarnThresholdMinor: 50000` (500.00) added to defaults
- New EVENTS: `PAYROLL_COMPONENT`, `FIXED_ASSET_PURCHASE`, `FIXED_ASSET_DEPRECIATION`, `FIXED_ASSET_DISPOSAL`, `FIXED_ASSET`
- New SOURCE: `FIXED_ASSET`
- Schema/db bump: `schemaVersion` 9, `dbVersion` 10, app `3.5.0-lite`, summary VERSION 9

## A4.3 Plan (remaining)
- UI: settings, employees, reports pages for payroll components and fixed assets
- Migration 8→9 in `js/storage/migrations.js`
- Summary VERSION 9 fields in `js/storage/summary.js`
- Regression tests — payroll components/liability payments and fixed assets (disabled warning, 1,200.00/24-month/50.00 example, disposal, void/reversal, migration, locks)
- Run full Node/browser suites, offline verifier; finalize docs

## Known gaps (verify before claiming)
- Payroll component postings: 6100/6110/6120/2100/2110/2120/2200 entries must balance
- Fixed-asset depreciation: floor monthly with remainder in last month, starts month after purchase
- Disposal: reverses only scheduled depreciation dated after disposal date
- Capitalization warning: threshold 500.00 (50,000 minor) when module disabled
- Migration parity: existing data must survive 8→9 with new collections