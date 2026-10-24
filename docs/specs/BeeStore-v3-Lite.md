# Bee Store (بي ستور) — v3-Lite
## Single-Phone Offline App · Daily Closing · Accountant Package · Off-Device Backups (No Backend)

> **Companion to `BeeStore-Project-Spec.md` (v1) and `BeeStore-v2-Monthly-Periods.md` (v2). Read both first. Where v3-Lite conflicts with them, v3-Lite wins.**
> **`BeeStore-v3-Offline-Sync.md` (full cloud sync) is NOT part of this work.** It stays as the future upgrade path (see §14). Do not implement servers, databases, accounts or sync.
> Same ground rules as v1/v2: complete working code, no placeholders/`TODO`s/pseudo-code, Arabic RTL UI, integer money, local `YYYY-MM-DD` business dates, atomic postings, period locking, a regression test for every bug. Do not stop to ask questions — decisions are made below; record extra assumptions in the README "Decisions".

---

## 0. The Decision in One Paragraph

Bee Store has **one shop** and **one cashier device: a phone**. That phone is the **only device that writes data**. The app is delivered as an **installable offline web app (PWA)** from a **free static HTTPS host** (a place that only hands out the app's files — no server code, no database, no data). All data lives **on the phone** (IndexedDB) and works with no internet. Safety comes from **off-device backups** sent through the phone's share sheet to Google Drive/WhatsApp/email, and the accountant receives a **read-only monthly package** in a shared Drive folder. A **daily closing** reconciles the cash drawer each day; the **monthly closing** (v2) locks the accounting period.

**Why not a live shared database file on Drive?** A single database file synced by Drive/Dropbox is replaced as a whole (last writer wins and silently erases others' changes), can be corrupted or duplicated ("conflicted copy") if sync runs while the app writes, and phone browsers have no reliable way to write to such a file. So: **the live database stays on the phone; Drive is only for backups and exports.**

**Why not one database file per month?** Months are linked (opening balances, stock, debts, returns of old invoices, customer statements, yearly reports). Splitting them duplicates master data and breaks references. The correct practice is **one database + monthly period closing** (v2) — plus a **frozen monthly export** for the accountant (§8).

---

## 1. Changes vs v1 / v2 (summary table)

| Area | v1/v2 | v3-Lite |
|---|---|---|
| Delivery | open `index.html` from disk (`file://`) | **PWA served over HTTPS from a static host**; desktop browsers use the same URL. `file://` is no longer a supported target. **Keep the existing classic-script structure; do not migrate to ES modules.** |
| Primary device | desktop Chrome/Edge | **Phone** (Android Chrome and iPhone Safari installed to the home screen); desktop still works |
| JSON folder mirror (File System Access) | primary safety net | **Optional on desktop only** (feature-detected). On phones it is replaced by share-sheet backups (§6) |
| Daily closing | simple record (v1 §5.22) | **Full daily closing** with cash reconciliation, day lock, Day Report, Days page (§4) |
| Period selector | month / year / custom | adds **Day** mode (§4.6) |
| P&L | v2 §7 | adds **cash over/short** line (§4.5) |
| Roles | none | **Two local PIN profiles: Owner and Cashier** (§7) |
| Accountant | none | **Monthly Accountant Package** (§8) |
| Memory use | load everything | **memory window + lazy loading from IndexedDB** (§5) |
| Camera barcode | not included | **Included** (§9) |

---

## 2. Delivery: Static HTTPS Hosting + PWA

- **Hosting:** any free static host with HTTPS (e.g. GitHub Pages, Cloudflare Pages or Netlify — choose one, justify in README, and check its current terms). It serves only the app files. **No backend, no database, no analytics, no third-party scripts, no secrets.**
- **Relative paths everywhere** (some hosts serve under `/repo-name/`): `manifest` with `start_url: "./"`, `scope: "./"`; no absolute `/path` URLs.
- **Manifest:** Arabic name "بي ستور", `display: standalone`, `dir: rtl`, `lang: ar`, bee-yellow theme color, icons 192/512 + maskable (generate simple bee-themed icons yourself).
- **Service worker:** precache the full app shell (explicit file list + `CACHE_VERSION` constant; provide `scripts/build-sw-list.js` that regenerates the list and a content hash), cache-first for the shell, **offline start must always succeed once loaded once.** No caching of anything outside the app's own files.
- **Safe update flow:** when a new version is available, show "تحديث متوفر" and apply it **only at a safe moment** (never mid-invoice or mid-closing; wait for the user's tap or an idle state). Never lose the in-progress invoice on update. Data schema migrations (v1 §4 rule 12) run on first start of the new version, after an automatic local snapshot.
- **Install guide in the app** (Arabic, short, with Android and iPhone variants): how to "Add to Home Screen", and a persistent hint when running in a plain browser tab instead of the installed app.
- **Storage persistence:** call `navigator.storage.persist()`; show the result in Settings → Data.
- **Deployment docs:** `docs/DEPLOY_AR.md` — numbered Arabic steps to publish the first time and to publish an update (including how to bump `CACHE_VERSION`), and what the owner should do if the hosting address changes (data is tied to the address; see §6.5).
- **Security headers via `<meta>` CSP** where the host cannot set headers (self-only scripts/styles/images, no inline eval).

---

## 3. Single-Writer Rule

Only **one device** is the writer. There is no sync, so a second writing device would create two diverging copies.
- Enforce one active tab with the Web Locks API (v1 §4 rule 13).
- Every backup/export carries `meta.deviceId`, `meta.revision`, `meta.savedAt`. Restoring a backup onto a device **warns** if the backup is **older** than the data already on this device ("النسخة أقدم من بياناتك الحالية — ستفقد عمليات") and requires typed confirmation; restoring on a *different* device shows a "make this the primary device" confirmation and explains that the old device must stop being used.
- Document this in the Arabic guide in plain words: "جهاز واحد فقط للتسجيل".

---

## 4. Daily Closing (إغلاق اليوم)

**Purpose:** a daily *control* — reconcile the cash drawer, freeze the day's numbers, and give a clean per-day report. It is **not** an accounting period (the month is). It follows standard retail end-of-day practice.

### 4.1 Data (`dailyClosings`, replaces v1 §5.22)
`date` (unique), `status` ("closed"), `openingCashMinor`, `salesByMethod{}` (net of returns refunded by method), `invoicesCount`, `returnsCashRefundMinor`, `customerCollectionsByMethod{}`, `supplierCashPaymentsMinor`, `cashExpensesMinor`, `cashInOtherMinor` (capital in etc.), `cashOutOtherMinor` (withdrawals), `expectedCashMinor`, `countedCashMinor`, `differenceMinor` (= counted − expected), `denominationsCount{}|null`, `externalTotals{method: amountMinor}|null` and `externalDifferences{}`, `takenOutMinor`, `takenOutMode` ("bank_deposit"|"owner_withdrawal"|"none"), `retainedFloatMinor` (= counted − takenOut; next day's opening), `noCount` (bool), `note`, `closedAt`, `generatedRecordIds[]` (the transfer/withdrawal/adjustment created by the closing).

Settings additions: `cashDrawerAccountId`, `defaultBankAccountId`, `cashDenominations` (default list for the configured currency; ILS: 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.1), `backupWarnDays` (default 2).

### 4.2 Closing wizard (mobile-first, 4 steps)
1. **Summary:** the day's figures computed live from the ledger (sales by method, invoices count, returns, collections, expenses, other cash movements) and **expected cash** = opening cash + all cash inflows − all cash outflows of the day on the cash-drawer account (excluding the closing's own records). Opening cash = the cash-drawer balance at the end of the previous day (derived).
2. **Count cash:** enter the counted total, or use the optional **denominations counter** (quantity per bill/coin → total). Show the difference live (shortage in red, surplus in green). Optional **external totals** per non-cash method (card terminal, bank, wallet): shows a warning if they differ from the day's recorded total — **no ledger adjustment** for these (the owner must investigate).
3. **Take out cash:** "إيداع بالبنك" / "سحب شخصي" / "بدون", with amount; shows the retained float for tomorrow. These create the corresponding **transfer / owner-withdrawal** records automatically so nothing is entered twice.
4. **Confirm & finish:** note, confirm. Then show buttons: **مشاركة تقرير اليوم** (§4.4) and **نسخة احتياطية الآن** (§6). One transaction does everything.

### 4.3 Accounting treatment (must be exact)
- If `differenceMinor ≠ 0`, the closing creates a ledger entry on the cash-drawer account dated that day (`sourceType: "cash_difference"`) so the book cash balance equals the counted cash.
- **P&L:** a **shortage is an expense, a surplus is income**, shown together as one operating line **"فروقات الصندوق" (cash over/short, net)** included in Operating Expenses of v2 §7. They are *not* user-selectable expense categories.
- **Balance snapshot** still balances (the cash change is offset by the P&L effect). Add `cash_difference` to the account ledger sources (v1 §5.20) and to the Profit⇄Cash reconciliation (it is part of net profit).
- A day closed with **"إقفال بدون جرد"** (`noCount`, for catch-up of forgotten days) records `differenceMinor = 0`, flag `NO_COUNT`, and the Day Report shows a visible "بدون جرد نقدي" mark.

### 4.4 Day Report (تقرير اليوم)
Printable and shareable. Contents: date, status; sales (count, total, average invoice) by payment method; returns; customer collections; expenses (list); cash reconciliation (opening, in, out, expected, counted, difference, taken out, retained float); top 5 items sold; low-stock items touched; open credit created today; notes; signature line. Output: browser print (A4 / 80 mm), a short **WhatsApp-style text summary** (copy/share), and an image/PDF via the share sheet. **Arabic PDF rule:** never draw Arabic text with PDF text APIs (shaping/ordering breaks). Generate reports as HTML and use the browser's print-to-PDF, or render the HTML to a canvas image and place that image in the PDF.

### 4.5 Rules
- **Day lock:** after a day is closed, creating/editing/voiding **sales, returns, payments/receipts, cash expenses, transfers, withdrawals, capital movements dated that day** is blocked (`assertDayOpen(date)` inside every such posting transaction, like `assertPeriodOpen`). Documents with no cash/sales effect (an unpaid purchase invoice, payroll accrual, stock adjustment) are **not** blocked by the day lock. The month lock (v2) is stricter and always wins.
- **Order:** days that had activity must be closed in order; a forgotten earlier day can be closed first with `noCount`. Closing a day with no activity is allowed but not required.
- **Reopen a day:** owner profile + PIN, only the **most recent** closed day, not if its month is closed; the closing's generated records are soft-voided with audit; typed confirmation.
- **Editing after close (owner only):** to correct a closed day, reopen it (above) or post the correction today (return/adjustment).
- **Business day** = calendar day in local time (document the assumption).

### 4.6 Where days appear (UI)
- **Home/dashboard "اليوم" card:** today's sales, invoices, expected cash so far, status (مفتوح/مُقفل), button "إغلاق اليوم". Also "أمس": status and cash difference. A **warning list of unclosed days that had activity**.
- **Days page (الأيام):** a table of every day of the selected month — sales, invoices, returns, expenses, net cash movement, status, difference — sorted newest first; tapping a day opens its Day Report with ◀ ▶ day navigation.
- **Global period selector** gains modes **يوم / شهر / سنة / مخصص**; in Day mode all period-scoped pages show only that day.
- The Month Review (v2 §9.1) gains a **days table** and counts of days closed/unclosed and total cash differences.

---

## 5. Data Size & Performance on a Phone

- **IndexedDB stores everything** (≈ 20–75 MB per year at 30–100 invoices/day — state this as an estimate in the README and measure it with seeded data).
- **Memory window:** always in memory: master data (products, variants, categories, customers, suppliers, employees, accounts, settings) + documents of the **current month and the previous `memoryWindowMonths`** (default 2). **Older months are read from IndexedDB on demand** through indexed date queries (show a small progress indicator) and kept in a small LRU cache. All repository reads are async so services need no change.
- **Backups stream:** exporting a backup builds a `Blob` from **per-collection chunks**; never one giant `JSON.stringify` of the whole database.
- **Storage monitor** (Settings → Data): usage vs quota (`navigator.storage.estimate()`), record counts, estimated size per year, a yellow warning at 70% of quota and a red one at 90%; handle `QuotaExceededError` without data loss.
- **Yearly archive is out of scope now** (data growth is slow). Keep the hooks: the `opening` stock-movement type, opening balances for customers/suppliers/accounts, and period snapshots must stay intact so an "archive closed years" tool can be added later without redesign. Document this in `docs/FUTURE.md`.
- **Targets (test with a seeded dataset of 50,000 invoices on a mid-range phone profile):** cold start ≤ 3 s; save invoice ≤ 100 ms; dashboard ≤ 1 s; Month Review of a window month ≤ 1 s; of an older month ≤ 2 s.

---

## 6. Off-Device Backups (the real safety net)

The phone is the single copy of the live data, so **losing the phone or wiping the browser data = losing everything since the last off-device backup.** This must be unmissable in the UI and in the Arabic guide.

### 6.1 Layers
1. IndexedDB (primary) with persistent storage requested.
2. **Rolling local snapshots** inside IndexedDB (last 10, compressed with `CompressionStream` when available) — protects against app bugs, **not** against phone loss.
3. **Off-device backup file** via the **Web Share API with files** (share sheet → Drive, WhatsApp, email…), with automatic **download fallback** when sharing files is unsupported.
4. Optional desktop folder mirror (v1 §11) when `showDirectoryPicker` exists.

### 6.2 Backup file
`BeeStore-backup-YYYY-MM-DD-HHmm.json` (full export in the stable format of v1 §11 + `meta.deviceId/revision/savedAt`, `schemaVersion`, and a SHA-256 checksum entry). Optional **passphrase encryption** (WebCrypto AES-GCM with a PBKDF2-derived key; recommended for sending through WhatsApp/email; the passphrase is never stored). If encryption is offered, the restore flow must handle it and tests must cover wrong-passphrase handling.

### 6.3 When
- After every **daily closing** the finish screen offers **"نسخة احتياطية الآن"** as the primary button.
- Track `lastOffDeviceBackupAt`. Show a **persistent banner** when there is activity since the last off-device backup older than `backupWarnDays` (default 2 days), and a **red** banner when older than 7 days. The dashboard shows "آخر نسخة خارج الجهاز: …".
- Always available: Settings → Backup & Restore.

### 6.4 Restore
File picker → validate structure/`schemaVersion` (migrate if older) → verify checksum → show a summary (date, counts, newest document) and the §3 warnings → automatic safety snapshot → replace everything in one IndexedDB transaction → reload. A guided **"phone replaced / reinstalled" flow**: install the app → open → "استعادة من نسخة" → pick the file from Drive/Downloads.

### 6.5 Address warning
IndexedDB belongs to the web address. If the hosting address changes, the data on the phone is not visible at the new address. The Arabic guide must say: **never change the address without first making a backup and restoring it at the new address.**

---

## 7. Local Roles & App Lock (small shop, one phone)

- **PIN lock** set in the first-run wizard; auto-lock after `autoLockMinutes` (default 5) of inactivity and when the app goes to the background for more than 1 minute. PIN stored as a salted PBKDF2 hash (WebCrypto, high iteration count); lockout delay after repeated wrong attempts.
- **Two profiles on the same device:** **Owner** (everything) and **Cashier** (a second PIN). Switch profile through the lock screen.
- **Cashier can:** create invoices (discount up to `cashierMaxDiscountPercent`, default 10), receive customer payments, view products/prices/stock, create returns up to `cashierMaxReturnMinor` (default configurable), see its own day's sales summary, do **barcode price check**.
- **Cashier cannot:** see **cost price or profit** anywhere (hidden in UI **and** stripped in the facade responses), open reports/Month Review, expenses, payroll, accounts, settings, backups, closing of days/months, voids, stock adjustments, edit prices/products, reopen anything.
- Enforcement lives in **one central place** (the `BeeStore.api` facade: `requirePermission(...)` + response shaping), never scattered in pages. **Limitation to document:** with no server, local roles protect against casual access, not against a technical person with developer tools. State this honestly in the README.
- All audit-log entries record the **profile** that performed the action.
- **Lost phone:** there is no remote wipe. Mitigations: device screen lock + app PIN + optional encrypted backups + frequent off-device backups. Put this in the Arabic guide.

---

## 8. Accountant Package (حزمة المحاسب)

Generated **in the browser** at (and available after) **month closing**; the accountant receives it through a **shared Drive folder with view-only permission**; **the accountant never edits the database.** Corrections found by the accountant are made by the owner in the app (current-month adjustments or reopening the latest month).

### 8.1 Contents (one ZIP, plus the PDF alone)
`BeeStore-YYYY-MM-Accountant-Package.zip`:
1. `00-README.txt` (Arabic + English short): what each file is, definitions, currency, month status.
2. `01-Month-Review.pdf` (via the Arabic-safe method in §4.4).
3. `accounting.xlsx` with sheets: Summary/P&L (with prior month and same month last year), Sales Journal (per invoice), Sales Lines (per item with cost and margin — **owner version only**), Returns, Purchases Journal, Expenses (categories, recurring, spread shares), Payroll, **Cash Book** (cash-drawer ledger with opening/closing), Bank & Wallet ledgers, Receivables aging & customer balances, Payables aging & supplier balances, **Inventory valuation at month end**, Stock movements summary, Balance snapshot, Profit⇄Cash reconciliation, **Daily Closings** (day, sales, expected, counted, difference), Adjustments & Voids (audit extract), Integrity check result.
4. `csv/` folder: the same tables as UTF-8 **with BOM** CSVs (for software that cannot read xlsx). Escape formula-injection prefixes (`= + - @`).
5. `manifest.json`: store name, month, status, `generatedAt`, `appVersion`, `schemaVersion`, currency, file list with **SHA-256 checksums**.
- Spreadsheet/ZIP libraries must be **vendored** (no CDN) and offline-capable. If a good xlsx library cannot be vendored, deliver CSV-only and say so in the README.
- **Closed-month rule:** the full package is offered only for **closed months**; for the open month it is generated with a visible "غير نهائي — الشهر مفتوح" watermark/status.
- **Cross-checks (tests):** P&L sheet equals Month Review; Σ Sales Journal = net sales (+ tax); Cash Book closing = cash account balance; Inventory valuation total = balance-snapshot inventory; Daily Closings differences sum = the P&L cash over/short line; manifest checksums verify.

### 8.2 Sharing
`Share` button (Web Share API with files) → user picks Drive/WhatsApp/email; download fallback. A `CloudTarget` abstraction (`ShareSheetTarget`, `DownloadTarget`) is used by both backups and packages so a future **Google Drive direct upload** can be added without touching the generators (**do not implement Drive upload now**, and do not leave placeholder code for it).
The Arabic guide explains the one-time setup: owner creates a Drive folder "BeeStore — المحاسب", shares it with the accountant as **Viewer**, and uploads each month's package there from the share sheet.

---

## 9. Camera Barcode Scanning (phone-first)

- Reusable scanner component: full-screen overlay, rear camera (`getUserMedia`, `facingMode: "environment"`), viewfinder, **torch toggle when supported**, camera switch, close; Arabic messages for permission denied / no camera / insecure context.
- Decoding: use `BarcodeDetector` when available (ean_13, ean_8, code_128, upc_a, upc_e, code_39, qr_code); otherwise a **vendored ZXing-based fallback** (offline, no CDN). Feature-detect; never sniff user agents. Verify on a real iPhone, including inside the installed app; if the installed iPhone app cannot open the camera, document the fallback of opening the URL in Safari.
- Continuous mode with debounce (ignore the same code ~1.5 s), beep + vibration, visual flash, distinct sound for unknown codes.
- Integration: **New invoice** (scan → add line/qty+1; unknown → toast + "create product" prefilled), **product/variant form** (fill barcode; reject duplicates with a link), **purchases receiving**, **stocktake** (count by scanning), and **"فحص سعر"** page. USB/Bluetooth keyboard scanners keep working; scanner Enter never submits the invoice.
- Internal barcodes are generated by the system (v1 §5.5) and printable as labels (v1 §8); manufacturer barcodes are optional.

---

## 10. Phone-First UX

POS and the main screens designed for ~360 px width first: big touch targets (≥ 44 px), bottom action bar for "add item / pay", collapsible sections, sticky totals, no horizontal scrolling, numeric keypad for amounts, quick-pick payment buttons, **receipt sharing** (text/PDF/image) in addition to printing. Respect safe areas and the on-screen keyboard. Dark mode not required. Large fonts option in Settings. Every screen works in portrait; landscape must not break.

---

## 11. Integrity & Safety Additions

Extend the v2 Integrity Checker with: every closed day's recorded numbers equal recomputation from documents; cash-drawer ledger balance equals the last closing's `retainedFloat` plus later movements; `cash_difference` entries match closings; days with activity but unclosed older than N days (warning); backup freshness; storage usage; **clock anomaly** (see below).
**Clock anomaly guard:** the phone's clock is the time source. If the current time is earlier than the latest committed document timestamp by more than 1 day, or the date jumps unrealistically forward, show a blocking Arabic warning requiring confirmation before any posting (prevents mis-dated documents when a phone's date is wrong).
Keep the global error log (v2 §12.3) with "copy details" and a diagnostics export (no business data).

---

## 12. Tests & Acceptance

### 12.1 Automated (in addition to all v1/v2 tests)
1. **Daily closing scenario (exact):** opening float 200.00; three invoices total 450.00 (cash 300.00, card 100.00, 50.00 on credit to customer A); customer B pays 80.00 cash on an old debt; cash expense 25.00; cash refund on a return 40.00. **Expected cash = 200 + 300 + 80 − 40 − 25 = 515.00.** Counted 510.00 → **difference −5.00** booked as a shortage in P&L (cash over/short −5.00) and the cash account equals 510.00. The owner takes 400.00 to the bank → retained float **110.00**; next day's opening cash = 110.00; bank +400.00; balance snapshot still balances; net profit includes −5.00.
2. Day lock: creating/voiding a sale or cash expense dated the closed day is rejected; an unpaid purchase and a stock adjustment dated that day are allowed; month lock overrides day reopen; only the latest day can be reopened and its generated records are voided.
3. Catch-up: closing a later day while an earlier active day is open is rejected; closing the earlier day with `noCount` works and shows the flag.
4. Non-cash external totals produce warnings but no ledger entries.
5. Backup → wipe → restore returns identical data (including closings and snapshots); older-backup and different-device warnings; checksum failure and wrong passphrase handled; streamed export works at 50,000 invoices.
6. Memory window: opening an older month loads it on demand and gives the same numbers as when in memory.
7. Local roles: the cashier never receives cost/profit fields from any facade method; cannot call restricted methods; discount/return limits enforced; owner can.
8. PIN lock/auto-lock; lockout delay; profile switching.
9. Accountant package: all cross-checks in §8.1, checksums verify, CSV BOM present, open-month watermark.
10. Clock anomaly guard.
11. PWA: with the network disabled after the first load, the app starts and an invoice can be created (use a headless browser such as Playwright with offline emulation if available; otherwise state clearly what could not be verified); update flow does not interrupt an in-progress invoice.
12. Share/download fallbacks with mocked `navigator.share`/`canShare`.

### 12.2 Manual checklist (`docs/CHECKLIST.md`)
Install on Android Chrome and iPhone (home screen); airplane-mode sale; camera scan in the installed app; close a day with a shortage; share the Day Report; make an off-device backup to Drive; restore it on a second phone; close the month; share the accountant package to the shared folder and open it on a computer; test an app update while an invoice is open; test with the phone's date set wrongly.

---

## 13. Milestones & Process

The project (v1 + v2) may already exist. **If it does:** first follow v2 §14 Phase A (audit, `docs/AUDIT.md`), fix problems, then apply these milestones. **If it does not:** build v1, then v2, then these. Never rewrite working modules unnecessarily.

1. **L1 PWA & hosting:** manifest, service worker, install/update flow, relative paths, `docs/DEPLOY_AR.md`, offline test.
2. **L2 Phone storage:** persistence request, memory window + lazy month loading, streamed export, storage monitor, desktop-only folder mirror gating.
3. **L3 Off-device backups:** share/download, optional encryption, backup banners, restore + new-phone flow, single-writer warnings.
4. **L4 Daily closing:** model, services (`assertDayOpen`, cash difference ledger, P&L/balance integration), wizard, Day Report, Days page, dashboard cards, Day mode in the selector, tests (§12.1 #1–4).
5. **L5 App lock & local roles** (§7).
6. **L6 Camera scanning & phone-first UI polish** (§9, §10).
7. **L7 Accountant package** (§8) with cross-check tests.
8. **L8 Integrity/clock additions** (§11).
9. **L9 Docs:** Arabic owner guide (below), `docs/DEPLOY_AR.md`, `docs/FUTURE.md`, `docs/UPGRADE_TO_V3_FULL.md` (how the data format and facade map to the full backend design), updated CHECKLIST, CHANGELOG, `CLAUDE.md`, `docs/MAP.md`.
10. **L10 Full verification:** all tests, performance targets, manual checklist items you can automate; honest report of anything not verified.

**Arabic owner guide must cover (short, numbered, simple words):** installing on the phone; daily routine (open → sell → close the day → share the report → backup); monthly routine (generate recurring expenses → payroll → close the month → share the accountant package); sharing the Drive folder with the accountant (view-only); restoring on a new phone; what to do if the phone is lost; the "one writing device only" rule; never change the hosting address without a backup; what the banners mean.

**Final deliverables:** updated project (deployable as static files), all tests passing, docs listed above, and a short Arabic report of what was done, what is not verified, and a 10-step manual test for the owner.

---

## 14. Future Upgrade Path (not now)

If a second writing device, live accountant access, or remote work from several devices is needed, upgrade to `BeeStore-v3-Offline-Sync.md` (cloud database + sync). Everything here is designed to carry over: the stable JSON format, the services/repository/facade separation, immutable documents, period and day closings. Keep `docs/UPGRADE_TO_V3_FULL.md` accurate.

---

## 15. Decisions Made (copy to README "Decisions")

One database, monthly closing for accounting periods, daily closing for cash control; single writing device; static HTTPS hosting; off-device backups by share sheet; accountant read-only monthly package; local PIN roles with documented limits; memory window of 2 previous months; no yearly archive yet; day = local calendar day; cash differences booked as P&L over/short; Arabic reports through HTML print/canvas rather than PDF text APIs; Drive direct upload deferred behind a `CloudTarget` interface.
