# Upgrading BeeStore v3-Lite to v3-Full (server + sync)

> **Status:** design guidance only. v3-Lite does **not** contain a server, accounts, sync or a cloud database. This document explains how the existing data format, services and facade are meant to carry over when the full design (`BeeStore-v3-Offline-Sync.md`) is implemented.

## 1. What stays the same

These are compatibility contracts. A future backend must accept and return them without renaming fields.

| Layer | Contract to preserve |
|---|---|
| Money | Integer minor units (agorot/cents), rounded with `BeeStore.money` |
| Dates | Business date `YYYY-MM-DD`; timestamps ISO-8601 UTC |
| IDs | Stable prefixed IDs (`sal_…`, `pur_…`, `clo_…`) generated on the client |
| Documents | Immutable after posting; corrections/voids are new states, never hard deletes |
| Periods | `periodClosings` lock a month; `dailyClosings` lock a day and reconcile the drawer |
| Cash | Signed `cashAdjustments`, generated transfer/withdrawal documents with `closingId` |
| Audit | Append-only `auditLog`, now including the acting profile |
| Settings | Same keys, including `systemStartDate`, tax, payment methods, drawer/bank accounts, profiles (PIN hash fields become server credentials) |
| Backups | The JSON envelope remains importable; a server migration must not invalidate old backups |
| Facade | `BeeStore.api.<namespace>.<method>(args) → {ok, data|error}` remains the only UI entry point |

## 2. Layer-by-layer mapping

### 2.1 Repository → server API

Today `IdbRepository` / `MemoryRepository` implement the same interface: `get`, `list`, `listRange`, `query`, `transaction`, `getSummary`, `exportAll`, import, etc.

For v3-Full:

1. Add a `RemoteRepository` (or a command API) behind the same service boundary.
2. Do **not** replace `repo.transaction(fn)` with fire-and-forget HTTP calls. A transaction becomes one server command (or one batch) that applies all writes atomically.
3. Keep a local IndexedDB cache for offline reads and optimistic writes; the sync engine owns retries.
4. `getSummary` becomes either a server-computed summary or a locally rebuilt cache. The summary `VERSION` must be bumped when its shape changes.

### 2.2 Services → server command handlers

The services already contain the business rules (pricing, average cost, returns, payroll, period locks, cash closing). Reuse them as the reference implementation:

- Move validation/business rules to shared pure modules if the server is JavaScript/TypeScript.
- Otherwise port them with the existing tests as the specification.
- Day/month closing rules must run **inside** the server transaction, not only in the UI.
- `assertPeriodOpen` and `assertDayOpen` become server-enforced guards, not client conventions.

### 2.3 Facade methods → REST/GraphQL routes

Keep namespace and method names stable so pages do not change. Example mapping:

| Facade | Full backend |
|---|---|
| `sales.create(data)` | `POST /stores/:id/sales` with `clientKey` idempotency |
| `sales.void(id, reason)` | `POST /stores/:id/sales/:id/void` |
| `returns.create(data)` | `POST /stores/:id/returns` |
| `dailyClosings.close(data)` | `POST /stores/:id/daily-closings` (one atomic command) |
| `periods.close(month, note)` | `POST /stores/:id/periods/:month/close` |
| `reports.monthReview(month)` | `GET /stores/:id/reports/month-review?month=` |
| `accountingPackage.build(month)` | can stay client-side, or move to a server job returning the same ZIP/manifest |
| `security.setPin/unlock` | replaced by `auth.login`, sessions, password reset |
| `backup.*` | server snapshots + export jobs; keep the same JSON envelope |

`docs/API.md` already lists the intended REST route per method. Keep it updated as the contract.

### 2.4 Local profiles → server accounts and roles

| v3-Lite | v3-Full |
|---|---|
| `settings.profiles.owner.pin` (PBKDF2 hash) | Owner account, server-side password/2FA |
| `settings.profiles.cashier.pin` | Cashier account bound to a store and permissions |
| Facade cashier allow-list + response stripping | Server RBAC + response DTOs that never contain cost/profit |
| Auto-lock after inactivity/background | Session expiry, refresh tokens, device list, remote revoke |
| Audit `profile` field | Authenticated actor id + role in every audit record |
| No remote wipe | Device/session revocation; optional remote data wipe |

**Important:** response shaping must happen on the server for the cashier role. Client-side stripping is not security once a network response exists.

### 2.5 Single writer → sync

v3-Lite is deliberately single-writer. A sync design needs, at minimum:

1. A server sequence/version per store and per document.
2. Client-generated operation IDs (existing `clientKey` is a start) and idempotent replay.
3. A conflict policy per document type:
   - Sales/payments/stock movements: append-only, no merge; reject duplicate operation IDs.
   - Master data (products, prices, customers): last-write-wins with server version checks, or explicit merge UI.
   - Closings: server-authoritative; reopening must be a command with an audit record.
