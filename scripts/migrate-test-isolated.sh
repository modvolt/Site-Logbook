#!/usr/bin/env bash
# migrate-test-isolated.sh
#
# Spins up a throwaway Postgres container, runs the migration smoke-test
# against it, then tears it down — regardless of pass/fail.
#
# Usage (from repo root):
#   bash scripts/migrate-test-isolated.sh
#
# No DATABASE_URL from the dev environment is used. The script creates its
# own isolated Postgres via Docker and exports a fresh DATABASE_URL pointing
# to the ephemeral container via a randomly chosen host port.
#
# Requirements: docker (rootful or rootless), pnpm, pg_isready (postgresql client)
set -euo pipefail

PG_IMAGE="postgres:16-alpine"
PG_USER="migrate_test"
PG_PASSWORD="migrate_test"
PG_DB="migrate_test"
CONTAINER_NAME="stavba_migrate_test_$$"

# Pick a random unused host port in the ephemeral range.
HOST_PORT=$(python3 - <<'EOF'
import socket, random
for _ in range(50):
    p = random.randint(49152, 65535)
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', p))
        s.close()
        print(p)
        break
    except OSError:
        pass
EOF
)

if [ -z "$HOST_PORT" ]; then
  echo "[migrate-test-isolated] ERROR: could not find a free port" >&2
  exit 1
fi

echo "[migrate-test-isolated] Starting temporary Postgres on 127.0.0.1:${HOST_PORT} (container: ${CONTAINER_NAME})"

cleanup() {
  echo "[migrate-test-isolated] Stopping and removing container ${CONTAINER_NAME}..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_USER="${PG_USER}" \
  -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
  -e POSTGRES_DB="${PG_DB}" \
  -p "127.0.0.1:${HOST_PORT}:5432" \
  "${PG_IMAGE}" \
  >/dev/null

# Wait for Postgres to accept connections using host-side pg_isready
# (docker exec is not available in all container runtimes).
echo "[migrate-test-isolated] Waiting for Postgres to be ready..."
MAX_WAIT=60
ELAPSED=0
until pg_isready -h 127.0.0.1 -p "${HOST_PORT}" -U "${PG_USER}" -d "${PG_DB}" -q 2>/dev/null; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "[migrate-test-isolated] ERROR: Postgres did not become ready within ${MAX_WAIT}s" >&2
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

echo "[migrate-test-isolated] Postgres ready after ${ELAPSED}s."

export DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/${PG_DB}"

echo "[migrate-test-isolated] Running test:migrate against isolated DB..."
pnpm --filter @workspace/db run test:migrate
