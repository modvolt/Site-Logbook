---
name: Drizzle push interactive conflict
description: Why `pnpm --filter @workspace/db run push` can hang/fail non-interactively, and the safe workaround
---

`drizzle-kit push` can drop into an interactive "is this table a rename?" prompt (`tablesResolver` / `promptNamedWithSchemasConflict`) and then fail in a non-TTY shell with "Interactive prompts require a TTY terminal".

**Why:** The Drizzle schema defines tables (e.g. `user_preferences`) that the dev DB does not yet have, while the DB has tables not in the schema (e.g. `user_sessions`, an auth/session-store table managed outside Drizzle). Drizzle sees one create + one drop and asks whether it's a rename. A blind `push --force` could DROP the session table.

**How to apply:** For a small additive change (e.g. adding one column), do NOT run a full `push`. Apply the exact column directly via SQL so it matches the schema definition:
`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;`
This keeps Drizzle schema and DB in sync without touching unrelated tables. Reserve full `push` for when schema and DB are otherwise aligned.
