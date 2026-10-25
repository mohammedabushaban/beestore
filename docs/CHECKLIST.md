# BeeStore Manual Acceptance Checklist

> **v3-Lite:** the app is a PWA served over HTTPS. Do **not** test by opening `index.html` via `file://`; IndexedDB and installation are blocked there. Use the deployed URL or `python3 -m http.server 8080` → `http://localhost:8080/`.

## Browser Compatibility

- [ ] Open the deployed HTTPS URL in Android Chrome
- [ ] Open the deployed HTTPS URL in iPhone Safari (not an in-app browser)
- [ ] Open the deployed HTTPS URL in desktop Chrome or Edge
- [ ] Confirm the page loads and shows the first-run wizard (or the dashboard if already configured)
- [ ] Confirm `file://` is not used anywhere in the test flow

## First-Run Wizard

- [ ] Enter store name (Arabic), phone, address, and system start date
- [ ] On a phone: the folder step is skipped automatically (desktop-only feature)
- [ ] On desktop Chrome/Edge: optionally choose a data folder (e.g. `BeeStore-Data`) or skip
- [ ] Load demo data or start empty
- [ ] After finishing, open **Settings → البيانات** and confirm the app version and cache version are visible

## PWA, Install & Offline (v3-Lite L1)

- [ ] `manifest.json` loads; the app name is «بي ستور» and the theme color is amber
- [ ] Android: the in-app install banner appears (or Settings → البيانات → دليل التثبيت), and install adds a home-screen icon
- [ ] iPhone: Safari → Share → Add to Home Screen works; the guide explains that Chrome/in-app browsers cannot install
- [ ] Opening from the home-screen icon runs standalone (no browser address bar)
- [ ] Settings → البيانات shows the persistence status; tapping «طلب تخزين دائم» updates the result
- [ ] After one online load, Settings says «التطبيق محفوظ على الهاتف ويعمل دون إنترنت»
- [ ] Airplane mode + close/reopen the app: the shell opens from cache and existing data is visible
- [ ] Create and save a small invoice offline; close/reopen: the invoice is still there
- [ ] Service worker controls the page and caches **84** app-shell files; no data/backup files are cached
- [ ] No external/CDN requests in DevTools → Network; no CSP errors in Console
- [ ] `index.html` has no inline `onclick` handlers; sidebar/header/nav links still navigate

## Safe Update Flow (v3-Lite L1)

- [ ] Change an app file, run `node scripts/build-sw-list.js`, deploy, then open the app online
- [ ] The «تحديث متوفر» banner appears (or Settings → البيانات → التحقق من التحديث)
- [ ] With a non-empty POS cart, tapping «تحديث الآن» is refused with the Arabic warning and the app does **not** reload
- [ ] With a visible dialog/wizard open, the update is refused; a **hidden** finished wizard does not block it
- [ ] With an empty cart, no save in progress, and no dialog, tapping «تحديث الآن» reloads once and the app starts normally
- [ ] Settings → البيانات shows the new cache version; Application → Cache Storage contains only the new cache
- [ ] The existing data (products, invoices, settings) is unchanged after the update
- [ ] Settings → البيانات lists the pre-migration snapshot (when a schema migration ran) and «تنزيل» downloads a JSON file
- [ ] Re-running `node --test tests/*.js` is green before every deploy

## Pages

- [ ] **Dashboard**: sales today, month totals, account balances, low stock count, اليوم/أمس day cards + unclosed-day warnings
- [ ] **Days (الأيام)**: month table, closing wizard, Day Report, reopen latest
- [ ] **POS (New Invoice)**: scan barcode, add items, set discount, save with payment
- [ ] **Invoices List**: search by number/customer, filter by status, view invoice, void invoice
- [ ] **Returns**: create return for an invoice, verify stock is restored
- [ ] **Products**: create product, edit price/cost, deactivate product, scan barcode
- [ ] **Price Check (فحص سعر)**: scan → name/size/color/price/stock; unknown → create action
- [ ] **Labels**: select variants, set copies, print label sheet
- [ ] **Purchases**: create purchase invoice, verify stock increases, scan receiving
- [ ] **Suppliers**: create supplier, pay supplier
- [ ] **Customers**: create customer, view statement, receive payment
- [ ] **Expenses**: add expense, view by category
- [ ] **Employees**: create employee, prepare payroll, pay salary
- [ ] **Accounts**: view balances, account statement (ledger), transfer between accounts
- [ ] **Reports**: P&L, sales report, inventory valuation, receivables/payables aging
- [ ] **Month Review** (Reports): KPIs, P&L vs previous month, cash flow, balances open→close
- [ ] **Periods (إقفال الشهور)**: months table, checklist, close a month, verify 🔒 badge
- [ ] **Settings**: update store info, backup/restore, maintenance

