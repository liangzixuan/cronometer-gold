# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG GO_IMAGE=docker.io/library/golang:1.26.6-alpine3.24@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83
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
      io.cronometer.module-lock.sha256="123ae5b96deb916e9b4614fa43c15e788beed08ad9722465260017eccbdc5155" \
      io.cronometer.grpc.version="v1.85.0-dev.0.20260825072537-93e31b48545e"
# Preserve the upstream entrypoint, companions and its drop to seaweed UID/GID 1000.
COPY --from=build /out/weed /usr/bin/weed
COPY --from=build /review/NOTICES.txt /usr/share/licenses/nourishing-object-store/NOTICES.txt
