# BeeStore — Agent Working Reference

> **Read this before exploring the codebase.** It is the fast path; do not re-read
> every file for routine changes. Per-file responsibility table: `docs/MAP.md`.
> API endpoint list: `docs/API.md`. Task state / next milestone: `CLAUDE.md`.
> Accounting rules/spec: `docs/specs/BeeStore-v5-Accounting-Core.md`.

## 1. What this project is

Offline-first Arabic (RTL) PWA for a small retail store. Vanilla JavaScript,
**no bundler and no build step**: every file is an IIFE that attaches to the
global `BeeStore` namespace, loaded in order from `index.html`. Data lives in
IndexedDB (`beestore`), with an optional JSON file mirror. Accounting is
double-entry (v5 journal) with a document-derived fallback.

- App version: `3.6.0-lite`; `schemaVersion` 10; `dbVersion` 10; summary
  `VERSION` 11 (payment-method clearing balances). Confirm in
  `js/core/namespace.js`, `js/storage/idbRepository.js`,
  `js/storage/summary.js`.
- Money is **always integer minor units** (agorot). `₪ 12.34` → `1234`.
  Format only at the UI via `BeeStore.money.format(minor)` → `"12.34 ₪"`.
  There are **no thousands separators** in the formatter.
- Dates are local business dates `YYYY-MM-DD`; months `YYYY-MM`. Never use
  `Date` string slicing directly — use `BeeStore.dates`.

## 2. Golden rules

1. **Pages never touch storage.** They call `BeeStore.api.<namespace>.<method>()`
   and receive `{ ok, data }` or `{ ok: false, error }`. Never call
   `BeeStore.<service>.repo` from a page.
2. Keep UI strings Arabic and RTL. Keep number/date formatting through
   `BeeStore.ui.formatMoney` / `formatDate` / `formatDocDate`.
3. A change to any shipped file requires regenerating the service worker:
   `node scripts/build-sw-list.js` (rewrites `sw.js`; never hand-edit its
   generated block).
4. Run the Node suite after logic changes:
   `node --test --test-concurrency=1 tests/*.js`
   (last known green: 38 files / 270 tests). Browser suites are under
   `tests/*.html`; offline verifier `tests/verify-offline.py`.
5. Preserve repository atomicity: document write + `summary.apply` + journal
   posting happen inside the same transaction. Do not introduce partial writes.
6. The cashier profile is restricted centrally in `js/api/api.js`
   (allow-list + sensitive-key stripping). Do not enforce roles in pages.

## 3. Layer map and load order

`index.html` loads, in this order:

```
js/core/*            namespace, config, money, dates, ids, validate, errors, chartSeed
js/storage/*         repository, summary, memoryRepository, idbRepository, migrations, fileSync
js/services/*        domain + posting + reports + dashboard + backup + maintenance
js/api/api.js        facade envelope, permissions, cashier stripping
js/ui/*              router, components, dialogs, print, lock, firstRun, period, scanner, ...
js/pages/*           one render() per screen
js/app.js            bootstrap (repo open, api, router, wizard, replay, PWA)
```

Key entry points:

- Bootstrap: `js/app.js` → `BeeStore._init` / `_start`.
- Routing table: `js/app.js` (`/reports`, `/dashboard`…).
- UI primitives: `js/ui/components.js` (`el`, `formatMoney`, `safeWidget`…).
- Global period selection: `js/ui/period.js`
  (`BeeStore.period.get/selMonth/getRange`, persisted in `localStorage`).
- Facade: `js/api/api.js`.

## 4. Storage, summary and reporting sources

### 4.1 Repository

- Interface + collection list + storage policy: `js/storage/repository.js`.
- IndexedDB implementation: `js/storage/idbRepository.js`.
- In-memory implementation (tests, diagnostics): `js/storage/memoryRepository.js`.
- Read helpers: `list`, `listRange(collection, from, to, predicate)`, `query`,
  `latest`, `get`, `getSummary`.

### 4.2 Materialized summary (important)

