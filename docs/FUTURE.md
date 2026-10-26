# BeeStore — Future Work

> This document records ideas that are **not implemented** in v3-Lite. Nothing here is a promise. The current product is deliberately a single-phone, offline, serverless PWA.

## Current boundary (do not weaken casually)

- One writer device, no accounts, no cloud database, no sync, no remote wipe.
- Static hosting only (GitHub Pages / Cloudflare Pages / Netlify). No server process.
- Data in IndexedDB; off-device copies are JSON backups and read-only accountant packages.
- Classic scripts only; no CDN, no analytics, no third-party runtime.
- Arabic RTL, phone-first, installable PWA.

The honest limits that come with this boundary:

- Local PIN/profile checks stop casual access, not a technical person with developer tools.
- A lost phone cannot be wiped remotely.
- Two writing devices produce two diverging databases.
- Drive/WhatsApp hold copies, not a live shared database.

## Likely next steps (in order of usefulness)

### 1. Better owner operations without a server

- Scheduled backup reminder that cannot be missed (local notification while the app is open).
- A second encrypted backup destination chosen by the owner (e.g. a second Drive folder).
- Richer printable reports (statement bundles, supplier payment schedules).
- More CSV import mappings (supplier price lists, opening balances).
- A guided year-end archive: one package per month plus a yearly summary.

All of these keep the local-first model and the existing data format.

### 2. Multi-device / live accountant access (requires v3-Full)

This is the first real architectural jump. It requires a backend, authentication, a server-side database and conflict handling. See `docs/UPGRADE_TO_V3_FULL.md` for the mapping intended before any code is written.

Candidate scope:

- Owner + cashier accounts with server-enforced roles.
- Several read-only devices; one or more controlled writers.
- Accountant login with read-only access to packages/reports.
- Server-side audit trail and remote session revocation.
- Optional remote wipe / device removal.

Non-negotiable prerequisites:

- Every posting keeps a stable client-generated id / `clientKey` for idempotency.
- Day and month closings remain immutable; corrections are new documents.
- The stable JSON field names and schema migrations are preserved.
- No live database file in Drive/Dropbox (last-writer-wins destroys data).

### 3. Commerce and compliance additions

Only after a backend exists and with a clear legal review:

- Online storefront or product catalogue (do not turn the internal tool into an e-commerce site on GitHub Pages).
- E-invoicing / tax-authority integration (country-specific; needs certification).
- Multi-currency and exchange-rate history.
- Multi-branch inventory and transfers.
- Purchase orders, goods-received notes, supplier portals.
- Barcode label templates imported from suppliers.

## Things we deliberately will not do

- Store a live database in a synced folder and call it “sync”.
- Run two writers without a conflict protocol.
- Add third-party scripts, remote fonts, analytics or trackers to the offline shell.
- Upload business data to a hosting provider as part of normal operation.
- Promise remote wipe or “military-grade” security while the app is serverless.
- Silently change historical figures after a month/day is closed.

## Decision checklist before starting a future milestone

1. Does it preserve the single-writer guarantee, or does it add a real sync design?
2. Can it be implemented without breaking the stable JSON format and existing backups?
3. Does it keep working offline for the shop’s daily selling flow?
4. Is the security claim honest for a browser-only app, or does it require a server?
5. Are day/month closings and the audit trail still immutable?
6. Is there a rollback path (backup → restore) and a test that proves it?
7. Does it add a dependency that must be vendored and checked for CSP/offline use?
