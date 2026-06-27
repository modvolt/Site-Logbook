---
name: Status CHECK constraints (jobs/activities)
description: DB-level CHECK constraints hardening jobs.status and activities.billing_status against invalid free-text writes.
---

`jobs.status` and `activities.billing_status` are free-text `text` columns. Two DB
CHECK constraints pin them to their known sets so no raw SQL, future endpoint, or
migration mistake can write a phantom status (defense-in-depth beyond the OpenAPI
enum on the HTTP write paths).

- `jobs_status_check`: `status IN ('planned','in_progress','done','cancelled','vyfakturovano')`.
  **Must include `vyfakturovano`** — the invoice issue flow writes it directly (storno reverts to `done`); omit it and issuing breaks.
- `activities_billing_status_check`: `billing_status IS NULL OR billing_status IN ('billable','not_billable','billed')`.
  `billed` is retained for rows with a live invoice link; editable intents are billable/not_billable; NULL = not tracked.

**How to apply:** defined as `check(...)` in the table's drizzle config callback
(`lib/db/src/schema/{jobs,activities}.ts`). If a new lifecycle/billing value is
ever added, update BOTH the schema check AND the OpenAPI enum, or writes 500 on
the CHECK.

**Why:** `jobs.status` had no constraint; a stray value could phantom-bill a job.
