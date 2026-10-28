# Bee Store (بي ستور) — v5 Accounting Core
## Double-Entry Journal First · Posting Rules · Card Clearing & Fees · Unpaid Expenses · Payroll Components · Controls

> **Companion to v1 (`BeeStore-Project-Spec.md`), v2 (`BeeStore-v2-Monthly-Periods.md`), v3-Lite (`BeeStore-v3-Lite.md`) and v4 (`BeeStore-v4-Changes.md`). Where v5 conflicts with them, v5 wins. v5 replaces v4 section R12 and changes the build order (§13).**
> Same ground rules: complete working code, no placeholders/`TODO`s, Arabic RTL UI, integer money, local `YYYY-MM-DD` business dates, atomic postings, day/month locks inside services, classic scripts (no ES modules), a regression test for every change, honest reporting of anything unverified. Do not stop to ask questions — decisions are made below; record extra assumptions in the README "Decisions".

---

## 0. Purpose and Honest Limits

The owner requires a **professional accounting system with a real ledger and no accounting errors**. Software cannot *guarantee* zero errors, so this spec makes errors **impossible by construction where possible, detectable everywhere else, and provable by tests** — and adds the human controls a real bookkeeping process needs (accountant review, parallel run). The system must **never silently plug a difference**: an imbalance is a bug and must stop the posting.

**Out of scope / owner decisions already made**
- **VAT / sales tax: NOT used** (the shop is not registered). Tax features are removed from the UI and every posting; fields stay `0`/`null` for future use; account `2300 Tax payable` is reserved but not created. If the shop registers later, a full VAT module (input and output tax, returns, reports, invoice requirements) must be designed with the accountant — do **not** half-implement it now.
- **Card/wallet commissions: YES** → full clearing, settlement and fee handling (§6).
- **Fixed assets & depreciation: undecided (owner will ask the accountant)** → implement the module but **disabled by default**, with a capitalization warning (§8).
- Single currency, single shop, integer quantities.

---

## 1. Accounting Contract (non-negotiable rules)

1. **The journal is the single source of truth for money.** Sub-ledgers hold *detail* (stock movements, customer/supplier statements, payroll, fixed-asset register, card settlements) and **must reconcile to control accounts** (§9). No report may compute money from documents by its own formula — reports read the journal.
2. **Double entry, always balanced.** Every entry: Σ debits = Σ credits, all amounts positive integers in minor units, each line either debit or credit. The service **rejects** an unbalanced entry; there are no "rounding plugs".
3. **Append-only.** Journal entries are never updated or deleted. A void/correction creates a **reversing entry** (`reversalOf`), dated the original date (the period is guaranteed open by the lock rules), and the original document stays visible as void.
4. **One posting per economic event, in the same transaction as the document.** Table-driven posting functions (§4), pure and unit-tested. A document and its entries are saved atomically or not at all. Each document stores `journalEntryIds[]`.
5. **Accrual basis** (v2 §4). Cash views are derived from cash, bank and clearing accounts.
6. **Locks apply to the journal:** entries cannot be posted to a closed month (v2) or against a closed day (v3-Lite) except by the documented reopen procedures. System-generated *scheduled* entries (§4 rule S) fall in future open months.
7. **Sequential numbering:** `JE-000001`… gapless, assigned inside the transaction.
8. **Rounding is explicit and deterministic** (§3.1). Half-up rounding; remainders allocated by a fixed rule; never an unexplained difference.
9. **Audit trail:** every entry records `createdAt`, profile/user, source document, `postingVersion` (the rules version that produced it, so future rule changes never rewrite history).

---

## 2. Chart of Accounts (seeded; system accounts cannot be deleted or renamed in code)

