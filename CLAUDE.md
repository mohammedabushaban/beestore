# BeeStore — Project Memory

## Project Summary
BeeStore is a **v3-Lite** browser-only Arabic RTL accounting & inventory system for one children's clothing shop on **one phone**. It is delivered as an installable offline PWA from a free static HTTPS host (currently GitHub Pages; Cloudflare Pages is the commercial-safe alternative). Data lives in IndexedDB; the JSON folder mirror is an optional desktop-only extra. **Never open `index.html` via `file://`** — it is no longer a supported target. Local dev: `python3 -m http.server 8080` then `http://localhost:8080/`. Tests: `node --test tests/*.js` (currently 173). After any app-shell change: `node scripts/build-sw-list.js`. **L1, L2, L3 and L4 are implemented:** L2 keeps master data + the current and previous `memoryWindowMonths` in memory, reads older months lazily through IndexedDB date indexes (300-doc LRU + top progress bar), and serves dashboard/reports from a materialized `meta.summary` updated in the same transaction. L4 adds day locks, a four-step cash-drawer closing, signed cash differences in P&L, a Day Report, the Days page, dashboard day cards and Day mode.

## Architecture Overview

**Layers** (bottom → top):
- `core/` — utilities: namespace, config, money (minor units), dates (local YYYY-MM-DD), ids, validate, errors
- `storage/` — repository interface + storage policy, `memoryRepository` (tests), `idbRepository` (browser, memory window + lazy indexed reads), pure `summary.js` (materialized totals/month buckets), `fileSync` (JSON mirror + backups), `migrations`
- `services/` — **all business logic**, pure JS, no DOM/IndexedDB/window (except the browser-only `pwa.js` and `snapshots.js`). Depend only on repository interface.
- `api/api.js` — thin facade `BeeStore.api.<namespace>.<method>` returning `{ok, data|error}` envelopes
- `ui/` — router, components, dialogs, print helpers, first-run wizard, keyboard shortcuts, camera scanner
- `pages/` — one file per page, renders into `#page-content`
- `services/pwa.js` — SW registration, update banner, install prompt/guide, persistence, safe-update gate
- `services/snapshots.js` — separate IndexedDB (`beestore-snapshots`) for pre-migration snapshots (last 10)
- `sw.js` + `scripts/build-sw-list.js` — explicit app-shell precache list + content-hash `CACHE_VERSION`
- `manifest.json` + `icons/` — Arabic RTL standalone PWA identity

**Global namespace**: `window.BeeStore` (IIFE-wrapped files, classic `<script>` tags, no ES modules)

**Script load order** (index.html): core → storage → services (`services/backupFile.js` before `services/backup.js`) → api → ui (`ui/backupUI.js` after dialogs) → pages → demo → `services/pwa.js` → `app.js`. `services/snapshots.js` loads with the services.

## Golden Rules (never break)
- Money = integer minor units (agorot/cents). Use `BeeStore.money` only.
- Business dates = local `YYYY-MM-DD` strings. `dates.today()` uses local date parts, **not** `Date.toISOString()`.
- Every posting operation = **one** `repo.transaction(fn)`.
- `assertPeriodOpen(date)` inside every posting transaction (v2).
- `assertDayOpen(date)` inside sales, sale voids, returns, receipts/payments, cash expenses, transfers, withdrawals and capital movements (L4). Unpaid purchases, payroll accrual and stock adjustments stay allowed. `assertCashDayOpen` only blocks expenses paid from the cash drawer.
- No hard deletes: `status: "void"` / `active: false`.
- Escape all user text: `textContent` or `BeeStore.ui.escapeHtml()`.
- Arabic RTL throughout (`<html lang="ar" dir="rtl">`), Western digits.
- No `fetch` of local files, no CDN, no ES modules, no build step for the app.
- **No inline scripts or inline event handlers** (`onclick=` etc.) — CSP is `script-src 'self'`. Navigation uses delegated `[data-route]` clicks.
- **Never edit the generated `PRECACHE` / `CACHE_VERSION` in `sw.js` by hand.** Run `node scripts/build-sw-list.js`; `tests/test-sw.js` fails if stale.
- **Never call `skipWaiting()` during install.** The page sends `{type:'SKIP_WAITING'}` only after `BeeStore.pwa.applyUpdate()` passes the safe gate (empty POS cart, not saving, no **visible** dialog/wizard, no closing).
- The first-run wizard stays in the DOM hidden; visibility (computed `display`) matters, not mere presence.
- PWA data is origin-scoped (scheme + host + port), not path-scoped. Warn before any host/port change.
- Keep `index.html`'s CSP self-only: no third-party scripts, analytics, or remote fonts.
- **Backup integrity:** the SHA-256 `integrity.value` covers only `schemaVersion`, `meta`, `settings`, `collections` via `dataJson()`; never include `integrity` itself. A checksum mismatch must abort restore without touching data.
- **Never store the encryption passphrase.** It is used only in memory for AES-GCM/PBKDF2; losing it means losing that backup.
- **Restore is destructive:** always create a `pre-restore` snapshot first; if the snapshot fails, abort. Never overwrite live data before checksum/passphrase validation.
- `lastBackupRevision` records the post-bookkeeping `meta.revision`; do not treat the settings write that marks a backup as new business activity.

