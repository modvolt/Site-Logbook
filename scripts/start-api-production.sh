#!/bin/sh
set -eu

# Production API startup is deliberately read-only with respect to schema.
# Migration 0107 must be applied by the separately approved one-shot control
# plane. This script accepts only the later v5 release approval, verifies its
# raw intent, execution and steady-state artifacts, then starts the API. Missing or
# mismatched evidence is a hard stop; this script never runs the schema migrator.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECKER="$SCRIPT_DIR/check-audit-0107-release-evidence.mjs"

if [ ! -r "$CHECKER" ]; then
  echo "[start-api] releaseEvidence=FAIL reason='checker not readable'" >&2
  exit 1
fi

if [ -r /app/dist/index.mjs ]; then
  API_ENTRYPOINT=/app/dist/index.mjs
elif [ -r artifacts/api-server/dist/index.mjs ]; then
  API_ENTRYPOINT=artifacts/api-server/dist/index.mjs
else
  echo "[start-api] releaseEvidence=FAIL reason='API entrypoint not readable'" >&2
  exit 1
fi

echo "[start-api] migrationMode=external-one-shot autoMigrate=false"
echo "[start-api] verifying exact steady-0107 release evidence"

RUNTIME_LINEAGE_B64=$(node "$CHECKER" --emit-runtime-lineage-b64)
case "$RUNTIME_LINEAGE_B64" in
  ""|*[!A-Za-z0-9+/=]*)
    echo "[start-api] releaseEvidence=FAIL reason='invalid runtime lineage output'" >&2
    exit 1
    ;;
esac

AUDIT_0107_RUNTIME_LINEAGE_B64="$RUNTIME_LINEAGE_B64"
export AUDIT_0107_RUNTIME_LINEAGE_B64

echo "[start-api] releaseEvidence=PASS schemaAction=steady-0107"
echo "[start-api] starting API without applying migrations"
exec node --enable-source-maps "$API_ENTRYPOINT"
