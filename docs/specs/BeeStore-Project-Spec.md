# Bee Store (بي ستور) — Accounting & Inventory System
## Full Project Specification for the Implementing AI

> **Read this whole document before writing any code.** Build everything described here as a complete, runnable project. No placeholders, no `TODO`s, no pseudo-code, no "left as an exercise". If something is ambiguous, choose the simplest option consistent with this document and record the choice in the README under "Decisions". Do not stop to ask questions — the key decisions are already made below.

---

## 1. Project Summary

**Client:** Bee Store (بي ستور), a children's clothing retail shop (single branch, owner-operated, a few employees).

**Goal:** One integrated system where nothing is recorded twice. The owner enters stock once (purchase invoices / product setup) and creates sales invoices; the system automatically updates stock, customer/supplier balances, cash/bank balances, profit and reports.

**The owner is non-technical.** The app must be trivial to start (open one file), safe against data loss (automatic backups with a clearly visible save status), and fully **Arabic, right-to-left**.

**Phased delivery**
- **Phase 1 (this document):** A **fully client-side web app — plain JavaScript in the browser. No server, no Node.js, no installation, works offline.** Data lives in the browser's IndexedDB and is continuously mirrored to a **real JSON file** (plus dated backups) inside a folder the owner chooses. Used for trial.
- **Phase 2 (future, NOT built now):** backend + real database, login/roles, hosting. The owner intends to grow into this once the trial proves the system. Phase 1 must therefore be architected so the upgrade is mechanical: (a) swap the storage layer, (b) swap the thin API facade from "call services in the browser" to "call REST", (c) move the unchanged service code to the server. See §4 and the required `docs/PHASE2_MIGRATION.md`.

---

## 2. Technology Requirements (Phase 1)

| Concern | Requirement |
|---|---|
| Supported browsers | Desktop **Chrome or Edge** (primary). On any other browser, show a friendly Arabic banner explaining that automatic file saving is unavailable and manual backups are needed. Feature-detect (`indexedDB`, `showDirectoryPicker`, `navigator.locks`) instead of sniffing the user agent. |
| Delivery | A plain folder containing `index.html`. Opens by **double-click** (`file://`). No web server, no npm, no build step for the owner. |
| Language | Plain HTML + CSS + vanilla JavaScript. No frameworks, no bundlers. |
| Scripts | **Do NOT use ES modules** (`type="module"` is blocked on `file://` in Chrome). Use classic `<script>` tags loaded in dependency order, one global namespace `window.BeeStore`, each file wrapped in an IIFE. Utility, storage-interface and service files must also support Node: end each with `if (typeof module !== "undefined") module.exports = …` so tests can load them in Node. |
| No `fetch` of local files | `fetch()` of local files is blocked on `file://`. Embed demo data and templates in `.js` files instead. |
| Offline | Vendor every library in `vendor/` (Chart.js for charts, JsBarcode for Code128) and bundle an Arabic font (Tajawal or Cairo, via relative `@font-face`) with a system-font fallback. **No CDN links, no external requests at all.** |
| Working storage | **IndexedDB**, one object store per collection (see §5, §11). |
| JSON file | **File System Access API** (`showDirectoryPicker`): continuous mirror to `db.json` + dated backups in an owner-chosen folder (see §11). |
| Tests | `node --test` (developer-only; the owner never needs Node). See §14. |

If a browser blocks a needed feature on `file://`, the README must document the fallback of opening the folder through any static web server (e.g. `python -m http.server`) — but the primary experience must work with a double-click.

---

## 3. Project Structure

```
bee-store/
├─ index.html                 (the file the owner opens)
├─ README.md                  (Arabic, simple, with a "Decisions" section)
├─ css/                       (app.css RTL styles, print.css)
├─ js/
│  ├─ core/                   (namespace.js, config.js, money.js, dates.js, ids.js,
│  │                           validate.js, errors.js)
│  ├─ storage/
│  │  ├─ repository.js        (documented interface contract)
│  │  ├─ idbRepository.js     (browser implementation: IndexedDB + in-memory state)
│  │  ├─ memoryRepository.js  (same interface, in-memory — used by tests)
│  │  ├─ fileSync.js          (folder link, db.json mirror, dated backups, status)
│  │  └─ migrations.js        (schemaVersion upgrades)
│  ├─ services/               (ALL business logic: inventory, sales, returns, purchases,
│  │                           customers, suppliers, expenses, payroll, accounts,
│  │                           reports, settings, backup, audit)
│  ├─ api/api.js              (the thin facade the UI calls — see §10)
│  ├─ ui/                     (router.js, components, dialogs, print helpers)
│  ├─ pages/                  (one file per page)
│  └─ demo/demoData.js        (demo dataset embedded as JS)
├─ vendor/                    (chart.js, jsbarcode, fonts)
├─ docs/                      (API.md, DATA_FORMAT.md, PHASE2_MIGRATION.md, CHECKLIST.md)
└─ tests/                     (node --test files + smoke.html for real-IndexedDB checks)
```

