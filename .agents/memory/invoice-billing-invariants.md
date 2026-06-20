---
name: Invoice billing invariants
description: Non-obvious correctness invariants for the Stavba invoicing (Fakturace) module — concurrency, job-billing provenance, and settings passthrough.
---

# Invoice billing invariants (Fakturace)

## 1. Issue flow must row-lock linked jobs (`FOR UPDATE`)
When issuing an invoice, checking `job.status === "done"` is NOT enough on its own.
Two drafts can link the same still-"done" job (a draft does not change job status),
and two concurrent issues both pass the check, both flip the job to
`vyfakturovano`, and both commit → the job is double-billed.

**Rule:** in the issue transaction, `select ... from jobs ... .for("update")` on the
linked job rows BEFORE re-checking status. The lock serializes concurrent issues so
the second one re-reads `vyfakturovano` and aborts with a 409.
**Why:** `done`-check without a lock is a TOCTOU race. Same caution applies to any
future status-transition flow that flips shared rows.
**How to apply:** any new billing/issue/cancel path that mutates `jobs.status` based
on a prior read must lock those rows in the same tx.

## 2. `invoice_source_links` decides which jobs get billed — recomputed on every edit
`invoice_source_links` (one row per job + amount) is what `issueInvoice` flips to
`vyfakturovano`. It is written at draft creation AND **recomputed on every draft edit**
(`updateDraft` when `input.lines` is provided): one link per job that still has >=1 line,
amount = sum of that job's line `totalWithoutVat` via `deriveJobSourceLinks()` in
`invoice-calc.ts`. For this to work, edited lines must carry `jobId` end-to-end:
the edit UI sends it, `mapLineInput` (routes/billing.ts) passes it through, and the
service `InvoiceLineInput` + `updateDraft` preserve it on persist.
- Deleting all of a job's lines in the edit UI now **drops its source link**, so the job
  returns to the unbilled pool (stays `done`) instead of being billed with nothing on it.
- The unbilled list excludes jobs already linked to a non-cancelled invoice.
- Recovery for a wrongly-billed *issued* invoice is still **storno (cancel)**.
**Why:** prior behavior preserved links across edits and stripped `jobId`, so deleting a
job's lines still billed it (job "lost" from fakturace). Job billing now tracks the
surviving lines. `createDraft` source links still come from the selected `jobIds`.
**Watch:** legacy drafts edited *before* this change have lines with null `jobId`; only a
fresh save recomputes them correctly.

## 3b. "Unpaid" / "overdue" = issued|sent only (drafts excluded)
`getBillingSummary`'s `unpaid*` / `overdue*` metrics and the frontend `overdueDays()`
badge both treat only `status in (issued, sent)` as a receivable. Drafts are excluded
even though they are technically "not paid/cancelled" — a draft is not yet handed to
the customer, so it is not money owed. Overdue = unpaid AND `dueDate < today`
(ISO "YYYY-MM-DD" string compare).
**Why:** the task defined overdue as "stav != zaplaceno/storno", but counting draft
amounts as outstanding receivables would distort cash-flow numbers.
**How to apply:** any future "receivables" / bank-payment-matching / reminder feature
must use the same issued|sent definition for consistency, not "not paid".

## 3. `/billing/settings` PUT enumerates fields explicitly
`routes/billing.ts` PUT `/billing/settings` lists each field by hand when calling
`updateBillingSettings`, and the service's `BillingSettingsInput` + `assign()` list
are also explicit allowlists. Adding a field to the OpenAPI/contract alone is a
**silent no-op** — you must update all three (route call, interface, assign list).
**How to apply:** when exposing a new billing-settings field, wire route → service
interface → `assign()` together, or the UI will appear to save while the server drops it.
`numberNextSeq`/`numberYear` are now wired through (guarded `numberNextSeq >= 1`);
the unique invoice-number index is the backstop against bad manual sequence values.
