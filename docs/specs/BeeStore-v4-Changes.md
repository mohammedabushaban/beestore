# Bee Store (بي ستور) — v4 Change Requests
## Owner Review Round 1: Items, Pricing, Search, Expenses, Returns, Statements, Purchases, and the Ledger Decision

> **Companion to v1 (`BeeStore-Project-Spec.md`), v2 (`BeeStore-v2-Monthly-Periods.md`) and v3-Lite (`BeeStore-v3-Lite.md`). Where v4 conflicts with them, v4 wins.**
> Same ground rules: complete working code, no placeholders/`TODO`s, Arabic RTL UI, integer money, local `YYYY-MM-DD` business dates, atomic postings, day/month locking inside services, classic scripts (no ES modules), a regression test for every change. Do not stop to ask questions — decisions are made below; record extra assumptions in the README "Decisions".
> **Existing data must survive.** Every change that touches the data model needs a migration (bump `schemaVersion`), a migration test, and must keep old backups restorable.

---

## 0. How to Work

1. Read `CLAUDE.md` and `docs/MAP.md` if they exist, then v1–v3-Lite, then this file.
2. Implement R1–R11 (milestones M1–M11), verifying each with tests, then R12 (the journal) last.
3. For each item: reproduce current behavior first (where a bug is described), fix, add a regression test, update `docs/CHANGELOG.md`, `docs/MAP.md`, `CLAUDE.md`.
4. Be honest in your final report about anything not verified.

## 1. Summary of Decisions (what the owner asked vs. what is correct)

| # | Owner's request | Verdict |
|---|---|---|
| R1 | Items not tied to categories; simple add (qty, base price, cost) | **Accepted with changes:** category and variants become *optional*; quantity is never edited directly (ledger) — "edit quantity" creates an adjustment. |
| R2 | Price above list price: the extra disappears | **Accepted — it is a defect.** Actual line price is recorded and revenue uses it; list price kept as a snapshot; overpayment must be explicitly allocated, never dropped. |
| R3 | Search stock/stocktake by name, number, barcode | **Accepted** — one shared search engine with Arabic normalization everywhere. |
| R4 | Separate item number besides barcode and name | **Accepted** — `itemCode` (replaces the hidden SKU). |
| R5 | Recurring expenses deducted daily (e.g. rent 100/day) | **Accepted with changes:** *one record per period* + **derived daily allocation** for day views. No daily records. Allocation affects profit views only, never cash. |
| R6 | Unpaid invoices should not be in today's sales | **Rejected as stated** (accounting accrual rule): a credit sale *is* a sale. Fix = show **invoiced / collected / on credit** separately everywhere, plus bad-debt write-off. |
| R7 | Invoices table: customer column, payment method, customer under payment method | **Accepted with changes:** separate Customer and Payment columns (desktop); stacked card layout on phone. |
| R8 | Date **and time** on every record | **Accepted** — `date` (business) + `time` + `createdAt`, shown everywhere. |
| R9 | Returns not tied to an invoice number | **Accepted with controls:** linked *or* unlinked returns, many search modes, unlinked ones flagged, capped and permission-limited. |
| R10 | Item names in customer statements | **Accepted** (+ supplier statements + an item ledger "بطاقة الصنف"). |
| R11 | Purchase invoice with item search and inline new-item creation | **Accepted, extended** (landed costs, price/margin prompt, size-run entry, drafts). |
| R12 | "Is the project a ledger?" | **Partly.** Stock is a true ledger; money is *derived*, not journaled. Add a double-entry **journal** (final milestone) with parity tests. |

---

## R1. Items (الأصناف) — Not Tied to Categories

**Terminology:** the UI says **"صنف"** (item) everywhere. Internally the existing `products` + `variants` model stays, but the UI must not force its complexity.

**Item fields:** `name` (required), `itemCode` (required, unique, auto-generated sequential number such as 1001, editable, validated for uniqueness), `barcode` (optional, unique), `categoryId` (**optional**), `brand` (optional), `unit` (default "قطعة"), `costMinor`, `priceMinor`, `lowStockThreshold`, `notes`, `active`, `hasVariants` (default **false**).

