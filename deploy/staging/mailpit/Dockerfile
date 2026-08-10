# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Mailpit is pinned to a security-fixed release. Alpine is pinned separately so
# the image can generate a staging-only CA/server certificate on first start;
# the application keeps its production-grade verified STARTTLS requirement.
FROM axllent/mailpit:v1.30.0@sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d AS mailpit

FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/modvolt/Site-Logbook" \
      org.opencontainers.image.revision="$BUILD_SHA"
ENV BUILD_SHA=$BUILD_SHA
RUN apk add --no-cache openssl su-exec tzdata \
  && addgroup -S -g 10001 mailpit \
  && adduser -S -D -H -u 10001 -G mailpit mailpit

COPY --from=mailpit /mailpit /mailpit
COPY deploy/staging/mailpit/entrypoint.sh /usr/local/bin/staging-mailpit-entrypoint
RUN chmod 0555 /mailpit /usr/local/bin/staging-mailpit-entrypoint

EXPOSE 1025/tcp 8025/tcp

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=10 \
  CMD ["/mailpit", "readyz"]

ENTRYPOINT ["/usr/local/bin/staging-mailpit-entrypoint"]
