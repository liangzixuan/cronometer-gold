# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

ADD --checksum=sha256:b9e49603540d04107b98e93917a30e6114970d403c23e40309a44ea9c2bca7fd \
    https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz /tmp/pnpm.tgz

RUN npm install --global --ignore-scripts /tmp/pnpm.tgz && rm /tmp/pnpm.tgz

COPY . .

RUN --mount=type=cache,id=nutrition-pnpm-api-v1,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @nutrition-tracker/api... && \
    pnpm --filter @nutrition-tracker/api... build && \
    pnpm --config.injectWorkspacePackages=true \
      --filter @nutrition-tracker/api deploy --prod /opt/deploy/api && \
    find /opt/deploy/api -exec touch -h -d @0 {} +

FROM ${NODE_IMAGE} AS runtime

ENV API_HOST=0.0.0.0
ENV API_PORT=3001
ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /opt/deploy/api/ ./

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.API_PORT || '3001') + '/ready').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/server.js"]
