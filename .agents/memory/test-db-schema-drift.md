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

**Known missing columns (as of June 2026):**
- `jobs.short_name` TEXT — `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS short_name TEXT;`
- `warehouse_movements.idempotency_key` TEXT + unique partial index — `ALTER TABLE warehouse_movements ADD COLUMN IF NOT EXISTS idempotency_key TEXT; CREATE UNIQUE INDEX IF NOT EXISTS warehouse_movements_idempotency_key_idx ON warehouse_movements(warehouse_item_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`

**Why:** push is interactive-only here and the journal is empty, so migrate-based
sync is unreliable; targeted additive DDL is safe and deterministic.

**Also:** if `pnpm --filter @workspace/api-server run typecheck` reports
`@workspace/db has no exported member ...` (e.g. `billingDocumentsTable`,
`invoiceRemindersTable`), the lib declarations are stale — run
`pnpm run typecheck:libs` first, then re-typecheck.
