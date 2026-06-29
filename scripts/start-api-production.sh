#!/usr/bin/env bash
set -euo pipefail

# Stavba API — production start script (Replit environment).
#
# Runs database migrations to completion before starting the API server.
# Mirrors what the Docker CMD ("node dist/migrate.mjs && exec node dist/index.mjs")
# does, but paths are relative to the monorepo root (where Replit runs the command).
#
# Logged fields (no secrets are printed):
#   migrationsFolder  — absolute path of the migrations folder being read
#   journalEntries    — number of migrations the build expects (_journal.json count)
#   migrateExitCode   — exit code of migrate.mjs (0 = success)
#   parity            — PASS when migrate.mjs exited 0, FAIL otherwise
#
# migrate.mjs itself logs applied-before / applied-after / newly-applied /
# latestExpectedTag via pino at info level. Those structured log lines appear in
# the same output stream and satisfy the "log migration counts" requirement.
#
# Environment variables:
#   MIGRATIONS_DIR   Folder containing Drizzle migrations (default: $PWD/lib/db/migrations)
#   DATABASE_URL     Postgres connection string (required by migrate.mjs)
#   PORT             Port for the API server (required by index.mjs)

MIGRATIONS_DIR="${MIGRATIONS_DIR:-$PWD/lib/db/migrations}"
# Resolve to an absolute path so the log is unambiguous regardless of CWD.
MIGRATIONS_FOLDER_ABS="$(realpath "$MIGRATIONS_DIR" 2>/dev/null || echo "$MIGRATIONS_DIR")"
JOURNAL="$MIGRATIONS_FOLDER_ABS/meta/_journal.json"

echo "[start-api] migrationsFolder=$MIGRATIONS_FOLDER_ABS"

# Fail fast if the journal is unreadable — no journal means no schema knowledge.
if [ ! -r "$JOURNAL" ]; then
  echo "[start-api] parity=FAIL reason='journal not readable at $JOURNAL'" >&2
  echo "[start-api] Check that MIGRATIONS_DIR points to lib/db/migrations." >&2
  exit 1
fi

JOURNAL_ENTRIES=$(node -e "const j=JSON.parse(require('fs').readFileSync('$JOURNAL','utf8'));process.stdout.write(String(j.entries.length))")
echo "[start-api] journalEntries=$JOURNAL_ENTRIES"

echo "[start-api] Running migrate.mjs …"
MIGRATIONS_DIR="$MIGRATIONS_FOLDER_ABS" node artifacts/api-server/dist/migrate.mjs
MIGRATE_EXIT=$?

if [ "$MIGRATE_EXIT" -ne 0 ]; then
  echo "[start-api] migrateExitCode=$MIGRATE_EXIT parity=FAIL" >&2
  echo "[start-api] Refusing to start API server against an out-of-date schema." >&2
  exit "$MIGRATE_EXIT"
fi

echo "[start-api] migrateExitCode=0 parity=PASS"
echo "[start-api] Starting API server …"
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
