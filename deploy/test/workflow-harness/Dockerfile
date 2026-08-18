# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

RUN apk add --no-cache \
    bash=5.2.37-r0 \
    jq=1.8.1-r0 \
    shellcheck=0.10.0-r2

USER nobody
ENTRYPOINT ["/bin/bash"]
