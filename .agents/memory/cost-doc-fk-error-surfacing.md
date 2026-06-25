---
name: Cost-document save FK validation & error surfacing
description: Why header save of a cost document can fail with a generic toast, and the rule for FK-referenced fields + surfacing server errors.
---

# Cost-document header save: validate FK refs, surface real errors

When `updateDocument` (cost-document-service) sets a non-null `jobId`/`customerId`
that no longer exists (stale dropdown after the job/customer was deleted), the
`db.update` hits a Postgres FK violation that the route handler returned as a raw
`HTTP 500 "Failed query: update ..."`. The detail page masked every failure with a
generic "Uložení selhalo" toast, so the real reason (FK violation, or the clean
`409 "Schválený doklad nelze upravovat"`) was invisible.

**Rule:** For any user-selectable FK field on a write path, verify the referenced
row exists *before* the update and throw a clean `appError(400, ...)` — never let a
bare FK violation bubble as a 500. And mutation `onError` toasts should surface the
server's `error` message (extract `error.data.error`) as the toast description, not
just a generic title.

**Why:** A generic toast + a raw SQL 500 made a reproducible-on-stale-data bug
undiagnosable; the same masking hid the intentional approved-doc 409 too.

**How to apply:** New/edited billing-document or similar header forms — validate
jobId/customerId (and any FK) on the server, and keep the `saveErrorMessage()`
helper pattern (duck-types `error.data.error`; ApiError is NOT exported from
`@workspace/api-client-react`, so don't `instanceof` it).