---

## 4. Architecture Rules (critical for Phase 2)

1. **The UI talks only to `BeeStore.api`** (the facade in §10). It never touches the repository, IndexedDB or the file system directly.
2. **All business rules live in `services/`.** Services are pure JavaScript: no DOM, no direct IndexedDB/File System access, no `window` usage. They depend only on the repository interface. They must run **unchanged in Node** (for tests now, for the backend in Phase 2).
3. **Repository interface** (`repository.js`, implemented by `idbRepository` and `memoryRepository`): `open()`, `get(collection, id)`, `list(collection, predicate?)`, `query(collection, indexName, valueOrRange)`, `transaction(fn)`, `exportAll()`, `importAll(json)`, `clearAll()`. Inside a transaction the `tx` object exposes `get`, `list`, `query`, `put`, `remove` (only for non-business data), and `nextCounter(name)`.
4. **Load-to-memory + unit-of-work persistence.** On startup load all collections into memory and build in-memory indexes (barcode, sku, productId, number, date, customerId, supplierId, variantId…) so searches and reports are instant. Every change goes through `repo.transaction(async tx => …)`:
   - Writes are **staged** (copy-on-write); reads inside the transaction see the staged writes.
   - On success, **all** staged puts/deletes plus `meta` (counters, `revision++`) are written in **one IndexedDB readwrite transaction** spanning the needed object stores. Only after IndexedDB confirms (`oncomplete`) is the in-memory state swapped and the file mirror scheduled.
   - If the function throws or IndexedDB fails: **nothing changes** (neither memory nor storage) and a clear Arabic error is shown.
   - Code inside `transaction(fn)` may `await` only `tx` methods (IndexedDB auto-commits if the transaction goes idle).
5. **Every posting operation (sale, purchase, return, void, payment, payroll…) is exactly one transaction.**
6. **Never hard-delete business records.** Use `status: "void"` / `active: false`. Posted invoices are immutable (corrections via void or return).
7. **Snapshots:** an invoice line stores product name, size, color, unit price and **unit cost at time of sale**, so later edits to products never change history.
8. **IDs:** prefixed random IDs (e.g. `prd_x7k2…`). **Human-readable numbers** (invoice numbers) come from counters inside the transaction.
9. **Money:** integers in minor units (agorot/cents). One `money.js` helper for parse/format/round. Currency symbol/code from settings (default `₪` / `ILS`). Display with 2 decimals.
10. **Dates:** `date` fields are business dates `YYYY-MM-DD`; timestamps (`createdAt`) are ISO-8601 UTC. Display Gregorian, Western digits (0-9), local timezone.
11. **Response envelope:** every facade call returns `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code": "...", "message": "<Arabic message>" } }` — the same shape the future REST API will use.
12. **`schemaVersion`** stored in `meta` and in every exported file; `migrations.js` upgrades older data on startup and on restore/import.
13. **Single active tab.** Use the Web Locks API (`navigator.locks`) so only one tab writes. A second tab shows "البرنامج مفتوح في نافذة أخرى" and stays read-only/blocked. (Fallback if locks are unavailable: BroadcastChannel ping + warning.)
14. **`localStorage` is for UI preferences only** (e.g. collapsed sidebar), never for business data.

---

## 5. Data Model

In **IndexedDB**, each collection below is its own object store (`id` as key, plus the in-memory indexes from §4 rule 4), together with a `meta` store (`schemaVersion`, `counters`, `revision`, `savedAt`, `deviceId`). The **JSON file (`db.json`) and all backups** contain everything in one document: `{ schemaVersion, meta, settings, collections: { accounts, categories, products, variants, stockMovements, customers, sales, salesReturns, customerPayments, suppliers, purchases, purchaseReturns, supplierPayments, expenseCategories, expenses, recurringExpenses, employees, payroll, employeeAdvances, ownerTransactions, transfers, dailyClosings, auditLog } }`.

All records have `id`, `createdAt`, `updatedAt`. Fields below are in addition.

