# Architecture Decisions Log

Append-only. Newest at the bottom. Each entry: date, decision, why, and (if relevant) what it
supersedes. This is the project's architectural memory.

---

### 2026-05-27 — Foundational decisions (D1–D18, from the planning session)

These resolve contradictions in the v1.2 spec and the advisor's review. Captured verbatim from
the approved plan.

- **D1 — Multi-tenant by company.** `organizations` entity; roles `SUPER_ADMIN` (KNN platform),
  `COMPANY_ADMIN` (one org), `MEDIA_BUYER` (one org). _Why:_ "Super Admin = us, Admin = company-
  wise"; isolation between client companies.
- **D2 — Tenant isolation = Postgres RLS + service-layer tenant guard.** Every business table has
  `org_id`. _Why:_ defense in depth; a missed `WHERE org_id=` can't leak across tenants.
- **D3 — Fastify (API) + Hono (redirect engine); drop Express.** _Why:_ FB/Google SDKs are
  Node-only + VPS deploy ⇒ Hono's edge advantage is moot for the API; Fastify has mature
  first-party multipart/rate-limit/JWT/pino. The thin <50ms redirect hot path is where Hono fits.
- **D4 — Store UTC; business day = IST (Asia/Kolkata).** Channel lock/release + daily revenue
  buckets compute on the IST calendar day; FB spend folded into the IST day at aggregation.
  _Why:_ AdSense AFS reporting + channel rollover are IST-anchored; UTC storage is standard.
- **D5 — Keywords + RAC live on the CAMPAIGN.** _Why:_ user decision; campaign = the "offer."
  _Supersedes:_ spec's contradictory per-ad/per-campaign split and the advisor's "RAC is per-ad."
- **D6 — One article per campaign** (matched-or-generated from the campaign's keywords/RAC),
  shared by all its ads. _Why:_ follows D5; ads are creative variations. _Supersedes:_ spec
  §5.3.3 "each ad gets its own article."
- **D7 — One channel per campaign.** AdSense AFS revenue is attributed per channel = per campaign.
  _Why:_ user decision; matches spec §5.6.2 ("assign a channel to the campaign").
- **D8 — Revenue allocated to ads by conversion share:**
  `ad_revenue = campaign_revenue × (ad_conversions / Σ campaign_ad_conversions)`, where
  `ad_conversions` = FB pixel conversions per ad. _Why:_ user's worked example ($50→1 conv = $50;
  $50→4 conv = $12.50 each). Implemented in `@knn/shared` `allocateByWeights` (largest-remainder).
- **D9 — Redirect URL is per-ad** (`redirect_id` unique per ad), resolving to its campaign for the
  shared `ch`/`q`/`rac`/article. _Why:_ FB needs a distinct destination per ad to track per-ad
  clicks/conversions (the D8 signal).
- **D10 — `pxe` (pixel conversion event) is user-selectable, default `search`.** _Why:_ it's the
  conversion signal that drives D8.
  _Revised 2026-05-27:_ the **pixel + conversion event live at the AD-SET level**, matching
  Facebook's real structure (one ad set optimizes for one pixel/event; the whole ad set targets one
  audience). Facebook still reports conversions **per ad**, so the conversion-weighted revenue split
  (D8) is unaffected. Ad-set also owns audience (countries/age/gender), placements, and budget
  (ABO per-ad-set or CBO campaign-level); the ad keeps only creative + its unique `redirect_id` (D9).
- **D11 — Channel race condition** solved with `SELECT … FOR UPDATE SKIP LOCKED` in a txn
  (single-writer worker). Ship a 100-concurrent-approval stress test. _Why:_ spec was silent.
- **D12 — FB rate limits = BUC per ad account** (`ads_management` ≈ `300 + 40×active_ads`/hr
  standard), not "200/hr/user." Per-account queue + backoff (codes 17/4/613/80004) + circuit
  breaker = the `BATCHED` state. The official SDK does NO backoff. _Why:_ verified vs Meta docs.
