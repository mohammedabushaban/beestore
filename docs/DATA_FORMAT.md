# BeeStore Data Format

## JSON Structure

```json
{
  "schemaVersion": 4,
  "meta": {
    "schemaVersion": 4,
    "counters": { "invoice": 123, "purchase": 45, "return": 10, "journal": 7 },
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
    "chartOfAccounts": [...],
    "journalEntries": [...],
    "periodClosings": [...],
    "errorLog": [...],
    "auditLog": [...]
  }
}
```

## v5 A1 Accounting Fields (schemaVersion 4, dbVersion 7)

- `chartOfAccounts`: `id`, `code`, `nameAr`, `type` (`asset|liability|equity|revenue|expense|contra`), `normalSide` (`debit|credit`), `contra`, `system`, `active`, `parentCode`, optional `systemKey`, `legacyAccountId`, `legacyType`, `paymentMethodId`, `expenseCategoryId`, `clearing`, timestamps. System codes include `1010/1100/1150/1200/1300/2010/2020/2030/2100/2110/2120/2200/3010/3020/3030/4010/4020/4100/5010/5020/5030/6100/6110/6120/6200/6400/6410`; `6010–6095` are default expense categories; `1500/1590/4110/6300/6350` only when `settings.fixedAssetsEnabled`; tax account `2300` never exists.
- Legacy `accounts` gain `chartAccountId`; `expenseCategories` gain `chartAccountId` and `code`; `settings.paymentMethods[]` gain `kind` (`cash|bank_direct|clearing|customer_credit`) and `chartAccountId`. Old `accountId` remains untouched.
- `journalEntries`: `id`, `number` (`JE-000001`), `date`, `time`, `createdAt`, `sourceType`, `sourceId|null`, `description`, `lines[]`, `reversalOf|null`, `isScheduled`, `postingVersion`, `profile`. Each line is `{accountId, debitMinor, creditMinor, partyType|null, partyId|null, memo}` with exactly one positive integer side.
- Journal is **append-only**: never update/delete a stored entry; void by a same-date exact reversal. `meta.counters.journal` drives numbering and must never go backwards.
- Migration `3→4` seeds/links the chart, initializes `journalEntries: []`, and reconciles the JE counter from the largest existing number. Existing documents are not rewritten.

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
