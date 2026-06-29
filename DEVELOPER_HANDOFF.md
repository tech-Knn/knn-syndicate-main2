# Developer Handoff — KNN Syndicate

> **Start here.** This is the orientation for a developer taking over the project.
> Deep reference: [`README.md`](./README.md) (architecture, full setup, env, deploy) and
> [`CLAUDE.md`](./CLAUDE.md) (condensed architecture + conventions). Architectural rationale is in
> [`docs/DECISIONS.md`](./docs/DECISIONS.md); the status log in [`docs/CURRENT_STATE.md`](./docs/CURRENT_STATE.md);
> open items in [`docs/OPEN_QUESTIONS.md`](./docs/OPEN_QUESTIONS.md). Every `apps/*` and `packages/*`
> folder also has its own `CLAUDE.md` with invariants — **read it before editing that module.**

## What this is

A self-hosted, multi-tenant **search-arbitrage** platform: media buyers launch Facebook ads →
traffic is **cloaked** through an edge redirect → lands on **AI-generated, monetized article pages**
carrying a Google **AdSense for Search (AFS/RSOC)** unit → AFS revenue is **attributed back** to the
originating ad/campaign → buyers see **real-time ROI**. Monorepo: 6 apps, 7 packages (see README).

## Branch & repo state

- **Work on `main`** — it is now the source of truth (identical to `funnel-rsoc-quality-rpc`; the
  feature branch is kept as a mirror).
- All fixes are committed; **the build is green** (`pnpm typecheck`, `pnpm lint`, `pnpm build` all pass).
- **No secrets are in the repo** — only `*.example` templates are tracked. Real credentials are shared
  separately (see *Access you'll need*).

## Get it running (~5 min)

```bash
nvm use                  # Node 22 (.nvmrc); enable pnpm with: corepack enable
pnpm install
cp .env.example .env     # local dummy values boot the whole stack as-is
pnpm infra:up            # Postgres 16 (+pgvector) + Redis (Colima/Docker)
pnpm db:generate
pnpm db:bootstrap        # creates the non-superuser RLS role — REQUIRED
pnpm db:migrate          # apply all 35 migrations
pnpm db:seed             # platform settings + super admin
pnpm dev                 # all apps via Turborepo
```
API `:3000` (health `/health`, queues `/admin/queues`) · Article `:3001` · Dashboard `:3003`.
The edge Workers (`redirect`, `white`) run separately: `pnpm --filter @knn/redirect dev:worker`.

## Where things stand

- **Live:** staging on a Hetzner box (`178.105.241.185`, `/opt/rsoc`), fronted by **Caddy** (auto-TLS)
  + **Cloudflare** (DNS/WAF/Workers/KV). Apps deployed: `api`, `article`, `web`, `worker` (Docker);
  `redirect` + `white` are Cloudflare Workers (Wrangler).
- **Working:** the dashboard, Facebook + Google AdSense OAuth & sync, campaign launch to Facebook, the
  cloaking redirect (`go.*`, `kaid`-gated money-vs-white), per-ad revenue attribution wiring, and the
  funnel conversion beacons → Facebook CAPI.
- **NOT working — the #1 problem: RSOC ad revenue is `$0`.** Real ad clicks DO reach the money pages
  (verified ~190 in a week via the Cloaker stats), but Google serves **no AFS ads** → no ad clicks →
  `$0`. This is a Google-serving / setup issue, not a redirect or attribution bug. See P0 below.

## Top priorities (in order)

### P0 — Revenue (platform earns $0 until these are resolved)
1. **Google isn't serving AFS/RSOC ads on the article domains.** Most likely causes, in order:
   - **Domains not approved for AdSense for Search (RSOC).** Registering a domain *in the tool* does
     NOT register it with Google — confirm each article domain is approved/active for AFS on the
     account (`partner-pub-…`) with your AdSense/AFS partner. *(External gate — likely the main cause.)*
   - **`referrerAdCreative` is wrong.** `apps/api/src/modules/campaigns/launch.service.ts` sends
     `campaign.racValue` as the AFS `rc`, but that value is currently the **campaign name**, not the
     real Facebook ad creative text. Google requires the *exact* creative for source-controlled
     traffic and will suppress serving otherwise. Fix the RAC value per campaign (ideally derive it
     from the actual ad copy + warn when it equals the campaign name).
   - **Traffic quality.** Campaigns use the Facebook **ENGAGEMENT** objective → cheap, low-intent
     clicks Google won't monetize. Use a higher-intent objective for RSOC funnels.
2. **`/search` renders zero ads when the host has zero organic articles** (`maxAds = web-results
   count`). New/thin domains silently show no ad unit. `apps/article/app/search/search-ads.tsx`,
   `web-results.tsx`.
3. **Cloaker `enforce` mode drops ~13% of paid clicks** to the white page (missing `kaid={{ad.id}}`
   macro). Confirm the Facebook ad URL tags reliably stamp the macro, or run `observe` until proven.
   `apps/redirect/src/resolve.ts` + `apps/redirect/wrangler.toml` (`CLOAK_VERIFY_MODE`).

### P1 — Quality / policy
- `/search` "Web results" are not query-relevant (the fetch ignores `q`) — AFS quality/policy risk.
  `apps/article/app/search/web-results.tsx`.
- Per-domain `styleId` silently falls back to the global `NEXT_PUBLIC_AFS_STYLE_ID`; verify the style
  (and the channel id) belong to the domain's AFS account. `apps/article/app/_afs/site-config.ts`.

### P2 — Hardening
- Make Facebook launch resumable on partial creation; wire `pnpm db:bootstrap` into CI before tests;
  add Playwright E2E; reconcile the AFS channel cap vs the 1,500–2,000-campaign target. See
  `docs/OPEN_QUESTIONS.md`.

## Access you'll need (shared separately — never in the repo)

- **`deploy/.env.staging`** values (DB / JWT / `TOKEN_ENCRYPTION_KEY` / FB+Google secrets) — currently
  only on the box.
- **Hetzner box** SSH access + the deploy key (`~/.ssh/rsoc_staging_ed25519`).
- **Cloudflare** account (Workers + KV + DNS), **Google AdSense/AFS** account (`partner-pub-…`), and
  the **Facebook** apps (DATA / LAUNCH / VERIFY).
- Prefer giving the developer their **own** API keys and a **test** Facebook app over sharing prod.

## Deploy

- **Origin apps** (api/article/web/worker): `SSH_KEY=~/.ssh/rsoc_staging_ed25519 deploy/push-staging.sh
  <services>` — ships git `HEAD`, so commit first. Full runbook: [`docs/DEPLOY.md`](./docs/DEPLOY.md).
- **Edge Workers** (redirect/white): `pnpm --filter @knn/redirect deploy` (Wrangler).
