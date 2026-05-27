# syntax=docker/dockerfile:1
# Single image for the whole monorepo. Each service container runs a different
# command from this image (api/redirect/worker = node dist; web/article =
# next start; migrate = prisma). Staging-grade: prioritizes reproducibility over
# image size — see docs/DEPLOY.md for the prod slimming TODO (multi-stage prune /
# Next standalone output).

FROM node:22-slim AS base
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @knn/db generate
# AFS pubId/styleId are NEXT_PUBLIC_* → Next inlines them into the article build,
# so they must be present at build time (passed as build args from deploy config).
# Empty by default (placeholder slot); set on approved-domain deploys.
ARG NEXT_PUBLIC_AFS_PUB_ID=""
ARG NEXT_PUBLIC_AFS_STYLE_ID=""
ENV NEXT_PUBLIC_AFS_PUB_ID=${NEXT_PUBLIC_AFS_PUB_ID}
ENV NEXT_PUBLIC_AFS_STYLE_ID=${NEXT_PUBLIC_AFS_STYLE_ID}
RUN pnpm build

FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# Default command; overridden per service in docker-compose.staging.yml.
CMD ["node", "apps/api/dist/index.js"]
