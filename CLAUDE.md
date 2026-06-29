# KNN Syndicate — Search Arbitrage Platform

Self-hosted search-arbitrage platform: media buyers launch Facebook ads → traffic is cloaked
through a redirect engine → lands on AI-generated monetized article pages with a Google AdSense
AFS (Custom Search) widget → AFS revenue is attributed back to the originating ad/campaign →
buyers see real-time ROI. Multi-tenant (companies), ~50–200 buyers, ~1500–2000 managed campaigns.

> Read `docs/CURRENT_STATE.md` first each session (what's done / in progress / next).
> Architectural decisions live in `docs/DECISIONS.md`. Unknowns in `docs/OPEN_QUESTIONS.md`.

## Architecture (key decisions — see DECISIONS.md for the why)

- **Monorepo**: pnpm workspaces + Turborepo. Apps: `api` (Fastify), `redirect` (Hono on a
  **Cloudflare Worker**, `go.*`), `article` (Next 15 SSR), `white` (Cloudflare Worker — the safe
  decoy site), `web` (Next 15 dashboard/admin), `worker` (BullMQ). Packages: `db` (Prisma),
  `shared`, `config`, `queue`, `fb`, `adsense`, `ai`.
- **Framework split (D3)**: Fastify for the main API (Node — the Facebook/Google SDK paths aren't
  edge-compatible). The latency-critical (<50ms) public redirect (`go.*`) and the white decoy run as
  **Cloudflare Workers** (Hono) at the edge, reading per-ad config from Workers KV; deployed via
  `wrangler`, separate from the origin Docker stack (api/article/web/worker).
- **Multi-tenant by company (D1/D2)**: roles `SUPER_ADMIN` (KNN platform), `COMPANY_ADMIN`
  (one org), `MEDIA_BUYER` (one org). Isolation via **Postgres RLS + a service-layer tenant
  guard**; every business row carries `org_id`.
- **Campaign = the "offer" (D5/D6/D7)**: keywords, RAC, the (single) article, and the AdSense
  channel all live at **campaign** level. Ads are creative variations.
- **Per-ad redirect + conversion-weighted revenue (D8/D9)**: each ad has its own `redirect_id`.
  AdSense revenue is per channel = per campaign; it's split across the campaign's ads in
  proportion to each ad's FB pixel conversions (largest-remainder, sums exactly). See
  `packages/shared/src/money.ts#allocateByWeights`.
- **Time (D4)**: store UTC (`timestamptz`); the business day (channel rollover, daily revenue
  buckets) is the **IST** calendar day. Helpers in `packages/shared/src/datetime.ts`.
- **Channel pool (D11)**: 1 channel ↔ 1 campaign, assigned at approval via
  `SELECT … FOR UPDATE SKIP LOCKED` in a txn (single-writer worker). Stress-tested at 100
  concurrent approvals → zero double-assignment.
- **Facebook (D12/D13/D14)**: BUC rate limits are per ad account → per-account request queue +
  backoff + circuit breaker (the `BATCHED` state). Token breaks (err 190 subcodes) →
  `CONNECTION_BROKEN`, notify + reconnect, stop polling. Ad disapproval = poll `effective_status`
  every 30 min (no reliable webhook).
- **AI (D16)**: articles + compliance via Claude; embeddings via OpenAI `text-embedding-3-small`
  (1536-dim) in pgvector (ivfflat, cosine, reuse ≥0.70).

## Layout

```
apps/{api,redirect,article,white,web,worker}   packages/{db,shared,config,queue,fb,adsense,ai}
infra/docker-compose.yml                  docs/{DECISIONS,CURRENT_STATE,OPEN_QUESTIONS}.md
```

Internal packages export TS source directly (`exports → ./src/index.ts`); consumers compile them
(tsx in dev, tsup/Next bundle for prod). Don't add per-package build steps for libraries.

## Commands

- `pnpm infra:up` / `infra:down` — local Postgres 16 (+pgvector) + Redis via docker-compose
  (Colima provides Docker on this Mac).
- `pnpm db:migrate` / `db:generate` / `db:seed` / `db:studio` — Prisma (loads root `.env`).
- `pnpm dev` — all apps (Turborepo). `pnpm --filter @knn/api dev` for one.
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` — run across the monorepo.
- API health: `GET :3000/health`. Bull-Board: `:3000/admin/queues` (basic auth, see `.env`).

## Conventions

- TypeScript ESM everywhere, `strict` + `noUncheckedIndexedAccess`. Relative imports use the
  `.js` extension (resolves to `.ts`).
- Env is validated centrally in `@knn/config` (zod) — never read `process.env` directly in apps.
- Money is handled in integer cents; never sum across native currencies (convert to USD).
- Integration tests hit **real** Postgres/Redis (no DB mocks). Each phase has a test gate.
- Three environments: `local` / `staging` (real FB **test** ad accounts) / `production`. Never
  test FB integration in production.