- **Quick Add (إضافة سريعة):** one compact form — name, item code (auto), barcode (optional), cost, price, **opening quantity** — creates the item with one **default variant** (no size/color). It is reachable from: Items page, POS (unknown barcode), purchase invoice, stocktake, returns, price check.
- **Categories are optional:** a free "تصنيف (اختياري)" typeahead that can create a category on the fly, or leave empty. Reports group missing categories as **"بدون تصنيف"**. No screen may require a category.
- **Variants optional:** switch "له مقاسات/ألوان" reveals the size × color grid (v1 §5.5). Variants get their own `itemCode` (parent code + suffix, e.g. `1001-3`) and optional barcode; search finds both levels.
- **Quantity rule (accounting integrity):** the stored quantity is the sum of stock movements and is **never edited directly**. The item screen offers **"تعديل الكمية"**: the user types the new quantity; the system creates an `adjustment` movement for the difference with a required reason (تالف / فقد / زيادة / جرد / تصحيح) and audit entry. Opening quantity creates an `opening` movement.
- **Cost edits:** `costMinor` is the current weighted-average cost. A manual cost change is **owner-only**, requires a reason, and creates a `revaluation` stock movement (qty 0, new `avgCostAfterMinor`); the value difference is a P&L line "تسوية تكلفة المخزون" (inventory revaluation). Price edits are free (audit-logged) and never touch history.
- **Delete:** never; only deactivate.
- **Tests:** create item with no category and no variants; quick add from POS/purchase; quantity edit creates the right movement; cost revaluation moves inventory value and P&L correctly; migration keeps existing products working.

---

## R2. Selling Above the List Price & Overpayment

Two different situations; both must be handled and neither may lose money silently.

### R2.1 Actual line price (price override)
- Line fields: `listPriceMinor` (snapshot at sale time), `unitPriceMinor` (**actual, editable** by tapping the price in POS), `priceDiffMinor` = (`unitPriceMinor` − `listPriceMinor`) × qty.
- **Revenue uses the actual price.** The invoice and POS show the list price subtly and a badge: green "+20" (above list) / red "−10" (below list).
- Below list = a **discount** and is subject to the cashier's `cashierMaxDiscountPercent`; above list is allowed for any profile.
- **Report "فروقات الأسعار":** by day/month/item/profile: sales above list, below list, net variance. The Month Review gets one line with the net variance. Margin and profit use actual prices.

### R2.2 Overpayment (payment larger than the invoice total)
- Never cap or drop it. The payment screen shows **"المدفوع أكبر من الإجمالي بمقدار X"** and requires a choice:
  1. **باقي للزبون (إرجاع نقدي)** — default; cash out as change; net cash equals the invoice total.
  2. **رصيد للزبون** — becomes customer credit (requires a customer).
  3. **إيراد آخر / تقريب** — recorded as other income "فروقات تقريب وإكراميات" (permission-controlled).
- Invoice stores `overpaymentMinor` and `overpaymentMode`. Daily-closing expected cash uses **net cash** (received − change given).
- **Tests:** list 100, sold at 120 → revenue 120, variance +20; customer pays 150 → (1) change 30: cash +120; (2) credit 30: cash +150, customer credit 30; (3) other income 30: cash +150, revenue 120 + other income 30. Below-list sale respects the cashier discount limit.

---

## R3 + R4. One Search Engine: Name, Item Number, Barcode