## Short Recipes

**Add a page**: Create `js/pages/xyz.js` exporting `{ render(container) }`, register in `app.js _setupRouter()`.

**Add a service method**: Create/update `js/services/xyz.js`, bind repo in `api.js _bindServices()`.

**Add a facade method**: Add to `BeeStore.Api` in `api.js` returning `ok(data)` / `fail(code, msg)`.

**Add a report**: Add method to `ReportsService` (services/reports.js), expose in `api.js reports`, create page if needed.

**Add a settings field**: Add to `DEFAULT_SETTINGS` in `services/settings.js`, persist via `settings.save()`.

**Add data-model field + migration**: Add field in service `create()`, bump `schemaVersion` in `namespace.js`, add migration in `storage/migrations.js`.

## Specs (docs/specs/)
- **`BeeStore-v3-Lite.md` — authoritative v3-Lite spec (L1–L10). Read this first.**
- `BeeStore-Project-Spec.md` — v1 base system (sections 1-15)
- `BeeStore-v2-Monthly-Periods.md` — v2 addendum: monthly periods, month closing, hardening, acceptance scenario (§13.2)

## PWA / Deployment
- Hosting: GitHub Pages primary (repo already on GitHub; terms prohibit e-commerce/SaaS — BeeStore is an internal single-shop tool). Cloudflare Pages is the commercial-safe alternative. See `docs/DEPLOY_AR.md`.
- `manifest.json`: `start_url: "./"`, `scope: "./"`, Arabic/RTL, standalone, theme `#F5B700`.
- Icons: edit `icons/icon.svg` / `icons/icon-maskable.svg`, then screenshot with Chromium to PNG (no ImageMagick). Keep the SVGs as source.
- `sw.js` caches only the explicit app shell; never data, backups, downloads, or cross-origin requests. Navigation is cache-first with `index.html` fallback.
- `sw.js` deletes old `beestore-v3-lite-*` caches on activate and calls `clients.claim()`.
- Update UX: `تحديث متوفر` banner; apply only on tap; reload once via `controllerchange`; never lose an in-progress invoice.
- Persistence: `navigator.storage.persist()` on boot; result + usage/quota + install/offline/update status in Settings → البيانات.
- Off-device backup: Settings → النسخ الاحتياطي uses `navigator.share({files})` with a download fallback, SHA-256 integrity, optional AES-GCM encryption, and restore summary/warnings. The dashboard and PWA banner warn after 2 days with new activity (critical at 7). New phones can restore from the wizard.
- Pre-migration: `app.js` writes a snapshot to `beestore-snapshots` before `migrations.migrate`; abort migration if the snapshot fails. Restore also writes a `pre-restore` snapshot first.
- Tests: `tests/test-pwa.js`, `tests/test-sw.js`, `tests/test-snapshots.js`; browser checks cover offline start and safe update.

