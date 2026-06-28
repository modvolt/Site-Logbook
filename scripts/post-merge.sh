#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
# stamp: on a push-provisioned dev DB the tracking table is empty; stamp fills
# it so migrate sees the DB as up-to-date and skips CREATE TABLE statements
# that would fail on already-existing tables. On a properly-migrated DB stamp
# is a no-op (all rows are already present).
pnpm --filter @workspace/db run stamp
pnpm --filter @workspace/db run migrate
