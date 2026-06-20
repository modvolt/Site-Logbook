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

## 2. `invoice_source_links` — not lines — decides which jobs get billed
`invoice_source_links` is written ONCE at draft creation (one row per job + amount).
On issue, every source-linked job is flipped to `vyfakturovano`. Editing a draft
REPLACES all lines but deliberately preserves source links, and edited lines lose
their `jobId` (they become `sourceType:"manual"`). So:
- Deleting all of a job's lines in the edit UI still bills that job on issue
  (job marked `vyfakturovano` with nothing on the invoice for it).
- The unbilled list excludes jobs already linked to a non-cancelled invoice, so you
  cannot normally create a second draft for the same job.
- Recovery for a wrongly-billed job is **storno (cancel)**, which returns linked jobs
  to `done`.
**Why:** "which jobs this invoice bills" is a creation-time decision, intentionally
decoupled from free-form line editing. Do not try to re-derive job billing from line
`jobId` — edited lines don't carry it.

## 3. `/billing/settings` PUT enumerates fields explicitly
`routes/billing.ts` PUT `/billing/settings` lists each field by hand when calling
`updateBillingSettings`, and the service's `BillingSettingsInput` + `assign()` list
are also explicit allowlists. Adding a field to the OpenAPI/contract alone is a
**silent no-op** — you must update all three (route call, interface, assign list).
**How to apply:** when exposing a new billing-settings field, wire route → service
interface → `assign()` together, or the UI will appear to save while the server drops it.
`numberNextSeq`/`numberYear` are now wired through (guarded `numberNextSeq >= 1`);
the unique invoice-number index is the backstop against bad manual sequence values.
