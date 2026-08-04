# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

WORKDIR /app
COPY --chown=node:node receiver.mjs /app/receiver.mjs
RUN mkdir -p /var/lib/operational-alert-receiver && chown node:node /var/lib/operational-alert-receiver

USER node
ENV NODE_ENV=production \
    PORT=8080 \
    RECEIVER_BIND_HOST=0.0.0.0 \
    RECEIVER_TRUSTED_TLS_PROXY=true \
    RECEIVER_STATE_DIR=/var/lib/operational-alert-receiver
EXPOSE 8080
CMD ["node", "/app/receiver.mjs"]
