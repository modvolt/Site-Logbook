# syntax=docker/dockerfile:1
#
# Production image for the Stavba web frontend (PWA).
#
# Build with the repository ROOT as the build context:
#
#   docker build -f artifacts/stavba/Dockerfile -t stavba-web .
#
# The static assets are served by nginx with SPA history fallback, and /api is
# reverse-proxied to the API service so the browser talks to a single origin
# (keeps the session cookie working).

# ---------- Builder ----------
FROM node:24-slim AS builder
WORKDIR /repo

RUN npm install -g pnpm@10.26.1

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

# NODE_ENV=production keeps the Replit-only dev plugins inactive; BASE_PATH=/
# serves the app at the domain root (the API lives under /api on the same host).
ENV NODE_ENV=production
ENV PORT=3000
ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH

RUN pnpm --filter @workspace/stavba run build

# ---------- Runtime ----------
FROM nginx:1.27-alpine AS runtime

# nginx substitutes ${NGINX_PORT}/${API_UPSTREAM} into the config at startup.
ENV NGINX_PORT=80
ENV API_UPSTREAM=http://api:5000

COPY artifacts/stavba/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /repo/artifacts/stavba/dist/public /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${NGINX_PORT}/" >/dev/null 2>&1 || exit 1