- **D13 — FB token failures** → `CONNECTION_BROKEN` on err 190 (subcodes 458/459/460/463/466/467):
  email + in-app notify with one-click reconnect, stop polling/launches, proactive re-auth ~day
  55. Long-lived user tokens ~60d. Consider Business-Manager system-user/partner tokens later.
- **D14 — FB ad-disapproval = poll** `effective_status`/`ad_review_feedback` every 30 min, +
  optional `with_issues_ad_objects` webhook as a low-latency trigger. _Why:_ verified — Meta has
  NO dedicated "DISAPPROVED" webhook; the spec's polling is correct.
- **D15 — Multi-currency:** store native amount + a daily-converted USD field; display everything
  in USD; never sum native currencies. _Why:_ user note.
- **D16 — AI:** article generation + compliance via Claude; embeddings via OpenAI
  `text-embedding-3-small` (1536-dim) in pgvector (ivfflat, cosine). Store raw + compliant
  versions. _Why:_ Anthropic has no first-party embeddings; spec specified OpenAI embeddings.
- **D17 — Objective default = `OUTCOME_SALES`**, optimization `OFFSITE_CONVERSIONS`. _Why:_
  resolves spec §5.3.1 vs §5.3.2; search-arb optimizes for offsite conversions.
- **D18 — Bull-Board** (admin-only) from day 1; **3 environments** local / staging (real FB test
  ad accounts + sandboxed AdSense) / prod. _Why:_ user notes; never test FB in prod.

### 2026-05-27 — Phase 0 implementation choices

- **Local Docker via Colima** (no Docker Desktop on the machine). Same `infra/docker-compose.yml`
  is used everywhere (pgvector/pgvector:pg16 + redis:7).
- **Node**: runtime is 25 on this machine; `.nvmrc` pins 22 LTS and `engines` is `>=20`. Watch for
  Node-25-specific tooling quirks.
- **Internal packages export TS source** (`exports → ./src/index.ts`); apps bundle them (tsup
  `noExternal:[/^@knn\//]`, Next `transpilePackages`). No build step for libraries.
- **pgvector confirmed 0.8.2** available in the pg16 image.

### 2026-05-27 — Staging/prod deploy on Hetzner (Docker Compose + Caddy)

