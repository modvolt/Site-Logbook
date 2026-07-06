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

## Invoice-filled prices must revert when the source stops being approved

An approved invoice can fill a price onto a material that another document
created (a delivery-note "čeká na fakturu" material). That fill is invisible to
the per-document material sync, so every exit from the approved state must undo
it independently, or the app keeps offering a price whose source is gone.

**Rule:** the three exit points — un-approve, document delete, and the deferred
release of a customer invoice that had reserved the material — must each restore
such a material to a non-billable "awaiting invoice" state.
**Why:** "approved-only" pricing has to hold even when the events arrive out of
order (e.g. source doc deleted while the material sits on a customer draft; the
draft is cancelled only later). A reserved material is skipped by the
un-approve/delete revert, so the release path re-validates provenance itself.
**Critical detail:** clearing to awaiting-invoice means setting the price to
NULL, not 0 — the invoice-proposal/unbilled queries offer any material whose
price is non-null, so a 0 price is still billed as a 0 line. Also: price
propagation targets only confirmed links, so it must NOT be gated on the
auto-link *suggestion* toggle, or manual-confirmed links silently stop pricing.
**How to apply:** any new path that clears a customer-invoice reservation or
changes a cost doc's approved state must keep material price provenance
consistent with an actually-approved source. Quantity is never touched, so stock
issues are unaffected; revert only reconciles defensively.

## Every line-level mutation on an already-approved doc must re-run revert+propagate+sync

Approve/un-approve aren't the only state changes that affect an approved doc's
lines: `updateLine` (price/allocationType edits), `updateWarehousePricesFromDocument`
("Aktualizovat ceny"), and `bulkConfirmReviewLines` can all change which lines
are price-eligible or newly reviewable on a doc that is *already* `approved`.
Each of these must call `revertInvoicePricePropagation` →
`propagateInvoicePricesToJobMaterials` → `syncJobMaterialsForDocument(...,
{excludeSourceLineIds})` in that order after its own mutation, or a stale price
lingers (edit-up doesn't refill) or a newly-confirmed/newly-priced line never
materializes (bulk-confirm on a line added to an already-approved doc).
**Why order matters:** propagate must run before sync so consumed lines get
excluded from sync's own material creation — otherwise the same line produces
two materials (one filled by propagate onto another doc's material, one created
directly by sync).
**Gotcha:** `propagateInvoicePricesToJobMaterials`/`syncJobMaterialsForDocument`
don't check `line.matchConfirmed` — only `doc.status === "approved"` gates them.
For an invoice doc, `isInvoiceDoc` makes sync treat price `0` as authoritative
(sets a real `0` price, not `null`) — so *zeroing* a line's price doesn't cleanly
revert it to `awaiting_invoice`, it creates a second $0 material via sync. Use
allocation-type change (e.g. to `stock`) to test/produce a true "become
ineligible" revert instead of a price-to-zero edit.