### 5.1 settings (single object)
`storeName` ("Bee Store"), `storeNameAr` ("بي ستور"), `phone`, `address`, `logo` (optional data-URI), `currencyCode` ("ILS"), `currencySymbol` ("₪"), `taxEnabled` (default false), `taxRate` (default 0), `taxIncludedInPrices` (default true), `invoicePrefix` ("INV"), `purchasePrefix` ("PUR"), `returnPrefix` ("RET"), `invoiceFooter` (text), `invoicePaperSize` ("A4" | "80mm"), `labelSize` (default `50x30` mm), `defaultLowStockThreshold` (default 3), `allowNegativeStock` (default false), `paymentMethods` (default: نقداً cash, بطاقة card, تحويل بنكي bank, محفظة إلكترونية wallet), `sizes` (editable list, default: Newborn, 0-3M, 3-6M, 6-9M, 9-12M, 12-18M, 18-24M, 2Y, 3Y, 4Y, 5Y, 6Y, 7Y, 8Y, 9Y, 10Y, 12Y, 14Y, plus "Free size"), `colors` (editable list of `{name, hex}`), `autoBackup` (default true), `backupKeep` (default 30), `backupReminderDays` (default 3), `lastBackupAt`, `lastFileSaveAt`, `dataFolderName` (display only).

### 5.2 accounts (money places)
`name`, `type` ("cash" | "bank" | "wallet"), `openingBalanceMinor`, `active`. Seeded: "الصندوق" (cash drawer), "البنك" (bank). Current balance is **derived** from opening balance + all ledger movements (see 5.20), and each payment method in settings maps to a default account (e.g. نقداً → الصندوق).

### 5.3 categories
`name` (e.g. أولاد, بنات, مواليد, أحذية, إكسسوارات), `active`.

### 5.4 products
`name`, `categoryId`, `brand` (optional), `gender` ("boys"|"girls"|"unisex"|"baby"), `description`, `defaultCostMinor`, `defaultPriceMinor`, `active`, `imageDataUri` (optional, small).

### 5.5 variants (size × color — the unit of stock)
`productId`, `size`, `color`, `sku` (auto-generated, editable, unique), `barcode` (auto-generated, unique), `costMinor` (current **weighted-average cost**), `priceMinor` (selling price; defaults from product), `quantity` (cached on-hand), `lowStockThreshold` (optional override), `active`.
- Creating a product with sizes × colors **generates all combinations in one form** (grid: pick sizes, pick colors, enter initial quantity per combination, cost, price).
- Barcode: unique numeric Code128-compatible code, e.g. `2` + 11-digit sequence + check digit (EAN-13 style, internal range). Auto-assigned; user can override with an existing manufacturer barcode.

### 5.6 stockMovements (immutable ledger — source of truth for stock)
`variantId`, `date`, `type` ("opening" | "purchase" | "sale" | "sale_return" | "purchase_return" | "adjustment" | "stocktake" | "void_sale" | "void_purchase"), `qtyChange` (+/−), `unitCostMinor`, `refType`, `refId`, `note`, `balanceAfter`.
- `variants.quantity` must always equal the sum of `qtyChange`. Provide a "Recalculate stock" maintenance action and a test proving they match.

### 5.7 customers
`name`, `phone`, `address`, `notes`, `openingBalanceMinor` (they owe us), `active`. **Balance is derived** (opening + unpaid sales − payments − credit from returns). Walk-in sales need no customer.

### 5.8 sales (invoices)
`number` (e.g. `INV-000123`), `date`, `time`, `customerId|null`, `soldByEmployeeId|null`, `lines[]`, `subtotalMinor`, `discount` `{type:"amount"|"percent", value}`, `discountMinor`, `taxMinor`, `totalMinor`, `payments[]` (`{method, accountId, amountMinor, date}`), `paidMinor`, `dueMinor`, `status` ("paid" | "partial" | "unpaid" | "void"), `returnStatus` ("none"|"partial"|"full"), `installmentPlan|null`, `notes`.
- Line: `variantId, productName, size, color, barcode, qty, unitPriceMinor, unitCostMinor (snapshot), lineDiscountMinor, lineTotalMinor, returnedQty`.

### 5.9 installmentPlan (inside a sale)
`downPaymentMinor`, `count`, `frequency` ("weekly" | "biweekly" | "monthly"), `firstDueDate`, `schedule[]` = `{ n, dueDate, amountMinor, paidMinor, status: "pending"|"partial"|"paid"|"overdue" }`. Last installment absorbs rounding remainder.

### 5.10 customerPayments (collecting debts)
`customerId`, `saleId|null`, `date`, `amountMinor`, `method`, `accountId`, `note`. If `saleId` is null, the payment is applied to the oldest unpaid invoice first (FIFO) and installment schedule entries in due-date order; any excess becomes customer credit.