## Period Selector & Closing (v2)

- [ ] Header shows ◀ current month ▶; switch months and confirm lists re-scope
- [ ] "السنة كاملة" and "فترة مخصصة" modes scope the lists correctly
- [ ] **Day mode** (`?d=YYYY-MM-DD`): pages scope to that day and a closed-day warning appears
- [ ] Refresh keeps the period; copy URL with `?m=`/`?y=`/`?d=` to a new tab and confirm it opens the same period
- [ ] Closed month shows 🔒 in header, scope bars, and statements
- [ ] Close flow: generate recurring → prepare/pay payroll → checklist green → close → backup note
- [ ] Posting dated in a closed month is rejected with an Arabic message
- [ ] Collecting an old invoice payment "today" still works after closing
- [ ] Reopen works only for the latest closed month, with typed confirmation
- [ ] Recurring-expenses banner appears on Dashboard when a month record is missing
- [ ] Double-clicking POS save posts exactly one invoice
- [ ] Entering `٢٥٠` (Eastern digits) in an amount field parses as 250
- [ ] Settings → Maintenance → "فحص سلامة البيانات" runs and shows results
- [ ] Month Review prints on A4 without cut tables; invoice prints on 80mm

## Daily Closing (v3-Lite L4)

- [ ] Settings → طرق الدفع: set the cash-drawer account, default bank, and denominations; reload and confirm they persist
- [ ] Dashboard shows اليوم/أمس cards with status, expected cash, difference, and unclosed-day warnings
- [ ] Open **الأيام** → **إغلاق اليوم**; confirm 4 steps: ملخص → جرد → إخراج النقد → تأكيد
- [ ] Enter 2 of the largest denomination; the counted total and live difference update
- [ ] Enable **بدون جرد**: the count field disables and the closing records `noCount`
- [ ] Choose a bank deposit: a transfer from the drawer to the bank is created on close
- [ ] Choose an owner withdrawal: an owner transaction from the drawer is created on close
- [ ] Retained float = counted − taken out; the next day's opening equals it
- [ ] Reference scenario: opening 200, cash sales 300, card 100, credit 50, collection 80, cash expense 25, cash refund 40 → expected **515**; count **510** → difference **−5**; take out **400** → retained **110**; P&L includes the −5
- [ ] Day Report shows the full reconciliation, methods, collections, external differences, print A4/80mm and share
- [ ] A closed day blocks sales, sale voids, returns, receipts/payments, cash expenses, transfers, withdrawals, and capital movements dated that day
- [ ] Unpaid purchases, payroll accrual, and stock adjustments remain allowed on a closed day
- [ ] Closing a later day before an earlier one is blocked; close the forgotten earlier day with **بدون جرد**, then close the later one
- [ ] Reopen the latest closed day (month must be open): generated records are soft-voided with an audit entry; reopening a non-latest day is blocked
- [ ] Month Review shows the days table, closed/unclosed counters, total differences, and signed cash-difference row in P&L
- [ ] External totals (card/wallet) produce warnings only and never post ledger entries

## Camera Barcode Scanning (Android Chrome)

Run from **https** or `http://localhost` — plain `http://192.168.x.x` is blocked by Chrome (insecure context).

- [ ] Open POS → tap "مسح": browser asks for camera permission → allow once
- [ ] Rear camera opens (not the selfie camera); the viewfinder shows the live feed
- [ ] Scan a product label → item is added, short beep + vibration + green flash, scanner stays open (continuous mode)
- [ ] Keep the same label in front of the camera → it is **not** added again within ~1.5 s
- [ ] Scan a second label → qty of the first line stays 1 and the new line is added
- [ ] Scan an unknown barcode → lower buzz + red flash + "باركود غير موجود" toast with "إضافة صنف"; tapping it closes the camera and opens the new-variant dialog with the barcode filled
- [ ] Close the camera mid-scan → no green camera indicator remains (stream stopped)
- [ ] Torch button appears only when the device supports it; toggling works
- [ ] "تبديل الكاميرا" switches front/back and scanning still works
- [ ] Deny camera permission → Arabic message appears; manual barcode entry still works
- [ ] Press Escape / × / tap outside → scanner closes and the invoice/cart is unchanged
- [ ] In the POS barcode field, a USB/Bluetooth scanner + Enter adds the item and **never** saves the invoice
- [ ] While the camera overlay is open, F2/F4/Ctrl+Enter do nothing
- [ ] Product form → "مسح" fills the barcode; scanning a barcode owned by another variant shows its name/size/color with "فتح الصنف"
- [ ] Purchases → new purchase → "مسح" selects the variant and prefills the cost
- [ ] Stocktake → "مسح للجرد": first scan of a variant sets counted to 1, next scans add one
- [ ] Price Check page: scan several items in a row → each result shows name, size, color, price, stock

