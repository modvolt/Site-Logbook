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

## Invoice price-fill must revert symmetrically across the whole lifecycle

When an approved invoice/credit note fills a price onto a DIFFERENT document's
material (delivery-note "čeká na fakturu" material: `priceSourceDocumentId` =
invoice, but the material's own `sourceId` line belongs to the delivery note),
that fill is NOT removed by `syncJobMaterialsForDocument` (it keys off the
invoice's own lines, which never created these materials). So every path that
takes the invoice OUT of `approved` must explicitly roll the price back, or the
system keeps offering/billing a price from a non-approved source.

**Rule:** `revertInvoicePricePropagation(tx, documentId)` resets such materials
to `awaiting_invoice` (price 0, clear all `priceSource*`), and is wired into
`setDocumentStatus` (leaving `approved`) and `deleteDocument`. It skips
materials already reserved on a customer invoice (`invoicedInvoiceId != null`).

**The closing edge case:** because revert skips reserved materials, a doc
un-approved/deleted WHILE its material sits on a customer draft would leave a
stale price after the draft is later cancelled. So `releaseInvoicedMaterials`
re-validates on release: if `priceSource='invoice'` and the source document is
gone or no longer `approved`, it reverts the price then too.
**Why:** "approved-only" price semantics must hold through un-approve, delete,
AND deferred customer-invoice release — three separate exit points.
**How to apply:** any new path that clears `invoicedInvoiceId` or changes a
doc's approved state must keep material price provenance consistent with an
actually-approved source. Quantity is never touched, so stock issues are
unaffected; revert only reconciles defensively.