- **Shared component `ItemPicker` + service `items.search(q, opts)`**, used in: POS, purchase invoices, returns, stocktake, inventory page, stock adjustments, label printing, price check.
- **Matches:** (a) **name** — partial, any word order, all words must match; (b) **item code** — exact, prefix, partial; (c) **barcode** — exact, and partial by the last 4+ digits; also brand and size/color text.
- **Ranking:** exact code/barcode > code/barcode prefix > name starts-with > name contains. Results are variant rows showing name, size/color, code, stock, price.
- **Arabic normalization (matching only, `normalizeForSearch`):** remove diacritics and tatweel; unify أ إ آ ٱ → ا; ى → ي; ة → ه; Arabic-Indic digits → Western; lowercase Latin; collapse spaces. Each variant stores a precomputed `searchKey`, kept in an in-memory index.
- **Behavior:** typing an exact item code or a scanned/typed exact barcode + Enter selects that item immediately; recent items list; filters (in stock, low, zero, negative, category, active); camera scan button (v3-Lite §9).
- **Inventory and stocktake pages** use the same search box and filters.
- **Tests:** "ازرق" finds "أزرق"; "ولادي" finds "ولادى"; "قميص ازرق" matches regardless of word order; code `1001` and prefix `100`; barcode exact and last-4; ranking order; 10,000 variants search < 50 ms.

---

## R5. Recurring Expenses and Daily Allocation

**Principle:** one record per period (e.g. one rent record per month). The **daily view is derived**; nothing is created every day, and nothing depends on the owner opening the app daily.

### R5.1 Templates
`frequency` ("monthly" | "weekly" | "yearly"), `amountMinor` (per period), `dayOfMonth`/weekday, `categoryId`, `description`, `startMonth/endMonth`, `active`, `allocateDaily` (default **true** for rent/utilities/internet; selectable), `basis` ("period_amount" **default** | "per_day_amount"). v2 §6.2 rules stay (idempotent "generate for month", `effectiveFrom`, banner on new month).
- `period_amount`: day share = period amount ÷ days in the service period (calendar month: 28–31; week: 7; year: 365/366). Remainder cents go to the **last** day so the month total equals the amount exactly.
- `per_day_amount` (e.g. "100 per day"): the template stores the daily amount; generating a month creates **one** expense record with amount = daily × days in that month, and shows a note "قد يختلف عن الإيجار الفعلي". Month total changes with month length — document this.

### R5.2 Day view
- Day P&L (Day Report, dashboard "ربح اليوم", Days page) = gross profit of the day − **day shares** of allocated expenses − non-allocated expenses dated that day − day share of salaries (setting `dayViewAllocation.salaries`: "daily" default | "none").
- Label it **"ربح اليوم (تقدير إداري)"** with a help tooltip explaining allocation. **Month totals never change** (monthly P&L is identical with or without allocation).
- **Cash is not affected:** the daily closing's cash reconciliation ignores allocated shares; cash leaves on the payment date. The Day Report lists **"مصاريف موزّعة (غير نقدية)"** separately from cash expenses.
- v2 spread expenses (several months) are also allocated across the days of each month in day views.
- **Tests:** rent 3,000.00 in a 30-day month → 100.00 per day, total 3,000.00; in a 31-day month → 96.77 for 30 days and **96.90** on the last day (total 3,000.00); paying the rent on the 1st moves cash −3,000.00 that day only; the day's expected cash is unaffected by shares; month P&L equals the sum of its days' allocated lines.

---

## R6. Credit (Unpaid) Sales and "Today's Sales"

**Accounting rule (accrual):** a sale is recognized on the invoice date when goods are delivered, even if unpaid. A credit sale belongs to **sales** and **profit**, but **not to cash received**. Excluding it from "sales" would understate revenue and break profit, stock and customer balances. The owner's real need is *not to confuse sales with money collected* — so show them separately.

- **Everywhere (dashboard, Day Report, daily closing, Month Review, Days page)** show:
  - **إجمالي المبيعات (مفوترة)** = Σ invoices (net of returns).
  - **منها: مقبوض عند البيع** and **آجل (غير مدفوع)**.
  - **المقبوض اليوم (تحصيل)** = payments received that day, including payments of older invoices.
  - **ذمم جديدة** (credit created) and **ذمم محصّلة**.
