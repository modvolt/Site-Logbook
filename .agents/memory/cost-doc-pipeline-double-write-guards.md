---
name: Cost-document pipeline double-write guards (merge/duplicate/frozen invoice)
description: Three structural guards that keep the ingest→merge→approve→material-sync→warehouse→invoice pipeline from double-writing stock/price when documents are merged, manually paired as duplicates, or already invoiced.
---

# Cost-document pipeline: never double-write across merge/duplicate/invoice seams

Warehouse movements and job-material prices are only ever written at
**approval time** (`syncJobMaterialsForDocument` / `propagateInvoicePricesToJobMaterials`,
called from `approveDocument` and `bulkConfirmReviewLines`). Every seam where a
document can be approved/re-synced more than once, or where two documents
represent the same real-world invoice, is a double-write risk. Three guards
close this:

1. **Auto-merge never absorbs (or is absorbed by) an already-APPROVED
   document.** `mergeRelatedDocumentsTx` (identity match AND fuzzy match
   branches) excludes `status==="approved"` candidates from `performMergeTx`
   and flags `needs_review` instead. An approved doc already ran the full
   pipeline; silently flipping it to `status="duplicate"` would orphan that
   state with nothing left to re-run it.

2. **`approveDocument` rejects `status==="duplicate"` documents outright
   (409).** A merged-away duplicate's own lines are kept for traceability but
   must never be independently approved — that would re-run the same
   propagation/sync pipeline the primary already ran.

3. **`bulkConfirmReviewLines` silently drops lines whose document is
   `status==="duplicate"`** (never counts them as `toConfirm`, never touches
   them) instead of 500ing or re-running propagation for a dead document. A
   client can still hold stale line ids from before a merge happened.

4. **Already-invoiced materials are frozen.** Both
   `propagateInvoicePricesToJobMaterials` and `syncJobMaterialsForDocument`
   skip/preserve any `materials` row with `invoicedInvoiceId != null` — a
   re-approve, price edit, or "Aktualizovat ceny" resync must never rewrite or
   delete a material that has already been billed to the customer.

**Why:** the pipeline is idempotent by design (reconcile-to-desired-state, not
append-only) EXCEPT at these seams, where "desired state" itself becomes
ambiguous (two documents, or a document vs. its own already-billed history).
Idempotency alone doesn't protect you when the *input* is duplicated, not just
the *call*.

**How to apply:** when adding any new bulk/automated action that can approve,
sync, or price-propagate a cost document, check it against a document's
`status` (reject/skip `duplicate`) and against `invoicedInvoiceId` on any
material it would touch. Test combined scenarios (merge + approve, bulk-confirm
+ stale duplicate line, re-sync + frozen material) together, not in isolation —
each guard alone doesn't prove the seam is closed.
