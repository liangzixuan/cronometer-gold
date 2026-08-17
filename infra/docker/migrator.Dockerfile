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

RUN --mount=type=cache,id=nutrition-pnpm-migrator-v1,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @nutrition-tracker/db... && \
    pnpm --filter @nutrition-tracker/db... build && \
    pnpm --config.injectWorkspacePackages=true \
      --filter @nutrition-tracker/db deploy --prod /opt/deploy/migrator && \
    find /opt/deploy/migrator -exec touch -h -d @0 {} +

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /opt/deploy/migrator/ ./

USER node

HEALTHCHECK NONE

CMD ["node", "--enable-source-maps", "dist/cli.js"]
