# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

FROM ${NODE_IMAGE} AS build

ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

ADD --checksum=sha256:b9e49603540d04107b98e93917a30e6114970d403c23e40309a44ea9c2bca7fd \
    https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz /tmp/pnpm.tgz

RUN npm install --global --ignore-scripts /tmp/pnpm.tgz && rm /tmp/pnpm.tgz

COPY . .

RUN --mount=type=cache,id=nutrition-pnpm-web-v1,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @nutrition-tracker/web... && \
    pnpm --filter @nutrition-tracker/web build && \
    find apps/web/.next/standalone apps/web/.next/static -exec touch -h -d @0 {} +

FROM ${NODE_IMAGE} AS runtime

ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static/ ./apps/web/.next/static/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "apps/web/server.js"]
