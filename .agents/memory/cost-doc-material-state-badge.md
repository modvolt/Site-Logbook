---
name: Cost-document derived materialState badge
description: How the document-level "material assigned/approved" state is derived & surfaced, and the nullable-enum OpenAPI pattern it uses.
---

Received cost documents (přijaté doklady) show a derived, document-level
material badge next to the status badge, in BOTH the list row and the detail
header (user explicitly chose "both").

Semantics (derived only — NO DB column):
- Material lines = `lineType === "material" && !feeType` (same filter the
  price/material propagation loop uses).
- `materialState`:
  - `"approved"` ("Materiál odsouhlasen") when EVERY material line is approved.
  - else `"assigned"` ("Materiál přiřazen") when EVERY material line has
    matchConfirmed > 0.
  - else `null` (no badge) — no material lines, or a mixed state.
- `approved` takes precedence over `assigned`.

Wiring:
- `deriveMaterialState(lines)` + `serializeDocument(row, materialState=null)`
  (optional 2nd param so other callers are unaffected).
- List endpoint carries no lines → one extra grouped query over
  `billing_document_lines` via `inArray(documentId, ids)`, grouped in JS into a
  Map, then per-row state. NOT N+1.
- Detail endpoint already loads `lines` → derive directly, no extra query.

**Nullable enum in OpenAPI → clean orval/zod codegen:** use
`type: ["string","null"]` + `enum: [assigned, approved, null]` (null listed in
the enum). Orval generates a string union type and zod emits
`zod.union([literal('assigned'), literal('approved'), literal(null)]).nullish()`.
Keep the field OUT of `required` so it's optional+nullable on the client.

**Why:** badge colours are deliberately blue (assigned) / violet (approved) so
the new badge never visually reads as the green "Schváleno" document-status
badge sitting right beside it.
