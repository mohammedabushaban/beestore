# BeeStore — Audit vs v1 + v2 Specs

**Date:** 2026-10-14. **Method:** read CLAUDE.md + MAP.md, read both specs fully, read all 60+ source files, ran `node --test tests/test-sales.js` (12/12 pass), `node --check` on every JS file (clean), headless Chromium load of `index.html` (shell renders, zero console JS errors — see §0.3). No code changed in this step.

**Test results:** 12 passed, 0 failed. Syntax: all files parse.

## 0. Owner-Reported Problems (v2 §15 — fix FIRST)

**None pasted.** V2 §15 items 1–3 are still placeholder (`…`). There is nothing to reproduce here. If the owner supplies reports later, each gets a regression test + CHANGELOG entry per the spec process.

## 0.1 Headless-browser check (what ran / what did not)

- Ran: `chromium --headless=new --dump-dom file:///.../index.html` twice (8s/10s virtual-time budget). Shell renders, `<html lang="ar" dir="rtl">` correct, **zero** uncaught/TypeError/ReferenceError/console-error lines.
- Could NOT verify interactively: under virtual-time budget the async `init()` (IndexedDB open) never completes — both `#app` and `#first-run-wizard` stay `display:none`, byte-identical DOM. This is the known virtual-clock/IndexedDB interaction, not an app error. **Manual double-click test in Chrome still required** (CHECKLIST §1).
- Could NOT run: `tests/smoke.html` needs a real browser session (not executed); 5,000-variant / 50,000-invoice performance test (no seed script); print output verification (no printer/PDF inspection).

## 0.2 Verdict

Architecture is sound (layers, namespace, repos, tx model) — **no rewrite**. V1 core (stock→sale→cash loop) works and is tested. V2 (monthly periods, closing/locking, hardening) is **entirely absent** — 0 hits for `assertPeriodOpen`, `periodClosings`, `systemStartDate`, `avgCostAfterMinor`, spread/prepaid, integrity checker, `escapeHtml`, `monthRange`. Plus 5 real **Broken** defects (§D) to fix first with regression tests.

**Counts:** Done ~55 | Partial ~45 | Missing ~40 (nearly all v2) | Broken 8.