`js/storage/summary.js` keeps all-time totals and per-month buckets, updated in
the same transaction as each document. It is the performance source for
dashboard balances and whole-month P&L.

- `summary.apply(summary, collection, oldDoc, newDoc)` — incremental update.
- `summary.compute(collections)` — full rebuild.
- `summary.pnlRange(summary, fromMonth, toMonth)` — whole-month P&L totals.
- `summary.accountBalanceAt`, `customerTotals`, `supplierTotals`,
  `unpaidExpensesThrough`, `overdue`.

Per-month P&L bucket fields include: `netSales`, `cogs`, `salaryExpense`,
`employerExpense`, `endOfServiceExpense`, `depreciationExpense`,
`assetSaleGain`, `assetSaleLoss`, `stockLosses`, `stockRevaluation`,
`cardFees`, `otherIncome`, `expensesTotal`, `spreadExpenses`,
`cashDifference`, `expensesByCategory`.

### 4.3 The important routing switch in `ReportsService.profitAndLoss`

`js/services/reports.js`:

```
profitAndLoss(from, to, options)
  → journal route if journal approval is active and replay is OK
  → otherwise document route:
       full calendar month (from = startOfMonth, to = endOfMonth)
         → summary.pnlRange(...)          // fast, materialized
       any partial range (e.g. month-to-today)
         → direct scan of sales/returns/expenses/payroll/stock/... // legacy
```

- Journal route gate: `_journalReportsActive()` requires
  `meta.journalApproval.status === 'approved'` and a healthy `meta.journalReplay`.
- `options.legacy: true` forces the document scan.
- `options.journal: true` forces the journal route.

This means the **same month can be served by three paths** (summary, document
scan, journal). They are intended to match; if a KPI looks wrong, compare them
before changing formulas. A ready-made comparison tool:
`node scripts/diagnose-pnl.js [db.json] [YYYY-MM]`.

### 4.4 P&L formulas (document and summary routes)

```
netSales         = sales(total - tax) - return refunds
cogs             = sale line cost - restocked return cost
grossProfit      = netSales - cogs

operatingExpenses =
    expensesTotal            // single + spread shares, excluding "رواتب"
  + salaryExpense + employerExpense + endOfServiceExpense
  + depreciationExpense
  + assetSaleLoss - assetSaleGain
  + stockLosses + stockRevaluation   // signed: a gain becomes negative expense
  + cardFees
  - cashDifference                   // positive surplus REDUCES expenses
netProfit        = grossProfit + otherIncome - operatingExpenses
```

**Why "المصاريف" can appear negative** (e.g. `-6245.00 ₪`):
`cashDifference` is signed (`counted - expected`; positive = زيادة صندوق) and is
subtracted, while `stockLosses` / `stockRevaluation` become negative on count
gains or value increases. A month with no recorded expenses and a positive cash
surplus therefore reports a negative operating-expense total by design.
This is not a data corruption; inspect the breakdown first:
`cashDifference`, `stockLosses`, `stockRevaluation`, `expensesTotal` in the P&L
result (or run the diagnostic script).

**Presentation split (same signed total, added for the KPI labels):**

```
expensesBeforeGains =
    expensesTotal + salaryExpense + employerExpense + endOfServiceExpense
  + depreciationExpense + assetSaleLoss + cardFees
  + max(stockLosses, 0) + max(stockRevaluation, 0) + max(-cashDifference, 0)
gains =
    assetSaleGain + max(cashDifference, 0)
  + max(-stockLosses, 0) + max(-stockRevaluation, 0)
operatingExpenses = expensesBeforeGains - gains   // identical to the formula above
```

All three routes (document, `summary.pnlRange`, journal) return the same
`expensesBeforeGains` / `gains` fields via `BeeStore.summary.expenseSplit()`.
Month Review displays `kpis.grossExpenses` under "إجمالي المصاريف" and shows
`kpis.gains` as "أرباح/فروقات (تُخصم)" when non-zero. `kpis.expenses` stays the
signed `operatingExpenses` for backward compatibility. The dashboard card and
chart still use the signed net line.

## 5. KPI source map — where screen numbers come from

