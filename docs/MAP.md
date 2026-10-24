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
| `repository.js` | Repository interface contract + collection list | `BeeStore.RepositoryInterface`, `BeeStore.COLLECTIONS` | `namespace.js` |
| `memoryRepository.js` | In-memory repo (tests), serialized tx, once-per-commit index rebuild | `BeeStore.MemoryRepository` | `repository.js`, `core/*` |
| `idbRepository.js` | IndexedDB repo, load-to-memory + indexes, serialized tx, once-per-commit index rebuild | `BeeStore.IdbRepository` | `repository.js`, `core/*` |
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
| `transactions.js` | Owner transactions, transfers, daily closing | `BeeStore.transactions`, `BeeStore.TransactionsService` | `core/*`, `storage/*`, `accounts.js`, `settings.js` |
| `periods.js` | Month assertOpen gate, checklist (§7.2 full: blockers+warnings+info), close w/ snapshot, reopen-latest, monthsWithData | `BeeStore.periods`, `BeeStore.PeriodsService` | `core/*`, `storage/*`, `stock.js`, `reports.js`, `accounts.js` |
| `reports.js` | P&L (accrual + spread shares), sales + returns/net, inventory, aging, v2 balance snapshot, Month Review, Year Overview, profit-cash reconciliation, compare, daily closing | `BeeStore.reports`, `BeeStore.ReportsService` | `core/*`, `storage/*`, `accounts.js`, `sales.js`, `expenses.js`, `payroll.js` |
| `dashboard.js` | Dashboard KPIs (today + month from accrual P&L), charts data, recent invoices | `BeeStore.dashboard`, `BeeStore.DashboardService` | `core/*`, `storage/*`, `sales.js`, `expenses.js`, `accounts.js`, `reports.js` |
| `backup.js` | Backup create/list/download/restore | `BeeStore.backup`, `BeeStore.BackupService` | `storage/*`, `fileSync.js` |
| `maintenance.js` | Recalculate stock, Data Integrity Checker (9 checks), reset all, check empty | `BeeStore.maintenance`, `BeeStore.MaintenanceService` | `storage/*`, `stock.js` |
| `barcode.js` | JsBarcode wrapper (canvas/SVG) | `BeeStore.barcode`, `BeeStore.BarcodeService` | `vendor/jsbarcode` |
| `scan.js` | Scan → variant lookup (exact barcode, then search), POS cart add (stock limits, qty+1), price-check lookup | `BeeStore.scanning.{lookupVariant,addToCart,priceCheck,normalizeCode}` | `scanner.js` (normalize), `api.variants` |
| `csv.js` | CSV import (products, digit-normalized) + export (formula-guarded, BOM) | `BeeStore.csv`, `BeeStore.CsvService` | `core/*`, `storage/*`, `products.js`, `variants.js` |

## API Facade (js/api/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `api.js` | Facade `BeeStore.api.<ns>.<method>` → `{ok,data\|error}` (never rejects; `_wrapAll` envelope) | `BeeStore.Api` | All services |

