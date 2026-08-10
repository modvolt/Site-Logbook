# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
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
FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS builder
WORKDIR /repo

RUN npm install -g pnpm@11.9.0

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
ARG VITE_BUILD_SHA=dev
ENV VITE_BUILD_SHA=$VITE_BUILD_SHA

RUN pnpm --filter @workspace/stavba run build

# ---------- Runtime ----------
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
ARG VITE_BUILD_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/modvolt/Site-Logbook" \
      org.opencontainers.image.revision="$VITE_BUILD_SHA"
ENV VITE_BUILD_SHA=$VITE_BUILD_SHA

# nginx substitutes the listen port, upstream and explicit host allowlist into
# the config at startup. Production must override NGINX_SERVER_NAME.
ENV NGINX_PORT=80
ENV API_UPSTREAM=http://api:5000
ENV NGINX_SERVER_NAME=localhost

COPY artifacts/stavba/nginx.conf /etc/nginx/templates/default.conf.template
COPY artifacts/stavba/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=builder /repo/artifacts/stavba/dist/public /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${NGINX_PORT}/" >/dev/null 2>&1 || exit 1
