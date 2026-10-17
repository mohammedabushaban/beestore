# Phase 2 Migration Plan

## Overview

Phase 2 moves the system from a client-side browser app to a Node.js backend with a real database.

## Migration Steps

### 1. Set Up Node Backend

- Create Express.js or Fastify server
- Add database (PostgreSQL recommended)
- Implement authentication (JWT) with roles: owner, cashier, accountant

### 2. Database-Backed Repository

Create a new repository implementation that satisfies the same interface as `memoryRepository` and `idbRepository`:

```javascript
class DbRepository extends RepositoryInterface {
  async open() { /* connect to PostgreSQL */ }
  async get(collection, id) { /* SELECT */ }
  async list(collection, predicate) { /* SELECT with WHERE */ }
  async transaction(fn) { /* BEGIN/COMMIT/ROLLBACK */ }
  // ... etc
}
```

### 3. Move Services Unchanged

All files in `services/` run unchanged on the server since they:
- Have no DOM dependency
- Have no direct IndexedDB/File System access
- Only depend on the repository interface

### 4. Replace API Facade

Each `BeeStore.api.<namespace>.<method>()` body becomes a REST call:

```javascript
// Before (Phase 1):
const result = await BeeStore.sales.create(data);

// After (Phase 2):
const result = await fetch('/api/sales', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
  body: JSON.stringify(data)
}).then(r => r.json());
```

### 5. Import Existing Data

- Implement a one-time import endpoint `POST /api/import`
- Accept the `db.json` export format
- Validate `schemaVersion` and run migrations
- Import all collections in one transaction

### 6. Add Authentication

- User model with roles
- Login endpoint returning JWT
- Middleware checking permissions per route
- User-level audit logging

### 7. Hosting

- Deploy backend to a cloud provider
- Serve static files from same origin
- Set up HTTPS
- Configure regular database backups

## Files to Create in Phase 2

```
server/
  index.js              # Express app entry
  db/
    connection.js       # PostgreSQL pool
    schema.sql          # Table definitions
    repository.js       # DbRepository implementation
  middleware/
    auth.js             # JWT verification
    roles.js            # Role-based access control
  routes/
    auth.js             # Login/logout
    api.js              # All REST routes (maps to existing services)
  services/             # Symlink or copy from Phase 1
```

## Files to Modify in Phase 2

- `js/api/api.js` — replace each method body with fetch call
- `index.html` — add login form, remove wizard
- `js/app.js` — remove IndexedDB/FileSync initialization, add auth flow