## UI (js/ui/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `router.js` | Hash-based router (period travels as `?m=YYYY-MM`, wins over prefs) | `BeeStore.router`, `BeeStore.Router` | `namespace.js` |
| `components.js` | Reusable UI primitives (el, toast, confirm, table, pagination, dropdown, skeletons, escapeHtml, safeWidget) | `BeeStore.ui.{el,toast,confirmDialog,formatMoney,formatDate,statusBadge,emptyState,table,pagination,loadingSpinner,skeleton,dropdown,escapeHtml,safeWidget}` | `namespace.js`, `money.js`, `dates.js` |
| `dialogs.js` | Form dialog helpers (openDialog, formField, input, select, textarea, checkbox, radio, date, number, file) | `BeeStore.dialogs.{openDialog,formField,input,select,textarea,checkbox,radioGroup,fileInput,numberInput,dateInput,hiddenInput}` | `components.js` |
| `print.js` | Invoice (A4/80mm), label sheet with Code128 images, daily closing print | `BeeStore.print.{printInvoice,printLabelSheet,printDailyClosing,buildInvoiceHtml,buildLabelSheetHtml}` | `components.js`, `api.js`, `money.js`, `dates.js` |
| `firstRun.js` | First-run wizard (store info → folder → demo/empty) | `BeeStore.FirstRunWizard` | `components.js`, `api.js`, `fileSync.js`, `settings.js` |
| `period.js` | v2 global period store: month/year/custom selection (localStorage + URL hash + memory fallback), header selector, scope bar, `defaultDateForNew`/`applyDefaultDate` | `BeeStore.period.{get,set,setYear,setCustom,init,toQuery,shift,getRange,monthLabel,label,selMonth,isClosed,monthsWithData,defaultDateForNew,applyDefaultDate,scopeBar,renderHeader}` | `components.js`, `dialogs.js`, `dates.js`, `api.periods` |
| `errorLog.js` | v2 §12.3 global error capture (last 200 in IDB `errorLog`), Arabic dialog + copy, diagnostics download | `BeeStore.errorLog.{repo,install,capture,list,clear,diagnostics}` | `components.js`, `ids.js` |
| `scanner.js` | Camera barcode scanner: full-screen overlay, rear camera, torch, camera switch, BarcodeDetector + vendored ZXing fallback, continuous mode with 1.5 s repeat filter, beep/vibrate/flash, manual entry, Arabic errors | `BeeStore.scanner.{open,scan,scanButton,closeCurrent,isSupported,unsupportedReason,reasonMessage,normalizeCode,createRepeatFilter,REASONS,PREFERRED_FORMATS}` | `components.js`, `vendor/zxing` |

## Pages (js/pages/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `dashboard.js` | Dashboard page (cards, charts, recent invoices) | `BeeStore.pages.dashboard` | `ui/*`, `api.dashboard`, `api.reports` |
| `pos.js` | POS page (camera + USB barcode scan, continuous scanning, unknown-barcode create action, cart, discount, payments, save w/ clientKey + in-flight guard) | `BeeStore.pages.pos` | `ui/*`, `scanner.js`, `scan.js`, `api.products`, `api.variants`, `api.sales`, `api.customers`, `api.settings` |
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
| `accounts.js` | Accounts, ledger, transfers, owner tx, daily closing | `BeeStore.pages.accounts` | `ui/*`, `api.accounts`, `api.transactions`, `api.reports` |
| `reports.js` | All reports (P&L, sales, inventory, aging, balance, daily) + v2 tabs (Month Review, Profit⇄Cash, Compare, Year Overview) | `BeeStore.pages.reports` | `ui/*`, `ui/period.js`, `api.reports` |
| `periods.js` | v2 month-closing page: months table, live checklist, KPIs, close/reopen/integrity/print | `BeeStore.pages.periods` | `ui/*`, `ui/period.js`, `api.periods`, `api.reports`, `api.maintenance`, `api.backup` |
| `settings.js` | Settings page (store info, tax, invoice, sizes/colors, payment methods, backup + storage-path card, audit, maintenance + integrity check + error log) | `BeeStore.pages.settings` | `ui/*`, `api.settings`, `api.backup`, `api.maintenance`, `api.audit`, `fileSync.js` |

## Demo (js/demo/)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `demoData.js` | Load ~20 products, variants, suppliers, customers, sales, expenses, employees | `BeeStore.loadDemoData()` | All services |

## App Bootstrap (js/app.js)
| File | Responsibility | Exports | Depends On |
|------|---------------|---------|------------|
| `app.js` | Init repo, fileSync, api, wizard or start, lock, router, save-status | `BeeStore._setupRouter`, `BeeStore._setupSaveStatus`, `BeeStore._setupVisibilityHandlers` | All layers |