### 5.11 salesReturns (returns & exchanges)
`number`, `date`, `saleId`, `customerId|null`, `lines[]` (`saleLineIndex/variantId, qty, unitPriceMinor, unitCostMinor, restock: boolean`), `refundMinor`, `refundMode` ("cash_refund" | "customer_credit" | "exchange"), `refundMethod/accountId`, `reason`, `exchangeSaleId|null`.
- Exchange = return + a new sale created in the same flow; the UI shows the net difference to pay or refund.

### 5.12 suppliers
`name`, `phone`, `address`, `notes`, `openingBalanceMinor` (we owe them), `active`. Balance derived.

### 5.13 purchases (purchase invoices)
`number`, `supplierInvoiceNo`, `date`, `supplierId`, `lines[]` (`variantId, qty, unitCostMinor`), `subtotalMinor`, `discountMinor`, `totalMinor`, `payments[]`, `paidMinor`, `dueMinor`, `status` ("paid"|"partial"|"unpaid"|"void"), `notes`.
- Posting increases stock and recalculates **weighted-average cost**: `newCost = (oldQty*oldCost + qty*unitCost) / (oldQty + qty)` (if oldQty ≤ 0, newCost = unitCost).
- The purchase form must allow creating a **new product/variants inline** (so stock is entered once, via purchases), and also direct "opening stock" entry in the product form (creates `opening` movements).

### 5.14 purchaseReturns, supplierPayments
Purchase return: `supplierId, purchaseId, date, lines[], totalMinor, mode ("reduce_payable"|"cash_refund")`; decreases stock. Supplier payment: `supplierId, purchaseId|null, date, amountMinor, method, accountId, note` (FIFO if no purchase specified; excess = supplier credit).

### 5.15 expenseCategories & expenses
Default categories (editable): إيجار, كهرباء, ماء, إنترنت وهاتف, مواصلات, تسويق وإعلان, تغليف وأكياس, صيانة, ضرائب ورسوم, مصاريف أخرى.
Expense: `date, categoryId, amountMinor, method, accountId, description, recurringId|null`.
`recurringExpenses`: `categoryId, amountMinor, dayOfMonth, description, active` — a button "Generate this month's recurring expenses" creates the expense records (no auto-posting without user click, but the dashboard shows a reminder).

### 5.16 employees
`name`, `phone`, `position`, `hireDate`, `baseSalaryMinor`, `active`, `notes`.

### 5.17 payroll (monthly salary records)
`employeeId`, `month` (`YYYY-MM`), `baseMinor`, `bonusMinor`, `overtimeMinor`, `deductionsMinor` (penalties/absence), `advanceRepaymentMinor`, `netMinor`, `status` ("draft"|"paid"), `paidDate`, `method`, `accountId`, `note`.
- `net = base + bonus + overtime − deductions − advanceRepayment`. One record per employee per month (block duplicates).
- A "Prepare payroll for month X" button creates drafts for all active employees from their base salary; the owner adjusts bonus/deductions and clicks pay.
- Paying creates a ledger out-movement and an automatic salary expense (see §7), so salaries are never entered twice.

### 5.18 employeeAdvances (سلف)
`employeeId, date, amountMinor, repaidMinor, accountId, note`. Cash out when given (not an expense); repaid via payroll deduction up to the remaining balance.

### 5.19 ownerTransactions & transfers
`ownerTransactions`: `date, type ("capital_in"|"withdrawal"), amountMinor, accountId, note` (owner investment / personal withdrawal — **not an expense**, shown in equity). `transfers`: move money between accounts (e.g. cash → bank).

### 5.20 Financial ledger (derived, not stored separately)
Account balances are computed from: opening balance + sale payments + customer payments + capital in − refunds − supplier payments − purchase payments − expenses − net salaries − advances − withdrawals ± transfers. Provide a single function `accounts.getLedger(accountId, range)` returning a unified, chronological list of movements (with source links) for the account-statement page.

### 5.21 auditLog
Append-only: `timestamp, action, entityType, entityId, summary`. Written for: void, return, stock adjustment, stocktake, price/cost edits, payroll payment, backup/restore, settings change, deactivation.

### 5.22 dailyClosings
`date`, `salesByMethod` (map), `expensesMinor`, `expectedCashMinor`, `countedCashMinor`, `differenceMinor`, `note`. One record per day (editable only on the same day or by the owner with an audit entry).

---

## 6. Core Business Rules

