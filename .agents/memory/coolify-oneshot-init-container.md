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