- Dashboard card "مبيعات اليوم" shows the total with the sub-line "مقبوض X • آجل Y"; a toggle "عرض: مفوترة / مقبوضة" switches the headline figure.
- Daily closing expected cash counts **only cash movements**; credit sales never enter it.
- **Bad debt write-off (شطب دين معدوم):** owner-only, per customer with amount, reason, date; reduces receivables and records an expense "ديون معدومة" (reserved category); subject to day/month locks; audit-logged.
- **Tests:** day 1: invoice A 300.00 cash, invoice B 200.00 on credit → invoiced 500.00, collected-at-sale 300.00, credit 200.00, expected cash +300.00; day 2: customer pays 200.00 → collections 200.00, sales 0, profit unchanged; write-off of a debt creates the expense and zeroes the balance.

---

## R7. Invoices Table

- **Desktop columns:** رقم الفاتورة | التاريخ والوقت | الزبون | الإجمالي | طريقة الدفع | المدفوع | المتبقي | الحالة | إجراءات.
- **Customer:** the customer's name, or **"زبون عام"** for walk-in; phone as a small sub-line. **Fix the current Customer column bug** (find the root cause in the audit; add a regression test with registered, walk-in and deleted/inactive customers).
- **Payment method:** chips — "نقدي", "بطاقة", "تحويل", "محفظة", split payments as "نقدي + بطاقة" (amounts on tap/hover), "آجل", and partial as "جزئي (مدفوع 50 من 120)". Voided invoices struck through.
- **Do not put the customer name under the payment method on desktop** — it mixes two facts and breaks sorting/filtering. On **phone** the list is a card layout: line 1 number + date/time; line 2 customer name; line 3 payment chips + total + status.
- Filters: customer (name/phone), payment method, status, date/time range, search by invoice number or item name. Sort by date-time (default newest first).

---

## R8. Date **and Time** on Every Record

- Every document gets: `date` (business date, editable within locks, drives periods/closings), `time` (`HH:mm:ss`, local), and `createdAt` (system UTC timestamp, immutable). Applies to sales, returns, purchases, expenses, customer/supplier payments, stock adjustments, owner transactions, transfers, advances, payroll payments (`paidAt`), write-offs, daily closings (`closedAt`).
- Default `time` = now. Editing the date (back-dating) also allows editing the time (owner/permission); the original `createdAt` stays visible in details.
- **Time never affects which day/month a document belongs to — only `date` does.**
- Display everywhere (tables, statements, Day Report, stock movements, receipts) as date + time; setting `timeFormat` ("12h" default with ص/م | "24h"). Sort by (`date`, `time`, `createdAt`, number).
- **Migration:** backfill `time` from `createdAt` (converted to local) where missing; keep existing sale `time` values.
- **Tests:** invoices created at 23:59 and 00:01 land on different business dates; a back-dated invoice keeps its `createdAt`; tables show date + time; migration fills missing times.

---

## R9. Returns Without Forcing an Invoice Number

The stock side is already a movement ledger; the return becomes a first-class document that **may or may not reference a sale line.**

### R9.1 Finding what to return (tabs on the new-return screen)
1. **By item:** `ItemPicker` (name/code/barcode/scan) → shows that item's recent sales (date/time, customer, qty, net price, returnable qty) to **link** with one tap, or "بدون ربط".
2. **By customer:** search name/phone → the customer's purchase history by item lines → pick lines.
3. **By invoice number** (optional shortcut).
4. **By date/time range.**
5. **No reference** ("مرتجع بدون فاتورة").
Multiple items per return; each line may be linked or unlinked.