4. Pull changes since a cursor; keep a local outbox while offline.
5. A rule that a device cannot post into a day/month closed on the server.
6. Tests for offline → online replay, duplicate submits, two-device conflict, and clock skew.

Do **not** implement “sync” by putting the JSON database file in Drive/Dropbox. Whole-file replacement loses concurrent changes and can corrupt on interrupted writes.

## 3. Suggested migration sequence

1. **Freeze and verify v3-Lite.** Run all tests, create an encrypted off-device backup, and verify a restore on a second device.
2. **Define the server schema** from the collection list in `docs/DATA_FORMAT.md`; preserve field names and IDs.
3. **Build an importer** that reads the v3-Lite JSON envelope (`schemaVersion`, `meta`, `settings`, `collections`) and writes rows without changing IDs or amounts.
4. **Build read-only endpoints first** (`settings.get`, products, sales list, reports, packages) and compare outputs against the v3-Lite app on the same imported data.
5. **Add write commands** one namespace at a time, starting with master data, then sales/returns/payments, then purchases/expenses/payroll, then closings.
6. **Run parallel verification:** import the same backup into both systems; compare P&L, balance snapshots, receivables/payables aging, cash book, and the accountant package manifest checks.
7. **Cut over one writer.** Disable the old device’s writing path (or keep it read-only). Never allow dual writes during the transition.
8. **Enable sync only after** idempotency, conflict tests, and server-side day/month guards pass.
9. **Keep the v3-Lite export/import path forever** as the escape hatch and archival format.

## 4. Backend data model sketch

Use one row/document per existing entity; do not normalize away the stable IDs.

- `stores`, `users`, `memberships(role)`, `devices`, `sessions`.
- `accounts`, `categories`, `products`, `variants`, `stockMovements`.
- `customers`, `sales`, `salesReturns`, `customerPayments`.
- `suppliers`, `purchases`, `purchaseReturns`, `supplierPayments`.
- `expenseCategories`, `expenses`, `recurringExpenses`.
- `employees`, `payroll`, `employeeAdvances`.
- `ownerTransactions`, `transfers`, `dailyClosings`, `cashAdjustments`, `periodClosings`.
- `auditLog`, `errorLog` (technical only).
- `storeSummary` (materialized) or an on-demand report cache.

Every document keeps `createdAt`, `updatedAt`, `createdByProfile`/actor, and its business `date`. Never mutate a posted document in place without an audit trail.

## 5. Closing and reporting rules to port exactly

- Sales returns reduce net sales and COGS only for restocked lines.
- Purchases do not reduce profit; COGS is recognized at sale time using weighted-average cost.
- Payroll accrues by month; paying it settles cash, not a second expense.
- Spread expenses allocate one share per month; shares sum exactly to the total.
- Signed cash differences: shortage increases operating expenses, surplus reduces them.
- Daily closing expected cash = drawer ledger balance at day end; generated difference/transfer/withdrawal documents are excluded from the recomputation.
- Month close requires earlier months closed and all active days closed in order.
- Accountant package cross-checks:
  - P&L equals Month Review.
  - Σ Sales Journal = net sales (+ tax identity).
  - Cash Book closing = cash balance.
  - Inventory valuation = balance-snapshot inventory.
  - Daily-closing differences = P&L cash difference.
  - Manifest SHA-256 checksums verify.

## 6. Security and honesty checklist

- Do not claim remote wipe until it exists.
- Do not ship a cashier UI that relies only on hidden fields; shape responses server-side.
- Store passwords with a modern KDF (the v3-Lite PIN uses PBKDF2-SHA256, 210,000 iterations; server auth should use Argon2id/bcrypt and TLS).
- Rate-limit login and sensitive commands.
- Encrypt backups in transit and at rest where the backend stores them.
- Keep an audit record for logins, role changes, device removal, closings, voids, and price/cost edits.
- Document data-retention and export/delete procedures.

## 7. Acceptance tests before calling the upgrade complete

1. Import a real v3-Lite backup; every count and total matches the old app.
2. A cashier account cannot obtain cost/profit from any endpoint, including reports and raw document payloads.
3. Two devices replaying the same `clientKey` create exactly one sale.
4. Offline sales sync after reconnect in order, with no duplicates.
5. A posting into a closed day/month is rejected by the server.
6. The accountant package from the server passes all cross-checks and checksum verification.
7. Restore/export still produces a JSON envelope that v3-Lite can import.
8. Audit log shows the authenticated actor for every sensitive action.
9. Removing a device/session takes effect immediately.
10. A rollback to the v3-Lite backup is tested and documented.
