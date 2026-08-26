# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# This exact signed v1.53.1 index is a provenance input only. Its reviewed
# linux/arm64 child is sha256:b4a0a1f9545ae1dd8e12a750fa4416ef3f4b421ed0758c430d0c46182ad233ee.
FROM docker.io/getmeili/meilisearch@sha256:8d6643d86d71fad6ad3cba92cde7ccfce9e4d6c384bda67598eb553571c32431 AS runtime

LABEL io.cronometer.runtime.component="meilisearch" \
      io.cronometer.runtime.contract="v1.53.1-openssl-3.5.8-r0-uid-gid-1000" \
      io.cronometer.upstream.image="docker.io/getmeili/meilisearch:v1.53.1" \
      io.cronometer.upstream.image.digest="sha256:8d6643d86d71fad6ad3cba92cde7ccfce9e4d6c384bda67598eb553571c32431" \
      io.cronometer.upstream.image.arm64.digest="sha256:b4a0a1f9545ae1dd8e12a750fa4416ef3f4b421ed0758c430d0c46182ad233ee" \
      io.cronometer.upstream.source="https://github.com/meilisearch/meilisearch" \
      io.cronometer.upstream.source.revision="577f7af28942b71782eab1e59f44ad8296ce0a92" \
      io.cronometer.upstream.version="v1.53.1" \
      io.cronometer.runtime.openssl-packages="libcrypto3=3.5.8-r0,libssl3=3.5.8-r0" \
      io.cronometer.runtime.openssl-upgrade-trigger="CVE-2026-14456"

RUN set -eux; \
    apk add --no-cache --upgrade \
      'libcrypto3=3.5.8-r0' \
      'libssl3=3.5.8-r0'; \
    apk list --installed libcrypto3 | grep -Fx 'libcrypto3-3.5.8-r0 aarch64 {openssl} (Apache-2.0) [installed]'; \
    apk list --installed libssl3 | grep -Fx 'libssl3-3.5.8-r0 aarch64 {openssl} (Apache-2.0) [installed]'; \
    test "$(/bin/meilisearch --version)" = 'meilisearch 1.53.1'

USER 1000:1000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD curl --fail --silent http://127.0.0.1:7700/health >/dev/null || exit 1
