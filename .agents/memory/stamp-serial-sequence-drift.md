---
name: stamp-cli SERIAL sequence drift
description: Post-merge stamp-cli fails with unique-key violation (23505) when the SERIAL sequence is behind the max id in __drizzle_migrations.
---

# stamp-cli SERIAL sequence drift

## The rule
After `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations` and before inserting any rows, call `setval(pg_get_serial_sequence(..., 'id'), COALESCE(MAX(id), 0), true)` to sync the sequence with the actual table content.

**Why:** When a task-agent's isolated DB is provisioned by copying the dev DB (or via `push`), the SERIAL sequence can be left at a value lower than `max(id)`. The next auto-increment insert collides with an already-existing row, causing a 23505 unique-key violation even though the idempotency check (dedup by `created_at`) would have skipped the row.

**How to apply:** The fix is already in `lib/db/src/stamp-cli.ts` — always run `setval` right after `CREATE TABLE IF NOT EXISTS`, before the existing-rows query. Do not remove it when refactoring the stamp script.
