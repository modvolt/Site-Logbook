---
name: Docker pnpm store cache mount
description: Why both Dockerfiles wrap pnpm install/deploy in a BuildKit cache mount + long npm fetch retries.
---

# Docker build: persist the pnpm store across deploys

Both production Dockerfiles (`artifacts/api-server`, `artifacts/stavba`) run
`pnpm install --frozen-lockfile` (and the api-server `pnpm deploy`) under a
BuildKit cache mount: `--mount=type=cache,id=pnpm-store,target=/pnpm/store`
combined with `--store-dir=/pnpm/store`. `.npmrc` also sets aggressive
`fetch-retries` / `fetch-retry-*` / `fetch-timeout`.

**Why:** On the Hetzner/Coolify host the npm registry was intermittently very
slow (single package requests taking 20-30s) and every deploy re-downloaded the
*entire* dependency set from scratch — pnpm logs showed `reused 0, downloaded 0,
added 0` crawling for minutes, which hung/timed out the build. A persistent
store cache makes warm builds reuse packages instead of re-fetching; the long
fetch retries keep a slow registry from killing a cold build.

**How to apply:** Keep the cache-mount id (`pnpm-store`) and `--store-dir` path
identical across every `pnpm install`/`deploy` RUN in all Dockerfiles so they
share one warm store. The store is only an install-time source cache — the
runtime image copies the materialized `/app/node_modules`, so the ephemeral
cache mount never makes runtime deps incomplete. On a warm build expect
`reused > 0`; if it's still `reused 0`, the builder's cache was wiped (or
Coolify rebuilt on a fresh builder), not a Dockerfile bug.
