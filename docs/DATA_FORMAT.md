# BeeStore Data Format

## JSON Structure

```json
{
  "schemaVersion": 3,
  "meta": {
    "schemaVersion": 3,
    "counters": { "invoice": 123, "purchase": 45, "return": 10 },
    "revision": 456,
    "savedAt": "2026-01-15T10:30:00.000Z",
    "deviceId": "dev_abc123"
  },
  "settings": { "systemStartDate": "2026-10-01", "blockFutureDates": true, ... },
  "collections": {
    "accounts": [...],
    "categories": [...],
    "products": [...],
    "variants": [...],
    "stockMovements": [...],
    "customers": [...],
    "sales": [...],
    "salesReturns": [...],
    "customerPayments": [...],
    "suppliers": [...],
    "purchases": [...],
    "purchaseReturns": [...],
    "supplierPayments": [...],
    "expenseCategories": [...],
    "expenses": [...],
    "recurringExpenses": [...],
    "employees": [...],
    "payroll": [...],
    "employeeAdvances": [...],
    "ownerTransactions": [...],
    "transfers": [...],
    "dailyClosings": [...],
    "cashAdjustments": [...],
    "periodClosings": [...],
    "errorLog": [...],
    "auditLog": [...]
  }
}
```

## v2 Period Fields (schemaVersion 3)

- `settings.systemStartDate` (`YYYY-MM-DD`): no document may predate it. `settings.blockFutureDates` (default true).
- `expenses`: `month` (derived `YYYY-MM`), `allocation: { mode: "single"|"spread", months, startMonth }`, `voided`, `voidReason`, `recurringId`.
- `recurringExpenses`: `startMonth`, `endMonth|null`, `lastGeneratedMonth`, `effectiveFrom`; unique `(recurringId, month)` on generated expenses.
- `stockMovements`: `avgCostAfterMinor` (weighted-average cost right after the movement).
- `payroll`: `month` is the accrual month; `paidDate` is the cash date.
- `periodClosings`: `month` (unique), `status: "closed"`, `closedAt`, `snapshot{...}`, `note`, `reopenHistory[]`.
- `errorLog`: last 200 `{id, timestamp, source, message, stack, url, userAgent}` — technical details only, no business data (v2 §12.3).
- `sales`: `clientKey` (optional idempotency key — a repeated create with the same key returns the original invoice; v2 §12.1.3).

## v3-Lite L4 Daily Closing Fields (schemaVersion 3, dbVersion 6)

- `dailyClosings`: `date` (unique), `status` (`closed`|`reopened`), `openingCashMinor`, `salesByMethod{method: minor}` (net of refunds by method), `cashSalesMinor` (gross cash for drawer reconciliation), `customerCollectionsCashMinor`, `invoicesCount`, `returnsCashRefundMinor`, `customerCollectionsByMethod{}`, `supplierCashPaymentsMinor`, `cashExpensesMinor`, `cashInOtherMinor`, `cashOutOtherMinor`, `expectedCashMinor`, `countedCashMinor`, `differenceMinor` (counted − expected, signed), `denominationsCount{}|null`, `externalTotals{method: minor}|null`, `externalDifferences{}|null`, `takenOutMinor`, `takenOutMode` (`bank_deposit`|`owner_withdrawal`|`none`), `retainedFloatMinor`, `noCount` (bool), `note`, `closedAt`, `generatedRecordIds[]`, `reopenHistory[]`.
- `cashAdjustments`: `{id, date, accountId, amountMinor (signed), sourceType: "cash_difference", closingId, voided, note, createdAt, updatedAt}`. A negative amount is a shortage (expense); positive is a surplus (income). Indexes: `date`, `accountId`, `closingId`.
- Closing-generated `transfers` (bank deposit) and `ownerTransactions` (owner withdrawal) carry `closingId` and `voided`; reopening soft-voids them instead of deleting audit history.
- `settings.cashDrawerAccountId`, `settings.defaultBankAccountId`, `settings.cashDenominations[]` configure the drawer, suggested bank, and count sheet.
- P&L: monthly summary stores signed `cashDifference`; operating expenses subtract it, so a shortage raises expenses and a surplus lowers them.

## Money Representation

All monetary values are integers in minor units (agorot/cents). For example, ₪100.50 is stored as `10050`.

## Date Representation

- Business dates: `YYYY-MM-DD` strings
- Timestamps (`createdAt`, `updatedAt`): ISO-8601 UTC strings
- Display: Gregorian calendar, Western digits (0-9), local timezone

## ID Format

Random prefixed IDs: `{prefix}_{10 random alphanumeric chars}`, e.g., `prd_x7k2m9p4q1`.

## Human-Readable Numbers

Invoice numbers come from counters: `INV-000123`, `PUR-000045`, `RET-000010`.

## Barcodes

Code128-compatible, 13 digits: `2` + 11-digit sequence + EAN-13 check digit.
