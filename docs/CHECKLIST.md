# BeeStore Manual Acceptance Checklist

## Browser Compatibility

- [ ] Open `index.html` by double-click in Chrome
- [ ] Open `index.html` by double-click in Edge
- [ ] Verify the app loads and shows the first-run wizard
- [ ] Open in Firefox/Safari and confirm the warning banner appears

## First-Run Wizard

- [ ] Enter store name (Arabic and English)
- [ ] Choose a data folder (create new subfolder like `BeeStore-Data`)
- [ ] Load demo data or start empty

## Pages

- [ ] **Dashboard**: sales today, month totals, account balances, low stock count
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
- [ ] Refresh keeps the period; copy URL with `?m=`/`?y=` to a new tab and confirm it opens the same period
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
- [ ] Clear browser data and recover from the folder file
- [ ] Restore a backup
- [ ] Open a second tab and confirm it is blocked

## Data Integrity

- [ ] Verify stock matches sum of movements (Settings > Maintenance)
- [ ] Verify P&L figures are correct after a series of operations
- [ ] Verify balance snapshot balances
- [ ] Verify customer balances are correct after sales and payments

## Performance

- [ ] Search is instant with 5,000+ variants
- [ ] Invoice list is fast with 50,000+ invoices