### 6.1 Selling (invoice)
1. Add lines by **barcode scan** (scanner acts as keyboard: input + Enter), by name/SKU search, or by picking product → size → color.
2. Merge identical variants into one line (increase qty).
3. Validate stock: qty ≤ on-hand unless `allowNegativeStock`. Show a clear Arabic error naming the item.
4. Discounts: per line and per invoice, as amount or percent; cannot exceed the amount they apply to.
5. Warn (not block) if a line's price is below cost.
6. Payments: one or more (split payment allowed). If paid ≥ total → status `paid` (overpayment recorded as change given; paid amount capped to total). If paid = 0 and a customer is selected → `unpaid` (credit sale); partial → `partial`. **A credit/partial sale requires a customer.**
7. Optional **installment plan** (customer required): down payment, number, frequency, first due date → schedule generated.
8. On save (single transaction): create invoice with next number; write `sale` stock movements; decrement variant quantities; snapshot unit costs; record payments into accounts; update customer balance.
9. After save: show print preview (A4 or 80mm per settings) and a "New invoice" button. Keyboard-friendly POS screen with large touch targets (works on tablet/phone).

### 6.2 Void invoice
Only for the owner action "إلغاء الفاتورة": requires a reason; reverses stock (`void_sale` movements), reverses payments (recorded as refund out-movements on the original accounts), marks `status:"void"`. Voided invoices are excluded from all totals but remain visible. Cannot void if it has returns (return them or handle separately — show a clear message).

### 6.3 Returns & exchanges
- Search by invoice number/customer; choose lines and qty (cannot exceed `qty − returnedQty`).
- Per line choose **restock** (returns to stock at original snapshot cost) or **damaged** (no restock; cost stays as loss — recorded as COGS not reversed).
- Refund mode: cash/bank refund, add to customer credit (reduces what they owe/creates credit), or exchange (opens a new sale pre-linked; shows net difference).
- Updates `returnedQty`, `returnStatus`, stock, accounts, customer balance.

### 6.4 Purchases
As in 5.13. Void purchase allowed only if resulting stock for all lines would not go negative.

### 6.5 Stock adjustments & stocktake (جرد)
- Manual adjustment (damaged, lost, gift, found) with reason → `adjustment` movement; treat negative adjustments valued at current avg cost as a **"Stock loss" expense** line in the P&L.
- **Stocktake page:** list variants (filter by category), enter counted qty, system shows differences, one click "Apply" creates `stocktake` movements. Print-friendly count sheet.

### 6.6 Customers & installments
- Customer page shows: balance, all invoices, payments, installment schedule with overdue highlighting (due date < today and unpaid), and a "Receive payment" button (§5.10 allocation rules).
- "Overdue installments" list on dashboard with customer phone numbers (tap-to-call link `tel:`; optional WhatsApp link `https://wa.me/<phone>` text-prefilled reminder).

### 6.7 Suppliers
Supplier page: balance owed, purchase invoices, payments, "Pay supplier" button.

### 6.8 Low stock
A variant is low when `quantity ≤ threshold` (variant override → else default setting). Dashboard card + dedicated filtered list + printable "reorder list".

---

## 7. Accounting & Reports Definitions

All reports have a **date range filter** with presets (today, yesterday, this week, this month, last month, this year, custom) and **export to CSV** and **print**.

**Profit & Loss (قائمة الدخل)** for a period:
- **Net Sales** = sum of `totalMinor − taxMinor` of non-void sales, **minus** sales returns (value refunded).
- **COGS** = Σ(`unitCostMinor × qty`) of sold lines − Σ(cost of restocked returned lines).
- **Gross Profit** = Net Sales − COGS (also show margin %).
- **Operating Expenses** = Σ expenses (by category) + **Salary expense** (Σ `base + bonus + overtime − deductions` for payroll records of months in range; accrual by payroll month) + **Stock losses** (negative adjustments / stocktake shortages valued at avg cost, plus damaged returns).
- **Net Profit** = Gross Profit − Operating Expenses.
- Advances, owner withdrawals/capital and transfers are **not** expenses/revenue.
- If tax is enabled, tax is a liability, excluded from revenue.

**Other reports (each its own page/tab):**
1. **Sales report:** by day, by product, by category, by size/color, by employee, by payment method, by customer; best sellers & slow movers (no sales in N days).
2. **Profit per product/category** (revenue, cost, profit, margin).
3. **Inventory valuation:** per variant and totals — quantity, value at cost, value at retail, potential profit.
4. **Stock movement history** per variant.
5. **Receivables aging (ذمم الزبائن):** per customer with 0-30 / 31-60 / 61-90 / 90+ buckets; **Payables aging (ذمم الموردين)** likewise.
6. **Installments report:** upcoming, overdue.
7. **Cash & accounts:** balance per account, account statement (ledger) per account with date range, cash-flow summary (in/out by source).
8. **Expenses report:** by category and by month; chart.
9. **Payroll report:** per month and per employee; advances outstanding.
10. **Balance snapshot (الميزانية المبسطة)** as of a date: Assets (cash+bank+wallet balances, inventory at cost, customer receivables, employee advances) = Liabilities (supplier payables, customer credits) + Equity (opening capital + capital in − withdrawals + retained profit). Must **balance**; if not, show a reconciliation warning (and tests must verify balance on seeded data).
11. **Daily closing (إغلاق اليوم):** sales total by payment method, expenses, expected cash in drawer, with an input for counted cash → shows difference; saved as a record with print.

