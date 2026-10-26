# BeeStore — Source File Map

## Core (js/core/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `namespace.js` | Global namespace + version | `BeeStore`, `BeeStore.version`, `BeeStore.schemaVersion` | — |
| `config.js` | App constants (DB name, paths, lock) | `BeeStore.config` | `namespace.js` |
| `money.js` | Minor-unit money math (parse/format/round, Eastern-digit normalization) | `BeeStore.money.{roundMinor,parseDecimal,normalizeDigits,fromMajor,toMajor,format,add,sub,mul,sum}` | `namespace.js` |
| `dates.js` | Business dates (local YYYY-MM-DD), month ops (monthOf/monthRange/addMonths/daysInMonth/isSameMonth/compare), injectable clock | `BeeStore.dates.{today,now,nowTime,parseDate,formatDate,formatDateTime,monthKey,daysInMonth,addDays,addMonths,startOfMonth,endOfMonth,diffDays,monthOf,monthRange,isSameMonth,compare,setClock,resetClock}` | `namespace.js` |
| `ids.js` | Prefixed random IDs, barcode generation | `BeeStore.ids.{randomId,nextBarcode,eanCheckDigit}` | `namespace.js` |
| `validate.js` | Field validation helpers (required, min, max, phone, email) | `BeeStore.validate.{required,isNumber,min,max,phone,email}` | `namespace.js` |
| `errors.js` | Typed error class + factory | `BeeStore.errors.{BeeError,err}` | `namespace.js` |

## Storage (js/storage/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `repository.js` | Repository interface contract + collection list + **storage policy** (master vs dated collections, `memoryWindowMonths`, `windowBounds`, `inMemoryWindow`, `inRange`, index definitions) | `BeeStore.RepositoryInterface`, `BeeStore.COLLECTIONS`, `BeeStore.storagePolicy` | `namespace.js`, `core/*` |
| `summary.js` | Pure v2 materialized summary: all-time receivables/payables/account balances/unpaid installments + monthly buckets (P&L, flows, customers/suppliers, tax, capital, opening inventory) + transient day deltas for as-of dates; `apply`/`compute`/`pnlRange`/`accountBalanceAt`/`customerTotals`/`supplierTotals`/`overdue` | `BeeStore.summary` | `namespace.js`, `core/dates.js` |
| `memoryRepository.js` | In-memory repo (tests) under the same window policy, serialized tx, once-per-commit index rebuild, cached `getSummary()` invalidated on commit; streamed export + counts | `BeeStore.MemoryRepository` | `repository.js`, `summary.js`, `core/*` |
| `idbRepository.js` | IndexedDB repo: window load + lazy indexed reads (`listRange/get/query/latest/count/list`), 300-doc LRU, `onLazyRead` progress hook, materialized summary persisted in `meta` and updated inside each transaction, v6 indexes (date/field + compound `variantDate` + `cashAdjustments`), serialized tx; reports the **stored** `schemaVersion` so startup migrations are not skipped; streamed export/import + counts | `BeeStore.IdbRepository` | `repository.js`, `summary.js`, `core/*` |
| `migrations.js` | Schema version upgrades | `BeeStore.migrations.{migrate,migrations}` | `namespace.js` |
| `fileSync.js` | Folder handle, db.json mirror, dated backups, status + file info (name/size/lastModified) and folder/file path metadata | `BeeStore.FileSync` | `core/*`, `config.js` |