`type` ∈ asset / liability / equity / revenue / expense / contra. Owner may add **expense accounts** (these replace v2's expense categories: each category *is* an expense account `6xxx`) and bank/wallet accounts.

| Code | Account | Type | Notes |
|---|---|---|---|
| 1010 | الصندوق (Cash drawer) | asset | `cashDrawerAccountId` |
| 1020+ | البنوك (Bank accounts) | asset | one per bank account |
| 1050+ | حسابات تسوية البطاقات/المحافظ (Clearing) | asset | one per electronic method (§6) |
| 1100 | الذمم المدينة – الزبائن (AR) | asset | `partyId` = customer |
| 1150 | سلف الموظفين | asset | `partyId` = employee |
| 1200 | المخزون | asset | control for stock sub-ledger |
| 1300 | مصاريف مدفوعة مقدماً | asset | prepaid / spread expenses |
| 1500 / 1590 | الأصول الثابتة / مجمع الإهلاك | asset / contra | only if module enabled |
| 2010 | الذمم الدائنة – الموردون (AP) | liability | `partyId` = supplier |
| 2020 | مستحقات ومصاريف غير مدفوعة | liability | unpaid expenses |
| 2030 | أرصدة الزبائن الدائنة | liability | credits/deposits, `partyId` |
| 2100 | رواتب مستحقة | liability | net pay owed |
| 2110 | استقطاعات الرواتب المستحقة | liability | withholdings owed to authorities |
| 2120 | مساهمات صاحب العمل المستحقة | liability | employer contributions owed |
| 2200 | مخصص نهاية الخدمة | liability | optional component |
| 3010 | رأس المال | equity | owner capital in |
| 3020 | مسحوبات المالك | contra-equity | drawings |
| 3030 | حقوق الملكية الافتتاحية | equity | system balancing at start |
| — | الأرباح المحتجزة / ربح السنة | equity | **derived** from revenue/expense accounts (no closing entries) |
| 4010 | إيرادات المبيعات | revenue | net of discounts |
| 4020 | مردودات المبيعات | contra-revenue | |
| 4100 | إيرادات أخرى | revenue | rounding/overpayment, cash surplus |
| 4110 | أرباح بيع الأصول | revenue | module only |
| 5010 | تكلفة البضاعة المباعة (COGS) | expense | |
| 5020 | خسائر/فروقات المخزون | expense | adjustments, shrinkage |
| 5030 | تسوية تكلفة المخزون | expense | revaluation / purchase variance |
| 6010… | مصاريف تشغيلية (إيجار، كهرباء، ماء، إنترنت، …) | expense | seeded from v2 categories; owner-extendable |
| 6100 | الرواتب والأجور | expense | |
| 6110 | تكاليف صاحب العمل على الرواتب | expense | optional component |
| 6120 | مصروف نهاية الخدمة | expense | optional component |
| 6200 | عمولات البطاقات والمحافظ | expense | §6 |
| 6300 | مصروف الإهلاك | expense | module only |
| 6350 | خسائر بيع الأصول | expense | module only |
| 6400 | عجز الصندوق | expense | daily closing |
| 6410 | ديون معدومة | expense | write-offs |

Reserved/blocked uses (v2 §6.4 stays): you cannot post salaries, purchases, drawings, advances or card fees through a generic expense.

---

## 3. Core Policies (explicit — do not guess)

### 3.1 Rounding & allocation
- Round **half up** to the minor unit.
- **Discount allocation** (line + invoice discounts across lines) and **landed-cost allocation** (purchases): proportional to line value using the **largest-remainder method** so allocated parts always sum exactly to the total; ties broken by line order.
- No computation may produce a difference that is "absorbed" elsewhere.

### 3.2 Inventory valuation — weighted average with *tracked value*
Integer money + average cost creates drift unless value is tracked. Therefore **each variant stores `valueMinor`** (total inventory value) alongside `quantity`; **average cost = valueMinor ÷ quantity** (derived, displayed rounded). Stock movements store `valueChangeMinor` and `valueAfterMinor` (v2's `avgCostAfterMinor` becomes derived).
- Purchase of `q` units for total cost `C`: `value += C`, `qty += q`.
- Sale/consumption of `q` units from quantity `Q` and value `V`: **COGS = round(V × q ÷ Q)**; if `q == Q`, **COGS = V** (the last unit takes the exact remainder). `value −= COGS`.
- Example: buy 3 units for 100.00 (V = 10000, Q = 3). Sell 1 → 33.33 (V 6667, Q 2). Sell 1 → round(6667 ÷ 2) = 33.34 (V 3333, Q 1). Sell last → 33.33 (V 0). **Total COGS 100.00; inventory exactly 0.**
- Negative stock is disallowed by default (`allowNegativeStock` false). If enabled: cost of an unsupported sale uses the last known average; flag `COST_ESTIMATED`; adjusted when stock is replenished is **not** attempted (document the limitation).
- Linked returns restock at the **original sale cost** (value added back); unlinked returns restock at the current average (v4 R9).
- Inventory control account `1200` must equal Σ variant `valueMinor` **exactly**.

### 3.3 Revenue & credit
Revenue recognized at invoice date, net of discounts (v2 §4, v4 R6). Overpayment, change, credit use follow v4 R2.

### 3.4 Expenses
Recognized by expense date; unpaid expenses go to **2020** and are paid later (§7). Spread/prepaid and depreciation use **scheduled entries** (rule S below). Day-level daily allocation (v4 R5) is **reporting only and is never journaled.**

### 3.5 Opening balances (at `systemStartDate`)
One `OPENING` entry set dated the start date: cash/bank balances, customer receivables (by party), supplier payables (by party), opening stock at cost (from `opening` movements, with `valueMinor`), employee advances, prepaid, with **3030 Opening equity** as the balancing amount (shown on the balance sheet).

---

## 4. Posting Rules (one function per event; all in the document's transaction)

Notation: Dr/Cr; "[party]" = party dimension on the line. Cash receipt goes to the account behind the payment method (§6): cash drawer, bank (direct), or a clearing account.

| # | Event | Debit | Credit |
|---|---|---|---|
| 1 | **Sales invoice** | per payment: Cash / Bank / **Clearing(method)** / **Customer credits 2030** (credit used) ; AR 1100 [customer] for the unpaid part | 4010 Revenue (net of discounts) ; overpayment kept as credit → 2030 [customer]; kept as other income → 4100 |
| 1b | Sales cost | 5010 COGS (Σ per §3.2) | 1200 Inventory |
| 2 | **Customer payment** | Cash / Bank / Clearing | AR 1100 [customer] (excess → 2030 [customer]) |
| 3 | **Sales return** | 4020 Returns (net refund value) | refund mode: Cash/Clearing/Bank, or AR 1100 [customer] (reduces debt), or 2030 [customer] (credit) |
| 3b | Return restocked | 1200 Inventory (value per §3.2) | 5010 COGS |
| 3c | Return damaged (not restocked) | — (cost stays in COGS as the loss) | — |
| 4 | **Bad-debt write-off** | 6410 Bad debts | AR 1100 [customer] |
| 5 | **Purchase invoice** | 1200 Inventory (lines net of discount + allocated landed costs) | AP 2010 [supplier] (due) ; Cash/Bank (paid now) |
| 6 | **Supplier payment** | AP 2010 [supplier] | Cash / Bank (excess stays as AP debit balance = supplier credit) |
| 7 | **Purchase return** | AP 2010 [supplier] or Cash/Bank (credit received) | 1200 Inventory (value per §3.2) ; any difference to 5030 |
| 8 | **Expense (paid)** | expense account 6xxx | Cash / Bank |
| 8b | **Expense (unpaid / part-paid)** | expense account 6xxx | 2020 for the unpaid part ; Cash/Bank for the paid part |
| 9 | **Expense payment later** | 2020 | Cash / Bank |
| S | **Spread / prepaid expense** | at posting: 1300 Prepaid | Cash / Bank / 2020 (full amount) |
| S | …scheduled monthly release | 6xxx expense (month share) | 1300 Prepaid |
| 10 | **Payroll accrual** (§7.3) | 6100 Salaries (base + bonus + overtime − penalties) ; 6110 Employer costs ; 6120 provision | 2100 Accrued salaries (net) ; 1150 Advances (repayment) ; 2110 Withholdings ; 2120 Employer contributions ; 2200 Provision |
| 11 | **Salary payment** | 2100 | Cash / Bank |
| 11b | **Pay withholdings/contributions** | 2110 / 2120 | Cash / Bank |
| 12 | **Employee advance** | 1150 [employee] | Cash / Bank |
| 13 | **Stock adjustment** (loss / count shortage) | 5020 | 1200 |
| 13b | Stock gain (count surplus / found) | 1200 | 5020 |
| 14 | **Cost revaluation** (v4 R1) | 1200 ↔ 5030 | (opposite side) |
| 15 | **Daily cash difference** | shortage: 6400 ; surplus: Cash | shortage: Cash ; surplus: 4100 |
| 16 | **Owner capital / drawings** | Cash/Bank ; 3020 Drawings | 3010 Capital ; Cash/Bank |
| 17 | **Transfer** (cash ↔ bank) | destination account | source account |
| 18 | **Card/wallet settlement** (§6) | Bank (net) ; 6200 Fees | Clearing (gross) |
| 19 | **Fixed asset purchase / depreciation / disposal** (§8) | 1500 ; 6300 ; Cash, 1590, 6350 | Cash/Bank/2020 ; 1590 ; 1500, 4110 |
| 20 | **Opening balances** | assets | liabilities + 3030 |
| 21 | **Void of any document** | mirror of its entries | mirror (reversalOf) — including its scheduled entries |

**Rule S (scheduled entries):** spread releases and depreciation are created **at posting time as future-dated entries**, one per month, dated `max(first day of the month, document date)`. Reports and balance sheets include only entries up to their end date, so future entries do not appear early. Voiding the source reverses all of them. Scheduled entries cannot be created inside closed months (guaranteed by the document locks).

---

## 5. Journal Data Model

- `chartOfAccounts`: `id, code, nameAr, type, system(bool), active, parentCode?`.
- `journalEntries`: `id, number (JE-000001), date, time, createdAt, sourceType, sourceId, description, lines[], reversalOf|null, isScheduled(bool), postingVersion, profile`.
- `lines[]`: `accountId, debitMinor, creditMinor, partyType|null ("customer"|"supplier"|"employee"), partyId|null, memo`.
- Repository API: `append` only for `journalEntries` — update/delete **throw**; enforced by tests.
- Every document gains `journalEntryIds[]`. Sub-ledger records keep their own detail (stock movements with `valueChangeMinor`, party statements derived from journal lines by `partyId`, etc.).
- **Performance:** partition journal entries by month for lazy loading (v3-Lite §5); `periodClosings.snapshot` additionally stores **per-account balances at month end** so a trial balance as of any date = last closed snapshot + later movements. Maintain in-memory running balances per (account, month), cleared on commit and rebuilt lazily.

---

## 6. Card & Wallet Payments, Clearing and Fees

**Problem:** a 1,000.00 card sale does not put 1,000.00 in the bank — the provider pays later, net of commission.

- **Payment method settings** (`paymentMethods[]`): `{ id, nameAr, kind: "cash" | "bank_direct" | "clearing" | "customer_credit", accountId, feeBasisPoints (e.g. 200 = 2.00%), feeFixedMinor, settlementDays (informational) }`. Defaults: نقدي → cash drawer; بطاقة and محفظة → **clearing** accounts (one each); تحويل بنكي → bank (direct); رصيد الزبون → customer_credit.
- **At sale:** Dr Clearing(method) gross, Cr Revenue (rule 1). **Daily closing** (v3-Lite §4): the optional external totals per method compare with the terminal/wallet totals.
- **Settlement document (تسوية البطاقات/المحافظ):** `method, date, time, grossMinor (amount cleared), feeMinor, netReceivedMinor, bankAccountId, reference, note`. Validation: `gross = fee + net`; `gross ≤ unsettled clearing balance` of that method (excess rejected unless owner confirms with flag `OVER_SETTLED`). Entry (rule 18): Dr Bank net, Dr 6200 Fees, Cr Clearing gross. **Partial settlements allowed.**
- The screen pre-fills the **expected fee** = Σ unsettled sales × fee rate (+ fixed fee per transaction); the owner enters the **actual** figures from the provider statement; the **difference between expected and actual fee** is shown (never hidden).
- **Reports:** unsettled amounts by method with aging (days since sale), fees by month, effective fee rate; clearing balance = control account reconciled to unsettled sales (§9).
- **Refunds** to the same method credit the clearing account (rule 3). Chargebacks/disputes are out of scope (record as adjustments with the accountant).
- **Tests:** card sale 1,000.00 with 2% fee → clearing 1,000.00; settlement gross 1,000.00 / fee 20.00 / net 980.00 → bank +980.00, fees 20.00, clearing 0; actual fee 21.50 / net 978.50 → fee 21.50, expected-vs-actual difference 1.50 shown; partial settlement leaves the remainder in clearing; over-settlement blocked.

---

## 7. Unpaid Expenses, Payroll Components

### 7.1 Unpaid expenses (accrued)
`expenses` gain `paymentStatus` ("paid"|"partial"|"unpaid"), `paidMinor`, `payee` (free text or `supplierId`), `dueDate`; new `expensePayments` (`expenseId, date, time, amountMinor, method/account`). Posting rules 8b/9. Pages: **"مستحقات غير مدفوعة"** list with aging; payments appear as cash out in the daily closing on the payment day (not the accrual day). **Test:** electricity bill dated Oct 31, 120.00, unpaid → October P&L −120.00, other payables 120.00; paid Nov 10 → cash −120.00 in November, November P&L unaffected.

### 7.2 Payroll components (configurable, default only what is needed)
Component types: **earning** (base, bonus, overtime), **deduction** (penalty/absence), **advance repayment**, **employee withholding** (insurance/tax withheld; liability 2110), **employer cost** (employer share; expense 6110 + liability 2120), **end-of-service provision** (optional, % of base per month → 6120/2200; **off by default**; amounts and legal basis to be decided with the accountant). Components are defined in Settings with account mapping and optional percentage-of-base rules; **all optional components are off by default.** The accountant must confirm legal rates and treatment — do not hard-code any country's rates.

### 7.3 Payroll posting and example (acceptance test)
Base 1,000.00; bonus 100.00; penalty 50.00; advance repayment 200.00; employee withholding 60.00; employer cost 90.00.
- Salaries expense (6100) = 1,000 + 100 − 50 = **1,050.00**; employer cost (6110) **90.00**.
- Net pay accrued (2100) = 1,050 − 200 − 60 = **790.00**; advances (1150) −200.00; withholdings (2110) 60.00; employer contributions (2120) 90.00.
- Check: debits 1,050 + 90 = 1,140 = credits 790 + 200 + 60 + 90 = 1,140 ✔.
- Salary payment: Dr 2100 / Cr Cash 790.00. Paying the authorities later: Dr 2110 60.00 + Dr 2120 90.00 / Cr Bank 150.00.

---

## 8. Fixed Assets & Depreciation (module **disabled by default**)

- **Setting `fixedAssetsEnabled` (false).** When **false**: any single expense ≥ `capitalizationWarnThresholdMinor` (default **500.00**) shows a warning "هل هذا أصل ثابت؟ اسأل المحاسب" with options: record as a normal expense, **spread over months** (v2 §6.3 / rule S), or cancel — preventing a large equipment purchase from distorting one month's profit.
- When **true**: asset register (name, cost, purchase date, useful life in months, salvage value, method = straight-line, status). Purchase: Dr 1500, Cr Cash/Bank/2020. **Depreciation starts the month after purchase;** monthly amount = (cost − salvage) ÷ life, remainder cents in the last month; scheduled entries (rule S): Dr 6300, Cr 1590. **Disposal:** void remaining scheduled depreciation, then Dr Cash (proceeds), Dr 1590 (accumulated), Dr 6350 (loss) or Cr 4110 (gain), Cr 1500 (cost).
- Example: shelf 1,200.00, 24 months, straight-line = **50.00/month**; after 10 months accumulated 500.00, book value 700.00; sold for 600.00 → Dr Cash 600.00 + Dr 1590 500.00 + Dr 6350 100.00 = Cr 1500 1,200.00 ✔.
- Everything here is **reviewed by the accountant before enabling** (see §11).

---

## 9. Controls & Reconciliations (Integrity Checker additions; run on demand, daily, and before every month close)

1. **Trial balance balances** (Σ debits = Σ credits) globally and per month; every entry balances; entry numbers gapless; no update/delete of entries.
2. **Control accounts = sub-ledgers (exact):** AR 1100 = Σ customer balances; AP 2010 (+2020) = Σ supplier balances (+ unpaid expenses); Inventory 1200 = Σ variant `valueMinor` and = Σ stock-movement value changes; Customer credits 2030 = Σ customer credits; Clearing = Σ unsettled card sales − settlements; Prepaid 1300 = unreleased schedule; Accrued salaries/withholdings/contributions = payroll records; Advances 1150 = Σ employee advance balances; Fixed assets = register.
3. **Document ↔ journal:** every posted document has exactly its expected entries (re-run the posting function and compare); every void has its reversal; no orphan entries.
4. **Cash:** cash-drawer account balance = last closing's retained float + later movements; bank/clearing balances shown for the accountant to compare with statements.
5. **Statements:** balance sheet balances by construction; closed-month snapshots equal recomputation (including per-account balances).
6. **Periods:** nothing posted in closed months after the close; scheduled entries only in future months.
7. Failures are listed with the affected record and never auto-"fixed" except pure derived caches.

---

## 10. Reports From the Journal

Trial balance (as of date / period movement), **general ledger** per account (filters by date/party/source, running balance), **journal** (all entries, search by number/source/account), Profit & Loss (by account groups; monthly comparison; v2/v4 views), Balance sheet, Cash-flow (direct, by source, from cash/bank/clearing accounts) + the v2 profit⇄cash reconciliation, customer/supplier statements (journal lines by party; v4 R10 presentation), inventory valuation (sub-ledger = control), unsettled card report, unpaid-expenses aging, fees report. **Every document gets a "عرض القيد المحاسبي" button** showing its journal entries (transparency for the accountant). The Accountant Package (v3-Lite §8) adds sheets: Chart of Accounts, Trial Balance, General Ledger, Journal, Reconciliations, Card Settlements, Unpaid Expenses.

---

## 11. Human Controls (the AI must produce these documents)

1. **`docs/ACCOUNTANT_REVIEW.md`** for the owner's accountant: the chart of accounts; the posting-rules table with **a numeric sample entry for every event**; the policies of §3 (rounding, weighted-average with tracked value, revenue recognition, returns, unpaid expenses, prepaid/depreciation timing); the month-end procedure; and **open questions for sign-off**: (a) fixed-asset capitalization threshold and depreciation policy; (b) end-of-service and employer payroll contributions and their legal rates; (c) confirm VAT non-registration and invoice requirements; (d) treatment of card fees and settlements; (e) inventory costing method acceptance; (f) revenue recognition for credit sales and bad-debt policy; (g) year-end procedure and any statutory filings.
2. **`docs/PARALLEL_RUN.md`** and a comparison sheet template: for **one full month**, the accountant keeps their own books next to the app; at month end compare (total sales, returns, cash and bank balances, receivables, payables, inventory value, expenses by category, salaries, card fees, net profit). Differences are investigated and fixed before the owner relies on the system. Recommended: repeat for the first **quarter-end**.
3. **Owner routines** in the Arabic guide: never edit data outside the app; close days and months on time; compare cash/bank balances with real statements monthly; keep off-device backups; ask the accountant before changing account settings.

---

## 12. Tests & Acceptance

**Invariant tests (property-based, random sequences of all event types, including voids, returns, reopen):** trial balance always balances; every entry balances; control accounts always equal sub-ledgers; no mutation of entries; period/day locks respected; inventory never drifts from value tracking.

**Numeric scenarios (exact):**
1. **Inventory rounding:** purchase 3 units for 100.00; sell 1, 1, 1 → COGS 33.33 / 33.34 / 33.33; inventory 0.00; journal inventory equals sub-ledger after each step.
2. **Card settlement:** §6 test values.
3. **Unpaid expense:** §7.1 test values.
4. **Payroll components:** §7.3 values (including payments of net pay and of liabilities).
5. **Fixed asset (module enabled):** §8 example; with the module disabled a 1,200.00 expense triggers the warning and spreading over 12 months releases 100.00/month via scheduled entries; voiding the source reverses all releases.
6. **Void/reversal:** voiding a sale restores revenue, COGS, inventory, cash and AR via reversing entries; trial balance still balances; the month's P&L is as if the sale never happened.
7. **Opening balances:** system start with cash 5,000.00, one customer owing 300.00, stock worth 450.00 → Opening equity 5,750.00; balance sheet balances on day one.
8. **Day-1 end-to-end:** the v2 §13.2 and v3-Lite §12.1 acceptance scenarios still produce the same figures — now **from the journal**.
9. **Migration parity (existing data):** replay all existing documents to build the journal; run a **parity report** comparing P&L per month, balance sheet at each month end, account balances, customer/supplier balances and inventory against the previous derived reports. **Only differences caused by the new inventory rounding rule (§3.2) are allowed**, each traced to a stock movement, with the total absolute difference per month printed; **any other difference is a failure** and blocks switching reports to the journal. The owner/accountant approves the parity report before the cut-over.
10. Existing tests from v1–v4 still pass.

---

## 13. Build Order (supersedes v4 §4)

**Journal first**, then features built on top of it:
- **A1** Chart of accounts, journal core (append-only repository API, numbering, balance enforcement), trial balance, invariant tests.
- **A2** Inventory value tracking (`valueMinor`, `valueChangeMinor`), rounding rules, COGS posting.
- **A3** Posting rules for all **existing** documents (rows 1–21 except the new modules), migration replay, **parity report**, switch reports to the journal.
- **A4** New modules: card/wallet clearing + settlement + fees; unpaid expenses + payments; payroll components; scheduled entries (spread/prepaid); fixed assets (off by default) + capitalization warning; tax UI removal.
- **A5** Journal-based reports, "عرض القيد" buttons, Accountant Package additions, `docs/ACCOUNTANT_REVIEW.md`, `docs/PARALLEL_RUN.md`.
- **A6** Integrity Checker extensions (§9), property tests, performance tests (50,000 invoices; trial balance ≤ 1 s with snapshots).
- **Then v4 milestones M1–M11.** Every posting those features introduce (overpayment modes, write-off, landed costs, unlinked returns, cost revaluation, etc.) **must go through the journal posting rules above**; v4 R12 is replaced by this document.

If a project already exists: audit first (v2 §14 Phase A), keep working modules, never leave the app broken, update `CLAUDE.md`, `docs/MAP.md`, `docs/CHANGELOG.md` after each task, and finish with an honest report of what is verified and what is not.

---

## 14. Kickoff Prompt (copy to the AI together with the spec files in `docs/specs/`)

```
You are a senior full-stack engineer with strong accounting knowledge and a meticulous QA mindset.

Read CLAUDE.md and docs/MAP.md first if they exist. Then read completely: docs/specs/BeeStore-Project-Spec.md (v1), BeeStore-v2-Monthly-Periods.md (v2), BeeStore-v3-Lite.md (v3-Lite), BeeStore-v4-Changes.md (v4), BeeStore-v5-Accounting-Core.md (v5). v5 wins over all others on conflict and replaces v4 section R12 and the v4 build order. Do NOT implement BeeStore-v3-Offline-Sync.md.

Goal: a professional double-entry accounting core where the journal is the single source of truth for money, with no unexplained differences anywhere. Follow v5 section 13: milestones A1-A6 first (journal core, inventory value tracking, posting rules for existing documents with a migration parity report, card clearing and fees, unpaid expenses, payroll components, optional fixed assets disabled by default, journal-based reports, controls, accountant documents), then the v4 milestones M1-M11 on top of the journal.

Rules: complete working code only (no placeholders, TODOs or pseudo-code); integer money with the rounding rules of v5 section 3; local YYYY-MM-DD business dates; every posting atomic and balanced; journal entries append-only; day and month locks enforced inside services; keep the classic-script structure (no ES modules); Arabic RTL UI; the app must keep working offline. Never plug a difference: an unbalanced posting is a bug and must be rejected. Work in small verified steps, run the tests after each, add a regression test for every bug, and never claim something works unless you ran it, stating clearly what you could not verify. Existing data and old backups must keep working through migrations. After each task update CLAUDE.md, docs/MAP.md and docs/CHANGELOG.md.

Start with a short written plan, the risks and conflicts you see between v5 and the existing code, and any gaps you find in the specs themselves; then begin with milestone A1.
```
