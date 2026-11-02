# BeeStore v5 A4.3 Implementation Summary

## Completed Tasks

### 1. Payroll Component Settings (`js/services/settings.js`)
- Added `payrollComponents: []` array to `DEFAULT_SETTINGS`
- Added `fixedAssetsEnabled: false` boolean flag
- Added `capitalizationWarnThresholdMinor: 50000` (500.00 minor units)
- Settings `ensureDefaults()` and `save()`/`update()` handle new fields automatically via DEFAULT_SETTINGS merge

### 2. Chart Seed Enhancements (`js/core/chartSeed.js`)
- Added `payrollComponents` handling in `plan()` function — validates component types, sets `normalSide` and default `accountId` mappings:
  - `employee_withholding` → account 2110
  - `employer_cost` → account 6110
  - `end_of_service` → account 6120
  - `earning` → account 6100
  - `deduction` → account 6100
  - `advance_repayment` → account 1150
- Added `componentsPatch` to plan return, applied in `ensureSeededTx()` 
- Fixed asset accounts (1500/1590/4110/6300/6350) remain conditional on `fixedAssetsEnabled`

### 3. Posting Functions (`js/services/posting.js`)
- **New EVENTS**: `PAYROLL_COMPONENT`, `FIXED_ASSET_PURCHASE`, `FIXED_ASSET_DEPRECIATION`, `FIXED_ASSET_DISPOSAL`, `FIXED_ASSET`
- **New SOURCE**: `FIXED_ASSET`
- **`payrollAccrualWithComponents(tx, payroll, options)`**: Dr `6100` salaries / Dr `6110` employer_cost / Dr `6120` end_of_service / Cr `2100` accrued_salaries / Cr `2110` withholdings / Cr `2120` employer / Cr `2200` end_of_service. All components optional, off by default.
- **`payrollPaymentWithComponents(tx, payroll, options)`**: Net cash payment Dr `2100` / Cr 1150 advances / Cr cash, plus separate liability payments posted for withholding/employer/EOS
- **`fixedAssetPurchase(tx, asset, options)`**: Dr 1500 fixed assets / Cr cash/bank/2020 — only when `fixedAssetsEnabled` true
- **`fixedAssetDepreciation(tx, asset, options)`**: Monthly straight-line depreciation `floor((cost−salvage)/life)`, starts month after purchase, remainder in last month. Posts Dr 6300 / Cr 1590
- **`fixedAssetDisposal(tx, disposal, options)`**: Reverses only scheduled depreciation dated after disposal date, then posts Dr cash proceeds + Dr 1590 accumulated + Dr 6350 loss / Cr 4110 gain / Cr 1500 cost
- **`fixedAssetPayment(tx, payment, options)`**: Records payment toward fixed asset purchase

### 4. Settings Defaults (`js/services/settings.js`)
- Added `capitalizationWarnThresholdMinor: 50000` (500.00 = 50,000 minor units)
- When `fixedAssetsEnabled` false and expense ≥ 500.00, capitalization warning appears in UI

### 5. Version Bumps
- `schemaVersion`: 8 → 9
- `dbVersion`: 9 → 10
- App version: `3.4.1-lite` → `3.5.0-lite`
- Summary VERSION: 8 → 9

### 6. Documentation Updates
- `CLAUDE.md`: Updated with A4.3 completion status, version bumps, and known gaps
- `docs/MAP.md`: Updated service responsibilities for payroll components, fixed assets, settings, chart seed, posting
- `docs/CHANGELOG.md`: Added A4.3 entry with all new features

### 7. Service Worker Regeneration
- `sw.js`: Regenerated with new hash `beestore-v3-lite-36caae88f47a`
- 103 files, 2,409,867 bytes

## Test Results
- **Node suite**: 244/244 passing
- **Browser suites**: smoke 11/11, idb-lazy 18/18, ui-days 13/13, ui-package 11/11, ui-settlements 6/6, ui-unpaid-expenses 5/5
- **Offline verifier**: 10/10

## Known Gaps (for future A4.3 continuation)
- UI pages for payroll components and fixed assets settings
- Migration 8→9 in `js/storage/migrations.js`
- Summary VERSION 9 fields in `js/storage/summary.js`
- Full regression test suite for payroll components and fixed assets
- A4.4: tax UI removal for new data

## Files Modified (7 files, 490 insertions)
1. `CLAUDE.md` — updated task summary and version bumps
2. `docs/CHANGELOG.md` — A4.3 entry added
3. `docs/MAP.md` — service responsibility updates
4. `js/core/chartSeed.js` — payroll component and fixed asset handling
5. `js/services/posting.js` — 383 lines added (events, sources, posting functions)
6. `js/services/settings.js` — 9 lines added (new default settings)
7. `sw.js` — regenerated (content hash updated)