**Dashboard (الرئيسية):** today's sales / invoices count / profit; this month's sales, gross profit, expenses, net profit; balances per account; inventory value (cost & retail); low-stock count; receivables total; payables total; overdue installments count; payroll status for current month (paid/unpaid); recurring expenses due; charts: last 30 days sales, last 12 months sales vs expenses vs net profit; top 5 products; recent invoices.

---

## 8. Pages / Navigation (all labels Arabic, RTL)

Sidebar (collapses to a hamburger drawer on mobile):

1. **الرئيسية** — Dashboard
2. **فاتورة جديدة** — POS / new invoice
3. **الفواتير** — invoices list (search, filter by status/date/customer), view, print, void
4. **المرتجعات والاستبدال** — returns & exchanges list + new
5. **المنتجات والمخزون** — products & variants, stock levels, adjust, stocktake, import CSV
6. **الباركود والملصقات** — pick variants + copies → label sheet print (store name, product, size, color, price, Code128 barcode; size from settings; CSS `@page` for exact label size)
7. **المشتريات** — purchase invoices, purchase returns
8. **الموردون** — suppliers + payments
9. **الزبائن والديون** — customers, balances, installments, receive payment
10. **المصاريف** — expenses, categories, recurring
11. **الموظفون والرواتب** — employees, monthly payroll, advances
12. **الحسابات** — accounts, statements, owner transactions, transfers, daily closing
13. **التقارير** — all reports in §7
14. **الإعدادات** — store info, tax, invoice/label options, sizes/colors lists, payment methods, **backup/restore**, import/export, audit log viewer, data-folder link status and re-link button, maintenance (recalculate stock, load demo data, reset all data with strong confirmation)

---

## 9. UI / UX Requirements

- **Arabic RTL** throughout (`<html lang="ar" dir="rtl">`), numbers in Western digits, phone numbers displayed LTR.
- **Bee brand look:** warm yellow `#F5B700` accent, near-black text, white cards, soft rounded corners; clean, friendly, uncluttered. Light theme only for Phase 1.
- Responsive: desktop first, but POS, products and dashboard must work well on phone/tablet.
- **First-run wizard (معالج البداية)** on an empty database: store info → choose the data folder → optional demo data or CSV import. See §11.
- **Always-visible save-status indicator** in the header (see §11) and a clear banner whenever automatic file saving is unavailable.
- Every list: search, filters, sorting, pagination (or virtual scroll) — must stay fast with 5,000+ variants and 50,000 invoices (index in memory; do not re-scan arrays on every keystroke).
- Forms: inline validation with Arabic messages, required-field markers, Enter-to-submit where sensible, never lose entered data on a validation error.
- Confirmation dialogs for destructive/irreversible actions (void, restore backup, reset).
- Toast notifications for success/errors; clear empty-states with a call to action.
- POS shortcuts: `F2` focus barcode, `F4` payment, `Ctrl+Enter` save, `Esc` cancel dialog.
- **Printing:** invoice template (A4 and 80mm thermal) with logo, store name/phone/address, invoice number/date/time, customer, lines (name, size, color, qty, price, total), discount, tax, total, paid, remaining, installment schedule if any, footer text. Print CSS hides all app chrome.
- Accessibility basics: labels, focus states, sufficient contrast, keyboard navigation.

---

## 10. Internal API Facade (mirrors the future REST API)

The UI calls only `BeeStore.api.<namespace>.<method>(args)`. Every method is async and returns the envelope from §4 rule 11. In Phase 2 the body of each method becomes a `fetch` to the matching REST route and **nothing else in the UI changes**. Keep the names stable and document each method with its equivalent REST route in `docs/API.md`.

