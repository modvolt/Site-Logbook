# syntax=docker/dockerfile:1

FROM alpine:3.22.1
RUN apk add --no-cache jq \
  && addgroup -S -g 10001 preflight \
  && adduser -S -D -H -u 10001 -G preflight preflight

COPY deploy/staging/preflight/preflight.sh /usr/local/bin/staging-preflight
RUN chmod 0555 /usr/local/bin/staging-preflight

USER preflight
ENTRYPOINT ["/usr/local/bin/staging-preflight"]