### 5.1 Dashboard (`الرئيسية`)

- Page: `js/pages/dashboard.js` → `render(container)`.
- Data: `BeeStore.api.dashboard.get()` →
  `DashboardService.get()` in `js/services/dashboard.js`.
- Month KPI block:
  - `monthStart = dates.startOfMonth(today)`
  - `pnl = await BeeStore.reports.profitAndLoss(monthStart, today)`
  - `month.revenue = pnl.netSales`
  - `month.grossProfit = pnl.grossProfit`
  - `month.expenses = pnl.operatingExpenses`
  - `month.netProfit = pnl.netProfit`
  - Because the range is **month-start → today** (not month-end), this uses
    the direct document scan unless the journal route is active.
- "مبيعات اليوم" / today profit: computed inline in `DashboardService.get()`
  from today's sales and returns (net of refunds), not from the P&L.
- Receivables/payables/account balances/overdue: from
  `repo.getSummary()` (`summary.receivablesMinor`, `payablesMinor`,
  `summary.balance`, `summary.overdue`).
- Inventory cost/retail: from variants (`valueMinor` / `costMinor` × quantity).
- Cashier profile gets `cashierSummary()` instead (no cost/profit/month data).
- **Gotcha:** the dashboard KPI cards always show the **current** month. The
  global period selector only adds the "الشهر المحدد" strip when the selected
  month is not the current month. Do not assume the cards follow the selector.

### 5.2 Reports (`التقارير`)

Page: `js/pages/reports.js`.

- **تقرير الشهر** (`_renderMonth`) → `api.reports.monthReview(month)` →
  `ReportsService.monthReview` in `js/services/reports.js`.
  - Month is `mInput.value`, initialized from `BeeStore.period.selMonth()`.
  - KPI cards: `k.netSales`, `k.grossProfit`, `k.grossExpenses` (shown as
    "إجمالي المصاريف"), `k.gains` (shown as "أرباح/فروقات تُخصم" when non-zero),
    `k.netProfit`. `k.expenses` remains the signed `pnl.operatingExpenses` for
    backward compatibility.
  - Full-month range → normally `summary.pnlRange` (or journal route).
  - The P&L comparison table uses `pnl.previous` and `pnl.lastYear`.
  - "المصاريف حسب التصنيف" uses `pnl.expensesByCategory` plus automatic rows
    for salaries and stock losses.
- **قائمة الدخل** (`_renderPnL`) → `api.reports.profitAndLoss(from, to)` with
  editable date inputs (default month-start → today). Shows the line-by-line
  breakdown, including `cashDifference` as عجز/زيادة.
- **الربح ⇄ النقد** (`_renderRecon`) → `reports.profitCashReconciliation`.
- **مقارنة شهرين** → `reports.compareMonths`; **نظرة سنوية** →
  `reports.yearOverview`.
- **الميزانية** → `reports.balanceSnapshot(asOf)`; **ميزان المراجعة** →
  `journal.trialBalance`; **دفتر الأستاذ** → `journal.generalLedger`;
  **دفتر اليومية** → `journal.list`.
- **المبيعات / تقييم المخزون / الأعمار** → the matching `reports.*` methods.

Other places that consume the same P&L:

- `js/pages/periods.js` — month-closing KPI cards.
- `js/services/monthReviewPdf.js` and `js/services/accountingPackage.js` —
  printed/exported Month Review.
- `js/services/periods.js` — close snapshot.

When changing a P&L field, update **all** of: document route, summary bucket
(`summary.js` contribution + `pnlRange`), journal route
(`_journalPnlFromContext`), monthReview, PDF/package, and the parity key list
(`_pnlDifferences`).

## 6. Accounting / journal essentials

- Chart seed and account mapping: `js/core/chartSeed.js`.
- Journal service: `js/services/journal.js` (append-only, gapless `JE-000001`,
  exact reversals, trial balance).
- Posting/replay: `js/services/posting.js` (every document flow posts inside
  its transaction; `replayAll()` is idempotent).
