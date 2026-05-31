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

**Rule (extends to distribution):** any endpoint that *emits* vault data —
not just reads it — carries the same gate. The "email the přístupové údaje
PDF to the customer" route (`POST /customers/:id/send-credentials-email`,
in `customers.ts`, not the credentials router) must also
`requireRole("master","admin")`; it ships the same plaintext secrets and
takes a client-supplied `pdfBase64`/`to`, so generic write access would turn
it into a credential-exfil + SMTP-relay channel.

**How to apply:**
- Backend: apply `requireRole("master", "admin")` **per-route** on each
  device-credential endpoint. Do NOT use a pathless `router.use(requireRole(...))`
  at the top of the router — every router is mounted pathlessly in
  `routes/index.ts`, so a pathless guard runs for *every* request flowing through
  the chain and 401s unauthenticated requests (e.g. login) on routers mounted
  after it. See `pathless-router-middleware-leak.md`.
- Frontend: gate both the nav item and the route with `can("write")`
  (master+admin) so guests never see a page that only 403s.
- On POST/PATCH, validate that any provided `siteId` belongs to the same
  customer as the credential, or reject (cross-customer linkage otherwise
  silently allowed by the FK alone).

## Required-field enforcement (ipAddress)

`ipAddress` is required when creating a credential. Enforce it at the **API
contract** (OpenAPI `DeviceCredentialInput.required: [ipAddress]` +
`minLength: 1`), not just in the frontend form — a client-only check is not a
real requirement.

**Why:** the DB column stays nullable on purpose (legacy rows pre-date the
field; a NOT NULL migration would need a backfill). The Create Zod schema is
the source of truth that makes IP mandatory for new entries without breaking
existing data or the partial Update path.

**How to apply:** keep IP required only on `DeviceCredentialInput` (Create).
`DeviceCredentialUpdate` and the DB column remain nullable. `JablotronUser.pin`
must be in the schema's `required` list (nullable) so the generated zod type
matches the DB jsonb `$type` (required key, `string | null`) — otherwise the
route insert fails typecheck with optional-vs-required key mismatch.
