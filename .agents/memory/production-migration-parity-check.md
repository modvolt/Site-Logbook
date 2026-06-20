---
name: Production migration-parity check (don't break prod)
description: How to verify, offline, that committed migrations fully capture the TS schema before a prod deploy.
---

# Verifying production won't break from a schema/migration mismatch

Production deploys from GitHub `main` (Coolify/Docker) and applies the committed
SQL migrations on startup (`dist/migrate.mjs`). The #1 way to break prod after a
wave of merges is a schema in `lib/db/src/schema/*` that some migration file
never captured → prod gets `column/relation does not exist` at runtime.

**Canonical check (offline, DB-independent):**
`pnpm --filter @workspace/db run generate`
- It diffs `schema.ts` against the committed migration snapshots (NOT the live DB;
  no `DATABASE_URL` needed).
- `No schema changes, nothing to migrate 😴` ⇒ committed migrations fully match the
  schema ⇒ a fresh prod migrate produces the correct, complete schema. **Safe.**
- If it WRITES a new migration file ⇒ there is uncommitted schema drift; that
  generated file is the fix and must be committed (or prod will be missing it).

**Why this beats running the tests for the prod question:** the local/dev DB is
push-provisioned with an empty `drizzle.__drizzle_migrations` journal and lags the
schema (see test-db-schema-drift.md), so DB-backed vitest failures (`relation X
does not exist`) are usually a *dev-DB* gap, not a code/prod defect. Don't conflate
them. Sync the dev DB (apply the missing committed migration SQL via psql) only to
prove the code runs green locally — it is irrelevant to prod safety.

**Note:** the main dev DB can lag by *column-level* ALTERs from older migrations
too (e.g. 0006 `invoices.paid_date/paid_amount`, 0007 `billing_settings
.reminder_*`), not just whole tables — applying the recent migrations alone may not
be enough; chase each `does not exist` to its migration and apply that ALTER.
