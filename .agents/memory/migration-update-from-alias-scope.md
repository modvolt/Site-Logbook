---
name: UPDATE...FROM subquery alias scope in migrations
description: A SQL migration that crash-loops the API on deploy was caused by referencing an inner subquery alias in the outer UPDATE SET.
---

In Postgres `UPDATE t SET col = X FROM (subquery) AS best`, the SET/WHERE can
ONLY reference `t` and the outer FROM alias (`best`) — NOT table aliases that
live *inside* the subquery. Referencing an inner alias (e.g. `ph` from a JOIN
inside the subquery) raises `missing FROM-clause entry for table "ph"` and the
whole migration fails.

**Why:** the API container runs `dist/migrate.mjs` on startup; a failing
migration crash-loops the container, so the Coolify deploy "succeeds" at build
(all layers CACHED) but the app never comes up — the real failure is in the
Postgres/api startup logs, not the build log.

**How to apply:** in the outer SET/WHERE, select the value out in the subquery
and reference it via the OUTER alias (`best."purchase_price"`), never the inner
join alias. A migration that has NEVER applied cleanly anywhere (it errors every
start) is safe to edit in place — no env has it recorded as applied. Verify by
running the .sql against the dev DB twice (idempotent → second run = UPDATE 0).
