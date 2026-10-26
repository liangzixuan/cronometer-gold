# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG GO_IMAGE=docker.io/library/golang:1.26.10-alpine3.24@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca
ARG UPSTREAM_IMAGE=ghcr.io/chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882

FROM ${GO_IMAGE} AS build
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local \
    GOENV=off \
    GOWORK=off \
    GOPRIVATE="" \
    GONOSUMDB="" \
    GONOPROXY=""
WORKDIR /review
COPY scripts/verify-object-store-modules.go scripts/verify-object-store-modules_test.go ./
COPY infra/docker/object-store-modules.json /review/modules-lock.json
COPY infra/docker/object-store-NOTICES.txt /review/NOTICES.txt
RUN set -eux; \
    test "${TARGETARCH}" = arm64; \
    GO111MODULE=off go test -count=1 -v verify-object-store-modules.go verify-object-store-modules_test.go; \
    GO111MODULE=off go build -o /review/verify-modules verify-object-store-modules.go

ADD --checksum=sha256:3700416b287d03912506955dacf4f0a1d4f89cb44806e39e7cc572d2259407a4 \
    https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/c5073360007d28385a33426a42ac3e4ec504c5a3 /tmp/source.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/source.tar.gz --strip-components=1
COPY infra/docker/object-store.go.mod /src/go.mod
COPY infra/docker/object-store.go.sum /src/go.sum
RUN --mount=type=cache,id=nutrition-object-store-go-build-v1,target=/root/.cache/go-build,sharing=locked \
    set -eux; \
    mkdir /out; \
    /review/verify-modules inputs /review/modules-lock.json go.mod go.sum; \
    /review/verify-modules authenticate /review/modules-lock.json; \
    go mod download all; \
    go mod verify; \
    go list -mod=readonly -m -json all > /out/modules.json; \
    /review/verify-modules graph /review/modules-lock.json go.sum /out/modules.json; \
    /review/verify-modules inputs /review/modules-lock.json go.mod go.sum; \
    GOOS=linux GOARCH=arm64 go build -mod=readonly -buildvcs=false \
      -ldflags='-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=c5073360007d28385a33426a42ac3e4ec504c5a3' \
      -o /out/weed ./weed; \
    /review/verify-modules inputs /review/modules-lock.json go.mod go.sum; \
    go version -m /out/weed > /out/weed-buildinfo.txt; \
    sha256sum /out/weed > /out/weed.sha256; \
    cp go.mod go.sum /out/

FROM scratch AS build-evidence
COPY --from=build /out/go.mod /out/go.sum /out/modules.json /out/weed-buildinfo.txt /out/weed.sha256 /
COPY --from=build /review/NOTICES.txt /licenses/NOTICES.txt

FROM ${UPSTREAM_IMAGE} AS runtime
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/liangzixuan/cronometer-gold" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="4.47-grpc-patched" \
      io.cronometer.runtime.component="object-store" \
      io.cronometer.upstream.source.revision="c5073360007d28385a33426a42ac3e4ec504c5a3" \
      io.cronometer.upstream.image.digest="sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882" \
      io.cronometer.module-lock.sha256="e4a99de72a8abd1892d0a266772f3dfaaa16e35c5662fde137e2c169b5a49850" \
      io.cronometer.grpc.version="v1.85.0-dev.0.20260825072537-93e31b48545e"
# Keep the upstream entrypoint, supported companions and seaweed UID/GID 1000.
# The entrypoint and Go storage server do not use the inherited curl client.
# Keep the installed CA bundle explicitly before removing curl and libcurl.
# This avoids importing a newly published package just to repair CVE-2026-92392.
# The pinned Brotli decoder fix and verified weed binary remain unchanged.
RUN --mount=type=bind,from=build,source=/out/weed,target=/tmp/nourishing-weed,readonly \
    set -eux; \
    apk add --no-cache --upgrade 'brotli-libs=1.2.1-r0'; \
    apk add --no-network ca-certificates-bundle; \
    apk del --no-network curl libcurl; \
    test ! -e /usr/bin/curl; \
    test ! -e /usr/lib/libcurl.so.4; \
    test -s /etc/ssl/cert.pem; \
    for companion in /usr/bin/weed-volume /usr/bin/weed-worker; do \
      if test -s "${companion}"; then \
        libraries="$(ldd "${companion}" 2>&1)" || \
          case "${libraries}" in *'Not a valid dynamic program'*) ;; *) printf '%s\n' "${libraries}"; exit 1 ;; esac; \
        if printf '%s\n' "${libraries}" | grep -E 'Error loading|not found|libcurl'; then exit 1; fi; \
      fi; \
    done; \
    cp /tmp/nourishing-weed /usr/bin/weed; \
    chmod 0755 /usr/bin/weed; \
    su-exec seaweed /usr/bin/weed version
COPY --from=build /review/NOTICES.txt /usr/share/licenses/nourishing-object-store/NOTICES.txt