Namespaces and methods: `settings`, `accounts`, `categories`, `products` (incl. variants of a product), `variants` (`search`, `byBarcode`), `stock` (`adjust`, `stocktake`), `sales` (`create`, `get`, `list`, `void`, `printData`), `returns`, `customers` (incl. `statement`, `payments`), `suppliers` (incl. `payments`), `purchases` (incl. `void`), `purchaseReturns`, `expenses`, `expenseCategories`, `recurringExpenses` (incl. `generate`), `employees`, `payroll` (`prepare(month)`, `pay(id)`), `advances`, `ownerTransactions`, `transfers`, `dailyClosing`, `reports.<name>(from, to)`, `dashboard`, `backup` (`createNow`, `list`, `download`, `restore`), `maintenance` (`recalculateStock`, `loadDemoData`, `resetAll`), `import.products(csv)`, `export.all()`.

---

## 11. Data Safety, Backup, Import/Export

Because everything runs in the browser, **protecting the owner's data is the most important non-functional requirement.**

**Layers of protection**
1. **IndexedDB** = primary working store. Call `navigator.storage.persist()` on first run to reduce the chance of the browser evicting data.
2. **JSON mirror in an owner-chosen folder** (`db.json`) written via the File System Access API:
   - **First-run wizard (معالج البداية):** store info → choose data folder with `showDirectoryPicker({ mode: "readwrite" })`. Tell the user (Arabic) to pick a **new subfolder** such as `BeeStore-Data`, because Chrome refuses system folders like Documents/Desktop/Downloads themselves. Persist the directory handle in IndexedDB.
   - **Write policy:** debounced (~3 s) after every committed transaction, plus on `visibilitychange → hidden` and `pagehide`. Write through `createWritable()` (atomic swap on close). Include `meta.revision`, `meta.savedAt` and `meta.deviceId`.
   - **Permission handling:** on startup call `queryPermission`; if re-permission is needed, show a non-blocking banner "اضغط هنا للسماح بالحفظ في الملف" (requires a user gesture). The app stays fully usable meanwhile; pending changes are saved as soon as permission is granted.
3. **Dated backups** in the same folder under `backups/db-YYYY-MM-DD-HHmm.json`: on the first commit of each day, and before any restore / reset / demo-load / migration. Keep the last `backupKeep` (default 30).
4. **Rolling snapshots inside IndexedDB** (last 10; gzip with `CompressionStream` when available) as a second safety net.
5. **Manual download + reminders:** a "Download backup now" button always works. On browsers without folder access, a permanent yellow banner plus an automatic backup-download prompt when the daily closing is saved and every `backupReminderDays` (default 3) if there are unbacked-up changes.

**Save-status indicator** in the header, always visible: 🟢 "محفوظ في الملف (HH:MM)", 🟡 "بانتظار الحفظ…" / "اضغط لإعادة السماح بالحفظ", 🔴 "فشل الحفظ في الملف" (with a retry button), ⚪ "الحفظ في الملف غير متاح في هذا المتصفح".

**Startup consistency check:** compare the folder's `db.json` (`revision`, `savedAt`) with IndexedDB:
- IndexedDB empty but file exists → offer to restore from the file automatically (this is the "browser data was cleared" recovery).
- File `revision` greater than IndexedDB `revision` → dialog: "Load data from the file (recommended if you used another browser/computer)" vs "Keep browser data (the file will be overwritten)". Take safety backups of both before acting.

**Restore:** from the backups list or an uploaded `.json`: validate structure + `schemaVersion` (migrate if older), safety backup first, replace everything in one IndexedDB transaction, reload the app.

**Corruption handling:** if IndexedDB fails to open or load, do not show a blank page — show an Arabic explanation and offer restore from the folder file / latest backup.

**Import/Export**
- CSV import of products/variants for the initial stock: downloadable template, preview with per-row errors, commit only after confirmation; imported quantities create `opening` movements.
- Export any list/report to CSV (UTF-8 **with BOM** so Excel opens Arabic correctly).
- **The exported/mirrored JSON format is a stable contract:** `{ schemaVersion, meta, settings, collections: { … } }`, documented in `docs/DATA_FORMAT.md`. It is also the import format for Phase 2.

---

## 12. Demo Data & Reset (done from the UI — the owner has no command line)

Settings → Maintenance:
- **"تحميل بيانات تجريبية"** loads the demo dataset from `js/demo/demoData.js`: ~20 products with sizes/colors and stock, 2 suppliers, 5 customers (one with an installment plan, one overdue), 30 days of sales, a few purchases, expenses, 3 employees with one paid month and one advance. Allowed only on an empty database, or after typed confirmation plus an automatic backup.
- **"حذف كل البيانات والبدء من جديد"**: requires typing a confirmation word, downloads/stores a backup first, then clears everything and returns to the first-run wizard.

---

## 13. Out of Scope for Phase 1 (do not build, but keep the architecture ready)