- **Deploy = one Docker image for the whole monorepo**, run as separate service
  containers (api/redirect/worker/web/article) via `deploy/docker-compose.staging.yml`,
  fronted by **Caddy** (automatic Let's Encrypt TLS) for the three domains, with
  Postgres + Redis on the box and **Cloudflare** in front. _Why:_ extends our local
  docker-compose, far less error-prone than hand-rolled Nginx+PM2+certbot for a pnpm
  monorepo, and reproducible. Supersedes the spec's §11 Nginx+PM2 sketch. Runbook in
  `docs/DEPLOY.md`. Staging is provisioned ~Phase 2 (Facebook needs public HTTPS URLs);
  see memory `deploy-workflow`.
- A one-shot `migrate` container runs `db:deploy` + `db:bootstrap` (creates the RLS
  `knn_app` role) + `db:seed` before apps start. Only Caddy is exposed (80/443).
- Image is staging-grade (full monorepo + deps for reliability); prod slimming
  (multi-stage prune, Next standalone, non-root) is a Phase 11 TODO.

### 2026-05-27 — Phase 4 (Approval system)

- **Campaign state machine is one source of truth** in `@knn/shared/campaign-status.ts`
  (`CAMPAIGN_TRANSITIONS` + `canTransitionCampaign`). Every status change (api + worker, all
  phases) validates against it, so no path can make an illegal transition. The graph is
  intentionally complete now (covers later-phase states PROCESSING/BATCHED/QUEUED_NO_CHANNEL/
  LAUNCHING/ACTIVE/META_REJECTED); phases attach routes/jobs to edges as they're built. ARCHIVED
  is the only terminal state; PENDING_APPROVAL is *not* directly archivable (must be resolved via
  approve/reject/withdraw so a rejection always carries a reason).
- **Approval modes per company (org-level toggle `organizations.auto_approve`).** Manual review is
  the default; auto-approve flips a submission straight to APPROVED. Auto-approve is modeled as
  _submit + immediate system approval_ (both edges DRAFT→PENDING_APPROVAL and PENDING_APPROVAL→
  APPROVED are valid) so the graph needs no synthetic DRAFT→APPROVED edge; the auto-approved row
  has `reviewedById = null` (system) + `reviewedAt` set. SUPER_ADMIN can toggle any org;
  COMPANY_ADMIN only their own.
- **Reject requires a reason** (`campaigns.rejection_reason`, shown to the buyer). Approve/reject
  record `reviewedById`/`reviewedAt`. A buyer can **reopen** (PENDING_APPROVAL→DRAFT = withdraw,
  REJECTED→DRAFT = revise) to edit + resubmit; reopen clears the review trail.
- **`audit_log` gets its first writers** (`apps/api/src/lib/audit.ts#writeAudit`, written inside the
  same txn as the change): `campaign.{submitted,approved,rejected,auto_approved,reopened}`,
  `org.{created,auto_approve.enabled,auto_approve.disabled}`, `user.{approve,reject,suspend,
  reactivate}`. Reject entries carry `{reason}` in `details`. RLS applies — under `withTenant` the
  audit row's `org_id` must equal the active org; super-admin writes via `withSystem`.

### 2026-05-27 — Phase 5 (Article engine + frontend)

- **`@knn/ai` uses `fetch`, not the vendor SDKs** (same call as `@knn/fb`): light deps + trivially
  mockable via `vi.stubGlobal('fetch')`. Embeddings = OpenAI `text-embedding-3-small` (1536-d);
  articles + compliance = Claude Messages. Keys are **optional** — missing → `AiNotConfiguredError`
  so the app degrades instead of crashing; live generation is an external dep (like FB connect).
- **Article reuse is tenant-scoped.** The cosine search + create run in `withTenant(campaign.orgId)`
  (not `runScoped`/`withSystem`), so an org never reuses another tenant's generated article, even for
  a SUPER_ADMIN-triggered generation. Reuse threshold = cosine ≥ 0.70 (`ARTICLE_SIMILARITY_THRESHOLD`).
- **pgvector via raw SQL.** The `embedding vector(1536)` column is `Unsupported(...)` in Prisma, so the
  embedding is written with `$executeRawUnsafe (… = $1::vector)` and the nearest-neighbour search uses
  `embedding <=> $1::vector` (cosine distance; similarity = 1 − distance) — both inside the tenant txn
  (RLS-scoped). Vector literals are built from finite-validated numbers (no injection). ivfflat index.
- **Store raw + compliant; serve compliant only.** Both versions persist for audit (D16); the public
  read (`getPublicArticleBySlug`) and the frontend expose only `compliantContent`.
- **The article frontend is API-backed, not DB-backed.** `apps/article` fetches `GET /api/public/
  articles/:slug` instead of importing `@knn/db` — keeps `@knn/config`'s eager env validation out of the
  Next build (build-safe) and matches the web app's "talk to the API" pattern. SSR needs `ARTICLE_API_BASE`
  (the API origin) since `articles.<domain>` is a different origin than `app.<domain>`.
- **First-paragraph teaser rule** (`@knn/shared#articleTeaser`): first paragraph, capped at ≤100 words
  AND ≤300 chars on a word boundary (spec §5.5).

### 2026-05-28 — AFS/RSOC is the two-page model (matched to the AdSense-generated code)

- The monetization is **RSOC (Related Search on Content)** via Google CSA, and it is a **two-page
  flow** (confirmed against the account's generated code, style "Ajeet" `7465600436`):
  1. **Content page** = our article (`articles.<approved-domain>/a/<slug>`) renders a
     `_googCsa('relatedsearch', { relatedSearchTargeting:'content', resultsPageBaseUrl, … }, {container:'relatedsearches1', relatedSearches:10})`
     unit — *search terms*, not ads. Terms appear only after Google crawls the URL (~1h).
  2. **Results page** = `/search?query=<term>` renders
     `_googCsa('ads', { pubId, query, styleId, adsafe:'high', … }, {container:'afscontainer1'}, {container:'relatedsearches1', …})`
     — this is where the **ads + revenue** are. Both pages live on the Google-approved domain.
- **`pubId` is `partner-pub-…`** (the AdSense **generated code** is authoritative; the help-center
  wording "the part after partner-" is misleading). Always use the account's generated snippet.
- **`referrerAdCreative` is mandatory** (since 2025-11-01) because our traffic comes from a source we
  control (FB ads) — plumbed via the `rc` URL param (redirect will pass the originating ad creative).
- AFS only serves on Google-**approved** domains; `pubId`/`styleId`/`adtest` are `NEXT_PUBLIC_*` →
  baked into the article build (deploy build args). `adtest=on` for safe validation (no impressions/
  clicks/revenue, avoids self-click policy issues); **never** `on` in production. Loader +
  page-options live in `apps/article/app/_afs/csa.ts`. AdSense access is account-manager-gated and
  has a usage floor (>20 search-ad impressions in ≥2 of 6 months) — OPEN_QUESTIONS #4.

### 2026-05-28 — Phase 6 (Channel pool & assignment, D7/D11)

- **Channels are a GLOBAL platform pool** (`channels` table, no `org_id`, no RLS — like
  `platform_settings`); one channel ↔ one campaign while assigned. The per-campaign attribution span
  (`channel_assignments`) + the FIFO wait queue (`campaign_queue`) ARE org-scoped (RLS). The
  assignment worker runs under `withSystem`. `campaign.channelId` = the Channel **row id** (uuid),
  not the AdSense channel string (join for the `ch` value).
- **Assignment = `FOR UPDATE SKIP LOCKED`** (`apps/worker/src/channel-pool/channel.service.ts#assignChannel`):
  claims one `AVAILABLE` channel per txn; concurrent claims skip each other → **zero double-assignment**
  (proven by a 100-concurrent stress test). Pool exhausted → enqueue + `QUEUED_NO_CHANNEL`.
- **Single-writer worker** processes `CHANNEL_MAINTENANCE` jobs (`assign`/`release`/`rollover`/
  `process-queue`, concurrency 1); the API enqueues `assign` on approve / auto-approve (best-effort).
  `processQueue` drains the FIFO queue into freed channels; `releaseChannelForCampaign` frees + re-drives.
- **IST midnight rollover** (00:05 IST cron → `rollover` job, D4): release channels from non-holding
  campaigns (holding = PROCESSING/LAUNCHING/ACTIVE/BATCHED), renew still-active locks (close the prior
  `channel_assignment` span, open today's — per-day attribution for Phase 9), then drain the queue.
- **Pool provisioning**: `packages/db/scripts/seed-channels.ts` (`CHANNEL_POOL_SEED`, target 2000).
  Placeholder ids today; real AdSense **custom-channel** ids are the operational input (OPEN_QUESTIONS #4).

### 2026-05-28 — Phase 7 redirect runs at the EDGE (Cloudflare Workers + KV), refining D3

- **Decision:** deploy the redirect as a **Hono Cloudflare Worker** (not on the single Hetzner origin).
  Research (RSOC best practice + edge-latency benchmarks): a single region can't hit <50ms for a
  global FB audience (90–250ms RTT for far users); Workers serve from 300+ PoPs at ~8–25ms. Hono is
  the edge-native standard (Express→Hono-on-Workers measured p50 4ms). This is D3's "move to edge
  later" brought forward — Hono code ports unchanged.
- **Data:** per-ad configs in **Workers KV** (`redirect:{redirectId}`), write-through-synced from the
  origin (Postgres = source of truth) on launch/update; KV reads are 1–5ms globally and eventually
  consistent (fine — configs rarely change). Hot path = one KV read + the pure `resolveRedirect`, no
  origin round-trip. Workers can't open Postgres/Redis TCP — hence KV.
- **Code:** `apps/redirect/src/resolve.ts` (pure, runtime-agnostic: paid-vs-organic detection via
  `fbclid`/`utm_source`, AFS param build `rc`/`ch`/`rac`/`styleId`/`txid`, weighted traffic split,
  fallback) + `worker.ts`/`wrangler.toml`. The legacy Node service is transitional (retire once the
  Worker is live on `go.*`). LIVE on `go.10linesabout.com` (~20–25ms; benchmarked).

### 2026-05-28 — Phase 8 (FB launch pipeline + meta-rejection, D12/D14)

- **`launchCampaign` (`apps/api/.../launch.service.ts`)** orchestrates an approved+channel'd campaign
  live: ensure article (Phase 5) → write each ad's redirect config to edge KV (Phase 7, `lib/kv-sync.ts`)
  → create Campaign→AdSet→Ad on FB **ACTIVE** via the rate-limited client (D12) → ACTIVE + notify +
  audit `campaign.launched`. FB rate-limit → **BATCHED** (retry); idempotent (already-launched → ACTIVE);
  refuses launch without a channel. The proven write-path is refactored into `resolveLaunchPlan` /
  `createFbStructure(status)` / `persistFbIds`, shared by `testLaunchCampaign` (PAUSED) — folds in the
  task-#14 stopgap. Route `POST /api/campaigns/:id/launch` (admin).
- **KV sync** is best-effort on unconfigured CF (`KvNotConfiguredError` → warn + continue; the redirect
  falls back until synced); real KV errors fail the launch (clicks would otherwise miss the funnel).
- **Meta-rejection (D14):** no reliable FB webhook → `checkMetaRejections` polls `effective_status`
  every 30 min (worker cron + `META_REJECTION_CHECK` queue); a DISAPPROVED ad → META_REJECTED +
  release the channel back to the pool + notify.
- **Gate met (mocked FB):** launch ACTIVE/BATCHED/idempotent + rejection→status+notify+channel-release.
  **Live validation pending external deps:** a CF API token (Workers KV Edit) for the live KV sync,
  an FB **test** ad account (D18), and AI keys for live article generation.

### 2026-05-28 — D19: Auto-launch is a per-company toggle (default manual gate)

- **Decision:** approval and *launch* are separate gates. `Organization.autoLaunch` (default **false**)
  mirrors `autoApprove`. With it OFF (the safe default for an ad-spend platform), an approved campaign
  acquires a channel and sits at **PROCESSING** until an admin clicks launch (`POST /api/campaigns/:id/launch`).
  With it ON, launch fires automatically the instant a channel is assigned — no human in the loop.
- **Trigger wiring (worker):** `triggerAutoLaunch(campaignId)` runs on **every** path that hands a campaign
  a channel — the direct `assign` handler, plus queue-drain and midnight-rollover via an `onAssigned`
  callback threaded through `processQueue`/`releaseChannelForCampaign`/`rolloverChannels`. It gates on
  `org.autoLaunch && channelId && !fbCampaignId` and enqueues `FB_LAUNCH`.
- **Why HTTP, not a direct call:** the launch must run on the **API** process (it owns the FB client and
  the creative files on local disk), so the `FB_LAUNCH` worker POSTs the token-guarded
  `POST /api/internal/launch/:id` (`x-internal-token` === `INTERNAL_API_TOKEN`); the endpoint loads the
  campaign as its buyer and calls the same `launchCampaign`. Needs `INTERNAL_API_TOKEN` +
  `INTERNAL_API_URL` in deployed envs.
- **Safety:** `FB_LAUNCH` is **`attempts:1`** — `launchCampaign` is only idempotent on *full* success
  (`fbCampaignId`), so a partial FB failure must not auto-retry (would double-create). Rate-limits aren't
  job failures (the API parks the campaign in BATCHED, a 200). A truly failed launch lands in Bull-Board
  for a manual retry. Resumable partial-failure launch is a Phase 11 hardening follow-up (OPEN_QUESTIONS #10).
- **UX:** the auto-launch switch sits beside auto-approve on the Approvals page (company-admin only);
  approval/auto-approval notifications now say "will launch automatically" vs "ready to launch" per the mode.

### 2026-05-28 — Phase 9 (stats & revenue aggregation, D8/D15)

- **Four new tables (all IST-day keyed, D4):** `fx_rates` (global, no RLS — daily USD-per-unit rate),
  `ad_stats_daily` (per-ad FB insights: impressions/clicks/conversions + native & USD spend),
  `campaign_revenue_daily` (per-campaign gross AFS revenue, native & USD, `afs_clicks`, `suppressed`),
  `ad_revenue_daily` (the derived per-ad split: allocated/visible/margin + `basis`). The three per-org
  tables get the standard `tenant_isolation` RLS policy; the worker writes them under `withSystem`.
- **Storage is DAILY, deviating from the plan's `ad_stats_hourly`.** Attribution + AFS reporting are
  daily and FB's hourly breakdown is timezone-fragile; the cron PULLS hourly to keep "today" fresh.
  FB day buckets use the ad-account reporting tz (= IST for IST accounts; OPEN_QUESTIONS #14).
- **Allocation (D8 + OPEN_QUESTIONS #1)**: `allocateCampaignRevenue` (`@knn/shared/money.ts`) splits a
  campaign's gross USD across its ads by conversion share (largest-remainder, exact-sum), falling back
  conversions → clicks → impressions → `unallocated` (held at the campaign level). Then `applyRevenueCut`
  (buyer `revenueCutPct` ?? org `defaultRevenueCutPct`) → buyer-visible + platform margin.
- **Multi-currency (D15)**: native minor units + a USD field via `fx_rates`; `toUsdMinor` converts;
  `getUsdRate` falls back to the most-recent rate then 1.0. Never sum across native currencies.
- **AFS source (`@knn/adsense`) is built + tested but DORMANT** (AFS access + Google OAuth token are
  external, OPEN_QUESTIONS #4/#13). Attribution consumes an **injected** `fetchAdsense` (undefined by
  default → cleanly no-ops); FB insights (`@knn/fb/insights.ts`) run live through the rate limiter (D12).
- **Idempotent finalization (§5.8)**: every write is an upsert keyed on (entity, day); the `ATTRIBUTION`
  queue runs `hourly` (today) + `finalize` (re-pull trailing FB `FB_REPULL_DAYS` / AdSense
  `ADSENSE_REPULL_DAYS` windows). Re-runs never double-count — proven in `attribution.test.ts`.
- **Gate met:** attribution math (worked examples + zero-conversion fallback), currency conversion,
  revenue-cut (buyer override), AFS `<10` suppression, and finalization re-pull idempotency — all green
  against real Postgres (`apps/worker/src/attribution/attribution.test.ts`, 10 tests; `money.test.ts` 20).

### 2026-05-28 — Article generation moves to OpenAI (amends D16)

- **Decision:** generate the monetized articles with **OpenAI `gpt-4.1-mini`** (env
  `OPENAI_ARTICLE_MODEL`), not Claude. These search-arb articles are short + formulaic, so a mini model
  matches the competitor output at ≈⅓¢/article (nano is ~1/12¢ if you want to A/B it). Cost isn't the
  constraint — quality-per-dollar is, and mini wins here. Embeddings already use OpenAI (unchanged).
  Reverse-engineered from live competitors (creatorrule.com / goodprojectideas.com).
- **Structured JSON output** (`generateArticleOpenAI`, response_format json_object):
  `{title, teaser, body_markdown, related_search_terms}`. The body follows the competitor skeleton —
  *Define → Benefits → Concrete details (numbers) → Steps → 3-Q FAQ*, 8th-grade, ## headings + lists.
- **The high-CPC monetization is `related_search_terms`**, not keyword-stuffed prose: 6 high-commercial-
  intent search queries the model emits per topic → stored on `articles.related_search_terms` → fed to
  the content-page CSA `terms` (preferred over campaign keywords). Pick a high-RPM vertical (insurance/
  auto/finance/medical/senior) as the topic; the article is just on-topic context for Google's
  content-targeting.
- **Rendering:** `@knn/shared#articleBlocks` parses the markdown into safe React blocks (h2/h3/p/ul/ol —
  no `dangerouslySetInnerHTML`); the opening paragraph is the lead above the AFS unit, sections below.
- **Compliance:** `complianceRewriteOpenAI` runs only when an admin `compliance_prompt` is set
  (skipped otherwise — saves a call); raw + compliant are still both stored (audit). Claude variants
  remain in `@knn/ai` but are no longer the default.