## Recent Changes
- **v3-Lite L4 — daily closing, cash reconciliation, Day Report, day lock (2026-10-25)**: `dbVersion` 5→6 adds `cashAdjustments` (`date`/`accountId`/`closingId` indexes) with `schemaVersion` unchanged; summary VERSION 3 recomputes signed `cashDifference`. `js/services/dailyClosing.js` builds the cash-drawer preview from accounts/sales/returns/collections/expenses/transfers/withdrawals/payroll/advances, closes atomically (difference adjustment + bank transfer or owner withdrawal + retained float + audit), lists month days/unclosed days/status, reopens only the latest closed day with soft-voids, and builds the Day Report/text summary. `periods.assertDayOpen`/`assertCashDayOpen` gate all cash/sales postings; `js/pages/days.js` provides the month table, 4-step wizard, denominations, no-count, external totals, Day Report/print/share/reopen; dashboard shows اليوم/أمس + warnings; Month Review has the days table and signed cash-difference row; `period.js`/router add Day mode (`?d=`); Settings sets drawer/bank/denominations. Legacy `transactions.dailyClosing` delegates to L4; `reports.dailyClosing` retained. Tests: `test-daily-closing.js` (4), `ui-days.html` 13/13, `idb-lazy.html` 17/17 (v3→v6); 173/173 Node. Perf re-run: 370 ms cold, 176 ms dashboard, 153/180 ms Month Review, 30 ms save. SW 89 files `beestore-v3-lite-5b829f658d8e`. Docs: README, CHANGELOG, MAP, API, DATA_FORMAT, CHECKLIST.
- **v3-Lite L2 — phone storage: memory window, lazy months, materialized summary (2026-10-25)**: `repository.js` now owns `BeeStore.storagePolicy` (master list, dated-field map, `windowBounds`, `inMemoryWindow`, `inRange`, index definitions). `IdbRepository` loads only the window, reads older docs through v4/v5 date/field indexes (`dbVersion` 3→5, `schemaVersion` unchanged) including the compound `variantDate` index for `lastManyByIndex`, keeps a 300-doc LRU, exposes `onLazyRead` for the non-blocking top progress bar in `app.js`, and still makes `list()/exportAll()/exportAllStreamed()` complete. `js/storage/summary.js` (VERSION 2) materializes all-time totals and monthly P&L/flow/customer/supplier/tax/capital/opening-inventory buckets; `_runTransaction` applies old/new contributions before commit and persists `meta.summary`, with rebuild on missing/version mismatch. Dashboard, Month Review, `balanceAsOf/balancesAsOf`, balance snapshots (month ends), customer/supplier balances/statements, ledger ranges and P&L whole months use the summary or indexed ranges; arbitrary ranges still scan only the requested days. Tests: `test-storage-policy.js` (7), `test-summary.js` (6), summary-vs-legacy P&L/snapshot parity in reports/as-of, `idb-lazy.html` 17/17 browser, `smoke.html` 10/10; 169/169 Node after SW rebuild. 50k perf (headless Chromium): cold 546 ms, dashboard 245 ms, Month Review window 208 ms / old 242 ms, save 19 ms (targets 3 s/1 s/1 s/2 s/100 ms). Docs: README performance table + L2 complete, CHANGELOG, MAP.
- **v3-Lite L3 — off-device backups, encryption, safe restore, new phone (2026-10-24)**: `js/services/backupFile.js` (SHA-256 over stable data fields, AES-GCM/PBKDF2 210k, filename, summary/warnings, freshness status, share/download fallback) + expanded `backup.js` (streamed payload, share/download, inspect, restore with `pre-restore` snapshot, status). `js/ui/backupUI.js` handles file picker, passphrase retry, restore review/confirm, toasts. Settings → النسخ الاحتياطي has an off-device card (encryption, share/download, address warning) and full restore; the first-run wizard has **استعادة من نسخة احتياطية**. Dashboard shows last backup + “نسخ الآن”; PWA shows 2/7-day reminder banners. Repositories gained `exportAllStreamed()` and `count()`; Settings → البيانات shows counts/usage/year estimate + 70/90% warnings. Tests: `test-backup-file.js` (+9), **153/153 green**; SW precache 86 files. Browser-verified: UI, 116 KB checksum payload, encrypted round-trip + wrong passphrase, full restore (10 products), dashboard line, critical banner, wizard restore. Docs: README, DEPLOY_AR, CHECKLIST, CHANGELOG, MAP.
- **v3-Lite L1 — PWA, offline shell, safe updates (2026-10-24)**: `manifest.json` + generated icons; `sw.js` with explicit 84-file precache and content-hash `CACHE_VERSION`; `scripts/build-sw-list.js`; `js/services/pwa.js` (registration, update banner, install guide, persistence, safe gate); CSP meta with `script-src 'self'` and all 24 inline `onclick` handlers removed (delegated `[data-route]` navigation, hamburger listener fixed for wizard-created stores); Settings → البيانات; pre-migration snapshots in separate `beestore-snapshots` DB (last 10, download UI); fixed `IdbRepository` reporting the stored schema version; phone-first startup no longer warns when File System Access is missing; wizard skips the folder step on phones. Tests: `test-pwa.js`, `test-sw.js`, `test-snapshots.js`; **144/144 green**. Browser-verified: 84 cached files, offline reload, install banner/guide, Settings Data tab, update banner + blocked-with-cart + successful apply with old-cache cleanup. Docs: `docs/DEPLOY_AR.md`, README, MAP, CHANGELOG, CHECKLIST.
- **Camera barcode scanning + price check + save-file location**: `js/ui/scanner.js` is a full-screen overlay (rear camera, torch, camera switch, BarcodeDetector + vendored ZXing fallback, continuous 1.5 s repeat filter, beep/vibrate/flash, unknown-code buzz, manual entry, Arabic errors). Wired into POS (add line / qty+1, unknown → actionable "إضافة صنف", invoice never lost, Enter never submits, shortcuts paused while dialogs are open), product/variant forms (prefill + duplicate guard linking to the owner variant), purchases receiving (select variant + cost), stocktake (scan-to-count) and the new `/price-check` page (name/size/color/price/stock). Pure scan logic lives in `js/services/scan.js`; `fileSync.getStatus()/getFileInfo()` now expose the data file name, folder/file path, size and last-modified, shown in Settings → النسخ الاحتياطي with an honest note that the browser hides the absolute OS path. Tests: `test-scanner.js`, `test-scan.js`, `test-filesync-path.js`; 126/126 green.
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