# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
#
# Production image for the Stavba API server.
#
# IMPORTANT: build with the repository ROOT as the build context (the API is a
# package inside a pnpm workspace and needs the workspace manifests/lockfile):
#
#   docker build -f artifacts/api-server/Dockerfile -t stavba-api .
#
# The container never applies database migrations on startup. A separately
# approved one-shot schema control plane must first produce canonical intent,
# execution and exact steady release evidence; startup verifies that chain and
# then serves the REST API on $PORT (default 5000).

ARG BUILD_SHA

# ---------- Builder ----------
FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS builder
ARG BUILD_SHA
WORKDIR /repo

# glibc base (node:*-slim) is required: the workspace pins the gnu variants of
# esbuild/rollup/lightningcss/tailwind-oxide and removes the musl ones.
RUN npm install -g pnpm@11.9.0

# Install dependencies first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY .npmrc ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts
COPY attached_assets ./attached_assets

# Persist pnpm's content-addressable store across builds via a BuildKit cache
# mount, so a slow npm registry isn't re-hit for every dependency on every
# deploy ("reused 0, downloaded 0" symptom). The mount survives layer-cache
# invalidation when the lockfile changes.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# Bundle the API and the separately invoked migration/control-plane entrypoints.
RUN printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    && BUILD_SHA="$BUILD_SHA" pnpm --filter @workspace/api-server run build

# Produce a pruned, production-only node_modules at /app. Reuse the same warm
# pnpm store so this step doesn't re-fetch from the registry either.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @workspace/api-server deploy --prod --legacy --store-dir=/pnpm/store /app

# ---------- Runtime ----------
FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# Location of committed SQL migrations used by read-only health identity checks
# and separately invoked control-plane tools.
ENV MIGRATIONS_DIR=/app/migrations

# pg_dump (postgresql-client) is needed at runtime for the database backup
# feature. node:24-slim is Debian 12 (bookworm), whose postgresql-client is
# v15 — add the official PGDG repo to install the v16 client matching the
# PostgreSQL 16 server (pg_dump must be >= the server's major version).
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
  && install -d /usr/share/postgresql-common/pgdg \
  && wget -qO /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y wget gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Keep revision metadata after the expensive package layer so exact-SHA builds
# reuse the PostgreSQL client installation without changing runtime provenance.
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/modvolt/Site-Logbook" \
      org.opencontainers.image.revision="$BUILD_SHA"
ENV BUILD_SHA=$BUILD_SHA

# Runtime deps that esbuild keeps external (e.g. @aws-sdk, nodemailer).
COPY --from=builder /app/node_modules ./node_modules
# Runtime allowlist: production cannot invoke migration or mutating gate bundles.
COPY --from=builder /repo/artifacts/api-server/dist/index.mjs ./dist/index.mjs
COPY --from=builder /repo/artifacts/api-server/dist/index.mjs.map ./dist/index.mjs.map
COPY --from=builder /repo/artifacts/api-server/dist/thread-stream-worker.mjs ./dist/thread-stream-worker.mjs
COPY --from=builder /repo/artifacts/api-server/dist/pino-worker.mjs ./dist/pino-worker.mjs
COPY --from=builder /repo/artifacts/api-server/dist/pino-file.mjs ./dist/pino-file.mjs
COPY --from=builder /repo/artifacts/api-server/dist/pino-pretty.mjs ./dist/pino-pretty.mjs
# SQL is used only by the in-process read-only readiness and health projections.
COPY --from=builder /repo/lib/db/migrations ./migrations

RUN chown -R node:node /app
USER node

EXPOSE 5000

# Built-in HTTP health check using the global fetch in Node 24 (no curl needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The bundled entrypoint verifies production evidence and live read-only DB
# readiness before it dynamically imports the application or any worker.
CMD ["node", "--enable-source-maps", "/app/dist/index.mjs"]

# ---------- One-shot schema control plane / staging ----------
# This target deliberately contains the complete tool bundle. It must never be
# selected for the production API service; commands are supplied explicitly by
# an approved one-shot runner or the isolated staging Compose stack.
FROM runtime AS control-plane
USER root
LABEL io.modvolt.site-logbook.image-profile="control-plane"
# The attended credential runbook prepares a dedicated 0700 bind mount for
# this fixed non-root identity. Fail the image build if the upstream uid/gid
# ever drifts instead of silently weakening evidence permissions or using root.
RUN test "$(id -u node)" = "1000" \
    && test "$(id -g node)" = "1000"
RUN touch /app/.site-logbook-control-plane-image
COPY --from=builder /repo/artifacts/api-server/dist ./dist
COPY --from=builder /repo/scripts/start-api-production.sh ./scripts/start-api-production.sh
COPY --from=builder /repo/scripts/check-audit-0107-release-evidence.mjs ./scripts/check-audit-0107-release-evidence.mjs
RUN test -f /app/.site-logbook-control-plane-image \
    && test -f /app/dist/production-exact-0096-backup-producer.mjs \
    && test -f /app/dist/production-exact-0096-backup-host-worker.mjs \
    && test -f /app/dist/production-migration-host-operator.mjs \
    && test -f /app/dist/production-runtime-db-credential-cutover.mjs
RUN chown -R node:node /app/dist /app/scripts
USER node

# Keep the default/final Docker target non-mutating. Production publication may
# also select this target explicitly; it contains only the runtime allowlist.
FROM runtime AS production
LABEL io.modvolt.site-logbook.image-profile="production"