### R9.2 Rules
- **Linked line:** quantity ≤ sold − already returned; refund price defaults to the **net price actually paid** (after discount proration) and cannot exceed it; cost for COGS reversal = the original cost snapshot.
- **Unlinked line:** item + qty + **refund price entered by the user** (default = current list price; capped at the list price unless the owner overrides); **reason required**; cost for COGS reversal = current weighted-average cost; header flag `NO_REFERENCE`.
- **Permission:** owner always; cashier only up to `cashierUnlinkedReturnLimitMinor` per return (default **0 = not allowed**; configurable).
- Restock or damaged per line (v1 §6.3); refund mode: cash/bank, customer credit, exchange (v1 §6.3). Optional `customerId` (required for customer credit).
- **Audit visibility:** report "مرتجعات بدون مرجع" (by day/month/profile) and a line in the Day Report and Month Review.
- **Why the controls:** without an invoice, price, cost and ownership of the item cannot be verified; the caps, reason, flag and report protect the owner without blocking real situations.
- **Tests:** linked return defaults to the net paid price and cannot exceed sold qty; unlinked return blocked for the cashier when limit = 0, allowed for the owner at ≤ list price, flagged `NO_REFERENCE`, stock +qty, refund and COGS reversal at average cost; each search tab finds the right lines.

---

## R10. Statements Show Item Names + Item Card

- **Customer and supplier statements:** chronological table — التاريخ والوقت | النوع | رقم المستند | **البيان** | مدين | دائن | الرصيد, with opening and closing balance rows (v2 §5).
  - **البيان** shows item names: `اسم الصنف (مقاس/لون) × الكمية` for the first two lines and "+N أخرى" when long; a **"عرض الأصناف تفصيلياً"** toggle expands each document into item sub-rows (name, code, qty, unit price, line total). Returns, payments (with method), write-offs and adjustments also carry readable descriptions.
  - Printing/CSV/PDF honor the toggle. Supplier statements show purchase lines the same way.
- **New: Item Card (بطاقة الصنف / حركة الصنف):** per item/variant, a ledger of every movement (opening, purchases, sales, returns, adjustments, revaluations) with date-time, document link, qty in/out, unit cost, **running quantity**, and optionally running value. Filter by period. Reachable from the item screen and search results.
- **Tests:** statement rows contain the item names of their documents; toggling expands rows; item card running quantity equals current stock.

---

## R11. Purchase Invoices (المشتريات)

### R11.1 Flow
Header: supplier (search or **quick-add supplier**), supplier invoice number, **date + time**, payment (paid now amount + method/account; remainder on credit), notes.
Lines grid: `ItemPicker` (search by name/code/barcode/camera) → quantity, **unit cost** (default = last purchase cost), line discount, optional **new selling price**. If the item does not exist: **"إضافة صنف جديد"** opens Quick Add (R1) inside the purchase screen and returns the new item as a line. For items with variants, a **size-run matrix** (rows = colors, columns = sizes, cells = quantities) allows entering a whole size run at once.

### R11.2 Accounting behavior
- A purchase sets **cost**; it never changes the selling price automatically. Show **margin %** (price vs new cost) per line; when the new cost raises the cost above the old price or the margin drops below `minMarginPercent` (setting), prompt **"تحديث سعر البيع؟"** with one-tap apply.
- **Landed costs:** invoice-level `extraCostsMinor` (shipping, customs, loading) is **allocated across lines proportionally to line value** and becomes part of inventory cost (not a period expense). Invoice discount is allocated the same way.
- Weighted-average cost updates on posting (v1 §5.13). Posting increases stock, creates the supplier payable and the payments (cash-drawer payments appear in the daily closing as cash out).
- **Drafts (مسودة):** a purchase can be saved as a draft (no stock/ledger effect, editable, listed under "مسودات المشتريات") and posted later — useful for long entries on a phone.
- Unchanged: purchase returns, supplier payments, voiding rules, period/day locks.
- **Tests:** buy 10 units at 20.00 with 30.00 shipping → landed unit cost 23.00; existing stock 5 @ 20.00 + this purchase → average cost **22.00** ((100 + 230) ÷ 15); inline new item appears in the invoice and inventory; draft has no stock effect until posted; margin prompt appears when cost exceeds the old price.

---

## R12. Is the Design a Ledger? — Decision and Journal Milestone

**Honest assessment of the current design (v1–v3-Lite):**
- **Stock = a true append-only ledger** (`stockMovements`), quantities derived from it. ✔
- **Documents** (invoices, purchases, returns, payments…) are immutable; corrections via void/return. ✔
- **Money = derived, not journaled.** Cash/bank balances, receivables, payables and profit are *computed* from documents each time. There is **no double-entry journal and no chart of accounts.** ✘

