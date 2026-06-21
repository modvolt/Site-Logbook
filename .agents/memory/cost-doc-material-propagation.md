---
name: Cost-document → job material propagation
description: How approved billing_document_lines propagate into a job's materials list, and the pre-existing splitLine FK bug discovered while wiring it.
---

# Approved cost-document lines → job materials

When a `billing_document` is `status='approved'`, its material lines are
propagated into the linked job's `materials` list (qty + unit price bez DPH).

**Keying / idempotency:** materials carry additive nullable cols
`source_type` + `source_id`. A partial unique index `materials_source_uq`
ON (source_type, source_id) WHERE source_type IS NOT NULL guarantees one
material per source line. `MATERIAL_SOURCE_TYPE = 'billing_document_line'`.

**Sync:** `syncJobMaterialsForDocument(tx, documentId)` is an atomic upsert
(`INSERT ... ON CONFLICT (source_type, source_id) WHERE source_type IS NOT NULL
DO UPDATE`) + reconcile-delete (deletes sourced materials whose line no longer
exists on the doc). It is wired into approve / un-approve (setDocumentStatus) /
line update / splitLine / deleteDocument. **Why upsert, not select-then-insert:**
two concurrent approvals/edits of the same line both see "missing" and both
insert; the partial unique index then 500s one of them. ON CONFLICT makes them
converge. **How to apply:** any code path that changes a document's approved
state or its material lines must call this helper inside the same transaction,
or job materials drift from the doc.

**Why reconcile-delete keys off the doc's current line ids:** when a line is
removed (e.g. split replaces the original), the helper alone can't see the gone
line, so splitLine must *explicitly* delete the original line's sourced material
before re-syncing — otherwise an orphan material survives.

## splitLine FK self-reference (fixed)

`splitLine` deletes the original line, then inserts the new parts. It used to set
`parentLineId = <original lineId>`, but `billing_document_lines.parent_line_id`
has a self-FK → `billing_document_lines(id)`; referencing the just-deleted
original violated it, so split **always 500'd and rolled back** (the route had
never actually worked). **Fix:** split parts now carry `parentLineId = null` —
provenance to a deleted row is impossible anyway, and the frontend never reads
parentLineId (it only ever gated re-splitting). **How to apply:** never point a
self-FK at a row deleted earlier in the same transaction; null it or reorder.