## Camera Barcode Scanning (iPhone Safari)

iOS 14.3+ exposes `getUserMedia` only in Safari (or a WebView with camera permission); `BarcodeDetector` is unavailable, so the vendored ZXing fallback must decode.

- [ ] Open the app over **https** (LAN http will not show the permission prompt)
- [ ] Tap "مسح" → "Allow" camera access
- [ ] Rear camera opens; scanning EAN-13 and Code-128 labels works (ZXing fallback)
- [ ] Success beep plays after the first user gesture; vibration is not supported on iOS (no error shown)
- [ ] Torch button is hidden when unsupported (no broken control)
- [ ] Continuous scanning ignores the same label for ~1.5 s
- [ ] Rotate the phone / switch apps → returning keeps the page usable; closing the scanner stops the camera
- [ ] Manual barcode entry works when camera access is denied

## Save File Location (Settings → النسخ الاحتياطي)

- [ ] With a folder linked: card "مكان حفظ البيانات" shows `<folder>/db.json`, the file size and last-modified date
- [ ] "نسخ" copies the shown path
- [ ] The backups folder (`<folder>/backups/`) and the newest backup file name are visible
- [ ] The note explains that the browser hides the absolute OS path and shows only the folder + file names
- [ ] Without a folder: the card clearly says data is only in browser storage (`beestore-db`) and offers "اختيار مجلد البيانات"
- [ ] After "حفظ الآن", the file size/last-modified refresh when reopening the tab

## Printing

- [ ] Print an invoice in A4 format
- [ ] Print an invoice in 80mm thermal format
- [ ] Print a barcode label sheet

## Data Safety

- [ ] Close browser abruptly mid-use and confirm no data is lost
- [ ] Confirm Settings → البيانات shows whether persistent storage is granted; if not, request it
- [ ] Understand that «مسح بيانات الموقع» in browser settings deletes IndexedDB; take a backup first
- [ ] Create an off-device backup from Settings → النسخ الاحتياطي → نسخ ومشاركة; save it to Drive/WhatsApp/email
- [ ] Create a backup with a passphrase; verify the file is encrypted and cannot be restored with a wrong passphrase
- [ ] Restore the unencrypted backup on the same origin; review the summary/warnings, type `استعادة` to enable the button, confirm, and verify data
- [ ] Restore the encrypted backup; confirm the passphrase is requested and the checksum verifies
- [ ] Tamper with one character in a backup JSON; confirm restore is blocked with a checksum error and data is unchanged
- [ ] Restore an older backup; confirm the “older backup” warning appears and a pre-restore safety snapshot is created
- [ ] Restore a backup with a different `meta.deviceId`; confirm the “different device” warning appears
- [ ] On a fresh install, choose “استعادة من نسخة احتياطية” from the wizard and verify the app starts with the restored data
- [ ] Set the last backup to 3 days ago with new activity; confirm the reminder banner appears; at 8 days confirm the red critical banner
- [ ] Confirm the dashboard shows the last backup time and “نسخ الآن” works
- [ ] Confirm Settings → البيانات shows record counts, storage usage, and 70%/90% warnings when applicable
- [ ] Open a second tab and confirm it is blocked
- [ ] Verify data is tied to the origin (scheme + host + port): opening a different host/port shows a separate empty database
- [ ] Before changing hosting/domain: create an off-device backup from the old address and restore it on the new one
- [ ] Apply a PWA update and confirm no invoices/products/settings were lost
- [ ] Confirm the pre-migration snapshot exists/downloads when a schema migration is triggered

## Data Integrity

- [ ] Verify stock matches sum of movements (Settings > Maintenance)
- [ ] Verify P&L figures are correct after a series of operations
- [ ] Verify balance snapshot balances
- [ ] Verify customer balances are correct after sales and payments

## Performance (L2)

> Automated reference (headless Chromium, re-run after L4 on 2026-10-25): 370 ms cold start, 30 ms save, 176 ms dashboard, 153 ms window month, 180 ms old month, 39.2 MB. Physical-phone verification is still required.

- [x] Seed 50,000 invoices with `tests/perf.html` (headless or a desktop browser)
- [x] Cold start ≤ 3 s; save invoice ≤ 100 ms; dashboard ≤ 1 s
- [x] Month Review for a month inside the memory window ≤ 1 s
- [x] Month Review for an older month (outside the window) ≤ 2 s and shows the small top progress bar without blocking the screen
- [ ] Search is instant with 5,000+ variants
- [ ] Invoice list is fast with 50,000+ invoices
- [x] A backup created after scrolling old months still contains those old invoices (restore/export check)
- [ ] On a physical mid-range phone, repeat the cold-start/dashboard/Month Review timings and record them
