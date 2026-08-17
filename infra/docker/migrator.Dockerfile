# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_BUILD_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167

FROM ${NODE_BUILD_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

ADD --checksum=sha256:b9e49603540d04107b98e93917a30e6114970d403c23e40309a44ea9c2bca7fd \
    https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz /tmp/pnpm.tgz

RUN npm install --global --ignore-scripts /tmp/pnpm.tgz && rm /tmp/pnpm.tgz

RUN install -d -m 0755 /opt/runtime-root/etc && \
    install -d -o 1000 -g 1000 -m 0755 /opt/runtime-root/home/node && \
    printf '%s\n' \
      'root:x:0:0:root:/root:/sbin/nologin' \
      'node:x:1000:1000:Node.js:/home/node:/sbin/nologin' \
      'nobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin' \
      > /opt/runtime-root/etc/passwd && \
    printf '%s\n' \
      'root:x:0:' \
      'node:x:1000:' \
      'nogroup:x:65534:' \
      > /opt/runtime-root/etc/group && \
    chmod 0644 /opt/runtime-root/etc/passwd /opt/runtime-root/etc/group

COPY . .

RUN --mount=type=cache,id=nutrition-pnpm-migrator-v1,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @nutrition-tracker/db... && \
    pnpm --filter @nutrition-tracker/db... build && \
    pnpm --config.injectWorkspacePackages=true \
      --filter @nutrition-tracker/db deploy --prod /opt/deploy/migrator && \
    find /opt/deploy/migrator -exec touch -h -d @0 {} +

FROM ${NODE_RUNTIME_IMAGE} AS runtime

LABEL io.cronometer.runtime.component="migrator" \
      io.cronometer.runtime.contract="distroless-node22-debian13-uid-gid-1000-empty-entrypoint" \
      io.cronometer.upstream.image="gcr.io/distroless/nodejs22-debian13:nonroot" \
      io.cronometer.upstream.image.digest="sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167" \
      io.cronometer.upstream.node.version="22.23.2" \
      io.cronometer.upstream.signature.identity="keyless@distroless.iam.gserviceaccount.com" \
      io.cronometer.upstream.signature.issuer="https://accounts.google.com"

ENV HOME=/home/node
ENV NODE_ENV=production
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY --from=build /opt/runtime-root/ /
COPY --from=build --chown=1000:1000 /opt/deploy/migrator/ ./

USER 1000:1000

ENTRYPOINT []

HEALTHCHECK NONE

CMD ["/nodejs/bin/node", "--enable-source-maps", "dist/cli.js"]