**Consequences:** reports can silently diverge if two code paths compute the same figure differently; there is no standard trial balance/general ledger for the accountant; "balance sheet balances" is a *test*, not a *guarantee by construction*.

**Decision:** add a lightweight **double-entry journal** as the **single source of truth for money**, keeping the sub-ledgers (stock movements, customer/supplier statements) as detail. **Do this last (after R1–R11 are verified)** and protect it with parity tests.

### R12.1 Model
- `chartOfAccounts` (fixed defaults, owner can add expense accounts): cash drawer(s), bank, wallets; accounts receivable (customers); employee advances; inventory; prepaid expenses; accounts payable (suppliers); customer credits; accrued salaries; tax payable; owner capital / opening equity; owner drawings; sales revenue; sales returns & allowances (contra-revenue); other income (rounding, cash surplus); COGS; inventory losses; inventory revaluation; operating expenses by category; salaries expense; cash shortages; bad debts.
- `journalEntries`: `id, date, time, createdAt, sourceType, sourceId, description, lines[{accountId, debitMinor, creditMinor, partyId?}]`. **Every entry must balance (Σ debit = Σ credit)**; the service refuses to post otherwise. Entries are immutable; a void creates a **reversing entry**. Period/day locks apply.

### R12.2 Posting rules (one function per event, inside the same transaction as the document)
| Event | Debit | Credit |
|---|---|---|
| Sale | Cash/Bank (paid), Receivables (due) | Sales revenue (net of discount, excl. tax), Tax payable |
| Sale cost | COGS (snapshot cost) | Inventory |
| Overpayment → credit / other income | Cash | Customer credits / Other income |
| Customer payment | Cash/Bank | Receivables (excess → Customer credits) |
| Sales return | Sales returns (+ Tax payable) | Cash/Bank, Receivables or Customer credits |
| Return restocked | Inventory | COGS |
| Purchase (incl. landed costs) | Inventory | Payables, Cash/Bank |
| Supplier payment | Payables | Cash/Bank |
| Purchase return | Payables / Cash | Inventory |
| Expense (single) | Expense account | Cash/Bank |
| Spread expense | Prepaid (on payment); then monthly Expense | Cash; then Prepaid |
| Payroll accrual | Salaries expense | Accrued salaries, Employee advances (repayment) |
| Salary payment | Accrued salaries | Cash/Bank |
| Advance | Employee advances | Cash/Bank |
| Stock loss / shortage | Inventory losses | Inventory |
| Cost revaluation | Inventory ↔ Inventory revaluation | (opposite) |
| Daily cash difference | Cash shortages ↔ Cash | (opposite: Cash ↔ Other income) |
| Bad debt write-off | Bad debts | Receivables |
| Owner capital / drawings | Cash ↔ Owner capital / Drawings ↔ Cash | |
| Transfer | Destination account | Source account |
| Opening balances (system start) | assets | liabilities + Opening equity (balancing) |

The **daily allocation of R5 is a reporting view only** — it is not journaled; the journal stays at true posting dates (monthly accrual).

### R12.3 Reports from the journal
Profit & Loss, balance sheet, **trial balance**, **general ledger** per account (with filters), journal view, account statements, cash flow, Month Review figures — all computed from the journal. Sub-ledger **reconciliation** (Integrity Checker): AR control = Σ customer balances; AP control = Σ supplier balances; Inventory control = Σ(qty × average cost); Prepaid, accrued salaries, advances = their sub-records; trial balance balances; every document has exactly its expected entries. The Accountant Package (v3-Lite §8) adds **Trial Balance, General Ledger and Journal** sheets.

### R12.4 Migration and parity (critical)
- On upgrade, **replay all existing documents in chronological order** to generate the journal (mark opening entries), then run reconciliation.
- **Parity test:** on seeded data and on a copy of the owner's backup, every report figure computed from the journal equals the previously derived figure **to the cent** (P&L per month, balance sheet at every month-end, account balances, customer/supplier balances, inventory value). Only after parity passes, switch the reports to the journal; keep the old derivations as test oracles.

