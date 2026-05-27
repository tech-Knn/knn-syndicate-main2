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
RUN pnpm build

FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# Default command; overridden per service in docker-compose.staging.yml.
CMD ["node", "apps/api/dist/index.js"]
