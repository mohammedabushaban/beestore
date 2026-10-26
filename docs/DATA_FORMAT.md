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

## v3-Lite L5 Local Profiles & Clock Fields (schemaVersion 3)

- `settings.profiles.owner` / `settings.profiles.cashier`: `{id, name, pin, active}`. `pin` is `null` or `{algorithm: "PBKDF2-SHA256", iterations: 210000, salt: <base64>, hash: <base64>, createdAt}`. The PIN itself is never stored and never returned by the facade.
- `settings.autoLockMinutes` (default 5), `settings.lockoutAfter` (default 5), `settings.lockoutSeconds` (default 30), `settings.cashierMaxDiscountPercent` (default 10), `settings.cashierMaxReturnMinor` (default 5000 = ₪50), `settings.largeFont` (default false).
- `sales`, `salesReturns`, `exchanges`: optional `createdByProfile` (`"owner"|"cashier"`). `auditLog` records carry `profile` and remain append-only.
- `meta.clock`: `{lastSeenDate, lastSeenAt, confirmedDate, confirmedAt}`. A backward jump >1 day vs `meta.updatedAt`, or a forward jump >30 days vs `lastSeenDate`, requires a per-day owner confirmation before posting.
- Lock state (active profile, failed attempts, lockout expiry) is in memory only and is intentionally not exported in backups.

## v3-Lite L8 Integrity Fields (schemaVersion 3, dbVersion 6)

No new collection or schema version was added. L8 uses the existing fields:

- `dailyClosings.cashDrawerAccountId` and `cashDrawerAccountName`: the drawer identity frozen with each closing. Integrity recomputation uses this account even if settings change later.
- `dailyClosings` frozen figures are re-derived from documents with `excludeClosingId`, so the closing's own `cashAdjustments` / `transfers` / `ownerTransactions` are not double-counted. The check compares opening, invoice count, sales, average, cash sales, collections, refunds, supplier cash payments, cash expenses, other in/out, expected cash, method maps, `counted − expected = difference`, `counted − takenOut = retainedFloat`, and the `noCount` zero-difference rule.
- `cashAdjustments` with `sourceType: "cash_difference"` must match their closing's `differenceMinor`, `date`, and drawer account; their monthly sum must equal the month's closing differences.
- `meta.summary.cashDifference` remains the signed monthly sum used by P&L.
- Integrity reads `settings.lastBackupAt`, `settings.lastOffDeviceBackupAt`, `settings.backupWarnDays`, `settings.backupCriticalDays`, `settings.unclosedDayWarningDays` (default 3), and returns `backup`, `storage`, `clock`, `drawer`, and `unclosedDays` alongside errors/warnings.

## v3-Lite L7 Accountant Package (not stored in IndexedDB)

The package is generated in memory and never written to the database. Its manifest uses this shape:

```json
{
  "format": "BeeStore-Accountant-Package",
  "formatVersion": 1,
  "month": "2026-10",
  "status": "closed",
  "final": true,
  "generatedAt": "2026-10-31T18:00:00.000Z",
  "appVersion": "3.0.0-lite",
  "files": [{ "path": "accounting.xlsx", "size": 12345, "sha256": "..." }],
  "checks": [{ "id": "pnl-month-review", "status": "pass", "message": "..." }]
}
```

`status` is `"open"` until the month is closed; open packages are watermarked **«غير نهائي — الشهر مفتوح»**. CSV files are UTF-8 with a BOM and guard leading `=`, `+`, `-`, `@` against formula injection.

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