---

## 2. Data Model & Migration Summary

- `products/variants`: `categoryId` optional; add `itemCode`, `hasVariants`, `unit`, `searchKey`; migrate old `sku` → `itemCode` (ensure uniqueness; resolve duplicates by suffix) and keep barcodes.
- Sales lines: add `listPriceMinor`, `priceDiffMinor`; sales: `overpaymentMinor`, `overpaymentMode`, `changeGivenMinor`.
- All documents: `time`; backfill from `createdAt`.
- `recurringExpenses`: `frequency`, `allocateDaily`, `basis`; expenses: `allocateDaily`, `serviceStart/serviceEnd`.
- `salesReturns`: lines `reference|null`, header `mode`, `flags[]`, `customerId|null`; relax any "invoice required" validation.
- New: `customerWriteOffs`; `stockMovements.type` adds `"revaluation"`; purchases: `status` adds `"draft"`, `extraCostsMinor`, per-line `allocatedExtraMinor`.
- Settings: `timeFormat`, `minMarginPercent`, `cashierUnlinkedReturnLimitMinor`, `dayViewAllocation`, `cashierMaxDiscountPercent` (exists).
- R12: `chartOfAccounts`, `journalEntries`.
- Bump `schemaVersion`; write and test migrations; old backups must restore and migrate.

## 3. Acceptance (summary — each item's tests are listed in its section)

All R1–R11 tests green; R12 parity test green; all v1–v3-Lite tests still green; the daily closing, period closing, backup/restore and accountant package tests still pass with the new fields; a manual checklist update in `docs/CHECKLIST.md` covering: quick-add item without category, sell above list price and choose each overpayment option, search by name/code/barcode in every picker, rent daily allocation in the Day Report, credit sale breakdown on the dashboard, invoices table on phone and desktop, date + time everywhere, an unlinked return by owner and by cashier, statements with item names, a purchase with an inline new item, and (after R12) trial balance and general ledger.

## 4. Milestones

M1 R1 items · M2 R3+R4 search · M3 R2 pricing/overpayment · M4 R6 credit-sales presentation + write-off · M5 R7 invoices table · M6 R8 date-time · M7 R9 returns · M8 R10 statements + item card · M9 R11 purchases · M10 R5 recurring expenses + daily allocation · M11 migration/regression sweep · **M12 R12 journal (last)**.

## 5. Kickoff Prompt (copy to the AI together with the spec files in `docs/specs/`)

```
You are a senior full-stack engineer with strong accounting knowledge and a meticulous QA mindset.

Read CLAUDE.md and docs/MAP.md first if they exist. Then read completely: docs/specs/BeeStore-Project-Spec.md (v1), BeeStore-v2-Monthly-Periods.md (v2), BeeStore-v3-Lite.md (v3-Lite), and BeeStore-v4-Changes.md (v4). v4 wins over the others on conflict. Do NOT implement BeeStore-v3-Offline-Sync.md.

Implement the v4 change requests R1-R11 in the order of the v4 milestones, then R12 (the journal) last. For each item: reproduce the current behavior if it is a defect, implement, add tests (including the numeric scenarios in the spec), write migrations for any data-model change (existing data and old backups must keep working), and update CLAUDE.md, docs/MAP.md and docs/CHANGELOG.md.

Rules: complete working code only (no placeholders, TODOs or pseudo-code); integer money; local YYYY-MM-DD business dates; atomic postings; day and month locks enforced inside services; keep the classic-script structure (no ES modules); Arabic RTL UI; the app must keep working fully offline. Work in small verified steps and run the tests after each; never claim something works unless you ran it and state clearly what you could not verify. Don't ask questions unless truly blocked; otherwise choose the simplest option consistent with the specs and record it in the README "Decisions".

Start with a short written plan and any risks or conflicts you see between v4 and the existing code, then begin with milestone M1.
```
