# BeeStore — Project Memory

## Project Summary
BeeStore is a browser-only Arabic RTL accounting & inventory system for a children's clothing shop. Data lives in IndexedDB, mirrored to a JSON file via File System Access API. Open `index.html` by double-click in Chrome/Edge. Run tests with `node --test tests/test-sales.js`.

## Architecture Overview

**Layers** (bottom → top):
- `core/` — utilities: namespace, config, money (minor units), dates (local YYYY-MM-DD), ids, validate, errors
- `storage/` — repository interface + implementations: `memoryRepository` (tests), `idbRepository` (browser), `fileSync` (JSON mirror + backups), `migrations`
- `services/` — **all business logic**, pure JS, no DOM/IndexedDB/window. Depend only on repository interface.
- `api/api.js` — thin facade `BeeStore.api.<namespace>.<method>` returning `{ok, data|error}` envelopes
- `ui/` — router, components, dialogs, print helpers, first-run wizard, keyboard shortcuts
- `pages/` — one file per page, renders into `#page-content`

**Global namespace**: `window.BeeStore` (IIFE-wrapped files, classic `<script>` tags, no ES modules)

**Script load order** (index.html lines 92-149): core → storage → services → api → ui → pages → demo → app.js

## Golden Rules (never break)
- Money = integer minor units (agorot/cents). Use `BeeStore.money` only.
- Business dates = local `YYYY-MM-DD` strings. `dates.today()` uses local date parts, **not** `Date.toISOString()`.
- Every posting operation = **one** `repo.transaction(fn)`.
- `assertPeriodOpen(date)` inside every posting transaction (v2).
- No hard deletes: `status: "void"` / `active: false`.
- Escape all user text: `textContent` or `BeeStore.ui.escapeHtml()`.
- Arabic RTL throughout (`<html lang="ar" dir="rtl">`), Western digits.
- No `fetch` of local files, no CDN, no ES modules, no build step.

## Short Recipes

**Add a page**: Create `js/pages/xyz.js` exporting `{ render(container) }`, register in `app.js _setupRouter()`.

**Add a service method**: Create/update `js/services/xyz.js`, bind repo in `api.js _bindServices()`.

**Add a facade method**: Add to `BeeStore.Api` in `api.js` returning `ok(data)` / `fail(code, msg)`.

**Add a report**: Add method to `ReportsService` (services/reports.js), expose in `api.js reports`, create page if needed.

**Add a settings field**: Add to `DEFAULT_SETTINGS` in `services/settings.js`, persist via `settings.save()`.

**Add data-model field + migration**: Add field in service `create()`, bump `schemaVersion` in `namespace.js`, add migration in `storage/migrations.js`.

## Specs (docs/specs/)
- `BeeStore-Project-Spec.md` — v1 base system (sections 1-15)
- `BeeStore-v2-Monthly-Periods.md` — v2 addendum: monthly periods, month closing, hardening, acceptance scenario (§13.2)

## Recent Changes
- **Full UI redesign (v2 design system)**: `css/app.css` rewritten around design tokens (amber brand, slate neutrals, soft shadows, layered radii); dark graphite sidebar with grouped nav + inline SVG icons, glass topbar, pill tabs, modern tables/badges/dialogs/toasts, new stat cards, and refreshed print styles. `index.html` shell rebuilt (grouped nav, quick "فاتورة جديدة" action, mobile header). Fixed: the global period picker stayed empty for wizard-created stores (`firstRun.finish()` now renders it) and got squeezed on phones (icon-only quick action + `flex-shrink: 0`). 98/98 tests green.
- Product form requires name + cost + price (`products.create` rejects empty name / non-positive explicit cost or price); POS auto-fills an editable payment equal to the cart total (manual edit disables auto-fill); sidebar closes on nav tap (capture delegation) + any `hashchange`; `el()` now accepts numbers/booleans (fixed low-stock tab `appendChild` crash); `file://` shows a clear "run via http(s)" message instead of a blank page; demo data passes default cost/price; `tests/test-validation.js` (+1); 98/98 green.
- Add-variant dialog now requires a positive opening quantity (`variants.create` rejects an explicit non-positive qty with `INVALID`; still allowed when omitted for import/test paths); `tests/test-validation.js` (+1); 97/97 green.
- Recurring generation now targets the selected period month (was always today's month, so created expenses landed outside the scoped list and looked unsaved); button + toast show the month; `tests/test-expenses.js` (+1); 96/96 green.
- JSDoc on `settings` (all services done), digit normalization in service qty/day inputs, real-IDB v2 smoke tests (close/reopen gate, integrity, monthReview), v2 manual CHECKLIST.
- Return accounting: return badge (كامل/جزئي) + refunded qty + returns card in invoices view, `sales.printData` includes `returns`, dashboard today + 30-day chart net of returns, `salesReport` adds `{returns,net}` per group + reports columns, daily-closing dialog shows gross/refunds/net; `tests/test-return-accounting.js` (+5); 95/95 green.
- Dashboard month KPIs from accrual P&L (single truth) + full service JSDoc + v2 CHECKLIST; 72/72 green (parallel payments WIP red separately).
- §12.1 audit round (float-money clean, TZ/midnight + boundary tests, print wrap builder tests, JSDoc, dead-code removal); 76/76 tests green.
- §12.1/§12.5 cleanup: returns-line container bug fix (qty read from `linesDiv`), negative/zero/absurd-input validation in sales+purchases, barcode `innerHTML`→`<img>`, atomicity tests, settings JSDoc, unused-import removal; `tests/test-validation.js` + `tests/test-atomicity.js`; 90/90 tests green.
- Tolerant integrity `paidMinor` check (fixes false `المدفوع غير متسق` on installment/exchange sales; joins linked `customerPayments`, never mirrors payments onto the sale — mirroring double-counted the ledger), POS payer-name field, returns-page `exchangePanel` TDZ fix; 79/79 tests green.
- Invoice payment button + settings-driven methods (incl. جوال باي/بال باي, editable in Settings → طرق الدفع), payer name/phone on customer & supplier payments, contact phone on sales, payments history in invoice view/print; `tests/test-payments.js`; 76/76 tests green.
- Year/custom period modes + §12 sweep (Eastern digits, CSV guard, tx mutex, safeWidget, dead-code removal); 68/68 tests green.
- Scoped flow lists + statements w/ opening/closing, hash period, errorLog + page isolation, clientKey double-submit guard, O(n²) index fix (208ms/5ms at 5k/50k); 65/65 tests green.
- V2 period UI: global month selector + `/periods` closing page + 4 report tabs + dashboard period touches + Settings checker; 57/57 tests green.
- §13.2 acceptance scenario passes to the cent; integrity checker (9 checks) gates closing; 56/56 tests green.
- Added v2 reports (Month Review, Year Overview, profit-cash reconciliation, compareMonths); 50/50 tests green.
- Added spread/recurring v2 expenses and full as-of balances (avgCost, prepaid, accrued, v2 snapshot); 46/46 tests green.
- Built v2 period-locking core (periods service, assertOpen in all postings, close/reopen, migration to schemaVersion 3, month fns); 34/34 tests green.
- Added purchaseReturns (service+facade+page+tests) and user-editable document dates on all major dialogs; 23/23 tests green.
- Fixed B1–B8 (payroll double-deduction, P&L salary accrual, facade envelope, expense void, label barcodes, barcode dup, safety backup, escapeHtml); 21/21 tests green; added docs/CHANGELOG.md.
- Created project memory system (CLAUDE.md, MAP.md, moved specs to docs/specs/)