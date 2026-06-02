---
name: Coolify one-shot init container "No such container" failure
description: Why the createbuckets init job in docker-compose must pin restart "no" for Coolify deploys
---

# Coolify one-shot init container → "No such container"

The Stavba stack has a one-shot `createbuckets` service (minio/mc) that creates
the S3 bucket then exits, gating the API via `service_completed_successfully`.

On Coolify, the deploy failed with a Docker `No such container` error *after*
PostgreSQL was already healthy.

**Rule:** any one-shot/init container in a Coolify compose file must set
`restart: "no"` explicitly.

**Why:** without an explicit policy Coolify can treat the short-lived container
as a long-running service that "keeps stopping" and its post-deploy monitor then
inspects a container that has already exited / been recreated, surfacing
`No such container`. Pinning `restart: "no"` keeps it in a stable `Exited(0)`
state so the dependent service's `service_completed_successfully` gate can read
it and the deploy proceeds.

**How to apply:** for any init/migration/seed container in compose destined for
Coolify: `restart: "no"`, make the command idempotent (e.g.
`mc mb --ignore-existing` so an existing bucket is not an error), and end with an
explicit `exit 0`. Keep dependents gated with `service_completed_successfully`
(init jobs) and `service_healthy` (long-running services).

## Bounded waits — never an unbounded `until` in a gating init container

A gating init container that waits for a dependency with an **unbounded** loop
(e.g. `until mc alias set ...; do sleep 2; done`) can hang the ENTIRE Coolify
deploy forever if the dependency is unreachable or its credentials are wrong:
the build succeeds, then `docker compose up` blocks silently because the API
gates on `service_completed_successfully` and that init job never finishes. The
deploy log just stops after `built in ...s` with no error — looks like a build
hang but is actually the start-up dependency chain.

**Rule:** bound every such wait (e.g. 60 tries × 2s ≈ 120s), then `exit 1` with a
clear stderr message naming the likely causes. A failed init job makes
`docker compose up` exit with a diagnosable error instead of stalling.

**How to diagnose a "stuck" Coolify deploy:** the build is almost never the
cause if it printed a success line. Look at the start-up chain
`postgres(healthy) → createbuckets(completed) → api(healthy) → web` and find
which link never resolves. Note: peer-dependency `✕ unmet/missing peer` lines in
the pnpm install step are warnings, NOT errors — they never fail the build.