Login/roles/permissions, multi-user or multi-device simultaneous use, cloud sync, multi-branch, online store sync, multi-currency, e-invoicing/government integration, installable PWA/service worker, native mobile app, payment-gateway integration.

**Phase 2 path (document in `docs/PHASE2_MIGRATION.md`):** run the same `services/` code on a Node backend; implement a database-backed repository that satisfies the same interface; replace each `BeeStore.api` method body with a REST call; import the existing `db.json` through a one-time import endpoint (same `schemaVersion` contract); then add authentication with roles (owner / cashier / accountant), user-level audit, and hosting.

---

## 14. Testing & Acceptance

**Automated tests (`node --test`, using `memoryRepository` with the same services) must cover at least:**
1. Sale deducts stock and creates the right movements; selling more than stock is rejected (and nothing is persisted).
2. Weighted-average cost after multiple purchases; COGS uses the snapshot cost even after cost changes later.
3. Void sale restores stock and reverses payments; totals exclude it.
4. Partial return, full return, exchange, damaged return; cannot return more than sold.
5. Credit sale + customer payment FIFO allocation + overpayment becomes credit.
6. Installment schedule generation (rounding) and overdue status.
7. Purchase posting, partial supplier payment, supplier payment FIFO.
8. Payroll net calculation, advance repayment limits, duplicate-month prevention, salary appears in P&L automatically.
9. P&L figures match a hand-computed scenario; **balance snapshot balances**.
10. Variant `quantity` equals the sum of its movements after a random sequence of operations.
11. **Atomicity:** a failure midway through a transaction (including a simulated storage-commit failure) leaves both memory and storage unchanged.
12. Export → modify → import returns identical data; migration from an older `schemaVersion`; JSON export/import round-trip.

**`tests/smoke.html`:** a page that runs a scripted scenario against the **real IndexedDB repository** (using a separate database name) and shows pass/fail, so the browser implementation is verified, not only the in-memory one.

**Worked example (must pass as an acceptance test):**
Buy 10 units of variant X at 20.00 from a supplier, pay 100.00 and leave 100.00 owed → stock 10, supplier owes 100.00. Sell 3 units at 35.00 with 5.00 invoice discount, paid in cash → revenue 100.00, COGS 60.00, gross profit 40.00, stock 7, cash drawer +100.00. Expense of 10.00 (electricity) → net profit 30.00. Return 1 unit (restocked, cash refund 35.00 less proportional discount handling as defined in code & README) → stock 8; figures update accordingly. The AI must document the exact discount-proration rule in the README.

**Manual acceptance checklist** (`docs/CHECKLIST.md`): open `index.html` by double-click in Chrome and Edge; run the first-run wizard; go through every page; create each document type; print an invoice and a label sheet; close the browser abruptly mid-use and confirm no data is lost; clear browser data and recover from the folder file; restore a backup; open a second tab and confirm it is blocked; test in a non-Chrome browser and confirm the warning banner.

---

## 15. Delivery Instructions to the AI

Build in this order. After each milestone, run the tests and make sure `index.html` opens and works; **do not move on with failing tests**.

1. **M1 Foundation:** namespace + utils, repository interface, `idbRepository` + `memoryRepository` (load-to-memory, indexes, unit-of-work transactions), migrations, `fileSync` (folder link, `db.json` mirror, dated backups, status indicator), first-run wizard, settings, audit log, API facade, layout/RTL shell, router, demo-data loader.
2. **M2 Products & stock:** categories, products, variants grid generator, barcodes, stock ledger, adjustments, stocktake, CSV import, low-stock.
3. **M3 Sales:** POS page, invoice posting, payments/accounts, invoice list/view/print (A4 + 80mm), void.
4. **M4 Customers, debts, installments.**
5. **M5 Returns & exchanges.**
6. **M6 Suppliers & purchases (+ returns, payments, avg cost).**
7. **M7 Expenses, recurring, accounts, owner transactions, transfers, daily closing.**
8. **M8 Employees, payroll, advances.**
9. **M9 Dashboard & all reports (+ CSV export, print).**
10. **M10 Barcode label printing, polish, full test suite + `smoke.html`, Arabic README, `docs/` (API, DATA_FORMAT, PHASE2_MIGRATION, CHECKLIST), final review against this document.**

**Final deliverable:** the complete project folder, openable by double-clicking `index.html`, all tests passing, and an Arabic README covering: where to put the folder permanently (and making a desktop shortcut), using Chrome/Edge, the first-run folder choice (a new subfolder), keeping a second copy of the data folder on a USB drive or cloud drive, daily use, how to back up and restore, FAQ — plus a "Decisions" section listing every assumption you made.
