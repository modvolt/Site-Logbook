---
name: Startup migration parity guard
description: runMigrations verifies the live DB actually reached the bundled migration set and aborts startup if behind.
---

# Startup migration parity guard

`runMigrations()` (lib/db) returns a `MigrationSummary` and, after `migrate()`,
compares the bundled `_journal.json` entries against the rows in drizzle's
tracking table `drizzle.__drizzle_migrations` (column `created_at` bigint ==
journal entry `when`). Any expected `when` not present → throws
`MigrationParityError` (carries `summary` + `missingTags`). The api-server
`migrate.mjs` exits non-zero on it, so the container start chain
(`node dist/migrate.mjs && exec node dist/index.mjs`) aborts instead of serving
500s against an out-of-date schema.

**Why:** a stale/cached Docker image bundled an old migration set; `migrate`
applied only what it shipped and exited 0, so prod booted missing newer columns
(`jobs.short_name`, warehouse cost cols, …) → reads/writes 500'd. The guard +
the "expected Y vs applied X, folder used" startup log make stale-image /
wrong-`MIGRATIONS_DIR` obvious.

**Drizzle gotcha (pg migrator):** `lastDbMigration` (max `created_at`) is read
**once** before the apply loop. So a fresh/empty DB applies ALL migrations
regardless of out-of-order `when` values, but an *incremental* run only applies
`folderMillis > startingMax`. Out-of-order journal `when`s (e.g. a rebased
migration whose `when` is lower than an earlier-idx one) are therefore silently
skipped on incremental runs.

**Self-heal (the guard no longer just aborts — it recovers):** `runMigrations()`
now runs the whole thing under a session `pg_advisory_lock` on ONE dedicated
PoolClient (also passed to `drizzle()`), and AFTER drizzle's `migrate()` calls a
recovery step that applies any journal entry whose `when` is not yet recorded —
in journal/array order, one tx per migration, stamping `(hash, created_at=
folderMillis)` exactly like drizzle. Identity key is `when`/`folderMillis`
(matches drizzle + the parity check). Fresh/normal-incremental runs find nothing
missing → no-op. Only then does the parity check throw (if STILL missing).

**Why:** prod crash-looped because 5 committed migrations had REAL `Date.now()`
`when`s (~1.7826e12) LOWER than neighbours given ARTIFICIAL inflated round future
`when`s (up to 1784900000000), so drizzle skipped them every deploy. Root cause
is the artificial-future-`when` convention: any migration later generated with a
real `Date.now()` is below the ceiling and gets skipped. Self-heal makes migrate
immune to `when` ordering — DO NOT re-timestamp already-applied migrations to
"fix" ordering (their tracking row stores the OLD `when`; changing the journal
`when` makes the parity check fail for them).

**How to apply:** trust the recovery; never hand-edit `when` of applied
migrations. Bare `DROP INDEX "x"` in a recoverable migration must be
`DROP INDEX IF EXISTS` (recovery may apply it against a partially-migrated prod).

**Remaining edge (future hardening):** drizzle still runs BEFORE recovery, so a
single deploy carrying BOTH a low-`when` and a higher-`when` pending migration
could let drizzle apply the high one first, then recovery the low one — out of
journal order. Full fix: recover BEFORE drizzle, or replace drizzle's
max-timestamp applier with a pure journal-order set-based applier (apply every
entry whose `when` ∉ tracking table, in array order).
