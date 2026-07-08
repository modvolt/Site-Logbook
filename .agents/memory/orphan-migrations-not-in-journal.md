---
name: Orphan migration files not in journal
description: Migration .sql files on disk that are missing from drizzle _journal.json never run anywhere; how to detect and fold them in.
---

Migration `.sql` files can exist in `lib/db/migrations/` without a matching entry in `meta/_journal.json` (e.g. hand-written during a merge). Drizzle migrate only runs journaled entries, so such orphans are **never applied in production**, and `generate` re-emits their DDL because the snapshot lags too.

**Why:** Found when job_groups + perf indexes existed as 0072/0073 .sql orphans — dev stamp claimed applied, prod never ran them, and dev DB was missing the tables (jobs list broken/slow).

**How to apply:**
- Detect: compare `ls migrations/*.sql` tags vs journal tags; also verify actual DB state (`to_regclass`, information_schema) — a stamped journal row does NOT prove the DDL ran.
- Fix: run `generate` (it captures the full missing diff from the last snapshot), rewrite the emitted SQL fully idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object` for FKs) because journaled-but-re-emitted parts may already be applied in prod, rename descriptively (sql filename + journal tag; snapshot filename stays NNNN_snapshot.json), delete the orphan files.
