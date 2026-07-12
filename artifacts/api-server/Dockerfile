# syntax=docker/dockerfile:1
#
# Production image for the Stavba API server.
#
# IMPORTANT: build with the repository ROOT as the build context (the API is a
# package inside a pnpm workspace and needs the workspace manifests/lockfile):
#
#   docker build -f artifacts/api-server/Dockerfile -t stavba-api .
#
# The container applies pending database migrations on startup and then serves
# the REST API on $PORT (default 5000).

# ---------- Builder ----------
FROM node:24-slim AS builder
WORKDIR /repo

# glibc base (node:*-slim) is required: the workspace pins the gnu variants of
# esbuild/rollup/lightningcss/tailwind-oxide and removes the musl ones.
RUN npm install -g pnpm@10.26.1

# Install dependencies first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY .npmrc ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

# Persist pnpm's content-addressable store across builds via a BuildKit cache
# mount, so a slow npm registry isn't re-hit for every dependency on every
# deploy ("reused 0, downloaded 0" symptom). The mount survives layer-cache
# invalidation when the lockfile changes.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# Bundle the API (produces dist/index.mjs and dist/migrate.mjs).
RUN pnpm --filter @workspace/api-server run build

# Produce a pruned, production-only node_modules at /app. Reuse the same warm
# pnpm store so this step doesn't re-fetch from the registry either.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @workspace/api-server deploy --prod --legacy --store-dir=/pnpm/store /app

# ---------- Runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# Location of the committed SQL migrations applied on startup.
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

# Runtime deps that esbuild keeps external (e.g. @aws-sdk, nodemailer).
COPY --from=builder /app/node_modules ./node_modules
# Bundled server + migrator + pino transport workers.
COPY --from=builder /repo/artifacts/api-server/dist ./dist
# SQL migrations (read at startup by dist/migrate.mjs).
COPY --from=builder /repo/lib/db/migrations ./migrations

RUN chown -R node:node /app
USER node

EXPOSE 5000

# Built-in HTTP health check using the global fetch in Node 24 (no curl needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply migrations, emit an unambiguous startup marker, then start the server.
# Explicit status handling keeps migration failures visible in container logs.
CMD ["sh", "-c", "echo '[startup] applying database migrations'; node dist/migrate.mjs; status=$?; if [ $status -ne 0 ]; then echo \"[startup] migration failed with exit code $status\" >&2; exit $status; fi; echo '[startup] migrations complete, starting API'; exec node --enable-source-maps dist/index.mjs"]
