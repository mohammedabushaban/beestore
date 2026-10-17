# Bee Store (بي ستور) — v2 Addendum
## Monthly Periods, Month Closing, Professional Hardening & Fix Plan

> **Companion to `BeeStore-Project-Spec.md` (v1). Read v1 first. Where v2 and v1 conflict, v2 wins.**
> Same ground rules as v1: complete working code, no placeholders, no `TODO`s, Arabic RTL UI, browser-only architecture (IndexedDB + JSON mirror), business logic in pure-JS `services/`. Do not stop to ask questions — the decisions are made below.

---

## 0. Why this addendum exists

The owner reviewed the first build and found many problems. He wants:
1. **Professional reliability** — correct numbers, no data loss, no crashes, no confusing behavior.
2. **Month-by-month operation** — every month's figures are clean and separate: sales, expenses, profit, cash. An expense entered in October must **never** appear in November's profit. At any moment the owner can look at one month and see exactly what happened in it, and compare it with other months.

This document defines the period model, the month-end workflow, the reports, the data-model changes, the hardening checklist and the process you must follow (§14).

---

## 1. Core Principle

**There is ONE dataset. Every record carries a business date. The month is a *view* and an *accounting period* — not a separate database and not a "reset".**

Three kinds of numbers exist, and the UI must never mix them up:

| Kind | Examples | Behavior |
|---|---|---|
| **Flow numbers** (belong to a period) | sales, returns, COGS, expenses, salaries, payments received/made, purchases | Filtered by the selected period's date range. |
| **Balance numbers** (as of a date) | cash/bank, inventory value, customer receivables, supplier payables, prepaid expenses, accrued salaries, equity | Shown as **opening** (end of previous month) and **closing** (end of selected month). They **carry forward automatically**; the owner never re-enters them. |
| **Current state** (now) | product catalog, stock on hand, customer/supplier list with current balances | Not period-scoped. |

**Answer to the owner's question "do expenses stay across the whole system?":** An expense is stored once, with its date, and belongs to exactly **one month** (or, if deliberately spread, to the specific months of its allocation — §6.3). It never leaks into other months' profit. A *recurring* expense (e.g. rent) is a **template** that creates one separate expense record per month.

---

## 2. Period Rules

- **Month key:** `YYYY-MM`, **calendar months**. Fiscal year = calendar year (Decision; document in README).
- Business logic uses **date strings only** (`YYYY-MM-DD`), compared as strings. Never build business dates from `Date` objects with timezones.
- `dates.js` must provide pure, tested functions: `today()`, `monthOf(date)`, `monthRange(month)` → `{from, to}` (handles 28/29/30/31 days and leap years), `addMonths(month, n)`, `daysInMonth(month)`, `isSameMonth`, `compare`. Accept an injectable clock for tests.
- **Critical bug to avoid:** `new Date().toISOString().slice(0,10)` returns the **UTC** date and gives the wrong day around midnight in the owner's timezone. `today()` must use **local** date parts.
- Timestamps (`createdAt`, `updatedAt`) stay ISO-8601 UTC; the business `date` is separate and user-editable (within the rules below).
- **System start date:** `settings.systemStartDate` is chosen in the first-run wizard ("تاريخ بدء استخدام النظام", default = first day of the current month). No document may be dated before it. All opening balances (accounts, customers, suppliers, opening stock, employee advances) are dated on this day.
- **Date validation on every document:** not before `systemStartDate`; not in the future (`settings.blockFutureDates`, default true); **not inside a closed month** (§7).

---

## 3. Global Period Selector

- A selector in the header, always visible: **◀ أكتوبر 2026 ▶**, with a dropdown listing months that contain data, plus **"السنة كاملة"** and **"فترة مخصصة"** (custom range). **Default = current month.**
- The selection is stored in the URL hash (e.g. `#/expenses?m=2026-10`) and in UI preferences, so refresh/back keep it.
- Every period-scoped page shows a clear scope label ("يعرض: أكتوبر 2026") and passes `{ from, to }` to the API automatically. A closed month shows a 🔒 badge "مُقفل".
- **Default date for new entries:** today if today falls in the selected month; otherwise the **last day of the selected month**, with a visible notice "التاريخ ضمن شهر X". If that month is closed, block with a clear message.
- Any date the user can pick on a form is validated against §2.

