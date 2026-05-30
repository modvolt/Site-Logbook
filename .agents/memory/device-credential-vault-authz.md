---
name: Device credential vault authz
description: Why the Přístupové údaje (device credentials) feature is role-gated to master+admin, not generic auth.
---

# Device credential vault — access control

The "Přístupové údaje" feature stores device login credentials (including
plaintext passwords) per customer/locality. Passwords are stored **plaintext**
in the DB on purpose — the app is the credential vault.

**Rule:** all device-credential routes must be gated to elevated roles
(`requireRole("master", "admin")`), never just `requireAuth`.

**Why:** the app supports `guest` (read-only) accounts. The global API
middleware only blocks *writes* for guests (`requireWriteAccess`), so any
authenticated user — including guests — can issue GETs. Without an explicit
role gate, a guest could read every stored password. Because the secrets are
plaintext, generic authenticated read access is a real leak, not a theoretical
one.

**How to apply:**
- Backend: `router.use(requireRole("master", "admin"))` at the top of the
  device-credentials router.
- Frontend: gate both the nav item and the route with `can("write")`
  (master+admin) so guests never see a page that only 403s.
- On POST/PATCH, validate that any provided `siteId` belongs to the same
  customer as the credential, or reject (cross-customer linkage otherwise
  silently allowed by the FK alone).
