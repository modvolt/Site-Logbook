---
name: drizzle-kit generate blocked by pre-existing snapshot collision
description: When generate refuses to run because two committed snapshots share an id, hand-write the next migration instead of touching the existing chain.
---

`drizzle-kit generate` validates the ENTIRE `migrations/meta` snapshot graph before
diffing. If two committed snapshots share the same `id` (a leftover from a past
rebase where data-only/backfill migrations were inserted), generate aborts with
"are pointing to a parent snapshot ... which is a collision" and emits no new
migration — even though the collision is unrelated to your change.

**How to apply (add ONE column without un-breaking the whole chain):**
- Do NOT rewrite the prevId/id of the existing colliding snapshots just to satisfy
  generate — that risks merge conflicts on committed migrations and is out of scope.
- Hand-write the next slot: `NNNN_<name>.sql` (e.g. a single `ALTER TABLE ... ADD
  COLUMN`), copy the highest-numbered `*_snapshot.json` to `NNNN_snapshot.json`, add
  your column to the relevant table in it, set its `id` to a fresh uuid and `prevId`
  to the copied snapshot's old `id`, then append a journal entry (idx, version, when,
  tag, breakpoints) to `_journal.json`.
- Apply the same DDL idempotently to the isolated dev DB via direct `psql`
  (`ADD COLUMN IF NOT EXISTS`) to verify — push needs a TTY and can prompt.

**Why this is safe:** `drizzle migrate` (prod replay) only uses `_journal.json` tags +
the `.sql` files + the `__drizzle_migrations` hash table. The `*_snapshot.json` meta
files are consumed ONLY by `generate` to compute diffs, so a hand-written snapshot
continuing from the latest slot applies cleanly in prod. The pre-existing collision
still blocks future `generate` runs until someone repairs the duplicate id, but your
migration is unaffected.
