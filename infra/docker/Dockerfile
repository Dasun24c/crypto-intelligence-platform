# syntax=docker/dockerfile:1.7
#
# One Dockerfile, two images (architecture §17):
#   --target server   the four backend services (api, ingestor, analyzer, jobs) and the CLIs
#   --target web      Caddy serving the web build and proxying /api to the api service
# Base images are pinned by digest; update the digest together with the tag.

ARG NODE_IMAGE=node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Node 26 no longer bundles corepack; install the pinned pnpm before any package.json is present.
RUN npm install --global --no-fund --no-audit pnpm@12.18.0 && pnpm --version
WORKDIR /repo

# Download every package once, keyed only on the lockfile, so source edits keep this layer cached.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm pnpm fetch --store-dir /pnpm/store

FROM fetch AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store \
      --filter "./packages/*" --filter "./apps/{api,ingestor,analyzer,jobs,web}"
RUN pnpm --filter "./packages/{contracts,observability,db}" --filter "./apps/{api,ingestor,analyzer,jobs}" run build \
 && pnpm --filter @cip/web run build

# Production dependencies only, for the server packages. This stage starts clean: `pnpm fetch` fills
# node_modules/.pnpm with every package (dev tools included), so inheriting from it would ship them.
# The COPY from `fetch` only orders the stages, so the shared store cache is populated first.
FROM base AS prod-deps
COPY --from=fetch /repo/pnpm-lock.yaml /tmp/fetched.lock
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm \
    pnpm install --offline --frozen-lockfile --prod --store-dir /pnpm/store \
      --filter "@cip/api..." --filter "@cip/ingestor..." --filter "@cip/analyzer..." --filter "@cip/jobs..." --filter "@cip/db..." \
 && find packages apps -mindepth 2 -maxdepth 2 -name src -type d -prune -exec rm -rf {} + \
 && rm -rf apps/web apps/desktop packages/app packages/ui packages/config

FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/packages ./packages
COPY --from=prod-deps --chown=node:node /repo/apps ./apps
COPY --from=build --chown=node:node /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/observability/dist ./packages/observability/dist
COPY --from=build --chown=node:node /repo/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/ingestor/dist ./apps/ingestor/dist
COPY --from=build --chown=node:node /repo/apps/analyzer/dist ./apps/analyzer/dist
COPY --from=build --chown=node:node /repo/apps/jobs/dist ./apps/jobs/dist
COPY --chown=node:node infra/docker/dev-secrets.mjs ./infra/dev-secrets.mjs
COPY --chown=node:node infra/docker/healthcheck.mjs ./infra/healthcheck.mjs
USER node
# Pick the service with the command, e.g. `node apps/jobs/dist/main.js`.
CMD ["node", "apps/api/dist/main.js"]

FROM ${CADDY_IMAGE} AS web
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/web
