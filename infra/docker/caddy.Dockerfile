# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Go 1.26.6 is pinned by its multi-platform index. The reviewed linux/arm64
# child is sha256:1b2cb58c3df8b93b8bcb5739778692c35e491087599139deb2c8c03567cbb03e.
ARG GO_IMAGE=docker.io/library/golang:1.26.6-alpine3.24@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83

FROM ${GO_IMAGE} AS build

ARG TARGETARCH

ENV CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local \
    SOURCE_DATE_EPOCH=1780458880

WORKDIR /src

# v2.11.4 is annotated tag 8ec11a4b7e39a5fd00da2fc5cb9b543e31fd7926,
# signed by the pinned key in caddy-v2.11.4.allowed_signers, and resolves to
# this exact commit. The workflow independently verifies that signature.
ADD --checksum=sha256:a593bd7077c76102ca76d19287a5e247d4e359dd67eddbc933f865afd3c131eb \
    https://codeload.github.com/caddyserver/caddy/tar.gz/e2eee6a7fce366321294c9c2a79f3146891dcbdf /tmp/caddy.tar.gz

# These exact Alpine packages provide the runtime trust bundle and timezone
# files. Caddy also embeds Go's time/tzdata; retaining the files preserves the
# conventional container contract without inheriting an OS package database.
ADD --checksum=sha256:bc5d3ae0b602748852e0bc601a4348cabc4f654f12f27578919cbf3c810f1c1e \
    https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/ca-certificates-bundle-20260611-r0.apk /tmp/ca-certificates-bundle.apk
ADD --checksum=sha256:677588e6b5d81ca4d697777609f38f969e743a812c68d196c7a0f0b1367aabc3 \
    https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/tzdata-2026c-r0.apk /tmp/tzdata.apk

RUN --mount=type=cache,id=nutrition-caddy-go-mod-v1,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=nutrition-caddy-go-build-v1,target=/root/.cache/go-build,sharing=locked \
    set -eux; \
    test "${TARGETARCH}" = arm64; \
    apk add --no-cache --no-network \
      /tmp/ca-certificates-bundle.apk \
      /tmp/tzdata.apk; \
    tar -xzf /tmp/caddy.tar.gz --strip-components=1; \
    go mod edit \
      -require=golang.org/x/crypto@v0.55.0 \
      -require=golang.org/x/net@v0.57.0 \
      -require=golang.org/x/text@v0.41.0 \
      -require=google.golang.org/grpc@v1.83.2; \
    go mod download; \
    go mod tidy; \
    go mod verify; \
    GOOS=linux GOARCH=arm64 go build \
      -buildvcs=false \
      -trimpath \
      -ldflags='-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4' \
      -o /out/caddy \
      ./cmd/caddy; \
    /out/caddy version | grep -Fx 'v2.11.4'; \
    go version -m /out/caddy | grep -E 'golang.org/x/crypto[[:space:]]+v0.55.0'; \
    go version -m /out/caddy | grep -E 'golang.org/x/net[[:space:]]+v0.57.0'; \
    go version -m /out/caddy | grep -E 'golang.org/x/text[[:space:]]+v0.41.0'; \
    go version -m /out/caddy | grep -E 'google.golang.org/grpc[[:space:]]+v1.83.2'; \
    /out/caddy list-modules --packages | grep -Fx 'tls.issuance.acme'; \
    /out/caddy list-modules --packages | grep -Fx 'tls.issuance.internal'

FROM ${GO_IMAGE} AS rootfs

RUN set -eux; \
    install -d -o 1000 -g 1000 -m 0755 \
      /runtime/config \
      /runtime/data \
      /runtime/etc/caddy \
      /runtime/home/caddy \
      /runtime/srv; \
    install -d -o 0 -g 0 -m 0755 \
      /runtime/etc/ssl/certs \
      /runtime/usr/share; \
    printf '%s\n' 'caddy:x:1000:1000:Caddy:/home/caddy:/sbin/nologin' > /runtime/etc/passwd; \
    printf '%s\n' 'caddy:x:1000:' > /runtime/etc/group; \
    chmod 0644 /runtime/etc/passwd /runtime/etc/group

COPY --from=build /etc/ssl/certs/ca-certificates.crt /runtime/etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/share/zoneinfo/ /runtime/usr/share/zoneinfo/

FROM scratch AS runtime

LABEL io.cronometer.runtime.component="caddy" \
      io.cronometer.runtime.contract="uid-gid-1000-net-bind-service" \
      io.cronometer.upstream.source="https://github.com/caddyserver/caddy" \
      io.cronometer.upstream.source.revision="e2eee6a7fce366321294c9c2a79f3146891dcbdf" \
      io.cronometer.upstream.source.tag-object="8ec11a4b7e39a5fd00da2fc5cb9b543e31fd7926" \
      io.cronometer.upstream.version="v2.11.4" \
      io.cronometer.upstream.vulnerability-patches="golang.org/x/crypto=v0.55.0,golang.org/x/net=v0.57.0,golang.org/x/text=v0.41.0,google.golang.org/grpc=v1.83.2"

ENV HOME=/home/caddy \
    PATH=/usr/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    TZ=UTC \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data

WORKDIR /srv

COPY --from=rootfs /runtime/ /
COPY --from=build --chown=1000:1000 /out/caddy /usr/bin/caddy

USER 1000:1000

EXPOSE 80 443 443/udp 2019

VOLUME ["/data", "/config"]

ENTRYPOINT ["/usr/bin/caddy"]

CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
