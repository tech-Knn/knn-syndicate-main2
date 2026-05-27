# KNN Syndicate — Search Arbitrage Platform

Self-hosted search-arbitrage platform: launch Facebook ads → cloaked redirect → AI-generated
monetized AFS article pages → revenue attribution → real-time ROI. Multi-tenant (companies).

See [`CLAUDE.md`](./CLAUDE.md) for the architecture, [`docs/DECISIONS.md`](./docs/DECISIONS.md)
for the decision log, and [`docs/CURRENT_STATE.md`](./docs/CURRENT_STATE.md) for status.

## Prerequisites

- Node `>=20` (repo pins **22 LTS** via `.nvmrc`)
- `pnpm` (`corepack enable`)
- Docker — on macOS without Docker Desktop, use **Colima**: `brew install colima docker docker-compose && colima start`

## Quickstart

```bash
cp .env.example .env          # local defaults (dummy secrets) work out of the box
pnpm install
pnpm infra:up                 # Postgres 16 (+pgvector) + Redis via docker-compose
pnpm db:generate
pnpm db:migrate               # apply migrations
pnpm db:seed                  # default platform settings
pnpm dev                      # run all apps (Turborepo)
```

- API: <http://localhost:3000> · health `GET /health` · Bull-Board `/admin/queues` (basic auth)
- Article frontend: <http://localhost:3001>
- Redirect engine: <http://localhost:3002>
- Dashboard: <http://localhost:3003>

## Workspace

```
apps/
  api/        Fastify — REST API, auth, FB/AdSense, admin
  redirect/   Hono   — public /go/:id engine (<50ms)
  article/    Next 15 SSR — public AFS article pages
  web/        Next 15 — dashboard + company-admin + super-admin
  worker/     BullMQ — stats, attribution, channel cron, FB launch, token refresh
packages/
  db/         Prisma schema + migrations (Postgres 16 + pgvector)
  shared/     constants, IST datetime, money/revenue-allocation utils
  config/     validated environment (zod)
  queue/      BullMQ connection + queue registry
```

## Common commands

```bash
pnpm lint        # eslint across the monorepo
pnpm typecheck   # tsc --noEmit per package
pnpm test        # vitest
pnpm build       # tsup (apps) + next build
pnpm infra:down  # stop local Postgres/Redis
```

## Environments

`local` / `staging` (real Facebook **test** ad accounts + sandboxed AdSense) / `production`.
Never test the Facebook integration in production.
