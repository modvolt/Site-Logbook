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

RUN pnpm install --frozen-lockfile

# Bundle the API (produces dist/index.mjs and dist/migrate.mjs).
RUN pnpm --filter @workspace/api-server run build

# Produce a pruned, production-only node_modules at /app.
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /app

# ---------- Runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# Location of the committed SQL migrations applied on startup.
ENV MIGRATIONS_DIR=/app/migrations

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

# Apply migrations, then start the server (exec so SIGTERM reaches Node).
CMD ["sh", "-c", "node dist/migrate.mjs && exec node --enable-source-maps dist/index.mjs"]
