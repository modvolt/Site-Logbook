#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run migrate
