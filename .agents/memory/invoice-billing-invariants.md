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

**Testing the race:** a concurrent-issue test must measure "billed once" by counting
links on an **issued** invoice, NOT all non-cancelled links. The loser of the race
409s but its draft (and its `invoice_source_links` row) survives — a non-cancelled
*draft* link is expected and is not a double-bill. Activities have no status flip, so
their guard is the activity-row `FOR UPDATE` + the issue-time "already on another
non-cancelled invoice" check; two drafts for one activity therefore deadlock-safe to
"at most one issues" rather than "exactly one" (each issue sees the other draft).

**Up-front draft guard (defense in depth, NOT the real safety net):** `buildProposedLines`
(jobs) and `buildProposedActivityLines` both reject a source already linked to a
non-cancelled (draft OR issued) invoice with a 400 BEFORE inserting the draft, so a
second operator can't even build the orphan draft. The `FOR UPDATE` issue-time lock
above is still the authoritative double-bill guard (the up-front check is a non-locking
read and races). Because the check fires inside line-building, a concurrent-issue test
that needs two drafts for one job/activity must insert the 2nd draft + its source link
**directly** (bypassing `createDraft`) to exercise the issue-time race. `updateDraft`
does NOT call the builders (works straight off `input.lines`), so editing a draft that
already links its own jobs never trips the guard.

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

## 3c. Client status-write paths must exclude the server-set `vyfakturovano`
`jobs.status` is free-text in the DB (no enum constraint), so the ONLY guard against
a client forcing a job invoiced is the OpenAPI status enum. Job-status request
schemas (`JobInput`, `JobUpdate`, `JobStatusUpdate`, `JobBulkStatusUpdate`) pin
`enum: [planned, in_progress, done, cancelled]` — `vyfakturovano` is intentionally
omitted. The legitimate invoiced flip is a direct DB write inside `invoice-service`
(issue → `vyfakturovano`, storno → `done`), never an HTTP PATCH, so narrowing the
enum can't break the real path. Mirrors the activity `billingStatus` enum (which
excludes `billed`).
**Why:** without the enum, `PATCH /jobs/:id` / `:id/status` accepted any string →
phantom-billed jobs. (`PATCH /jobs/status` had a redundant hardcoded list guard.)
**How to apply:** any new job (or activity) write path must keep the server-only
billed state out of the client-editable enum; narrowing the OpenAPI enum also
narrows the generated TS types, so frontend call sites passing a bare `string` need
a cast to the generated `Job*Status` type (api-client-react).

## 4. Cost-document line reservation needs full `sourceType`+`sourceId` round-trip
Approved cost-document lines are re-billed by including them as invoice lines with
`sourceType:"billing_document_line"` + `sourceId:<lineId>`. `markLinesInvoiced` /
`releaseInvoicedLines` key off `billingDocLineIds(lines)`, which filters
`sourceType==="billing_document_line" && sourceId!=null`. The reservation
(`billing_document_lines.invoicedInvoiceId`) is what keeps a line out of
`/billing/approved-lines` so it can't be billed twice.
**Why:** the passthrough is fragile across three layers and fails silently. Two real
bugs once coexisted: the create/update route's `mapLineInput` carried `sourceType`
but dropped `sourceId` (so `billingDocLineIds` was always empty → nothing reserved),
and the unbilled-detail "auto-add" UI never put the cost lines in the create payload
at all. Either alone means the line stays re-billable forever (double-bill risk).
**How to apply:** any invoice line-input mapper (server route mappers, the
invoice-edit row→input map, any new builder) MUST preserve BOTH `sourceType` and
`sourceId`, and any UI that claims to feed approved cost lines must actually send
them as `lines`. Verify by reserving on create (line leaves approved-lines) and
releasing on draft delete/storno (line returns).
