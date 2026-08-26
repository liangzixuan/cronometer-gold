# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# This exact 17.11/Alpine 3.24 index is the reviewed upstream input. Its
# linux/arm64 child is sha256:dfc2780980fe6ca2d158bfe4342660db5e4c6431fb969088e543430d09f8d0f2.
FROM docker.io/library/postgres:17.11-alpine3.24@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73 AS runtime

LABEL io.cronometer.runtime.component="postgres" \
      io.cronometer.runtime.contract="openssl-3.5.8-r0-uid-gid-70-preowned-pgdata-and-tmpfs" \
      io.cronometer.upstream.image="docker.io/library/postgres:17.11-alpine3.24" \
      io.cronometer.upstream.image.digest="sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73" \
      io.cronometer.upstream.image.arm64.digest="sha256:dfc2780980fe6ca2d158bfe4342660db5e4c6431fb969088e543430d09f8d0f2" \
      io.cronometer.upstream.version="17.11" \
      io.cronometer.runtime.openssl-packages="libcrypto3=3.5.8-r0,libssl3=3.5.8-r0" \
      io.cronometer.runtime.openssl-upgrade-trigger="CVE-2026-14456"

# Upgrade the two Alpine OpenSSL runtime packages implicated by the hosted
# strict scan. The runtime is never root, so the official entrypoint's gosu
# branch is unreachable and unnecessary. PGDATA and both runtime tmpfs mounts
# must be presented pre-owned by 70:70; these image paths make Docker-created
# volumes inherit the same ownership.
RUN set -eux; \
    apk add --no-cache --upgrade \
      'libcrypto3=3.5.8-r0' \
      'libssl3=3.5.8-r0'; \
    apk list --installed libcrypto3 | grep -Fx 'libcrypto3-3.5.8-r0 aarch64 {openssl} (Apache-2.0) [installed]'; \
    apk list --installed libssl3 | grep -Fx 'libssl3-3.5.8-r0 aarch64 {openssl} (Apache-2.0) [installed]'; \
    rm -f /usr/local/bin/gosu; \
    test ! -e /usr/local/bin/gosu; \
    install -d -o 70 -g 70 -m 0700 /var/lib/postgresql/data; \
    install -d -o 70 -g 70 -m 03775 /var/run/postgresql; \
    install -d -o 70 -g 70 -m 01770 /tmp; \
    install -d -o 70 -g 70 -m 0755 /docker-entrypoint-initdb.d

# Do not advertise an absent privilege-switching helper in the final config.
ENV GOSU_VERSION=""

USER 70:70

EXPOSE 5432

VOLUME ["/var/lib/postgresql/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD user="${POSTGRES_USER:-postgres}"; db="${POSTGRES_DB:-$user}"; pg_isready -h 127.0.0.1 -U "$user" -d "$db" || exit 1

STOPSIGNAL SIGINT

ENTRYPOINT ["docker-entrypoint.sh"]

CMD ["postgres"]
