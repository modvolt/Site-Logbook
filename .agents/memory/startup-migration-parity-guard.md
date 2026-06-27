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
migration whose `when` is lower than an earlier-idx one) can therefore be
silently skipped on incremental runs — exactly what the parity guard now catches.
