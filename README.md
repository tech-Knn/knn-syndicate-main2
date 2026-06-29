# KNN Syndicate — Search Arbitrage Platform

Self-hosted, multi-tenant **search-arbitrage** platform. Media buyers launch Facebook ads →
traffic is **cloaked** through a redirect engine → lands on **AI-generated, monetized article
pages** carrying a Google **AdSense for Search (AFS)** widget → AFS revenue is **attributed back**
to the originating ad/campaign → buyers see **real-time ROI**.

Multi-tenant by company: roles are `SUPER_ADMIN` (KNN platform), `COMPANY_ADMIN` (one org), and
`MEDIA_BUYER` (one org). Built for ~50–200 buyers and ~1,500–2,000 managed campaigns.

> **New here? Read this README top to bottom once, then keep these three open:**
> [`docs/CURRENT_STATE.md`](./docs/CURRENT_STATE.md) (what's done / in progress / next),
> [`docs/DECISIONS.md`](./docs/DECISIONS.md) (why the architecture is the way it is), and
> [`CLAUDE.md`](./CLAUDE.md) (the condensed architecture brief). Every app and package also has its
> own `CLAUDE.md` with invariants and footguns — **read the one for any package you touch.**

---

## The money loop (in one breath)

```
Media buyer builds a campaign  ─►  Facebook ad goes live
        │
        ▼
A real click hits  go.<domain>  (the cloaked redirect, Cloudflare Worker, <50 ms)
        │  ├─ real human  ─►  articles.<domain>  (AI "money" article + AdSense AFS search box)
        │  └─ bot/reviewer ─►  the "white" page (safe, non-monetized decoy)
        ▼
User searches on the AFS unit, clicks a sponsored result  ─►  Google pays AFS revenue
        │
        ▼
Worker pulls AdSense revenue per channel (= per campaign), splits it across the campaign's ads
in proportion to each ad's Facebook pixel conversions, fires Facebook CAPI, and surfaces ROI.
```

The arbitrage: a Facebook click costs **less** than the AFS search click it produces is worth.
Run that gap at scale, attribute every cent, and keep the difference.

---

## Table of contents

1. [Architecture](#architecture)
2. [Tech stack](#tech-stack)
3. [Prerequisites](#prerequisites)
4. [Local setup (quickstart)](#local-setup-quickstart)
5. [Repository layout](#repository-layout)
6. [The data model](#the-data-model)
7. [Environment variables](#environment-variables)
8. [Commands](#commands)
9. [Integrations (Facebook · Google AdSense · AI · Cloudflare)](#integrations)
10. [Background jobs (worker)](#background-jobs-worker)
11. [Testing](#testing)
12. [Deployment](#deployment)
13. [Environments](#environments)
14. [Key decisions & footguns](#key-decisions--footguns)
15. [Documentation map](#documentation-map)
16. [Security & secrets](#security--secrets)
17. [Troubleshooting](#troubleshooting)
18. [Onboarding a new developer](#onboarding-a-new-developer)

---

## Architecture

**Monorepo** managed by **pnpm workspaces + Turborepo**. Six runnable apps and seven shared
packages. Two of the apps (`redirect`, `white`) are **Cloudflare Workers** deployed separately via
Wrangler; the other four (`api`, `article`, `web`, `worker`) run as containers on the origin box.

```
                          Cloudflare (DNS · proxy · WAF · Workers · KV)
                                            │
      go.<domain>  ─────────────────────────┤   apps/redirect  (Worker)  + apps/white (Worker)
      (cloaked redirect, reads per-ad config from Workers KV; routes real vs bot traffic)
                                            │
                                  Hetzner VPS · Caddy :443 (auto-TLS)
                                            │
          app.<domain>      ─►  web :3003   (Next.js dashboard)  ── /api,/admin ─►  api :3000
          articles.<domain> ─►  article :3001 (Next.js SSR money pages + AFS unit)
                                            │
              api (Fastify)   worker (BullMQ)   postgres (pgvector)   redis
```

**Why the framework split** (see `docs/DECISIONS.md` D3): Fastify for the main API; the latency-
critical public redirect lives at the **edge** as a Cloudflare Worker. Everything server-side is
Node-only because the Facebook/Google SDK paths aren't edge-compatible.

### Apps

| App | Package | Stack | Runs as | Role |
|-----|---------|-------|---------|------|
| **api** | `@knn/api` | Fastify (tsx dev / tsup build) | container `:3000` | REST API, auth (JWT), tenant guard, Facebook + AdSense OAuth & sync, campaign/launch logic, admin, internal launch trigger, CAPI events endpoint, Bull-Board. |
| **article** | `@knn/article` | Next.js 15 SSR | container `:3001` | Public **money** article pages on `articles.<domain>`; renders the AdSense AFS/CSA search unit; hosts the conversion-detection beacon. **Revenue-critical & Google-crawled.** |
| **web** | `@knn/web` | Next.js 15 | container `:3003` | The dashboard: buyer, company-admin, and super-admin UIs. Talks to the API with a Bearer token. |
| **worker** | `@knn/worker` | BullMQ (tsx dev / tsup build) | container | Background jobs: stats sync, revenue attribution, channel-pool cron, FB launch, token refresh, AdSense pulls, FX rates, re-sync. |
| **redirect** | `@knn/redirect` | Hono on **Cloudflare Workers** | edge (Wrangler) | The public `go.<domain>` cloaking engine. Reads per-ad redirect config from Workers KV; decides money-vs-white; <50 ms. |
| **white** | `@knn/white` | **Cloudflare Worker** | edge (Wrangler) | Serves the safe, non-monetized **decoy** pages shown to bots/reviewers. Kept on a separate domain for cloaking hygiene. |

### Packages (internal libraries)

| Package | Purpose |
|---------|---------|
| `@knn/db` | Prisma schema, migrations, and the shared `PrismaClient` singleton. Postgres 16 + **pgvector**. Owns RLS. |
| `@knn/config` | Centralized, **zod-validated** environment. The single source of truth for env — apps never read `process.env` directly. |
| `@knn/shared` | Constants, **IST** datetime helpers, money (integer-cents) + conversion-weighted **revenue allocation** (`allocateByWeights`). |
| `@knn/queue` | BullMQ connection + queue registry. |
| `@knn/fb` | Everything Facebook: OAuth, the Graph client, error classification, the per-ad-account rate-limit/backoff/circuit-breaker, token encryption (AES-256-GCM), and account/page/pixel sync. |
| `@knn/adsense` | Google AdSense / AFS client: OAuth, revenue pulls, channel catalog. |
| `@knn/ai` | Article generation + compliance via Claude; embeddings via OpenAI `text-embedding-3-small` (1536-dim) for pgvector de-dup. |

> Internal packages **export TS source directly** (`exports → ./src/index.ts`); consumers compile
> them (tsx in dev, tsup / Next bundle for prod). **Don't add per-package build steps for
> libraries.** ESM everywhere; relative imports use the `.js` extension (which resolves to `.ts`).

---

## Tech stack

- **Language:** TypeScript (ESM, `strict` + `noUncheckedIndexedAccess`).
- **Runtime:** Node **22 LTS** (`.nvmrc`; `engines.node >= 20`).
- **Package manager:** **pnpm 10.11.0** (via `corepack`). Build orchestration: **Turborepo**.
- **API:** Fastify. **Dashboard / article:** Next.js 15 (React 19). **Edge:** Hono on Cloudflare Workers.
- **DB:** PostgreSQL 16 + **pgvector** (ivfflat, cosine). ORM: **Prisma 6**. Multi-tenancy via **RLS**.
- **Queue / cache:** Redis 7 + **BullMQ**.
- **Auth:** JWT (access + refresh), bcrypt password hashing.
- **External:** Facebook Marketing API, Google AdSense (AFS), Anthropic (Claude), OpenAI (embeddings), an FX rates API.
- **Infra:** Docker Compose, **Caddy** (auto-TLS), **Cloudflare** (DNS/CDN/WAF/Workers/KV), Hetzner VPS.
- **Tests:** Vitest (unit + integration against real Postgres/Redis); Playwright (web E2E).
- **Lint/format:** ESLint 9 (flat config) + Prettier.

---

## Prerequisites

- **Node 22 LTS** — `nvm use` (repo pins 22 via `.nvmrc`).
- **pnpm** — `corepack enable` (pins the version from `package.json`).
- **Docker** — for local Postgres + Redis. On macOS without Docker Desktop use **Colima**:
  `brew install colima docker docker-compose && colima start`.
- For external integrations you'll eventually need: a **Facebook app** (with **test** ad accounts
  for staging), **Google AdSense AFS** access on an approved domain, **Anthropic** + **OpenAI** API
  keys, and a **Cloudflare** account (for the Workers + KV). None are required to boot the stack
  locally — the app self-dormants on unset integrations.

---

## Local setup (quickstart)

```bash
nvm use                        # Node 22
corepack enable                # pnpm

cp .env.example .env           # local defaults (dummy secrets) work out of the box
pnpm install

pnpm infra:up                  # Postgres 16 (+pgvector) + Redis via docker-compose
pnpm db:generate               # generate the Prisma client
pnpm db:bootstrap              # create the non-superuser `knn_app` role that RLS needs
pnpm db:migrate                # apply all migrations
pnpm db:seed                   # platform settings + seed super admin
pnpm dev                       # run all apps (Turborepo)
```

| Service | URL | Notes |
|---------|-----|-------|
| API | <http://localhost:3000> | health: `GET /health` · queues: `/admin/queues` (basic auth, `BULL_BOARD_*`) |
| Article | <http://localhost:3001> | public AFS article pages (AFS shows a placeholder off an approved domain) |
| Dashboard | <http://localhost:3003> | log in with the seeded super-admin |
| Redirect (Worker) | `pnpm --filter @knn/redirect dev:worker` | runs under Wrangler; not part of `pnpm dev` |

> **`db:bootstrap` is required before the app can serve traffic.** It creates the `knn_app`
> non-superuser role so Row-Level Security is actually enforced (migrations run as the owner; the
> app runs as `knn_app`). `APP_DATABASE_URL` points at that role.

To run a single app: `pnpm --filter @knn/api dev`. To reset local data: `pnpm infra:reset` (drops
the Postgres/Redis volumes), then re-run bootstrap/migrate/seed.

---

## Repository layout

```
apps/
  api/        Fastify — REST API, auth, FB/AdSense OAuth+sync, campaign/launch, admin, CAPI, Bull-Board
  article/    Next 15 SSR — public AFS "money" article pages (articles.<domain>) + conversion beacon
  web/        Next 15 — dashboard (buyer / company-admin / super-admin) + Playwright E2E
  worker/     BullMQ — stats, attribution, channel cron, FB launch, token refresh, AdSense, FX
  redirect/   Cloudflare Worker (Hono) — the go.<domain> cloaking engine (reads Workers KV)
  white/      Cloudflare Worker — the safe decoy ("white") pages
packages/
  db/         Prisma schema + 35 migrations + bootstrap/seed scripts (Postgres 16 + pgvector)
  config/     zod-validated environment (the only place env is read)
  shared/     constants, IST datetime, money/revenue-allocation utils
  queue/      BullMQ connection + queue registry
  fb/         Facebook Marketing API: OAuth, Graph client, rate limiter, token crypto, sync
  adsense/    Google AdSense / AFS: OAuth, revenue pulls, channel catalog
  ai/         Claude (articles + compliance) + OpenAI embeddings (pgvector de-dup)
infra/
  docker-compose.yml          local Postgres + Redis
deploy/
  docker-compose.staging.yml  the staging/prod stack (postgres, redis, migrate, api, worker, web, article, caddy)
  Dockerfile                  one image, all apps
  Caddyfile                   reverse proxy + auto-TLS for the three domains
  push-staging.sh             ★ deploy from your machine → the box (rsync HEAD, build, recreate)
  deploy.sh                   on-box deploy (git pull + build + migrate + restart) — first provision
  provision.sh                one-time box provisioning (Docker, firewall)
  backup.sh / restore.sh      Postgres dump/restore + install-backup-cron.sh
docs/
  CURRENT_STATE.md  DECISIONS.md  OPEN_QUESTIONS.md  DEPLOY.md  APP_REVIEW.md  OFFERS_DOMAINS_AFS.md
```

---

## The data model

Single source of truth: [`packages/db/prisma/schema.prisma`](./packages/db/prisma/schema.prisma)
(33 models, 35 migrations). The major entities:

- **Tenancy & identity:** `Organization`, `User` (roles `SUPER_ADMIN` / `COMPANY_ADMIN` /
  `MEDIA_BUYER`), `RefreshToken`, `AuditLog`, `PlatformSetting`.
- **Facebook:** `FbConnection` (per-user OAuth, status incl. `CONNECTION_BROKEN`), `FbAdAccount`,
  `FbPage`, `FbPixel`.
- **The offer (campaign) & creatives:** `Campaign` (owns keywords, RAC, the single `Article` FK,
  and the AdSense `Channel` FK — the "offer"), `AdSet`, `Ad` (each carries a unique `redirect_id`),
  `Upload` (ad creatives), `LauncherPreset`, `Offer`.
- **Content:** `Article` (AI-generated; `embedding vector(1536)` for de-dup), `ArticleStatus`.
- **Channel pool (AdSense ↔ campaign):** `Channel`, `ChannelAssignment`, `CampaignQueue` (approval
  → channel assignment via `SELECT … FOR UPDATE SKIP LOCKED`).
- **Google / AdSense:** `GoogleConnection`, `AfsChannelCatalog`.
- **Domains:** `Domain`, `RedirectDomain`, `WhiteDomain` (money / redirect / decoy domains).
- **Money & stats (daily rollups, IST business day):** `FxRate`, `AdStatsDaily`, `AdStatDimDaily`,
  `CampaignRevenueDaily`, `AdRevenueDaily`, `OfferRevenueDaily`, `TermStatDaily`, `CloakStatDaily`,
  `ConversionEvent`.

**Multi-tenancy:** every business row carries `org_id`. Isolation is **defense-in-depth**: a
service-layer tenant guard **plus** Postgres **RLS** policies. Each request/txn must
`SET app.current_org = <id>` on the connection (the tenant guard does this). The app connects as the
non-superuser `knn_app` role so RLS is enforced; migrations connect as the owner.

**Money:** stored in **integer cents**, with a native amount + a USD-converted field. **Never sum
across native currencies** — convert to USD first (`docs/DECISIONS.md` D15;
`packages/shared/src/money.ts`).

---

## Environment variables

`.env` is loaded from the repo root and **validated by zod** in
[`packages/config/src/index.ts`](./packages/config/src/index.ts) — **that file is the authoritative
list.** Copy [`.env.example`](./.env.example) to `.env` for local dev (its dummy values boot the
whole stack). `APP_ENV` (`local` | `staging` | `production`) selects the profile; a per-env
`.env.<APP_ENV>` overrides the base.

Grouped reference (see `.env.example` for inline docs and `config/src/index.ts` for defaults):

| Group | Keys |
|-------|------|
| **Runtime** | `NODE_ENV`, `APP_ENV`, `LOG_LEVEL`, `RATE_LIMIT_MAX`, `RATE_LIMIT_AUTH_MAX` |
| **Ports** | `API_PORT` (3000), `ARTICLE_PORT` (3001), `REDIRECT_PORT` (3002), `WEB_PORT` (3003) |
| **Domains** | `PLATFORM_DOMAIN`, `WEB_DOMAIN`, `ARTICLE_DOMAIN`, `REDIRECT_DOMAIN` |
| **Article / AFS** (baked into the Next build) | `ARTICLE_API_BASE`, `NEXT_PUBLIC_AFS_PUB_ID`, `NEXT_PUBLIC_AFS_STYLE_ID`, `NEXT_PUBLIC_AFS_ADTEST`, `NEXT_PUBLIC_AFS_ADSAFE`, `NEXT_PUBLIC_EVENTS_URL` |
| **Postgres** | `DATABASE_URL` (owner; migrations), `APP_DATABASE_URL` (`knn_app`; RLS-enforced runtime), `SHADOW_DATABASE_URL`, plus `POSTGRES_*` for docker-compose |
| **Redis** | `REDIS_URL` (+ `REDIS_PORT`) |
| **Auth / crypto** | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `TOKEN_ENCRYPTION_KEY` (**64 hex chars = 32 bytes**, AES-256-GCM for FB tokens) |
| **Bull-Board** | `BULL_BOARD_USER`, `BULL_BOARD_PASSWORD` |
| **Facebook** | `FB_APP_ID`, `FB_APP_SECRET`, `FB_API_VERSION` (v21.0), `FB_OAUTH_REDIRECT_URI`, `FB_LOGIN_CONFIG_ID`, `FB_WEBHOOK_VERIFY_TOKEN` |
| **Facebook (advanced/optional)** | `FB_LAUNCH_APP_ID/SECRET/CONFIG_ID` (separate launch app), `FB_VERIFY_APP_ID/SECRET/CONFIG_ID` + `FB_VERIFY_API_VERSION` (v25.0; Advanced-Access app), `FB_HTTPS_PROXY`, `FB_SKIP_LONGLIVED`, `FB_DEBUG_LOG` |
| **Google AdSense** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` |
| **AI** | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_ARTICLE_MODEL` |
| **FX** | `FX_API_URL`, `FX_API_KEY` |
| **Cloudflare KV** (edge redirect config) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CF_KV_NAMESPACE_ID` |
| **Internal trigger** (worker → API auto-launch) | `INTERNAL_API_TOKEN`, `INTERNAL_API_URL` |
| **Ops alerting** | `NOTIFY_WEBHOOK_URL` (Slack-compatible incoming webhook for platform alerts — CONNECTION_BROKEN, launch failures, etc.; unset → log to console only) |
| **Misc** | `UPLOAD_DIR`, `BUSINESS_TIMEZONE` (`Asia/Kolkata`) |

> Generate strong secrets with `openssl rand -hex 32`. The integrations are **self-dormant**: unset
> keys disable that feature gracefully (e.g. no Cloudflare token → launch logs a warning and
> continues; unset AFS pub id → the article shows a placeholder slot).

---

## Commands

Run from the repo root (Turborepo fans out across the workspace):

```bash
pnpm dev            # run all apps (api, web, article, worker; redirect/white are Wrangler — run separately)
pnpm build          # build everything (tsup for api/worker, next build for web/article)
pnpm lint           # eslint across the monorepo   (pnpm lint:fix to autofix)
pnpm typecheck      # tsc --noEmit per package
pnpm test           # vitest (unit + integration; integration hits real Postgres/Redis)
pnpm format         # prettier --write   (pnpm format:check to verify)

pnpm infra:up       # start local Postgres + Redis
pnpm infra:down     # stop them (keeps data)
pnpm infra:reset    # ⚠️ drop volumes (wipes local DB), then restart
pnpm infra:logs     # tail infra logs
```

Database (`@knn/db`; all load the root `.env`):

```bash
pnpm db:generate    # prisma generate
pnpm db:migrate     # prisma migrate dev   (local; creates + applies a migration)
pnpm db:deploy      # prisma migrate deploy (staging/prod; applies only)
pnpm db:bootstrap   # create the knn_app RLS role (run once per fresh DB)
pnpm db:seed        # seed platform settings + super admin
pnpm db:studio      # Prisma Studio (DB browser)
```

Single app: `pnpm --filter @knn/<name> <script>` — e.g.
`pnpm --filter @knn/web e2e`, `pnpm --filter @knn/redirect dev:worker`,
`pnpm --filter @knn/redirect deploy` (Wrangler deploy of the edge Worker).

---

## Integrations

### Facebook (Marketing API) — `@knn/fb`

We use **`fetch`, not the official SDK**, so every Graph call flows through our own
rate-limit/backoff/circuit-breaker and error classification. Key facts (full detail in
[`packages/fb/CLAUDE.md`](./packages/fb/CLAUDE.md) and `docs/DECISIONS.md` D12–D14):

- **Up to three FB apps**, selected per call by `appKind` (`packages/fb/src/app-creds.ts`):
  - **DATA** (`FB_APP_*`) — the main app. Long-lived (~60-day) per-user token; all reads / sync /
    insights / CAPI + the daily token refresh.
  - **LAUNCH** (`FB_LAUNCH_*`, optional) — a second app used **only to create/modify ads** with a
    short-lived token (the DATA long-lived token trips FB's `31/3858385` ad-publish checkpoint).
    Falls back to DATA when unset.
  - **VERIFY** (`FB_VERIFY_*`, optional) — an Advanced-Access app for the post-App-Review path
    (any user can connect). It's an **App-type: Business** app, which Facebook forces through
    **Login for Business** → it needs a `config_id` **and** mints+redeems the OAuth code at the
    **same Graph version** (`FB_VERIFY_API_VERSION=v25.0`, vs DATA's `v21.0`). Getting the version
    or `config_id` wrong yields code 100 / subcode 36008.
- **Rate limits are per ad account** → a per-account request queue + backoff + circuit breaker. Any
  `/act_<id>/...` call must pass `accountId` so it's gated.
- **Error classification is the contract** (`classifyFbError`): token errors (190 / token subcodes)
  → `CONNECTION_BROKEN` (notify + stop polling, reconnect); account holds (368) →
  `FbAccountRestrictedError` (don't retry, don't mark the connection broken); rate codes → retry
  with backoff then trip the breaker.
- **Tokens are AES-256-GCM encrypted at rest** (`TOKEN_ENCRYPTION_KEY`). **Never log or persist a
  plaintext token.** Long-lived tokens are refreshed by the worker's daily job (degrades on expiry,
  nudges a re-auth ~day 55).
- **OAuth callback:** `FB_OAUTH_REDIRECT_URI` (shared by all apps — add it to each app in Meta).

### Google AdSense (AFS revenue) — `@knn/adsense`

OAuth via `GOOGLE_*`. The worker pulls AFS revenue per **channel** (1 channel ↔ 1 campaign), writes
it transactionally (no silent truncation), and the attribution step splits a campaign's revenue
across its ads by FB pixel **conversions** (largest-remainder, sums exactly —
`packages/shared/src/money.ts#allocateByWeights`). AFS ads render **only on Google-approved
domains**; off an approved domain the slot is a placeholder (`NEXT_PUBLIC_AFS_*`).

### AI — `@knn/ai`

Articles + compliance via **Claude** (`ANTHROPIC_MODEL`); article generation can use a
cost-optimized OpenAI model (`OPENAI_ARTICLE_MODEL`). Embeddings via OpenAI
`text-embedding-3-small` (1536-dim) in **pgvector** (ivfflat, cosine) for article de-dup
(reuse ≥ 0.70).

### Cloudflare (edge) — `apps/redirect`, `apps/white`

The **redirect** Worker (`go.<domain>`) is the cloaking engine: at launch the API writes a per-ad
redirect config to **Workers KV** (`CLOUDFLARE_*` / `CF_KV_NAMESPACE_ID`); the Worker reads it,
decides real-vs-bot, and routes to the money article or the **white** decoy Worker. Both deploy via
**Wrangler** (`pnpm --filter @knn/redirect deploy`), independently of the Docker stack. `apps/*/
wrangler.toml` hold the Worker config.

> The legacy Node redirect service was retired — `REDIRECT_DOMAIN` must point at the **Worker**, not
> the origin box, so a stray DNS/route flip can't silently serve unmonetized, param-less 302s.

---

## Background jobs (worker)

`apps/worker` (BullMQ over Redis) runs the asynchronous spine: Facebook stats/insights sync,
revenue attribution, the **channel-pool cron** (assign a channel at approval via
`FOR UPDATE SKIP LOCKED`), **FB ad launch**, the daily **token refresh**, **AdSense** revenue pulls,
**FX** rate updates, and scheduled **re-sync** of FB accounts/pages/pixels. Inspect queues live at
the API's **Bull-Board** (`/admin/queues`). When a company has auto-launch on, the worker calls the
API's internal launch endpoint (`INTERNAL_API_TOKEN` / `INTERNAL_API_URL`).

---

## Testing

- **Unit + integration:** `pnpm test` (Vitest). Integration tests hit **real Postgres/Redis** (no
  DB mocks) — `pnpm infra:up` first. `@knn/fb` tests stub `fetch` (no network/DB).
- **E2E (dashboard):** `pnpm --filter @knn/web e2e` (Playwright; `e2e:install` once for the browser).
- **Before pushing:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

---

## Deployment

Local dev runs on the Mac; **staging + production** run on a **Hetzner VPS**. One Docker image runs
the monorepo as separate service containers, fronted by **Caddy** (auto Let's Encrypt TLS), with
**Postgres + Redis on the box** and **Cloudflare** in front for DNS/CDN/WAF. The edge Workers
(`redirect`, `white`) deploy separately via Wrangler.

```
Cloudflare (DNS, proxy, WAF, Workers, KV)
        │
   Hetzner VPS ── Caddy :80/:443 (auto-TLS)
        │            ├── app.<domain>      → web :3003  (+ /api,/admin → api :3000)
        │            ├── articles.<domain> → article :3001
        ├── worker (BullMQ)   ├── postgres (pgvector)   └── redis
   go.<domain> → redirect Worker (edge) → money article | white Worker (edge)
```

### Primary path — deploy from your machine

The sanctioned flow is **`deploy/push-staging.sh`** (run locally). It mirrors the committed tree
(`git archive HEAD`) to the box with `rsync --delete` (so file removals propagate), then rebuilds
and recreates the containers. **Commit first** — it ships `HEAD`, not your working tree. Secrets
(`deploy/.env.staging`) and `backups/` on the box are preserved (excluded from `--delete`).

```bash
# full stack (+ Caddy):
SSH_KEY=~/.ssh/rsoc_staging_ed25519 deploy/push-staging.sh
# only specific services (faster):
SSH_KEY=~/.ssh/rsoc_staging_ed25519 deploy/push-staging.sh api worker
# preview what would change without touching the box:
DRY_RUN=1 deploy/push-staging.sh
```

Defaults: `DEPLOY_HOST=root@178.105.241.185`, `DEPLOY_DIR=/opt/rsoc` (override via env). The
`migrate` one-shot container applies migrations → `db:bootstrap` (RLS role) → `db:seed`, and the
apps wait for it. Deploy the edge Workers separately when they change:
`pnpm --filter @knn/redirect deploy` and `pnpm --filter @knn/white deploy`.

### First-time provisioning (on a fresh box)

See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for the full runbook:

```bash
ssh root@<box> 'bash -s' < deploy/provision.sh    # Docker + firewall (SSH/80/443 only)
# put the code on the box, then create deploy/.env.staging from the template (openssl rand -hex 32)
cd /opt/rsoc && bash deploy/deploy.sh             # build + migrate→bootstrap→seed + start
```

### Operations

```bash
C="docker compose -f deploy/docker-compose.staging.yml --env-file deploy/.env.staging --profile edge"
$C ps                 # status
$C logs -f api        # tail a service
$C exec api sh        # shell into a container
$C run --rm migrate   # re-run migrations/bootstrap/seed only
```

- **Caddyfile changes** don't reload reliably — `caddy validate` then `$C up -d --force-recreate
  caddy` (certs persist in the `knn_caddydata` volume).
- **Backups:** `deploy/backup.sh` (`pg_dump | gzip`); `deploy/install-backup-cron.sh` schedules it;
  `deploy/restore.sh` restores. **Never delete `backups/` on the box.**
- **Disk:** `push-staging.sh` caps the BuildKit cache (~15 GB) each deploy — unbounded cache once
  filled the disk and wedged the host.

---

## Environments

Three profiles selected by `APP_ENV`:

| Env | Stores | Facebook | AdSense |
|-----|--------|----------|---------|
| **local** | docker Postgres/Redis | unset (or your own test app) | placeholder slot |
| **staging** | on the Hetzner box | real FB **test** ad accounts | sandboxed / approved test domain |
| **production** | on the box | real ad accounts | live AFS |

> **Never test the Facebook integration in production.** Staging uses FB **test** ad accounts.

---

## Key decisions & footguns

Read [`docs/DECISIONS.md`](./docs/DECISIONS.md) for the full rationale. The traps that will bite you:

- **pgvector migration footgun:** Prisma can't see the `articles_embedding_idx` ivfflat index, so
  it adds `DROP INDEX` to **every** new migration. **Always** `prisma migrate dev --create-only`,
  delete the DROP line, then `db:deploy`. (Details in [`packages/db/CLAUDE.md`](./packages/db/CLAUDE.md).)
- **Migrations are immutable** once applied — never edit one in `prisma/migrations/`; add a new one.
- **RLS needs the `knn_app` role** — run `db:bootstrap` on any fresh DB or the app can't enforce
  isolation. App connects as `knn_app`; migrations connect as the owner.
- **Money is integer cents; never sum across currencies** — convert to USD first.
- **ESM `.js` import extensions** — relative imports must end in `.js` (resolves to `.ts`).
- **Env only via `@knn/config`** — never read `process.env` directly in an app.
- **The `article` app is revenue-critical and Google-crawled** — do not alter its monetization DOM
  casually; changes there can break AFS revenue or trip review.
- **`go.<domain>` is the Cloudflare Worker, not the box** — keep `REDIRECT_DOMAIN` on the Worker.
- **Ad creatives must stay on the `knn_uploads` volume** — they're written on upload and read at
  launch; a container recreate without the volume would lose them and 500 the launch.
- **FB multi-app / version split is intentional** — VERIFY at v25.0 + `config_id`, DATA at v21.0.
- **Deploy ships `HEAD`** — commit before `push-staging.sh`.

---

## Documentation map

| Doc | What's in it |
|-----|--------------|
| [`CLAUDE.md`](./CLAUDE.md) | Condensed architecture brief + conventions (start here after this README). |
| [`docs/CURRENT_STATE.md`](./docs/CURRENT_STATE.md) | Reverse-chronological status: what's done / in progress / next. |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | The decision log (D1–D16…) — the "why" behind the architecture. |
| [`docs/OPEN_QUESTIONS.md`](./docs/OPEN_QUESTIONS.md) | Known unknowns / pending items (the canonical backlog). |
| [`docs/DEPLOY.md`](./docs/DEPLOY.md) | Full deploy runbook (provisioning, operations, backups, hardening). |
| [`docs/APP_REVIEW.md`](./docs/APP_REVIEW.md) | Facebook App Review notes (permissions, the Advanced-Access path). |
| [`docs/OFFERS_DOMAINS_AFS.md`](./docs/OFFERS_DOMAINS_AFS.md) | Offers, domains, and AdSense AFS setup. |
| Each `apps/*/CLAUDE.md` and `packages/*/CLAUDE.md` | Per-module invariants and footguns — **read before editing that module.** |

---

## Security & secrets

- **Secrets are never committed.** `.gitignore` excludes `.env` and all `.env.*` (incl.
  `deploy/.env.staging`) but keeps `*.example` templates. Staging/prod secrets live only in
  `deploy/.env.staging` **on the box**.
- **Token encryption:** Facebook tokens are AES-256-GCM encrypted at rest with
  `TOKEN_ENCRYPTION_KEY` (64 hex). Don't log decrypted tokens; don't add a plaintext token column.
- **RLS + non-superuser role** enforce tenant isolation in the DB; only Caddy is exposed publicly
  (Postgres/Redis/app ports are not published).
- **Rotate** JWT secrets, DB passwords, the token-encryption key, and any API/app secret per
  environment — and immediately if one is ever exposed in chat, a screenshot, or a paste.
- **The SSH deploy key** (`~/.ssh/rsoc_staging_ed25519`) grants root on the box — treat it like a
  production credential.

---

## Onboarding a new developer

What a new dev needs to be productive:

1. **The code.** Clone the repo (or get a clean archive — see below). They do **not** need your
   secrets to boot the stack locally; `.env.example` defaults work.
2. **Tooling:** Node 22 (`nvm`), `corepack enable`, Docker/Colima.
3. **Run it:** follow [Local setup](#local-setup-quickstart) — `infra:up` → `db:generate` →
   `db:bootstrap` → `db:migrate` → `db:seed` → `dev`.
4. **Read order:** this README → `CLAUDE.md` → `docs/CURRENT_STATE.md` & `docs/DECISIONS.md` → the
   `CLAUDE.md` of whatever module they're touching.
5. **Real integrations (only when needed):** share Facebook/Google/AI/Cloudflare credentials
   **separately and securely** (a password manager or secrets vault) — never in the repo, a zip, or
   chat. Give them their **own** API keys / a test FB app where possible rather than sharing yours.

### Sharing this codebase

- **Preferred — a private Git repository** (GitHub/GitLab/Bitbucket). Push the code, then add the
  developer as a collaborator. This gives them history, branches, PRs, and a one-command way to pull
  every future change (`git pull`). Secrets stay out automatically — `.gitignore` excludes every
  `.env*` except the `*.example` templates.
- **One-off — a source archive.** `git archive HEAD -o knn-source.zip` (or zip the working tree with
  `git ls-files --cached --others --exclude-standard`) produces a tracked-files-only bundle that
  **already excludes** secrets, `node_modules`, and build output. Fine for a single handoff, but the
  dev won't get updates without you re-sending it.
- **Either way, secrets travel separately.** The repo/zip intentionally contains no real
  credentials. Send `deploy/.env.staging` values, the SSH deploy key, and the API/app secrets
  through a password manager or secrets vault — and prefer giving the dev their **own** keys and a
  **test** Facebook app over sharing production credentials. Rotate anything that has been exposed.
