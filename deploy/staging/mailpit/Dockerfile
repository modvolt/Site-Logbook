# syntax=docker/dockerfile:1

# Mailpit is pinned to a security-fixed release. Alpine is pinned separately so
# the image can generate a staging-only CA/server certificate on first start;
# the application keeps its production-grade verified STARTTLS requirement.
FROM axllent/mailpit:v1.30.0 AS mailpit

FROM alpine:3.22.1
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