## Services (js/services/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `settings.js` | Settings CRUD + defaults + payment account map | `BeeStore.settings`, `BeeStore.SettingsService` | `core/*`, `storage/*` |
| `audit.js` | Append-only audit log | `BeeStore.audit`, `BeeStore.AuditService` | `core/*`, `storage/*` |
| `accounts.js` | Account CRUD + balance + ledger | `BeeStore.accounts`, `BeeStore.AccountsService` | `core/*`, `storage/*` |
| `categories.js` | Product category CRUD | `BeeStore.categories`, `BeeStore.CategoriesService` | `core/*`, `storage/*` |
| `products.js` | Product CRUD + grid create (size×color) | `BeeStore.products`, `BeeStore.ProductsService` | `core/*`, `storage/*`, `variants.js` |
| `variants.js` | Variant CRUD, search, barcode lookup, low stock | `BeeStore.variants`, `BeeStore.VariantsService` | `core/*`, `storage/*`, `products.js` |
| `stock.js` | Stock movements, adjust, stocktake, recalc, verify | `BeeStore.stock`, `BeeStore.StockService` | `core/*`, `storage/*`, `variants.js` |
| `sales.js` | Sale create (POS, clientKey idempotency), list, void, print data, installments | `BeeStore.sales`, `BeeStore.SalesService` | `core/*`, `storage/*`, `variants.js`, `customers.js`, `settings.js` |
| `customers.js` | Customer CRUD, balance, statement, payments, overdue | `BeeStore.customers`, `BeeStore.CustomersService` | `core/*`, `storage/*`, `sales.js` |
| `returns.js` | Sale returns & exchanges (restock/damaged, refund modes, return badges, refunded qty), list w/ {from,to} | `BeeStore.returns`, `BeeStore.ReturnsService` | `core/*`, `storage/*`, `sales.js`, `variants.js`, `customers.js` |
| `purchases.js` | Purchase create (avg cost), list w/ {from,to,supplierId}, void | `BeeStore.purchases`, `BeeStore.PurchasesService` | `core/*`, `storage/*`, `variants.js`, `suppliers.js` |
| `purchaseReturns.js` | Purchase returns (reduce_payable/cash_refund), stock decrease, payable reduction, list w/ {from,to} | `BeeStore.purchaseReturns`, `BeeStore.PurchaseReturnsService` | `core/*`, `storage/*`, `variants.js`, `purchases.js` |
| `suppliers.js` | Supplier CRUD, balance, statement, payments (FIFO) | `BeeStore.suppliers`, `BeeStore.SuppliersService` | `core/*`, `storage/*`, `purchases.js` |
| `expenses.js` | Expense CRUD + void w/ reason, spread allocation + shares/prepaid, recurring v2 (bounds/effectiveFrom/idempotent), reserved names | `BeeStore.expenses`, `BeeStore.ExpensesService` | `core/*`, `storage/*`, `settings.js` |
| `payroll.js` | Payroll prepare (per month), update, pay (creates expense), advances | `BeeStore.payroll`, `BeeStore.PayrollService` | `core/*`, `storage/*`, `employees.js`, `expenses.js` |
| `employees.js` | Employee CRUD | `BeeStore.employees`, `BeeStore.EmployeesService` | `core/*`, `storage/*` |
| `transactions.js` | Owner transactions, transfers; legacy daily closing delegates to the full L4 service | `BeeStore.transactions`, `BeeStore.TransactionsService` | `core/*`, `storage/*`, `accounts.js`, `settings.js`, `dailyClosing.js` |
| `dailyClosing.js` | v3-Lite L4 daily closing: cash-drawer preview, atomic close (difference adjustment + take-out transfer/withdrawal + retained float), get/list/report/text summary, day/month status, unclosed days, reopen latest with soft-void + audit | `BeeStore.dailyClosing`, `BeeStore.DailyClosingService` | `core/*`, `storage/*`, `accounts.js`, `settings.js`, `periods.js` |
| `periods.js` | Month assertOpen gate, checklist (§7.2 full: blockers+warnings+info), close w/ snapshot, reopen-latest, monthsWithData | `BeeStore.periods`, `BeeStore.PeriodsService` | `core/*`, `storage/*`, `stock.js`, `reports.js`, `accounts.js` |
| `reports.js` | P&L (accrual + spread shares + signed cash differences), sales + returns/net, inventory, aging, v2 balance snapshot, Month Review, Year Overview, profit-cash reconciliation, compare, legacy daily closing | `BeeStore.reports`, `BeeStore.ReportsService` | `core/*`, `storage/*`, `accounts.js`, `sales.js`, `expenses.js`, `payroll.js` |
| `dashboard.js` | Dashboard KPIs (today + month from accrual P&L), charts data, recent invoices, L4 day status | `BeeStore.dashboard`, `BeeStore.DashboardService` | `core/*`, `storage/*`, `sales.js`, `expenses.js`, `accounts.js`, `reports.js`, `dailyClosing.js` |
| `backup.js` | Backup orchestration: file-sync create/list, streamed payload + checksum/encryption, share/download, inspect/summary, safe restore with pre-restore snapshot, reminder status | `BeeStore.backup`, `BeeStore.BackupService` | `storage/*`, `fileSync.js`, `backupFile.js`, `snapshots.js`, `migrations.js` |
| `backupFile.js` | Pure backup-file helpers: SHA-256 integrity, AES-GCM/PBKDF2 encryption, filename, summary/warnings, backup freshness status, share-sheet + download fallback | `BeeStore.backupFile.{addIntegrity,verifyIntegrity,encryptBytes,decryptEnvelope,openBackup,backupFileName,summarizeBackup,inspectBackup,backupStatus,shareOrDownload}` | `core/*` |
| `maintenance.js` | Recalculate stock, Data Integrity Checker (**16 checks**: 9 base + closed-day recomputation, drawer balance, `cash_difference` adjustments, stale unclosed days, backup/off-site freshness, storage, clock), reset all, check empty | `BeeStore.maintenance`, `BeeStore.MaintenanceService` | `storage/*`, `stock.js`, `dailyClosing.js`, `backupFile.js`, `pwa.js`, `clockGuard.js` |
| `barcode.js` | JsBarcode wrapper (canvas/SVG) | `BeeStore.barcode`, `BeeStore.BarcodeService` | `vendor/jsbarcode` |
| `scan.js` | Scan → variant lookup (exact barcode, then search), POS cart add (stock limits, qty+1), price-check lookup | `BeeStore.scanning.{lookupVariant,addToCart,priceCheck,normalizeCode}` | `scanner.js` (normalize), `api.variants` |
| `csv.js` | CSV import (products, digit-normalized) + export (formula-guarded, BOM) | `BeeStore.csv`, `BeeStore.CsvService` | `core/*`, `storage/*`, `products.js`, `variants.js` |
| `pwa.js` | Browser-only PWA manager: SW registration, update detection/banner, safe-update gate (POS cart/saving/visible dialog/closing), install prompt + Arabic Android/iPhone guide, persistence status, cache version, off-device backup reminder banner | `BeeStore.pwa.{register,checkForUpdate,applyUpdate,getState,onAppReady,getCacheVersion,isStandalone,isSafeToUpdate,collectAppState,storageStatus,requestPersistence,showInstallGuide,install}` | `components.js`, `dialogs.js`, `pos.js`, `backup.js` |
| `snapshots.js` | Separate IndexedDB `beestore-snapshots` for pre-migration safety snapshots; metadata + data stores, newest-10 pruning, download | `BeeStore.SnapshotService`, `BeeStore.snapshots` | `namespace.js`, `config.js` |
| `auth.js` | v3-Lite L5 local profiles: PIN set/verify (PBKDF2-SHA256 210k, 16-byte salt, 4–6 digits), 5-attempt exponential lockout, auto-lock/background lock state, safe profile/PIN stripping (`authUtils`) | `BeeStore.auth`, `BeeStore.authUtils` | `core/*`, `storage/*` |
| `clockGuard.js` | v3-Lite L5/L8 clock anomaly guard: backward >1 day vs latest commit, forward >30 days vs last seen day, per-day owner confirmation | `BeeStore.clockGuard` | `core/*`, `storage/*` |
| `zip.js` | Dependency-free store-only ZIP writer/reader (UTF-8 names, CRC32) used by the accountant package | `BeeStore.zip` | `namespace.js` |
| `xlsx.js` | Dependency-free OOXML XLSX writer (inline strings, styled headers, money formats, frozen panes) | `BeeStore.xlsx` | `namespace.js` |
| `monthReviewPdf.js` | Arabic-safe Month Review PDF: canvas pages → JPEG → minimal PDF; open-month watermark; browser renderer injectable for tests | `BeeStore.monthReviewPdf` | `namespace.js`, `dates.js`, `money.js` |
| `cloudTarget.js` | Shared delivery for backups/packages: `ShareSheetTarget` (`navigator.share({files})`), `DownloadTarget`, `shareOrDownload` with fallback | `BeeStore.cloudTarget` | `namespace.js` |
| `accountingPackage.js` | v3-Lite L7 read-only accountant package: 18 XLSX sheets, BOM CSV folder, bilingual README, Arabic Month Review PDF, manifest SHA-256/checksums, cross-checks, info/build/share/download | `BeeStore.accountingPackage` | `reports.js`, `zip.js`, `xlsx.js`, `monthReviewPdf.js`, `cloudTarget.js` |

