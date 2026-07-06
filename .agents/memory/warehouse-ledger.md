---
name: Warehouse movement ledger (skladové hospodářství)
description: invariants that keep stock quantity correct via an append-only signed movement ledger
---

Stock ("Sklad") is an append-only ledger: movement rows are signed (direction
in/out, positive magnitude), never updated or deleted. `warehouse_items.quantity`
is a cached value recomputed as the signed sum of that item's movements after every
write — it is NOT an independent field.

**Why:** preserves a full audit trail (kniha pohybů) and makes storno/un-approve/delete
trivially correct — append a reversing delta instead of mutating history.

**Invariants (do not break these):**
- **quantity is ledger-derived only.** `quantity` must NOT be writable through the
  warehouse-item create/update API — if it is, the cached column drifts from
  sum(movements) and the next reconcile silently corrects (i.e. loses) the
  difference. Opening balances / corrections go through the manual movement endpoint.
- **Any new install needs an opening-balance backfill.** When introducing the ledger
  onto a table that already has non-zero quantities, seed one "Počáteční stav"
  manual movement per existing item (guard with `NOT EXISTS any movement` so it is
  safe to re-run and never double-counts), or the first reconciled movement zeroes
  the historical baseline.
- **Scoped delete must precede the reversal.** In delete handlers, delete the
  path-scoped row FIRST and only append the reversing movement if a row was actually
  removed — otherwise a wrong-scope delete (404) still commits a spurious storno and
  corrupts the ledger.
- **Every mutation of an approved stock line must reconcile, not just sync materials.**
  Editing a line keeps its id, so re-run `reconcileDocumentStockMovements` (it appends
  the delta). Splitting/deleting a line destroys the id, so reconcile keyed off
  *current* line ids can never see it — explicitly reverse the old line's
  `billing_document_line` receipt AND any propagated `material` issue (before deleting
  the material row) first, then reconcile the new lines. `syncJobMaterialsForDocument`
  alone does NOT touch stock movements.

**How to apply:** all stock writes go through `warehouse-service.ts`:
`reconcileSourceMovements(tx, sourceType, sourceId, desired|null, actor)` appends ONE
delta movement so the source's net contribution equals `desired` (null = reverse to
zero); each append locks the item row `FOR UPDATE` then recomputes qty. Source types:
`billing_document_line` (+in, approved doc stock line, matched by sku/ean then name),
`material` + `activity_material` (−out), `manual`. UI source labels must use these
exact backend source-type strings.

- **`material`/`activity_material` resolution is ID-based, not name-based, at
  reconcile time.** `resolveItemForMaterial` only ever looks at the row's stored
  `warehouseItemId` FK — it never falls back to matching by name. Name matching
  happens ONCE, at save time, in the create/update routes (`resolveWarehouseItemIdByName`
  in `routes/materials.ts` / `routes/activities.ts`), which persist the resolved id
  onto the row. This makes the link immune to later renames/duplicate names.
  **Any test or script that inserts/updates these rows directly via Drizle (bypassing
  the route) must call `resolveWarehouseItemIdByName` itself and set `warehouseItemId`
  explicitly** — otherwise the row has no FK, no issue movement is ever created, and
  the gap looks like a ledger bug when it is actually a missing-linkage bug in the caller.
