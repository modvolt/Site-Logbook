---
name: DB-backed tests vs isolated dev DB drift
description: Why api-server DB-backed vitest tests can fail on missing tables/columns and how to sync the isolated dev DB.
---

# DB-backed tests and isolated-dev-DB schema drift

The api-server's dev DB (`DATABASE_URL`, host `helium`/`heliumdb`) was provisioned
via `drizzle-kit push`, so its drizzle migration journal (`drizzle.__drizzle_migrations`)
is **empty** and does NOT reflect the committed `lib/db/migrations/*.sql`. The
agent's `executeSql` tool talks to a *different* DB than the api-server, so probe
the real one with `psql "$DATABASE_URL"`.

This dev DB can lag the TypeScript schema by whole tables/columns. When a vitest
test (or the app) imports a service that `select`s a table, a missing column/table
surfaces as `column "X" does not exist` / `relation "Y" does not exist` deep in a
drizzle call.

**Rule:** before writing/running DB-backed tests, sync the dev DB to the current
schema. `pnpm --filter @workspace/db run push` needs a TTY (fails non-interactively
on a rename/conflict prompt), so instead apply the gap with **direct psql**:
- New tables → apply the relevant committed migration SQL (e.g.
  `psql "$DATABASE_URL" -f lib/db/migrations/0008_*.sql`); it's additive
  `CREATE TABLE`/constraints/indexes only.
- Missing columns → `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` mirroring the
  column's definition in `lib/db/src/schema/*` (type + NOT NULL + DEFAULT).
- Never `push --force` (can drop `user_sessions`).

**Known missing columns (as of June 2026, synced):**
- `jobs.short_name` TEXT
- `jobs.pricing_mode` TEXT NOT NULL DEFAULT 'hourly'
- `jobs.contract_price` numeric(10,2)
- `jobs.signature_token / signature_token_expires_at / signature_requested_at / signed_at / signature_object_path`
- `billing_settings.margin_alert_threshold_percent` numeric(6,2) NOT NULL DEFAULT '0'
- `billing_settings.quote_number_prefix` text NOT NULL DEFAULT 'NAB' + `quote_number_next_seq` integer NOT NULL DEFAULT 1
- `warehouse_movements.idempotency_key` TEXT + unique partial index
- `materials.purchase_price_per_unit` numeric(12,2)
- `materials.warehouse_item_id` integer FK → warehouse_items(id) ON DELETE SET NULL + index
- `invoices.recurring_template_id` integer FK → recurring_invoice_templates(id) ON DELETE SET NULL
- **Missing tables:** `quotes`, `quote_items`, `recurring_invoice_templates`, `recurring_invoice_generations` — create via DDL mirroring the respective schema files in `lib/db/src/schema/`.
- `billing_documents` was missing the partial unique index `billing_documents_sha256_unique_idx` (`ON billing_documents(sha256) WHERE sha256 IS NOT NULL`, from `lib/db/migrations/0067_rich_talkback.sql`). Its absence let concurrent-dedup tests silently insert real duplicate rows instead of racing into `23505`. If creating it fails with a duplicate-key error, first delete the debris rows it's blocking on (leftover from prior test runs that ran without the constraint) before retrying.
- `employee_leaves` (from `0037_employee_leaves.sql`) and `job_visits` (from `0032_job_visits.sql`) were entirely missing as of July 2026 — this broke GET `/api/leaves`, any endpoint calling a leave-conflict check, and DELETE `/api/jobs/:id` (which counts `job_visits`) with opaque 500s. Recreated both via their migration DDL directly.
- `customer_site_attachments` is still missing every column added by `0048_customer_documents.sql` (`valid_until`, `doc_status`, `customer_id`, etc.) as of July 2026 — breaks `/api/risks/summary`. NOT fixed yet: that migration has non-trivial backfill/constraint logic (not pure additive DDL), so replay it carefully (or via `lib/db run migrate` in a maintenance window) rather than hand-copying fragments.

**Why:** push is interactive-only here and the journal is empty, so migrate-based
sync is unreliable; targeted additive DDL is safe and deterministic.

**Also:** if `pnpm --filter @workspace/api-server run typecheck` reports
`@workspace/db has no exported member ...` (e.g. `billingDocumentsTable`,
`invoiceRemindersTable`), the lib declarations are stale — run
`pnpm run typecheck:libs` first, then re-typecheck.
