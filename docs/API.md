# BeeStore API Documentation

All methods return `{ ok: true, data: ... }` or `{ ok: false, error: { code, message } }`.

## REST Route Mapping

| Method | REST Route | Description |
|---|---|---|
| `settings.get()` | `GET /api/settings` | Get all settings |
| `settings.save(data)` | `PUT /api/settings` | Save all settings |
| `settings.update(patch)` | `PATCH /api/settings` | Update settings partially |
| `accounts.list()` | `GET /api/accounts` | List all accounts |
| `accounts.get(id)` | `GET /api/accounts/:id` | Get account by ID |
| `accounts.create(data)` | `POST /api/accounts` | Create new account |
| `accounts.update(id, patch)` | `PATCH /api/accounts/:id` | Update account |
| `accounts.balance(id)` | `GET /api/accounts/:id/balance` | Get account balance |
| `accounts.ledger(id, range)` | `GET /api/accounts/:id/ledger?from=&to=` | Get account ledger |
| `categories.list()` | `GET /api/categories` | List categories |
| `categories.create(data)` | `POST /api/categories` | Create category |
| `categories.update(id, patch)` | `PATCH /api/categories/:id` | Update category |
| `categories.remove(id)` | `DELETE /api/categories/:id` | Remove category |
| `products.list()` | `GET /api/products` | List products |
| `products.get(id)` | `GET /api/products/:id` | Get product |
| `products.getWithVariants(id)` | `GET /api/products/:id/variants` | Get product with variants |
| `products.create(data)` | `POST /api/products` | Create product |
| `products.createWithGrid(data)` | `POST /api/products/grid` | Create product with size×color grid |
| `products.update(id, patch)` | `PATCH /api/products/:id` | Update product |
| `products.deactivate(id)` | `POST /api/products/:id/deactivate` | Deactivate product |
| `products.search(q)` | `GET /api/products/search?q=` | Search products |
| `variants.list()` | `GET /api/variants` | List all variants |
| `variants.get(id)` | `GET /api/variants/:id` | Get variant |
| `variants.search(q)` | `GET /api/variants/search?q=` | Search variants |
| `variants.byBarcode(barcode)` | `GET /api/variants/barcode/:barcode` | Find by barcode |
| `variants.update(id, patch)` | `PATCH /api/variants/:id` | Update variant |
| `variants.getLowStock(threshold)` | `GET /api/variants/low-stock` | Get low stock variants |
| `stock.movements(variantId)` | `GET /api/stock/movements?variantId=` | Get stock movements |
| `stock.adjust(variantId, qty, reason, date, note)` | `POST /api/stock/adjust` | Adjust stock |
| `stock.stocktake(items, date)` | `POST /api/stock/stocktake` | Apply stocktake |
| `stock.recalculate()` | `POST /api/stock/recalculate` | Recalculate all stock |
| `stock.verify()` | `GET /api/stock/verify` | Verify stock integrity |
| `sales.list(filters)` | `GET /api/sales?status=&from=&to=&search=` | List sales (period-scoped by UI) |
| `sales.get(id)` | `GET /api/sales/:id` | Get sale |
| `sales.getByNumber(number)` | `GET /api/sales/number/:number` | Get by invoice number |
| `sales.create(data)` | `POST /api/sales` | Create sale (`clientKey` dedupes double-submits) |
| `sales.void(id, reason)` | `POST /api/sales/:id/void` | Void sale |
| `sales.printData(id)` | `GET /api/sales/:id/print` | Get print data |
| `returns.list(filters)` | `GET /api/returns?from=&to=` | List returns (period-scoped by UI) |
| `returns.get(id)` | `GET /api/returns/:id` | Get return |
| `returns.create(data)` | `POST /api/returns` | Create return |
| `customers.list()` | `GET /api/customers` | List customers |
| `customers.get(id)` | `GET /api/customers/:id` | Get customer |
| `customers.create(data)` | `POST /api/customers` | Create customer |
| `customers.update(id, patch)` | `PATCH /api/customers/:id` | Update customer |
| `customers.balance(id)` | `GET /api/customers/:id/balance` | Get customer balance |
| `customers.statement(id)` | `GET /api/customers/:id/statement` | Get customer statement |
| `customers.receivePayment(data)` | `POST /api/customers/payments` | Receive payment |
| `customers.overdueInstallments()` | `GET /api/customers/overdue-installments` | Get overdue installments |
| `suppliers.list()` | `GET /api/suppliers` | List suppliers |
| `suppliers.get(id)` | `GET /api/suppliers/:id` | Get supplier |
| `suppliers.create(data)` | `POST /api/suppliers` | Create supplier |
| `suppliers.update(id, patch)` | `PATCH /api/suppliers/:id` | Update supplier |
| `suppliers.balance(id)` | `GET /api/suppliers/:id/balance` | Get supplier balance |
| `suppliers.statement(id)` | `GET /api/suppliers/:id/statement` | Supplier statement (scoped in UI w/ opening/closing) |
| `suppliers.pay(data)` | `POST /api/suppliers/payments` | Pay supplier |
| `purchases.list(filters)` | `GET /api/purchases?from=&to=` | List purchases (period-scoped by UI) |
| `purchases.get(id)` | `GET /api/purchases/:id` | Get purchase |
| `purchases.create(data)` | `POST /api/purchases` | Create purchase |
| `purchases.void(id)` | `POST /api/purchases/:id/void` | Void purchase |
| `expenses.list(filters)` | `GET /api/expenses?from=&to=&categoryId=` | List expenses |
| `expenses.create(data)` | `POST /api/expenses` | Create expense |
| `expenses.update(id, patch)` | `PATCH /api/expenses/:id` | Update expense |
| `expenses.remove(id)` | `DELETE /api/expenses/:id` | Remove expense |
| `expenses.categories()` | `GET /api/expenses/categories` | List expense categories |
| `expenses.createCategory(data)` | `POST /api/expenses/categories` | Create category |
| `expenses.recurring()` | `GET /api/expenses/recurring` | List recurring expenses |
| `expenses.createRecurring(data)` | `POST /api/expenses/recurring` | Create recurring expense |
| `expenses.generateRecurring(month)` | `POST /api/expenses/recurring/generate` | Generate monthly recurring |
| `employees.list()` | `GET /api/employees` | List employees |
| `employees.get(id)` | `GET /api/employees/:id` | Get employee |
| `employees.create(data)` | `POST /api/employees` | Create employee |
| `employees.update(id, patch)` | `PATCH /api/employees/:id` | Update employee |
| `employees.deactivate(id)` | `POST /api/employees/:id/deactivate` | Deactivate employee |
| `payroll.list(filters)` | `GET /api/payroll?month=&employeeId=&status=` | List payroll |
| `payroll.prepare(month)` | `POST /api/payroll/prepare` | Prepare payroll for month |
| `payroll.update(id, patch)` | `PATCH /api/payroll/:id` | Update payroll record |
| `payroll.pay(id, method, accountId, note)` | `POST /api/payroll/:id/pay` | Pay salary |
| `payroll.advances(employeeId)` | `GET /api/payroll/advances?employeeId=` | Get advances |
| `payroll.createAdvance(data)` | `POST /api/payroll/advances` | Create advance |
| `payroll.outstandingAdvances(employeeId)` | `GET /api/payroll/advances/:employeeId/outstanding` | Get outstanding advances |
| `transactions.ownerTransaction(data)` | `POST /api/transactions/owner` | Owner transaction |
| `transactions.transfer(data)` | `POST /api/transactions/transfer` | Transfer between accounts |
| `transactions.dailyClosing(data)` | `POST /api/transactions/daily-closing` | Save daily closing |
| `reports.profitAndLoss(from, to)` | `GET /api/reports/pnl?from=&to=` | Profit & Loss |
| `reports.salesReport(from, to, groupBy)` | `GET /api/reports/sales?from=&to=&groupBy=` | Sales report |
| `reports.inventoryValuation()` | `GET /api/reports/inventory` | Inventory valuation |
| `reports.receivablesAging()` | `GET /api/reports/receivables-aging` | Receivables aging |
| `reports.payablesAging()` | `GET /api/reports/payables-aging` | Payables aging |
| `reports.balanceSnapshot(asOf)` | `GET /api/reports/balance?asOf=` | Balance snapshot |
| `reports.dailyClosing(date)` | `GET /api/reports/daily-closing?date=` | Daily closing report |
| `reports.monthReview(month)` | `GET /api/reports/month-review?month=` | v2 Month Review (§9.1) |
| `reports.yearOverview(year)` | `GET /api/reports/year?year=` | v2 Year Overview (§9.2) |
| `reports.profitCashReconciliation(month)` | `GET /api/reports/reconciliation?month=` | v2 Profit⇄Cash (§9.3) |
| `reports.compareMonths(a, b)` | `GET /api/reports/compare?a=&b=` | v2 Compare Months (§9.4) |
| `periods.list()` | `GET /api/periods` | Closed months |
| `periods.monthsWithData()` | `GET /api/periods/months-with-data` | Months containing documents |
| `periods.get(month)` | `GET /api/periods/:month` | Closing record or null |
| `periods.checklist(month)` | `GET /api/periods/:month/checklist` | Closing checklist (§7.2) |
| `periods.close(month, note)` | `POST /api/periods/:month/close` | Lock the month |
| `periods.reopen(month, note)` | `POST /api/periods/:month/reopen` | Reopen latest only |
| `expenses.spread(data)` | `POST /api/expenses/spread` | Spread expense over N months |
| `purchaseReturns.list(filters)` | `GET /api/purchase-returns?from=&to=` | List purchase returns (period-scoped by UI) |
| `purchaseReturns.create(data)` | `POST /api/purchase-returns` | Purchase return |
| `maintenance.integrityCheck()` | `GET /api/maintenance/integrity` | Data Integrity Checker (§12.2) |
| `dashboard.get()` | `GET /api/dashboard` | Dashboard data |
| `backup.createNow()` | `POST /api/backup` | Create backup now |
| `backup.list()` | `GET /api/backup` | List backups |
| `backup.download()` | `GET /api/backup/download` | Download backup |
| `backup.restore(data)` | `POST /api/backup/restore` | Restore from data |
| `backup.restoreFromFile(name)` | `POST /api/backup/restore/:name` | Restore from file |
| `maintenance.recalculateStock()` | `POST /api/maintenance/recalculate-stock` | Recalculate stock |
| `maintenance.resetAll()` | `POST /api/maintenance/reset` | Reset all data |
| `maintenance.isDatabaseEmpty()` | `GET /api/maintenance/empty` | Check if empty |
| `audit.list(limit)` | `GET /api/audit?limit=` | List audit log |
