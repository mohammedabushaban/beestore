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
- [ ] **Products**: create product, edit price/cost, deactivate product
- [ ] **Labels**: select variants, set copies, print label sheet
- [ ] **Purchases**: create purchase invoice, verify stock increases
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
