# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/modvolt/Site-Logbook" \
      org.opencontainers.image.revision="$BUILD_SHA"
RUN apk add --no-cache jq \
  && addgroup -S -g 10001 preflight \
  && adduser -S -D -H -u 10001 -G preflight preflight

COPY deploy/staging/preflight/preflight.sh /usr/local/bin/staging-preflight
COPY deploy/staging/preflight/validate-proxy-cidrs.sh /usr/local/lib/staging-proxy-cidrs.sh
RUN chmod 0555 /usr/local/bin/staging-preflight

USER preflight
ENTRYPOINT ["/usr/local/bin/staging-preflight"]
