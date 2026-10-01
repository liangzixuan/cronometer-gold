# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG GO_IMAGE=docker.io/library/golang:1.26.6-alpine3.24@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83

FROM ${NODE_IMAGE} AS frontend
ARG TARGETARCH
ENV NPM_CONFIG_CACHE=/npm-cache NPM_CONFIG_USERCONFIG=/npm-config/user \
    NPM_CONFIG_GLOBALCONFIG=/npm-config/global NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
    NPM_CONFIG_FETCH_RETRIES=0 NPM_CONFIG_ENGINE_STRICT=true
WORKDIR /review
COPY scripts/verify-mailpit-build.mjs scripts/license-policy.mjs ./scripts/
COPY config/license-policy.json ./config/
COPY infra/docker/mailpit-build-inputs.json infra/docker/mailpit-NOTICES.txt ./infra/docker/
ADD --checksum=sha256:538160e64be90a736342d13895b64094143966a85b9e878e4803db39b703a73d https://codeload.github.com/axllent/mailpit/tar.gz/ae3d9e20e410bf2af1c1b7292bc3b8491b41b30a /tmp/mailpit.tar.gz
WORKDIR /src
RUN set -eux; test "${TARGETARCH}" = arm64; \
    mkdir /evidence /npm-config; touch /npm-config/user /npm-config/global; \
    tar -xzf /tmp/mailpit.tar.gz --strip-components=1; \
    node /review/scripts/verify-mailpit-build.mjs source /src /evidence; \
    npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund; \
    node /review/scripts/verify-mailpit-build.mjs npm /src /evidence; \
    npm audit --audit-level=high --json > /evidence/npm-audit.json; \
    MINIFY=true node esbuild.config.mjs; \
    node /review/scripts/verify-mailpit-build.mjs frontend /src /evidence

FROM ${GO_IMAGE} AS go-inputs
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOENV=off GOWORK=off \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE="" GONOSUMDB="" GONOPROXY="" \
    GOFLAGS="-mod=readonly -p=2" GOMAXPROCS=2 GOROOT=/usr/local/go
ADD --checksum=sha256:538160e64be90a736342d13895b64094143966a85b9e878e4803db39b703a73d https://codeload.github.com/axllent/mailpit/tar.gz/ae3d9e20e410bf2af1c1b7292bc3b8491b41b30a /tmp/mailpit.tar.gz
ADD --checksum=sha256:caa4e1930299b96430f3b3fc98296b008cb38e0909caaaebdee270595c30b9ec https://proxy.golang.org/github.com/google/go-licenses/v2/@v/v2.0.1.zip /tmp/licenses.zip
WORKDIR /src
RUN set -eux; test "${TARGETARCH}" = arm64; \
    mkdir /out /tool-unpack; tar -xzf /tmp/mailpit.tar.gz --strip-components=1; \
    unzip -q /tmp/licenses.zip -d /tool-unpack; \
    mv /tool-unpack/github.com/google/go-licenses/v2@v2.0.1 /license-tool
COPY infra/docker/mailpit-go-licenses.go.mod /license-tool/go.mod
COPY infra/docker/mailpit-go-licenses.go.sum /license-tool/go.sum
COPY --from=frontend /src/server/ui/dist/ /src/server/ui/dist/
RUN set -eux; \
    sha256sum go.mod go.sum /license-tool/go.mod /license-tool/go.sum > /out/manifests.sha256; \
    go mod download all; go mod verify; \
    go list -m -f '{{.Path}} {{.Version}}' all > /out/mailpit-modules.txt; \
    go list -deps -f '{{.ImportPath}}' . > /out/mailpit-imports.txt; \
    cd /license-tool; go mod download all; go mod verify; \
    go list -m -f '{{.Path}} {{.Version}}' all > /out/tool-modules.txt; \
    go list -deps -f '{{.ImportPath}}' . > /out/tool-imports.txt; \
    cd /src; sha256sum -c /out/manifests.sha256

FROM frontend AS graph-admission
COPY --from=go-inputs /src/ /graph/source/
COPY --from=go-inputs /license-tool/ /graph/tool/
COPY --from=go-inputs /out/ /graph/
RUN node /review/scripts/verify-mailpit-build.mjs graph /graph /evidence

