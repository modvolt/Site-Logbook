---
name: Rebase migration-slot & isolated-dev-DB collisions
description: How to resolve Drizzle numbered-migration conflicts during a rebase, and why the isolated dev DB needs manual DDL afterward.
---

When rebasing a feature branch onto main, two recurring Drizzle problems show up
together. Both stem from numbered migrations + per-environment isolated DBs.

## 1. Migration-slot collision (e.g. both sides claim `0006`)
Do NOT rename your snapshot/SQL by hand — Drizzle snapshots are CUMULATIVE (each
`NNNN_snapshot.json` is the full schema at that point), so a renamed old snapshot
silently omits the other side's columns and the next `generate` diffs wrong.

**How to apply:**
- `git checkout --ours lib/db/migrations/meta/_journal.json` and the conflicting
  `NNNN_snapshot.json` (in rebase, `--ours` = main/HEAD = the branch you land on).
- `git rm` your own colliding `NNNN_*.sql`.
- Re-run `pnpm --filter @workspace/db run generate` — it diffs the merged schema TS
  against main's latest snapshot and emits a fresh higher-numbered migration that is
  cumulative-correct. Confirm it is additive-only (`rg "DROP" the new .sql` → 0).
- Before regenerating, verify the merged schema TS still contains BOTH sides' changes
  (grep the incoming side's new columns/tables) or generate will emit DROPs.

## 2. Generated API artifacts conflict → regenerate, don't hand-merge
`openapi.yaml` is source of truth; `api-client-react` + `api-zod` are generated.
Resolve only `openapi.yaml` (keep both sides' paths/schemas), then
`pnpm --filter @workspace/api-spec run codegen` to overwrite the generated files.
Watch for git folding a shared trailing line (e.g. `type: integer`) into common
context — you may need to re-add it to one side.

## 3. Isolated dev DB lacks the incoming branch's migrations
**Why:** your environment's dev Postgres only ever ran YOUR migrations; main's
incoming migrations were never applied there. `runPostMergeSetup` runs
`drizzle-kit push`, which prompts (rename resolver) and FAILS in non-TTY.
**How to apply:** apply the incoming migrations' exact DDL idempotently via direct
`psql "$DATABASE_URL"` (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
constraints in `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL $$`). Never blind
`push --force` (can drop user_sessions). Then restart the API workflow and curl the
endpoints that select the new columns to confirm.
