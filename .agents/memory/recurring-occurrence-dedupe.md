---
name: Recurring occurrence dedupe
description: Why auto-creating the next recurring job/event occurrence must dedupe, not just gate on the status transition.
---

# Auto-creating next recurring occurrence must dedupe

When a "done" transition auto-creates the next occurrence of a recurring item
(e.g. Stavba service_call jobs with recurrenceIntervalDays), gating only on
`existing.status !== "done"` is NOT enough to prevent duplicates.

**Why:** A reopen→re-done cycle (done → planned → done) passes the transition
gate again and creates a second future occurrence. Concurrent done requests can
also both read pre-done state and both insert.

**How to apply:** Before inserting the next occurrence, run a dedupe query for an
already-existing match (in Stavba: type=service_call AND same date AND same title
AND same customerId, using isNull for null customerId). If found, skip the insert.
Also guard the row returned from `.update().returning()` with `if (!job) 404`
before dereferencing it, since the row can disappear between the pre-read and the
update.