FROM go-inputs AS build
COPY --from=graph-admission /evidence/graph-verification.json /out/graph-verification.json
RUN set -eux; \
    cd /license-tool; go build -trimpath -buildvcs=false -o /go-licenses .; \
    cd /src; /go-licenses report . --template /src/.github/third-party-licenses.tpl \
      --ignore github.com/axllent/mailpit > /out/go-notices.txt 2> /out/go-notice-warnings.txt; \
    cp /out/go-notices.txt internal/licenses/third-party.txt; \
    go build -trimpath -buildvcs=false \
      -ldflags='-s -w -X github.com/axllent/mailpit/config.Version=v1.31.3' -o /out/mailpit .; \
    sha256sum -c /out/manifests.sha256; \
    go version -m /out/mailpit > /out/mailpit-buildinfo.txt; \
    sha256sum /out/mailpit > /out/mailpit.sha256; \
    cp go.mod go.sum /out/; cp /usr/local/go/LICENSE /out/Go-LICENSE

FROM frontend AS evidence-admission
COPY --from=build /out/ /go-evidence/
RUN node /review/scripts/verify-mailpit-build.mjs notices /go-evidence /evidence

FROM ${GO_IMAGE} AS rootfs
ADD --checksum=sha256:81a2c508dcdb3295196e6a8987274e3bc3487f99ad8d18e985f20bb2c336b5e6 \
    https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/ca-certificates-bundle-20260909-r0.apk /tmp/ca.apk
ADD --checksum=sha256:677588e6b5d81ca4d697777609f38f969e743a812c68d196c7a0f0b1367aabc3 \
    https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/tzdata-2026c-r0.apk /tmp/tz.apk
RUN set -eux; apk add --no-cache --no-network /tmp/ca.apk /tmp/tz.apk; \
    mkdir -p /rootfs/etc/ssl/certs /rootfs/usr/share /rootfs/data /rootfs/tmp /rootfs/home/mailpit; \
    cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/; \
    cp -a /usr/share/zoneinfo /rootfs/usr/share/; \
    printf 'mailpit:x:1000:1000:Mailpit:/home/mailpit:/sbin/nologin\n' > /rootfs/etc/passwd; \
    printf 'mailpit:x:1000:\n' > /rootfs/etc/group; \
    chmod 1777 /rootfs/tmp; chown 1000:1000 /rootfs/data /rootfs/home/mailpit

FROM scratch AS build-evidence
COPY --from=evidence-admission /evidence/ /
COPY --from=build /out/ /
COPY infra/docker/mailpit-NOTICES.txt /licenses/NOTICES.txt

FROM scratch AS runtime
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/liangzixuan/cronometer-gold" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="v1.31.3" \
      io.cronometer.runtime.component="mailpit" \
      io.cronometer.upstream.source.revision="ae3d9e20e410bf2af1c1b7292bc3b8491b41b30a" \
      io.cronometer.build-inputs.sha256="1ef490eb2ee51b8092a36d66bc9f41ee3a729a2e8512adcde7b628f841132ec9" \
      io.cronometer.notices.sha256="7e1f82454e28a1088dd18e410dc185c9c261017aacace2b713b7658d07c2e3b4"
COPY --from=rootfs /rootfs/ /
COPY --from=build /out/mailpit /usr/bin/mailpit
COPY --from=evidence-admission /evidence/notices-verification.json /usr/share/licenses/mailpit/notices-verification.json
COPY --from=frontend /evidence/ical.js-2.2.1.tgz /usr/share/licenses/mailpit/ical.js-2.2.1.tgz
COPY --from=frontend /evidence/browser-notices/ /usr/share/licenses/mailpit/browser-notices/
COPY --from=build /out/go-notices.txt /out/Go-LICENSE /usr/share/licenses/mailpit/
COPY infra/docker/mailpit-NOTICES.txt /usr/share/licenses/mailpit/NOTICES.txt
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/mailpit TMPDIR=/tmp TZ=UTC
USER 1000:1000
WORKDIR /data
EXPOSE 1025 8025
ENTRYPOINT ["/usr/bin/mailpit"]