- Journal approval/parity: `ReportsService.parityReport`,
  `approveJournal`, `journalReportStatus`.
- Account codes used by report math: `4010` revenue, `4020` returns, `4100`
  other income, `5010` COGS, `5020` inventory loss, `5030` revaluation,
  `6100` salaries, `6110` employer, `6120` end of service, `6200` card fees,
  `6300` depreciation, `6350` asset-sale loss, `6400` cash shortage.

## 7. Common change recipes

| Task | Touch these files |
|---|---|
| Add/change a dashboard card | `js/services/dashboard.js` (data), `js/pages/dashboard.js` (render), test in `tests/test-reports.js` |
| Change a month KPI | `js/services/reports.js` (+ `summary.js` if whole-month), PDF/package, tests |
| Change an expense sign/rule | `summary.js` contribution, `reports.js` document formula, `posting.js` journal entry, `_journalPnlFromContext`, tests |
| Add an API method | service method returning `{ok, data}` → bind/wrap in `js/api/api.js` → use from page |
| Add a collection/field | `repository.js` collection/index list → migrations → both repos → summary contribution |
| Add a UI page | `js/pages/<name>.js` → script tag in `index.html` → route in `js/app.js` → `scripts/build-sw-list.js` |
| Change labels only | the relevant page/service; Arabic RTL; no accounting change |

## 8. Diagnostics

- Compare reporting paths for a month from an exported backup:
  `node scripts/diagnose-pnl.js DB/db.json 2026-10`
- Browser console: `await BeeStore.api.reports.profitAndLoss('2026-11-01', '2026-11-30')`
  and inspect `operatingExpenses`, `cashDifference`, `stockLosses`,
  `stockRevaluation`, `expensesByCategory`.
- Integrity checker: `BeeStore.api.maintenance.integrityCheck()` (16 checks).
- Journal invariants: `BeeStore.api.journal.verify()`.
- Error log: Settings → البيانات / `BeeStore.errorLog.diagnostics()`.

## 9. Documentation map

- `docs/MAP.md` — file-by-file responsibilities (use for deeper navigation).
- `docs/API.md` — every facade method and intended REST mapping.
- `docs/specs/BeeStore-v5-Accounting-Core.md` — accounting rules and build order.
- `docs/CHANGELOG.md` — shipped changes.
- `CLAUDE.md` — current task state and next milestone (may be ahead/behind).
- `README.md` — long product/feature documentation (trust the code first).

## 10. Resolved symptom: negative "المصاريف" / large "صافي ربح الشهر"

Reported symptoms: dashboard "صافي ربح الشهر" looks very large, and Reports →
تقرير الشهر showed "المصاريف" negative (e.g. `-6245.00 ₪`).

Root cause: the old KPI was bound to `pnl.operatingExpenses`, which is a **signed
net line**, not gross expenses. Positive `cashDifference` (زيادة صندوق) and
stock/revaluation gains legitimately reduce it below zero and raise `netProfit`.
The P&L detail also wrapped that negative number in parentheses, reading as a
double negative.

Fixed without changing accounting rules or existing signed fields:
`expensesBeforeGains` / `gains` are returned by all routes, Month Review shows
`kpis.grossExpenses` under "إجمالي المصاريف" plus a separate gains card, and the
P&L tab shows negative net expenses as "دخل X" instead of `(-X)`.

If the profit still looks too large, check in order:

1. Understated/zero variant cost (`costMinor` / `valueMinor`) → `cogs ≈ 0` →
   `netProfit ≈ netSales`.
2. Large stock count gains or cost revaluations (`stockLosses` /
   `stockRevaluation` negative) — inspect the movement reasons.
3. Reporting-path mismatch (dashboard partial range vs Reports whole-month
   summary vs journal route) if the summary is stale after a migration/import.

Diagnose before changing formulas: run `scripts/diagnose-pnl.js`, or call
`reports.profitAndLoss` with `{legacy:true}` and `{journal:true}` and compare all
fields. Do not "fix" the negative expense by dropping `cashDifference` unless
the accounting spec is intentionally changed — that would break P&L/parity.