## API Facade (js/api/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `api.js` | Facade `BeeStore.api.<ns>.<method>` → `{ok,data\|error}` (never rejects; `_wrapAll` envelope); central L5 cashier allow-list, cost/profit stripping, PIN/profile stripping, clock posting block, cashier discount/return limits, cashier dashboard substitution, `security` namespace, L7 `accountingPackage` (read-only/clock-exempt) | `BeeStore.Api` | All services |

## UI (js/ui/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `router.js` | Hash-based router (period travels as `?m=YYYY-MM`, wins over prefs) | `BeeStore.router`, `BeeStore.Router` | `namespace.js` |
| `components.js` | Reusable UI primitives (el, toast, confirm, table, pagination, dropdown, skeletons, escapeHtml, safeWidget) | `BeeStore.ui.{el,toast,confirmDialog,formatMoney,formatDate,statusBadge,emptyState,table,pagination,loadingSpinner,skeleton,dropdown,escapeHtml,safeWidget}` | `namespace.js`, `money.js`, `dates.js` |
| `dialogs.js` | Form dialog helpers (openDialog, formField, input, select, textarea, checkbox, radio, date, number, file) | `BeeStore.dialogs.{openDialog,formField,input,select,textarea,checkbox,radioGroup,fileInput,numberInput,dateInput,hiddenInput}` | `components.js` |
| `backupUI.js` | Off-device backup UI flows: share/download toasts, file picker, passphrase retry, restore summary/warnings + confirmation, reload after restore | `BeeStore.backupUI.{restoreFromFile,shareBackup,downloadBackup}` | `components.js`, `dialogs.js`, `api.js`, `backupFile.js` |
| `print.js` | Invoice (A4/80mm), label sheet with Code128 images, daily closing print, Day Report HTML/print (A4/80mm) | `BeeStore.print.{printInvoice,printLabelSheet,printDailyClosing,buildInvoiceHtml,buildLabelSheetHtml,buildDayReportHtml,printDayReport}` | `components.js`, `api.js`, `money.js`, `dates.js` |
| `firstRun.js` | First-run wizard (store info → folder → demo/empty/restore); skips the desktop-only folder step on phones, supports new-phone restore, and signals PWA app-ready | `BeeStore.FirstRunWizard` | `components.js`, `api.js`, `backupUI.js`, `fileSync.js`, `settings.js`, `pwa.js` |
| `period.js` | v2 global period store: month/year/custom/**day** selection (localStorage + URL hash + memory fallback), header selector, scope bar, `defaultDateForNew`/`applyDefaultDate`, day-mode warning | `BeeStore.period.{get,set,setDay,setYear,setCustom,init,toQuery,shift,getRange,monthLabel,label,selMonth,currentMonth,isClosed,isDayClosed,monthsWithData,defaultDateForNew,applyDefaultDate,scopeBar,renderHeader}` | `components.js`, `dialogs.js`, `dates.js`, `api.periods`, `api.dailyClosings` |
| `errorLog.js` | v2 §12.3 global error capture (last 200 in IDB `errorLog`), Arabic dialog + copy, diagnostics download | `BeeStore.errorLog.{repo,install,capture,list,clear,diagnostics}` | `components.js`, `ids.js` |
| `scanner.js` | Camera barcode scanner: full-screen overlay, rear camera, torch, camera switch, BarcodeDetector + vendored ZXing fallback, continuous mode with 1.5 s repeat filter, beep/vibrate/flash, manual entry, Arabic errors | `BeeStore.scanner.{open,scan,scanButton,closeCurrent,isSupported,unsupportedReason,reasonMessage,normalizeCode,createRepeatFilter,REASONS,PREFERRED_FORMATS}` | `components.js`, `vendor/zxing` |
| `lock.js` | v3-Lite L5 lock screen and profile switch: PIN entry, attempt countdown, profile chip, manual lock, re-render on profile change, auto-lock/background hooks | `BeeStore.AppLock` | `components.js`, `api.security` |

## Pages (js/pages/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `dashboard.js` | Dashboard page (cards, charts, recent invoices, L4 today/yesterday day cards + unclosed-day warnings, last-backup status + “نسخ الآن”, L5 cashier own-day summary) | `BeeStore.pages.dashboard` | `ui/*`, `api.dashboard`, `api.reports`, `api.dailyClosings`, `api.backup` |
| `pos.js` | POS page (camera + USB barcode scan, continuous scanning, unknown-barcode create action, cart, discount, payments, save w/ clientKey + in-flight guard); exposes cart/saving state for the safe-update gate | `BeeStore.pages.pos.{render,getCartCount,isSaving,hasUnsavedWork}` | `ui/*`, `scanner.js`, `scan.js`, `api.products`, `api.variants`, `api.sales`, `api.customers`, `api.settings` |
| `invoices.js` | Invoice list (period-scoped + show-all, search, filter, view, print, void) | `BeeStore.pages.invoices` | `ui/*`, `api.sales`, `print.js` |
| `returns.js` | Returns & exchanges list (period-scoped) + create | `BeeStore.pages.returns` | `ui/*`, `api.returns`, `api.sales`, `api.customers`, `api.variants` |
| `products.js` | Products, categories, variants (scan barcode + duplicate guard linking to owner variant), stock, low-stock, CSV import | `BeeStore.pages.products` | `ui/*`, `scanner.js`, `scan.js`, `api.products`, `api.categories`, `api.variants`, `api.stock`, `csv.js` |
| `stocktake.js` | Stocktake page (count sheet, scan-to-count, apply) | `BeeStore.pages.stocktake` | `ui/*`, `scanner.js`, `scan.js`, `api.variants`, `api.stock` |
| `priceCheck.js` | "فحص سعر" page: scan/manual barcode → name, size, color, price, stock | `BeeStore.pages.priceCheck` | `ui/*`, `scanner.js`, `scan.js`, `api.variants` |
| `labels.js` | Barcode label sheet builder + print | `BeeStore.pages.labels` | `ui/*`, `api.variants`, `api.settings`, `barcode.js`, `print.js` |
| `purchases.js` | Purchase list (period-scoped) + create (scan receiving → variant + cost), purchase returns tab | `BeeStore.pages.purchases` | `ui/*`, `scanner.js`, `scan.js`, `api.purchases`, `api.suppliers`, `api.variants` |
| `suppliers.js` | Supplier list + payments + period-scoped statement | `BeeStore.pages.suppliers` | `ui/*`, `api.suppliers` |
| `customers.js` | Customer list, period-scoped statement, payments, installments | `BeeStore.pages.customers` | `ui/*`, `api.customers` |
| `expenses.js` | Expense list (period-scoped), categories, recurring | `BeeStore.pages.expenses` | `ui/*`, `api.expenses` |
| `employees.js` | Employee list, payroll prepare/pay, advances | `BeeStore.pages.employees` | `ui/*`, `api.employees`, `api.payroll` |
| `accounts.js` | Accounts, ledger, transfers, owner tx; closing tab delegates to the L4 wizard/Days page | `BeeStore.pages.accounts` | `ui/*`, `api.accounts`, `api.transactions`, `api.reports`, `pages/days.js` |
| `reports.js` | All reports (P&L, sales, inventory, aging, balance, daily) + v2 tabs (Month Review, Profit⇄Cash, Compare, Year Overview) + L4 days table and signed cash-difference rows | `BeeStore.pages.reports` | `ui/*`, `ui/period.js`, `api.reports`, `api.dailyClosings` |
| `days.js` | v3-Lite L4 Days page: month table (all days), closed/unclosed counters, cross-month warnings, 4-step closing wizard with denominations/no-count, take-out, Day Report (print/share/reopen/next-prev) | `BeeStore.pages.days.{render,openWizard,openReport}` | `ui/*`, `ui/period.js`, `ui/print.js`, `api.dailyClosings`, `api.settings`, `api.backup` |
| `periods.js` | v2 month-closing page: months table, live checklist (16-check integrity incl. L8 drawer/clock/backup), KPIs, close/reopen/integrity/print, L7 package + PDF share/download with open/closed hint | `BeeStore.pages.periods` | `ui/*`, `ui/period.js`, `api.periods`, `api.reports`, `api.maintenance`, `api.backup`, `api.accountingPackage` |
| `settings.js` | Settings page (store info, tax, invoice, sizes/colors, payment methods, off-device backup card + encryption/share/download/restore + storage-path card, **الأمان** tab: owner/cashier PIN, limits, auto-lock, **البيانات** tab: persistence/install/offline/update/cache version/snapshots + record counts/usage/year estimate/70–90% warnings, audit, maintenance + 16-check integrity + error log, large font) | `BeeStore.pages.settings` | `ui/*`, `api.settings`, `api.backup`, `api.maintenance`, `api.audit`, `api.security`, `backupUI.js`, `fileSync.js`, `pwa.js`, `snapshots.js` |

## Demo (js/demo/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `demoData.js` | Load ~20 products, variants, suppliers, customers, sales, expenses, employees | `BeeStore.loadDemoData()` | All services |

## PWA / Shell (root + scripts/)
| File | Responsibility | Exports / Notes | Depends On |
|------|---------------|-----------------|------------|
| `manifest.json` | PWA identity: Arabic/RTL, standalone, `start_url`/`scope` `./`, theme `#F5B700`, 192/512 + maskable icons | — | `icons/*` |
| `icons/icon.svg`, `icons/icon-maskable.svg` | Editable icon sources (bee mark on amber) | — | — |
| `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png`, `icons/apple-touch-icon-180.png` | Generated PNGs (Chromium screenshots of the SVGs; no ImageMagick) | — | SVG sources |
| `sw.js` | Cache-first app shell; explicit `PRECACHE` + content-hash `CACHE_VERSION`; navigation fallback to `index.html`; old-cache cleanup; `SKIP_WAITING` only on page request; `GET_VERSION` reply | generated block must not be hand-edited | `scripts/build-sw-list.js` |
| `scripts/build-sw-list.js` | Walks `index.html`, `manifest.json`, `bee.jpg`, `css/`, `js/`, `vendor/`, `icons/`; computes SHA-256; rewrites `sw.js` markers | `collectFiles`, `computeHash`, `versionForHash`, `renderBlock`, `updateSwFile` | Node `fs`, `path`, `crypto` |

## App Bootstrap (js/app.js)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `app.js` | Init repo, lazy-load progress bar (`onLazyRead`, 150 ms delay + counter), pre-migration snapshot, fileSync, api, wizard or start, single-tab lock, delegated `[data-route]` navigation, hamburger sidebar, save-status, PWA register/app-ready | `BeeStore._setupRouter`, `BeeStore._setupSaveStatus`, `BeeStore._setupVisibilityHandlers`, `BeeStore._setupSidebar` | All layers, `pwa.js`, `snapshots.js` |

## Tests (tests/)
| File | Responsibility |
|------|---------------|
| `test-storage-policy.js` | Window bounds, in-memory ranges, date fields, index definitions, `lastManyByIndex` (7 tests) |
| `test-summary.js` | Summary totals, dated customer/supplier payments, reversible updates, installments, MemoryRepository cache (6 tests) |
| `test-daily-closing.js` | L4 reference scenario (515 expected / 510 counted / −5 difference / 110 retained), day locks + allowed postings, close ordering + no-count catch-up, external totals warn only (4 tests) |
| `test-auth.js` | L5 PIN hashing/verification, lockout, cashier discount/return limits, allow-list, sensitive-field stripping, cashier summary (8 tests) |
| `test-accounting-package.js` | L7 SHA-256 vectors, package contents/checksums/BOM/formula guard/manifest/open→closed status, share/download/cashier denial (3 tests) |
| `test-integrity-l8.js` | L8 clean closed-day recomputation + drawer/stale/backup/storage, tamper detection, adjustment void/amount tamper, reopen/re-close, clock anomaly (3 tests) |
| `ui-package.html` | Browser L7/L8: open→closed package, Arabic Canvas PDF, 21 files/18 BOM CSVs, manifest checksums, share/download, cashier denial, 16-check integrity (11 tests) |
| `idb-lazy.html` | Browser: v6 indexes + `cashAdjustments` + compound `variantDate`, window-only memory, lazy `get/list/listRange/query`, progress events, `lastManyByIndex`, streamed export byte-equality, summary update/rebuild on import, v3→v6 upgrade (17 tests) |
| `ui-days.html` | Browser L4: dashboard day cards, Days table, wizard steps, denomination counter, no-count close, Day Report + print HTML, Day mode, Month Review, settings, accounts delegation, zero page errors (13 tests) |
| `smoke.html` | Browser IndexedDB smoke: repository open, dbVersion upgrade, product/variant/stock, export, month lock/reopen, integrity, Month Review, clear (10 tests) |
| `verify-offline.py` | L10 CDP offline check: SW controls the page, 97 cached files, offline shell start, IndexedDB reads, offline invoice, survives a second reload (10 checks; requires ChromeDriver) |
| `perf.html` | Seeds 50,000 invoices + 50,000 stock movements, rebuilds the summary, measures cold start, dashboard, Month Review (window/old), save invoice, and diagnostic components |
| `test-reports.js`, `test-asof.js` | Summary-vs-legacy P&L and balance-snapshot parity, plus v2 report/as-of suite |