## Fix log
- **2026-10-14 — B1–B8 FIXED** (see `docs/CHANGELOG.md`; 9 new regression tests in `tests/test-fixes.js`; full suite **21/21 green**). §D items B1–B8 below are now Done. Remaining: M1–M4, full v2, §13.2 scenario, remaining hardening.
- **2026-10-14 — v2 PERIODS + UI DONE** (services: dates/month fns, settings, migration v3, periods gate+checklist+close/reopen, spread/recurring, as-of balances, v2 reports, integrity checker; UI: global month selector, `/periods` closing page, 4 report tabs, dashboard period touches, Settings checker button; tests **57/57** incl. §13.2 exact-cents). Still open: full per-page scoping (§5 lists, statement open/close rows), §12.3 global error handling, §12.1 sweep items, year/custom selector modes, URL-hash persistence, §13.1 items 11–12 (double-submit test, perf test).
- **2026-10-14 — SCOPING + §12.3 + HARDENING DONE** (flow lists period-scoped w/ show-all; supplier statement + opening/closing rows on both statements; period in URL hash; global errorLog + page isolation + Settings viewer; `clientKey` double-submit guard; O(n²) index fix with §13.1.12 perf test 208ms/5ms at 5k/50k; §13.1.2 boundaries + §13.1.5 return-attribution tests; **65/65 green**).
- **2026-10-14 — YEAR/CUSTOM MODES + §12 SWEEP** (selector year/custom + hash, Eastern-digit normalization everywhere incl. CSV import, CSV formula guard, repo tx mutex w/ `Promise.all` race test, `safeWidget` isolation, POS dup merge + dead `keyboard.js` removal; **68/68 green**).
- **2026-10-15 — DASHBOARD TRUTH + FULL JSDOC + CHECKLIST**. Dashboard month KPIs now from accrual P&L (+regression test); ~90 service methods JSDoc'd; v2 manual CHECKLIST. Triaged subagent findings: returns cash fully derived in ledger (no bug), dailyClosing service is storage for UI-computed values (by design). ⚠️ A parallel worker is building payment features in the same tree (`suppliers.pay` double-count appeared and was fixed by them at 12:14; `reconcilePayments` tests still red/mid-build): re-run the suite at rest before release, and avoid same-file concurrent edits. Still open: real-printer check, remaining §12.1 classes.
- **2026-10-15 — PAYMENTS/INTEGRITY + §12.1/§12.5 CLEANUP** (full suite **90/90 green**). Payments: per-invoice دفعة button, settings-driven methods incl. جوال باي/بال باي, اسم المحوِّل + phone on invoices/payments. Fixed false `[sale-math] المدفوع غير متسق` via a tolerant check that joins linked `customerPayments` (no mirroring — that double-counted the ledger and broke §13.2). Fixed returns dialog "أدخل كمية واحدة على الأقل" (`linesDiv` never received the rows). Hardening: sale/purchase reject negative/zero quantity, negative price/cost, over-value discounts, empty lines, negative payments (§12.1 #9); barcode `<img>` instead of `innerHTML` (#6); `test-atomicity.js` rollback test (#4); settings JSDoc + unused-import sweep (§12.5). Still open: real-printer check; POD/parameter sweep for §12.5 is now clean.

---

## A. V1 spec audit (BeeStore-Project-Spec.md)

### A1. Technology (§2) & structure (§3)

| Req | Status | Files | Notes |
|---|---|---|---|
| Chrome/Edge primary + banner on other browsers | Done | `app.js`, `index.html` | Feature-detects indexedDB/showDirectoryPicker/locks |
| Double-click `index.html`, no build | Done | `index.html` | Verified |
| Vanilla JS, no frameworks | Done | all | Chart.js + JsBarcode vendored, Cairo vendored |
| Classic scripts, IIFE, `window.BeeStore`, Node exports | Done | all `js/**` | All files wrap + export |
| No `fetch` of local files, no CDN | Done | — | No fetch/CDN refs |
| IndexedDB working store, FSA JSON mirror | Done | `idbRepository.js`, `fileSync.js` | — |
| `node --test` | Done | `tests/test-sales.js` | 12/12 pass |
| README static-server fallback note | Missing | `README.md` | Only Chrome/Edge mentioned, no `python -m http.server` fallback |
| Folder layout per §3 | Partial | root | Stray `DB/db.json` (18K, mode 600) + `docs/db.json` (152K) data files in repo; `files/` duplicates the specs |

### A2. Architecture rules (§4)

| Req | Status | Files | Notes |
|---|---|---|---|
| 4.1 UI talks only to `BeeStore.api` | **Broken** | `pages/accounts.js:117,144` (`BeeStore.repo.list`), `pages/pos.js`, `returns.js`, `employees.js`, `accounts.js`, `expenses.js` (`BeeStore.settings.get`), `pages/products.js` (`BeeStore.csv.*`), `pages/settings.js` (`BeeStore.fileSync`) | Must route via facade |
| 4.2 Services pure JS | Partial | `services/sales.js`, `purchases.js`, `payroll.js` etc. | Logic is DOM/IDB-free, but calls `BeeStore.settings.resolvePaymentAccount` via global singleton instead of injected pure fn |
| 4.3 Repository interface | Done | `storage/repository.js` + 2 impls | All 8 methods present |
| 4.4 Load-to-memory + unit-of-work | Done | `memoryRepository.js`, `idbRepository.js` | Staged writes, single IDB tx, rollback on throw |
| 4.5 One tx per posting | Done | all services | Each create/void/pay = one `repo.transaction` |
| 4.6 No hard deletes | **Broken** | `services/expenses.js:79-83` (`remove` → `tx.remove`), `services/categories.js:42-50` (`remove` → `tx.remove`) | Must become void/deactivate |
| 4.7 Line snapshots (name/size/color/price/**cost**) | Done | `services/sales.js:53-65` | `unitCostMinor` snapshotted |
| 4.8 Prefixed IDs + counter numbers | Done | `core/ids.js`, services | `INV-/PUR-/RET-000123` via `tx.nextCounter` |
| 4.9 Money minor units | Partial | `core/money.js`, `pages/pos.js:342-364` | Services clean; POS duplicates total math in UI for display (service recomputes — display drift risk) |
| 4.10 Dates: `YYYY-MM-DD` + UTC stamps, Western digits | Partial | `core/dates.js` | `today()` local ✓. BUT `parseDate` uses `new Date('YYYY-MM-DD')` (= UTC midnight) then `formatDate` reads **local** parts → off-by-one for negative-UTC users. `addMonths` uses `Date` month arithmetic (v2 forbids) |
| 4.11 `{ok, data\|error}` envelope | **Broken** | `js/api/api.js` | Facade does `ok(await …)` with **no try/catch** — service throws become rejected promises, not `{ok:false}`. Every page `await`s without catch → silent unhandled rejection, no toast |
| 4.12 `schemaVersion` + migrations | Partial | `core/namespace.js` (=2), `storage/migrations.js` | Only trivial v1→v2 (`returnStatus`); `docs/DATA_FORMAT.md` still documents version 1 (stale) |
| 4.13 Single tab (locks + fallback) | Partial | `js/app.js:152-165` | Lock + blocked message ✓; BroadcastChannel fallback missing |
| 4.14 localStorage UI-prefs only | Done | — | No localStorage use at all |

### A3. Data model (§5)

| Req | Status | Files | Notes |
|---|---|---|---|
| 5.1 settings (all 25+ fields) | Done | `services/settings.js:5-47` | All spec fields present |
| 5.2 accounts | Done | `services/accounts.js` | Seeded cash+bank via `ensureDefaults` |
| 5.3 categories | Done | `services/categories.js` | — |
| 5.4 products | Done | `services/products.js` | incl. `imageDataUri` |
| 5.5 variants + grid generation + barcodes | Partial | `services/products.js:87-109`, `variants.js`, `pages/products.js` | Service `createWithGrid` exists but **no UI** uses it; single-variant dialog only |
| 5.6 stockMovements ledger + recalc + test | Done (v1) | `services/stock.js`, tests | `avgCostAfterMinor` is v2 (missing) |
| 5.7 customers + derived balance | Done | `services/customers.js:46-59` | — |
| 5.8 sales (all fields) | Done | `services/sales.js` | — |
| 5.9 installmentPlan + rounding-last | Done | `services/sales.js:183-208` | Remainder in last installment ✓ |
| 5.10 customerPayments FIFO + credit | Done | `services/customers.js:72-125` | FIFO oldest-first + installment order ✓; excess-credit path implicit |
| 5.11 salesReturns + exchange | Done | `services/returns.js` | restock/damaged flag ✓, 3 refund modes ✓, exchange sale ✓ |
| 5.12 suppliers | Done | `services/suppliers.js` | — |
| 5.13 purchases + weighted-avg + inline create | Partial | `services/purchases.js`, `pages/purchases.js` | Avg-cost formula ✓. **No inline new-product/variant creation** in purchase form; purchase dialog is **single-line only** (service supports `lines[]`) |
| 5.14 purchaseReturns + supplierPayments | Partial | `storage/repository.js` | `purchaseReturns` collection exists but **no service, no facade, no page**. Supplier FIFO pay ✓ |
| 5.15 expenseCategories + expenses + recurring | Partial | `services/expenses.js` | Defaults seeded? Only via demo (3 cats) — first-run does NOT seed the 10 spec defaults. Recurring = basic template (v2 fields missing) |
| 5.16 employees | Done | `services/employees.js` | — |
| 5.17 payroll (net formula, no dupes via prepare-skip, auto expense) | Partial | `services/payroll.js` | Formula in `update()` ✓ but **`pay()` double-deducts advances** (see §D-B1). Duplicate-month blocked only by prepare-skip, no hard guard |
| 5.18 employeeAdvances | Done | `services/payroll.js:135-151` | Cash-out, repaid via payroll ✓ |
| 5.19 ownerTransactions + transfers | Done | `services/transactions.js` | — |
| 5.20 ledger `getLedger(accountId, range)` | Partial | `services/accounts.js:99-193` | All sources covered, chronological + running balance ✓; **no opening-balance row** for ranged queries; void-reversal implicit only |
| 5.21 auditLog events | Partial | `services/audit.js` | void/return/adjust/stocktake/pay ✓; **price-cost edits, backup/restore, settings change, deactivation NOT logged** |
| 5.22 dailyClosings + edit rule | Partial | `services/transactions.js:44-68` | Record ✓; same-day/owner+audit edit rule **not enforced** |

### A4. Business rules (§6)

| Req | Status | Files | Notes |
|---|---|---|---|
| 6.1.1 barcode/name/SKU/product→size→color add | Done | `pages/pos.js` | — |
| 6.1.2 merge identical variants | Done | `pages/pos.js:266-276` | — |
| 6.1.3 stock validation w/ item name | Done | `services/sales.js:47-49`, POS client check | — |
| 6.1.4 line + invoice discounts, capped | Done | `services/sales.js:68-77` | — |
| 6.1.5 warn (not block) price < cost | **Missing** | `pages/pos.js`, `services/sales.js` | No warning anywhere |
| 6.1.6 split payments; paid/partial/unpaid; credit needs customer; change capped | Done | `services/sales.js:95-118` | POS shows negative due as "الباقي للزبون" ✓ |
| 6.1.7 installments (customer required) | Partial | `services/sales.js:145-147` | Service builds plan, but **POS has no installment UI** — plan can never be created from the app |
| 6.1.8 single-tx save | Done | `services/sales.js:37-181` | — |
| 6.1.9 print preview + New-invoice; POS shortcuts; touch targets | Partial | `pages/pos.js` | Print *button* (no auto preview); shortcuts F2/F4/Ctrl+Enter/Esc ✓; **duplicate `_setupKeyboardShortcuts`** (lines 195 vs 223, second silently wins — dead code) |
| 6.2 void w/ reason, reverses stock+payments, stays visible, blocks if returns | Partial | `services/sales.js:210-266` | Reason ✓, stock ✓, exclusion-from-totals ✓, returns-block ✓. Payment reversal only implicit (void excluded from ledger) — no explicit refund movements |
| 6.3 returns (qty cap, restock/damaged, 3 modes, updates) | Done | `services/returns.js`, `pages/returns.js` | — |
| 6.4 purchase void only if stock stays ≥ 0 | Done | `services/purchases.js:117-123` | — |
| 6.5 adjustments w/ reason; stocktake page + count sheet; losses in P&L | Done | `services/stock.js`, `pages/stocktake.js`, `services/reports.js:46-54` | — |
| 6.6 customer statement + overdue w/ `tel:`/WhatsApp | Partial | `pages/customers.js`, `services/customers.js` | Statement (invoices+payments) ✓ but **no opening/closing rows** (v2 also needs); overdue list exists in service only — **no dashboard phones/`tel:`/WhatsApp UI** |
| 6.7 supplier page: balance, invoices, pay button | Partial | `pages/suppliers.js` | No balance shown, no invoice list, pay dialog lacks date/account/purchase choice |
| 6.8 low stock (override→default), dashboard card, list, reorder print | Partial | `services/variants.js:122-134`, `pages/products.js` | Card + list ✓; **printable reorder list missing** |

### A5. Reports (§7)

| Req | Status | Files | Notes |
|---|---|---|---|
| P&L per spec formula | Partial (**Broken** salary part) | `services/reports.js:10-74` | Net sales/COGS/gross ✓. **Salary = `netMinor` of *paid only*** — must be `base+bonus+overtime−deductions` for *all* records in month (accrual, §D-B2) |
| Date presets + CSV export + print on all reports | **Missing** | `pages/reports.js` | Only custom from/to; **zero CSV-export buttons** on any report tab |
| 1 sales report (day/product/category/size-color/employee/payment/customer; best+slow) | Partial | `services/reports.js:76-92` | Only day/customer/payment groupings |
| 2 profit per product/category | **Missing** | — | — |
| 3 inventory valuation | Done | `services/reports.js:94-103` | cost/retail/potential ✓ |
| 4 stock movement history per variant | Partial | `services/stock.js:10-14` | Service ✓, **no UI** (products stock tab shows levels only) |
| 5/6 aging receivables/payables | Done | `services/reports.js:105-147` | 0-30/31-60/61-90/90+ ✓ |
| installments upcoming/overdue | Partial | `services/customers.js:142-167` | Overdue service ✓, **no report UI** |
| 7 cash & accounts (balances, statement, cash-flow summary) | Partial | `pages/accounts.js` | Balances + statement ✓; **cash-flow in/out-by-source missing** |
| 8 expenses by category+month + chart | **Missing** | — | Only raw expense list |
| 9 payroll per month/employee + advances outstanding | Partial | `pages/employees.js` | Raw lists only; no month filter on list, no report layout |
| 10 balance snapshot, must balance | Done (v1 formula) | `services/reports.js:149-216` | Balances; v2 formula (prepaid/accrued/tax) pending |
| 11 daily closing + print | Done | `services/reports.js:218-243`, `ui/print.js` | — |
| Dashboard per spec | Partial | `services/dashboard.js`, `pages/dashboard.js` | Today/month/cash/stock/receivables/payables/low/overdue-count/charts/top5/recent ✓. **Missing:** vs-previous-month arrows, payroll status, recurring-due reminder, 12-month chart |

### A6. Pages (§8, 14 entries)

All 14 pages exist. Gaps: invoices lack date/customer filters (§8.3); purchases single-line + no inline product (§8.7); labels print **text-only barcode, no Code128 image** (§8.6, §D-B5); settings lacks tax-rate/sizes/colors/payment-methods/label-size/thresholds/allowNegativeStock/backupKeep/audit-viewer/re-link (§8.14); stocktake is a separate nav item (spec folds it under products — harmless).

### A7. UI/UX (§9)

RTL/Western-digits ✓, brand `#F5B700` ✓, responsive ✓, wizard ✓, save indicator ✓, toasts/confirms/empty-states ✓, invoice A4+80mm ✓, focus/keyboard basics ✓. Partial/Missing: list sorting/pagination (search-only filtering), inline validation (dialogs validate on save), unsaved-changes warning, `tel:` links, logo on invoice, label `@page` exactness unverified.

### A8. Facade (§10) — namespaces

`settings accounts categories products variants stock sales returns customers suppliers purchases expenses employees payroll transactions reports dashboard backup maintenance audit` ✓. **Missing:** `purchaseReturns`, `advances` (lives under `payroll`), `import`/`export`, `loadDemoData`. Spec §10 names `expenseCategories`, `recurringExpenses`, `ownerTransactions`, `transfers`, `dailyClosing` as namespaces — implemented nested (`expenses.categories`, `transactions.*`) — acceptable aliasing, document in API.md.

### A9. Data safety (§11)

IDB + persist() ✓, folder mirror debounced + visibility/pagehide ✓, permission flow ✓, manual download ✓, restore-from-file ✓. **Missing:** auto first-commit-of-day backup, `backupKeep` pruning, rolling IDB snapshots, backup reminders, **startup consistency check** (file-vs-IDB revision dialog), backups-list/restore-from-backup UI, corruption screen (blank-page risk). Reset path takes **no safety backup** (spec requires).

### A10. Demo & reset (§12)

Demo loads (10 products not ~20, 2 suppliers ✓, 3 customers not 5, **no installment/overdue customer**, random 30d sales, **no purchases**, 2 expense cats, 2 employees not 3, **no paid month**, 1 advance ✓). Reset requires typed word ✓ but **no pre-backup**.

### A11. Tests (v1 §14)

| Req | Status | Notes |
|---|---|---|
| 1 sale deducts stock / over-sell rejected + nothing persisted | Done | tests 1–2 |
| 2 weighted-avg cost; COGS snapshot | Partial | avg formula ✓ (test 3); snapshot-after-cost-change **not tested** |
| 3 void restores + excluded | Done | test 4 |
| 4 partial/full/exchange/damaged; cap | Partial | partial ✓ (test 7); full/exchange/damaged/over-cap **not tested** |
| 5 credit + FIFO + overpay→credit | Partial | FIFO ✓ (test 8); overpay→credit **not tested** |
| 6 installments rounding + overdue | Partial | rounding ✓ (test 9); overdue status **not tested** |
| 7 purchase + partial supplier pay + FIFO | **Missing** | No purchase/supplier service tests |
| 8 payroll net + advance limits + dup-month + salary-in-P&L | Partial | net ✓ (test 10); limits/dup/P&L **not tested** |
| 9 P&L hand-computed + snapshot balances | Done | tests 11–12 |
| 10 qty = Σ movements after random ops | Done | test 6 |
| 11 atomicity incl. storage-commit failure | **Missing** | Only throw-rollback implicitly; no commit-failure test |
| 12 export→modify→import identical; old-version migration; round-trip | Partial | round-trip ✓ (test 5); modify-identical + migration **not tested** |
| `smoke.html` scripted IDB scenario | Partial | 6 trivial checks only |
| Worked example as acceptance test | **Missing** | Not automated |

### A12. Docs

`API.md` ✓ (v1 methods; aliases + missing namespaces undocumented), `DATA_FORMAT.md` stale (v1), `PHASE2_MIGRATION.md` ✓, `CHECKLIST.md` ✓, `README.md` Partial (Arabic ✓, short; **no monthly-closing guide, thin Decisions**), `CHANGELOG.md` **missing**, `AUDIT.md` this file.

---

## B. V2 spec audit (v2 wins on conflict)

| V2 section | Status | Notes |
|---|---|---|
| §1 flow/balance/current separation | **Missing** | No period concept anywhere |
| §2 month key, `dates` fns (`monthOf`, `monthRange`, `addMonths(month,n)`, `daysInMonth(month)`, `isSameMonth`, `compare`, injectable clock), local `today()`, `systemStartDate`, `blockFutureDates`, per-document date validation | **Missing** (today-local ✓ only) | `dates.js` has none of the month fns; no start-date; **no form in the app lets the user pick a document date** (sale/purchase/expense/return/payment/advance/transfer/owner all force today) |
| §3 global period selector (header ◀ month ▶, dropdown, year/custom, URL hash, scope label, 🔒 badge, default-date rule) | **Done** | `ui/period.js` (month/year/custom modes, hash `?m/?y/?from&to`, prefs + in-memory fallback), `ui/router.js`, header widget, scope bars, period-aware default dates (POS, expense, customer/supplier payments) |
| §4 profit-month vs cash-month table | **Done** | Service layer implements §4; Month Review help text explains stock≠expense |
| §5 page scoping (flows / as-of / current) + statement open/close rows | **Done** | Invoices/purchases/purchase-returns/returns/expenses auto-scoped w/ show-all toggle; customer + supplier statements period-scoped w/ opening/closing rows; customers/suppliers product lists stay current-state per spec |
| §6.1 one-time expense + void w/ reason in open month | **Missing** | Hard delete, no reason |
| §6.2 recurring (start/end/lastGenerated/effectiveFrom, idempotent `(recurringId,month)`, banner, no silent post) | **Missing** | Basic template only; `generateRecurring` keys on date-prefix, no month field |
| §6.3 spread expenses + prepaid asset | **Missing** | No allocation model |
| §6.4 no-double-count (reserved names, read-only salary/stock-loss lines) | **Missing** | No guards, no read-only lines |
| §6.5 period expenses page (total, by-category+chart, prev-month Δ, filters, CSV, generate btn, spread shares) | **Missing** | Raw list only |
| §7 closing workflow, checklist page, ordered closing, snapshot tx + pre-backup, `assertPeriodOpen` in **every** posting tx, settlement-today rule, reopen-latest-only | **Done** | `/periods` page: live checklist (§7.2 incl. daily-closing/stocktake/overdue rows), ordered closing enforced in service + tx, snapshot + audit, backup taken by UI before close, typed-confirmation reopen-latest |
| §8 as-of balances (`avgCostAfterMinor`, account/customer/supplier/prepaid/accrued/advances/tax/equity as-of, new snapshot equation) | **Missing** | Current-only balances |
| §9.1 Month Review | **Done** | Reports tab: KPIs, P&L vs prev/%/last-year, expenses by category, cash flow, balances open→close, top-10, customers/payroll + stock≠expense help text + print |
| §9.2 Year Overview | **Done** | 12 monthly columns + total + status row + best/worst |
| §9.3 Profit⇄Cash reconciliation | **Done** | Formula walk + matches badge; §13.2-tested |
| §9.4 Compare Months | **Done** | Side-by-side P&L + diffs + category diffs |
| §9.5 period-aware dashboard | **Done** | Prev-month arrows, selected-month strip, recurring banner, payroll status. Month KPIs now sourced from accrual P&L (single source of truth — spread + salary accrual included), regression-tested |
| §10 model changes (+ migration, schema bump) | **Missing** | None applied |
| §11 facade changes (`{from,to}` everywhere, new methods, envelope, API.md) | **Missing** | — |
| §12.1 bug classes 1–15 | Partial | #1 done (local today ✓ + TZ/midnight test + boundary tests; no UTC-slice remains), #2 done (no parseFloat; all /100 rounded; toFixed display-only), others **open** — see §D. **Fixed:** #3 double-submit (POS in-flight guard + `clientKey` idempotency + repo tx mutex — even `Promise.all` same-key posts once; single-tab lock covers cross-tab), #5 Arabic-Indic digits (`money.normalizeDigits`, 24 entries → `fromMajor`, POS qty/discount, CSV import), #7 CSV formula prefix, #11 O(n²) index rebuilds → once-per-commit (§13.1.12: 208ms/5ms), #13 print wrapping/page-break rules + builder tests (A4/80mm/labels; real-printer check still manual), #14 POS focus verified (Enter blocked + refocus; scanner never submits), #15 keyboard dup merged + dead `keyboard.js`/`formatNumber` removed |
| §12.2 Integrity Checker | **Done** | 9 checks; blocks closing; UI in `/periods` + Settings → Maintenance |
| §12.3 error handling (`window.onerror`, dialog + copy button, 200-error log, per-widget isolation, typed codes) | **Done** | `ui/errorLog.js` + route-level isolation + `ui.safeWidget` (dashboard) + Settings viewer/diagnostics; typed codes already used service-wide |
| §12.4 UX polish | Partial | Base polish exists; tooltips, sticky headers, export-everywhere, help texts missing |
| §12.5 code quality (JSDoc/service, no dead code, constants) | Partial | JSDoc on ALL services incl. `settings` (~100 methods); removed dead `keyboard.js`, `formatNumber`, `refs.totalsDiv`; service qty/day inputs digit-normalized; remaining: unused `refs`/params sweep completion |
| §13.1 period tests (12 items) | **Done** | `test-dates/periods/expenses/asof/reports/integrity/scoping/hardening.js`: boundaries, idempotent recurring, spread/prepaid, Nov-return attribution, payroll accrual vs cash, ordered closing + locks + reopen + snapshot equality, snapshot-every-month + reconciliation, checker failing-cases, migration, double-submit (§13.1.11), 5k/50k perf (§13.1.12: 208ms/5ms) |
| §13.2 acceptance scenario (exact cents) | **Done** | `tests/test-acceptance.js` passes to the cent; full suite 57/57 |

---

## C. Document dates forced to today (cross-cutting, v1 §4.10 + v2 §2)

No date input on: POS sale, purchase, expense, return, customer payment, supplier pay, advance, owner tx, transfer, stock adjust/stocktake, payroll `pay()` (`paidDate` forced). Only daily-closing and report filters accept dates. Fix: add date fields + validation (`systemStartDate` ≤ date ≤ today unless allowed, open month) once v2 lands.

## D. Defect list (severity · file/function · root cause · fix plan)

**B1 FIXED — Critical — payroll `pay()` deducts advances twice.** `services/payroll.js:74-96`: after the FIFO loop, leftover `repayment` is re-deducted as `extraDeduction` AND full requested amount is added to `advanceRepaymentMinor`, while advances only absorbed the applied part. Fix: `net = salaryExpense − appliedTotal`; persist `appliedTotal`; test: partial-coverage advance.
**B2 FIXED — Critical — P&L salary is cash, not accrual.** `services/reports.js:14,38-44`: only `status==='paid'` included, sums `netMinor` (advance repayments reduce it). Spec: all records of month, `base+bonus+overtime−deductions`. Fix + test (unpaid month still accrues; advance repayment doesn't move P&L).
**B3 FIXED — Critical — facade never returns `{ok:false}`.** `js/api/api.js`: no try/catch. Fix: wrap every method → `fail(code,message)`; keep `BeeError.code`. Regression test: failing call resolves (not rejects).
**B4 FIXED — Critical — expenses hard-deleted.** `services/expenses.js:79-83` (+ `categories.js:42-50`). Fix: `voided/voidReason` (+ `active:false` for categories); update pages; test void-excluded-from-totals.
**B5 FIXED — Major — label sheet has no barcode image.** `js/ui/print.js:102-130` prints barcode digits as text; `barcode.js` never used for labels. Fix: render Code128 (canvas→dataURL) per label; verify print.
**B6 FIXED — Major — variant barcode uniqueness not enforced on update.** `services/variants.js:109-120` (create checks, update doesn't). Fix: duplicate check excluding self; test.
**B7 FIXED — Major — reset/demo-load without safety backup.** `services/maintenance.js:33-36`, `pages/settings.js:241-254`, `demoData.js`. Fix: folder-backup + file-download before destructive action (typed confirm kept; audit log is wiped by reset itself, so no entry possible).
**B8 FIXED — Major — XSS surface.** No `escapeHtml`; print-template string building interpolated raw user text (`ui/print.js`). Fix: central `escapeHtml` applied to all print templates (invoice/labels/daily-closing); `el()`-built DOM was already safe (text nodes). Test with `<img onerror>`/`<script>` payloads. Remaining `innerHTML` uses are app-owned strings (no user data).
**M1 Missing — purchase-return flow** (collection only). Add service/facade/page or descope in README Decision.
**M2 Missing — user-editable document dates + validation** (§C).
**M3 Missing — all v2 period scope/closing/reports/checker/hardening** (§B).
**M4 Minor — POS dead duplicate `_setupKeyboardShortcuts`** (`pages/pos.js:195-246`); **stale `DATA_FORMAT.md`**; **stray `DB/db.json`, `docs/db.json`, `files/` dupes**; invoice `refundMethod` field actually stores accountId (rename at schema bump).

## E. Fix order (Steps 2–3)

1. B1–B4 + regression tests (money correctness + envelope).
2. B5–B8 + tests.
3. M2 dates, M1 purchase-returns decision, Partial-page gaps (filters, installments UI, supplier statement, exports).
4. V2 periods (§2–§11) module by module, each green before next.
5. Hardening §12 + checker + §13 tests incl. §13.2 scenario.
6. Docs: CHANGELOG, API/DATA_FORMAT/CHECKLIST updates, README monthly-closing guide + Decisions; MAP.md + CLAUDE.md lines.
