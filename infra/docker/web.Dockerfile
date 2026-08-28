# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_BUILD_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG NODE_RUNTIME_IMAGE

FROM ${NODE_BUILD_IMAGE} AS build

ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

ADD --checksum=sha256:b9e49603540d04107b98e93917a30e6114970d403c23e40309a44ea9c2bca7fd \
    https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz /tmp/pnpm.tgz

RUN npm install --global --ignore-scripts /tmp/pnpm.tgz && \
    rm /tmp/pnpm.tgz && \
    test "$(pnpm --version)" = 11.19.0

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

RUN --mount=type=cache,id=nutrition-pnpm-web-v1,target=/pnpm/store,sharing=locked \
    test "$(pnpm --version)" = 11.19.0 && \
    pnpm install --frozen-lockfile --strict-peer-dependencies --filter @nutrition-tracker/web... && \
    pnpm --filter @nutrition-tracker/web build && \
    find apps/web/.next/standalone apps/web/.next/static -exec touch -h -d @0 {} +

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG NODE_RUNTIME_IMAGE

LABEL io.cronometer.runtime.component="web" \
      io.cronometer.upstream.node-runtime.ref="${NODE_RUNTIME_IMAGE}" \
      io.cronometer.runtime.contract="patched-node22.23.2-openssl3.5.7-08e7756-base-nossl-debian13-uid-gid-1000-empty-entrypoint"

ENV HOME=/home/node
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV PORT=3000
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY --from=build /opt/runtime-root/ /
COPY --from=build --chown=1000:1000 /workspace/apps/web/.next/standalone/ ./
COPY --from=build --chown=1000:1000 /workspace/apps/web/.next/static/ ./apps/web/.next/static/

USER 1000:1000

ENTRYPOINT []

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["/nodejs/bin/node", "apps/web/server.js"]