---

## 4. Which Date Decides the Month

| Record | Month in which it affects **profit** (accrual) | Month in which it affects **cash** |
|---|---|---|
| Sale invoice | invoice date | each payment's date |
| Sale return | **return date** (not the original sale's month) | refund date |
| Purchase invoice | *none* — it becomes inventory (asset); cost hits profit as COGS **when sold** | each payment's date |
| Purchase return | *none* (reduces inventory/payable) | refund date |
| Expense (single) | expense date | same date |
| Expense (spread over N months) | each month of its allocation | payment date |
| Recurring expense | one record per month, each on its own date | that record's date |
| Payroll | **payroll month** (`payroll.month`) | `paidDate` |
| Employee advance | *none* (asset) — recovered through payroll deduction in the payroll month | date given |
| Customer / supplier payment | *none* | payment date |
| Stock loss (adjustment / stocktake shortage / damaged return) | adjustment date | *none* |
| Owner capital / withdrawal | *none* (equity) | date |
| Account transfer | *none* | date |

> **The owner must be told in the UI (help text on Month Review):** buying stock in a month does **not** reduce that month's profit; it turns cash into inventory. Profit is reduced when the goods are sold (COGS). The "Profit ⇄ Cash reconciliation" report (§9.3) shows this explicitly.

---

## 5. Page Scoping

**Period-scoped (flows, filtered by the selected period):** Dashboard (month cards + comparison to previous month; "today" cards stay visible), Invoices, Returns, Purchases, Expenses, Payroll (rows of the selected payroll month), Customer/Supplier payments, Stock movements, Daily closings, Account statements, **all Reports**.

**As-of (balances):** Accounts (opening + closing for the selected period), Inventory valuation, Receivables/Payables aging, Balance snapshot — evaluated at the **end of the selected month** (or today, if the selected month is the current one).

**Current state (not scoped):** Products & variants list, stock levels, Customers/Suppliers lists (current balances). Each customer/supplier **statement**, however, is period-scoped and shows an **opening balance row**, the period's invoices/payments, and a **closing balance row**.

Every list also keeps its own search/filter/sort inside the selected period.

---

## 6. Expenses Done Right

### 6.1 One-time expenses
Entered with a date; belong to that date's month only. Voiding requires a reason and is allowed only in an open month (never hard-delete).

### 6.2 Recurring expenses (rent, internet, subscriptions)
- Template fields: `categoryId, amountMinor, dayOfMonth (1–28 or "last"), description, startMonth, endMonth|null, active, lastGeneratedMonth`.
- **"Generate for month X"** creates the missing expense records for that month. It is **idempotent**: unique key `(recurringId, month)`; generating twice never duplicates. Generated records are ordinary expenses with `recurringId` and `month` set, editable/voidable like any other (in open months).
- **Never post silently.** When the app opens in a new month, or when the user selects a month with missing recurring expenses, show a banner "مصاريف شهرية لم تُنشأ بعد (N) — إنشاؤها الآن". One click generates them.
- Editing a template uses `effectiveFrom` (a month): it affects only months ≥ that; past records are untouched. Deactivating stops future generation only.

### 6.3 Spread expenses (annual insurance, annual license, prepaid items)
- A single payment covering several months: `allocation: { mode: "spread", months: N, startMonth }`.
- Cash leaves on the payment date; **profit** receives `amount / N` in each of the N months (the last month absorbs the rounding remainder). The unallocated remainder is shown on the balance snapshot as **"مصاريف مدفوعة مقدماً" (prepaid expenses, an asset)**.
- Editing/voiding a spread expense is allowed only if **none** of its months is closed.

### 6.4 No double counting
- Expense categories can **not** be used for salaries, stock purchases, owner withdrawals or advances — those have their own flows. Seed categories must not include them, and the UI blocks creating categories with those reserved names (show an Arabic hint explaining where to enter them).
- The Expenses page shows **"رواتب (تلقائي من الرواتب)"** and **"خسائر مخزون (تلقائي)"** as read-only lines in the month total, so the owner sees the full picture without entering them twice.

### 6.5 Expenses page (period-scoped)
Month total; breakdown by category (table + bar); comparison with previous month (amount and %); filter by category; search; CSV export; "Generate recurring" button; list of spread-expense shares falling in this month.

---

## 7. Month-End Workflow, Closing and Locking

### 7.1 The workflow the owner follows
1. During the month: work normally (sales, purchases, expenses…).
2. Month end: **Generate recurring expenses** → **Prepare & pay payroll** for the month → (optional) **Stocktake**.
3. Open **"إقفال الشهر"** — the checklist page for the selected month.
4. Review the **Month Review** (§9.1); fix anything wrong.
5. Click **"إقفال الشهر"**: the month is locked, a snapshot is stored, a backup is made, and the report can be printed. The next month starts automatically with the carried-forward balances.

### 7.2 Closing checklist (computed live)
| Check | Level |
|---|---|
| All earlier months are closed (months close **in order**) | Blocker |
| Data Integrity Checker (§12.2) reports no errors | Blocker |
| Recurring expenses generated for the month | Warning |
| Payroll prepared for all active employees (unpaid is fine — it is accrued) | Warning |
| Days without a daily closing | Warning |
| Variants with negative stock (only possible if `allowNegativeStock`) | Warning |
| Stocktake done during the month | Info |
| Overdue installments | Info |

Warnings can be acknowledged and the month closed anyway; blockers cannot.

### 7.3 What closing does (one transaction)
Creates a `periodClosings` record with a **snapshot** (net sales, COGS, gross profit, expenses by category, salaries, net profit, per-account closing balances, inventory value at cost and retail, receivables, payables, prepaid, accrued salaries), marks the month closed, writes the audit log, and triggers a dated backup (§11 of v1) **before** committing.

### 7.4 Locking rules
- Any create / edit / void of a document **dated in a closed month** is rejected (Arabic error naming the month and suggesting the correct action). Implement as `assertPeriodOpen(date)` called **inside every posting transaction** in the services (not only in the UI).
- Money events dated **today** that settle old items are fine: collecting a customer's payment for an October invoice in November is a November cash event; paying October's payroll in November sets `paidDate` = November. These change **cash**, never the closed month's profit.
- Payroll amounts of a closed month cannot change; only the payment event (status/`paidDate`/account) can.
- To correct a closed month's mistake: record the correction in the **current** month (return, stock adjustment, expense, etc.) or **reopen** the month.
- A voided invoice dated in a closed month is not allowed → use a return dated today.

### 7.5 Reopening
Only the **most recently closed** month can be reopened (to go further back, reopen sequentially). Requires typed confirmation; the snapshot is discarded; an audit entry is written; a backup is taken first.

---

## 8. Balances "As Of" a Date (opening / closing)

All balances for any date `D` are computed from dated records:

- **Inventory at cost as of D** = Σ over variants of (`balanceAfter` × `avgCostAfterMinor` of the variant's last stock movement dated ≤ D). Therefore **`stockMovements` gets a new field `avgCostAfterMinor`** (the weighted-average cost right after that movement). Inventory at retail uses current prices and is only reported for "today".
- **Account balance as of D** = account opening balance + all in/out movements dated ≤ D.
- **Customer balance as of D** = opening + Σ non-void sales (date ≤ D) − Σ payments (date ≤ D) − Σ credits from returns (date ≤ D). **Supplier balance** analogously.
- **Prepaid expenses as of D** = Σ over spread expenses paid ≤ D of the shares allocated to months **after** D's month.
- **Accrued salaries as of D** = Σ net of payroll records with `month` ≤ D's month that are unpaid or whose `paidDate` > D.
- **Employee advances as of D** = advances given ≤ D − repayments recognized in payroll with `month` ≤ D's month.
- **Tax payable as of D** (only if tax enabled) = tax collected on sales − tax refunded on returns (no remittance flow in Phase 1; show as a liability).
- **Opening equity** = (opening cash/bank + opening stock at cost + opening receivables + opening advances) − (opening payables). Computed automatically at `systemStartDate` and shown as "رأس المال الافتتاحي".
- **Equity as of D** = opening equity + capital in − withdrawals + cumulative net profit (all periods up to D).

**Balance snapshot (replaces §7 item 10 of v1):**
Assets = cash + bank + wallet + inventory at cost + customer receivables + prepaid expenses + employee advances.
Liabilities = supplier payables + customer credits + accrued salaries (+ tax payable).
Equity = as above. **Assets must equal Liabilities + Equity**; if not, show a red reconciliation warning and make the integrity checker fail.

Opening balances of month M = closing balances of month M−1 (for the first month: the opening balances entered at `systemStartDate`). For closed months, headline closing numbers are read from the stored snapshot; the Integrity Checker verifies that recomputation equals the snapshot.

---

## 9. Reports

All v1 reports remain, now filtered by the selected period. New/changed reports:

### 9.1 Month Review (تقرير الشهر) — the owner's main monthly report
Printable A4 + CSV. Header: store name, month, status (مفتوح / مُقفل 🔒). Sections:
1. **KPIs:** net sales, gross profit & margin %, total expenses, net profit, invoices count, average invoice, units sold.
2. **Profit & Loss** with columns: *This month | Previous month | Change % | Same month last year (if exists)*.
3. **Sales:** by day (chart), by category, top 10 products by quantity and by profit, by payment method, by employee.
4. **Expenses:** by category (incl. recurring, spread shares, salaries, stock losses) with comparison to previous month.
5. **Cash flow:** opening cash per account → inflows by source (cash sales, customer collections, capital in…) → outflows by source (purchases, suppliers, expenses, salaries paid, advances, withdrawals…) → closing cash.
6. **Balances (opening → closing):** inventory at cost, receivables, payables, prepaid expenses, accrued salaries, employee advances.
7. **Inventory movement:** units/value purchased, units/cost sold, adjustments/losses, closing stock.
8. **Customers:** new credit given, collections, overdue installments.
9. **Payroll:** per employee for the month (base, bonus, deductions, advances recovered, net, paid/unpaid).

### 9.2 Year Overview (نظرة على السنة)
A table with 12 monthly columns + total: net sales, COGS, gross profit, expenses (grouped), net profit, change in cash. Chart of sales vs expenses vs net profit. Highlights best/worst month. Clicking a month opens its Month Review. A second table lists month status (open/closed).

### 9.3 Profit ⇄ Cash Reconciliation (لماذا الربح يختلف عن النقد؟)
For the selected month:
`Net profit − increase in inventory − increase in receivables − increase in prepaid + increase in payables + increase in accrued salaries (± change in advances & tax payable) = cash from operations`; then `± capital in/withdrawals = change in cash`. **It must equal the actual change in total cash/bank balances** (tested).

### 9.4 Compare Months
Pick any two months and compare all P&L lines and expense categories side by side with differences.

### 9.5 Dashboard
Period-aware: selected month's net sales, gross profit, expenses, net profit with **arrows vs previous month**; plus today's sales; cash balances; low stock; receivables; payables; overdue installments; payroll status; recurring-expense reminder; last-12-months chart.

---

## 10. Data Model Changes (diff vs v1)

| Where | Change |
|---|---|
| `settings` | add `systemStartDate`, `blockFutureDates` (default true) |
| **new** `periodClosings` | `month` (unique), `status` ("closed"), `closedAt`, `snapshot{…}`, `reopenHistory[]` (`{reopenedAt, note}`), `note` |
| `expenses` | add `month` (derived from `date`, stored), `allocation: { mode:"single"|"spread", months, startMonth }`, `voided`, `voidReason` |
| `recurringExpenses` | add `startMonth`, `endMonth`, `lastGeneratedMonth`, `effectiveFrom`; unique `(recurringId, month)` on generated expenses |
| `stockMovements` | add `avgCostAfterMinor` |
| `payroll` | `month` is the **accrual month**; `paidDate` is the cash date; both required semantics as in §4 |
| derived cache | optional in-memory monthly aggregates (never stored as truth); fully cleared on every commit and recomputed lazily; closed months may use the snapshot for headline numbers |
| JSON file | `collections` gains `periodClosings`; **bump `schemaVersion`**; write a migration from v1 data: fill `avgCostAfterMinor` by replaying movements in order, set `systemStartDate` to the first day of the earliest document's month, compute `month` on expenses |

---

## 11. Services / Facade Changes

- **Every** list and report method accepts `{ from, to }` (or `month`); the UI passes the selected period automatically.
- New/changed methods: `periods.list()`, `periods.get(month)`, `periods.checklist(month)`, `periods.close(month)`, `periods.reopen(month)`, `reports.monthReview(month)`, `reports.yearOverview(year)`, `reports.profitCashReconciliation(month)`, `reports.compareMonths(a, b)`, `expenses.spread(...)`, `recurringExpenses.generate(month)`, `maintenance.integrityCheck()`, `accounts.balanceAsOf(accountId, date)`, `inventory.valueAsOf(date)`.
- `assertPeriodOpen(date)` and date validation (§2) run inside every posting transaction.
- All new methods keep the `{ok, data|error}` envelope and are documented in `docs/API.md`.

---

## 12. Professional Hardening

### 12.1 Bug classes you must eliminate (check the whole codebase for each)
1. **Timezone/date bugs** (§2); month boundary off-by-one (31st, 28/29 Feb, Dec→Jan rollover); using `Date` arithmetic for months.
2. **Float money errors:** all money is integer minor units; one rounding rule for discounts/tax/proration, documented; no `parseFloat` on formatted strings; no totals computed in the UI.
3. **Double-submit:** disable the action button and ignore repeated clicks/Enter while saving; one invoice per click, guaranteed.
4. **Non-atomic writes / partial saves:** every posting in one transaction (v1 §4); tests prove rollback.
5. **Arabic-Indic digits:** numeric inputs must normalize `٠١٢٣٤٥٦٧٨٩` and `٫`/`٬` to Western digits before parsing.
6. **XSS / HTML injection:** every user-supplied string (names, notes, descriptions) is inserted with `textContent` or a central `escapeHtml()`; never raw `innerHTML` with user data. Imported CSV/JSON is untrusted.
7. **CSV formula injection:** when exporting CSV, prefix cells starting with `= + - @` with `'`.
8. **Stale UI:** after any mutation, all visible numbers (dashboard, lists, header indicators) refresh from the single source of truth; no duplicated state.
9. **Negative / absurd values:** reject negative quantities/prices where not allowed, discounts above the amount, payments above due (except recorded as customer credit/change), zero-quantity lines.
10. **Orphans:** deactivating (not deleting) products/customers/suppliers/employees that have history; references never dangle.
11. **Performance:** in-memory indexes; virtualized/paginated lists; debounced search; no O(n²) loops in reports; test with the seed scaled to 5,000 variants and 50,000 invoices.
12. **Unhandled errors / blank page:** see §12.3.
13. **Print bugs:** invoice A4/80mm and label sheets verified with print CSS (`@page` sizes), RTL text, long product names wrapping, no cut-off tables.
14. **Focus/keyboard bugs in POS:** barcode input regains focus after each add; scanner Enter never submits the invoice.
15. **Memory/event leaks** from re-rendering pages (remove listeners when leaving a page).

### 12.2 Data Integrity Checker (Settings → Maintenance → "فحص سلامة البيانات")
Runs read-only and reports **errors / warnings** with the affected record and a link to it; offers safe automatic fixes only for derived data (e.g. "recalculate stock"). Checks at least:
- `variants.quantity` = Σ `stockMovements.qtyChange`; no unexplained negative stock.
- Each sale: Σ lines − discounts + tax = total; payments ≤ total + change rules; `dueMinor` consistent; status consistent.
- Each purchase/return/payroll/closing record internally consistent.
- No reference to a missing product/variant/customer/supplier/employee/account.
- Unique numbers (invoice/purchase/return) and unique barcodes/SKUs; counters ≥ max used number.
- Account balances equal the sum of their movements; **balance snapshot balances** for the current date and for every closed month.
- Every closed month's **stored snapshot equals recomputation**.
- No documents dated before `systemStartDate`, in the future (if blocked), or edited after their month closed (via audit log timestamps).
- Spread expenses' shares sum to their amount; recurring `(recurringId, month)` unique.

### 12.3 Error handling & logging
- Global `window.onerror` / `unhandledrejection` handlers: never a blank screen; show a friendly Arabic dialog with a **"نسخ تفاصيل الخطأ"** button; store the last 200 errors in an `errorLog` (IndexedDB) viewable in Settings and included in a "diagnostics" download (without business data beyond ids).
- Each page render is wrapped so a failure in one widget does not break the whole page.
- Service errors use typed codes (`VALIDATION`, `PERIOD_CLOSED`, `INSUFFICIENT_STOCK`, `NOT_FOUND`, `CONFLICT`, `STORAGE`), each with an Arabic message.

### 12.4 UX polish
Consistent spacing/typography; loading and empty states; unsaved-changes warning on forms; confirmation dialogs for destructive actions; clear success toasts; consistent number/date formatting; tables with sticky headers; sensible default sorting (newest first); every list exportable; short Arabic help tooltips on accounting terms (COGS "تكلفة البضاعة المباعة", prepaid expense, accrued salaries…); keyboard navigation and visible focus; no jargon in error messages.

### 12.5 Code quality
One responsibility per file; no dead code; JSDoc on every service function (inputs, outputs, errors, side effects); no globals outside `window.BeeStore`; consistent naming; constants in `config.js`; pure functions for all calculations (easy to test); comments explaining accounting rules where non-obvious.

---

## 13. Tests & Acceptance

### 13.1 Period-specific automated tests (in addition to v1's list)
1. `monthRange` for every month of a leap and a non-leap year; Dec→Jan rollover; `today()` around midnight with an injected clock and non-UTC offsets.
2. An expense dated 31 Oct appears only in October; one dated 1 Nov only in November; boundary invoices at 23:59 and 00:00.
3. Recurring generation is idempotent; editing a template with `effectiveFrom` does not change past months.
4. Spread expense: shares sum to the total, remainder in the last month, prepaid balance correct each month.
5. Return in November of an October sale reduces **November's** net sales and COGS, not October's.
6. Payroll accrues in its month; paying it in the next month changes cash only.
7. Closing: blocked when an earlier month is open; locks every document type (create/edit/void) in the closed month; allows settlement payments dated today; reopening only the latest; snapshot equals recomputation.
8. Balance snapshot balances for every month-end of the seeded data; Profit⇄Cash reconciliation equals actual cash change.
9. Integrity Checker detects deliberately corrupted data (each check has a failing-case test).
10. Migration of v1 data (`avgCostAfterMinor` backfilled, `systemStartDate` set).
11. Double-click on "save invoice" creates exactly one invoice.
12. Performance test at 5,000 variants / 50,000 invoices: month report < 1 s, search < 100 ms.

### 13.2 Acceptance scenario (must pass exactly; units are the store currency)

Setup: `systemStartDate` = 2026-10-01, no opening balances, owner capital in of **5,000.00** into the cash account on 2026-10-01.

**October**
1. Oct 1: purchase inventory **1,000.00**, paid in cash.
2. Oct 10: sales invoices total **1,000.00** (700.00 cash, 300.00 on credit to customer A); their COGS = **550.00**.
3. Oct 5: rent **200.00**; Oct 15: electricity **30.00** (both cash).
4. Oct payroll (two employees, no bonus/deductions): net **100.00** in total, **unpaid** at Oct 31.
5. Oct 3: annual insurance **1,200.00** paid in cash, spread over 12 months starting 2026-10.

Expected for **October**:

| Item | Value |
|---|---|
| Net sales | 1,000.00 |
| COGS | 550.00 |
| Gross profit | 450.00 |
| Expenses (rent 200 + electricity 30 + salaries 100 + insurance share 100) | 430.00 |
| **Net profit** | **20.00** |
| Cash from operations | −1,730.00 |
| Change in cash (incl. 5,000.00 capital in) | +3,270.00 → closing cash **3,270.00** |
| Inventory at cost (closing) | 450.00 |
| Receivables (closing) | 300.00 |
| Prepaid expenses (closing) | 1,100.00 |
| Accrued salaries (closing) | 100.00 |
| Balance check | Assets 3,270 + 450 + 300 + 1,100 = **5,120.00** = Liabilities 100 + Equity (5,000 + 20) = **5,120.00** ✔ |
| Profit⇄Cash | 20 − 450 − 300 − 1,100 + 100 = **−1,730.00** ✔ |

Close October → locked; adding an expense dated 2026-10-31 is rejected.

**November**
6. Nov 2: pay October payroll (100.00) in cash.
7. Nov 12: customer A pays 300.00.

Expected for **November**: net sales 0; expenses **100.00** (insurance share only — October payroll is **not** a November expense); **net profit −100.00**; change in cash **+200.00** (−100 + 300); receivables closing 0; accrued salaries closing 0; prepaid closing 1,000.00. Balance still balances.

---

## 14. Process You Must Follow

1. **Phase A — Audit (only if a project already exists in the working folder).** Review the whole codebase against v1 and v2. Write `docs/AUDIT.md`: every defect found (severity, file/function, root cause, how it will be fixed), starting with the **Owner-Reported Problems** below. Run the existing tests and record results.
2. **Phase B — Fix.** Fix owner-reported problems first, then critical/major defects. Add a **regression test for every fixed bug**.
3. **Phase C — Periods.** Implement §2–§11 (period selector, scoping, expenses model, closing/locking, as-of balances, new reports, migration).
4. **Phase D — Hardening.** Apply §12 (bug-class sweep, Integrity Checker, error handling, UX, code quality).
5. **Phase E — Verify.** All tests green (v1 list + §13), the §13.2 scenario passing as an automated test, `tests/smoke.html` passing on real IndexedDB, manual checklist updated in `docs/CHECKLIST.md`.
6. **Do not rewrite from scratch** unless the audit proves the existing architecture cannot satisfy v1/v2; if you do, explain why in `docs/AUDIT.md`.
7. **Deliverables:** updated project folder (opens by double-click on `index.html`), `docs/AUDIT.md`, `docs/CHANGELOG.md` (what changed and why), updated `docs/DATA_FORMAT.md`, `docs/API.md`, Arabic README with a new section "الإقفال الشهري" (a simple step-by-step guide for the owner), and an updated "Decisions" list.
8. Work in small verified steps; after each step run the tests; never leave the app in a broken state.

---

## 15. Owner-Reported Problems (fix FIRST)

> The owner pastes here, before giving this file to the AI, every problem he saw. Format per item: **Page** — **what I did** — **what happened** — **what I expected** (screenshots/error text if any). The AI must treat each item as a bug report: reproduce, fix, add a regression test, and list it in `docs/CHANGELOG.md`.

1. …
2. …
3. …
