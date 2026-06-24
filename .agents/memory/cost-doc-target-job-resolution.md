---
name: Cost-document target-job resolution (confirmed reference is a real link)
description: How an approved cost document decides which job its lines populate; confirmed references count as a link even when doc.jobId is null.
---

# Cost-document → job: target-job resolution

A confirmed `billing_document_reference` (`matchConfirmed=1`, `matchedJobId` set)
is a **real link** between a cost document and a job — but confirming it does
**not** write `doc.jobId` (only the references table is updated). So any code that
"populates the linked job" must treat the target job as: `doc.jobId` OR a confirmed
reference's `matchedJobId`, not `doc.jobId` alone.

**The rule:** the two halves of approval must use the SAME target-job set:
- `propagateInvoicePricesToJobMaterials` already targets `doc.jobId` + every
  confirmed reference's `matchedJobId`.
- `syncJobMaterialsForDocument` (which auto-creates the document's own unmatched
  lines as job materials) resolves each line as `line.jobId ?? fallbackJobId`,
  where `fallbackJobId = doc.jobId` else the SINGLE distinct confirmed-reference
  job (ambiguous → null → skip, never guess).

**Why:** before this, a reference-only-linked invoice (no `doc.jobId`, no
`line.jobId`) would update prices on existing delivery-note materials but silently
NOT create brand-new invoice-only items on the job — "neexistující položky se
nezaložily". The two flows disagreed on what "linked" meant.

**How to apply:** any future feature that mirrors document lines onto a job, or
gates on "is this document linked to a job", must include confirmed references in
the target set, and guard ambiguity (multiple distinct confirmed jobs) by doing
nothing rather than picking one. Duplicate-safety is preserved by the existing
`consumedLineIds` exclusion + `(sourceType, sourceId)` upsert idempotency.
