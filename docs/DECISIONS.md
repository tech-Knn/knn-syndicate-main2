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

### 2026-05-28 — D20: Conversion tracking via inferred AFS click → Facebook CAPI S2S

- **Why it's hard:** the final ads on `/search` render inside a **cross-origin** Google iframe
  (`syndicatedsearch.goog`), so we cannot observe the monetizing click directly (no DOM access, no
  callback). This is the single conversion signal we send back to Facebook to optimize the ads.
- **Detection (matches the production AFS/ClickFlare technique):** a client `message` listener on
  `/search` treats it as a final-ad click when **all** hold — `event.origin` starts with
  `https://syndicatedsearch.goog`, `document.activeElement.tagName === 'IFRAME'` (the ad iframe stole
  focus), and we haven't already fired this session (`sessionStorage knn_conv_fired`). Best-effort, once
  per session; `sessionStorage` failures degrade open (still fire). Lives in
  `apps/article/app/search/conversion-tracker.tsx`; inert unless `NEXT_PUBLIC_EVENTS_URL` is set.
- **The join key is the click id (`txid`), not a cookie.** The edge redirect Worker already mints `txid`
  per paid click; it now also writes `click:{txid}` → `{redirectId, fbclid, ts}` to Workers KV
  (`waitUntil`, 7-day TTL) only when the click is **paid and the redirect is active**. `txid` threads
  redirect → `/a/[slug]` (RelatedSearchUnit) → `/search` → the beacon. This is what makes pixel+token
  resolution deterministic and multi-tenant-safe.
- **Beacon → API:** the detector `navigator.sendBeacon`s the public `POST /api/events?click_id=…&value=…
  &currency=…&url=…` (query-param style, since `sendBeacon` can't set JSON headers; `fetch keepalive`
  fallback). The route is **public** (no auth — it's a browser beacon), captures `client_ip`/`user_agent`
  server-side, and **always 204s** (a beacon must never surface errors to the page).
- **Resolution (server, `events.service.ts`):** `click_id` → KV `readClick` → `redirectId` → `Ad`
  (→ `orgId`, `AdSet.pixelId` + `pxeEvent`, `Campaign.id`). Unknown click → recorded-false no-op.
  We persist a `ConversionEvent` (org-scoped, RLS; `clickId @unique` = idempotent ingest) with `status`
  **`pending`** when a pixel is resolved, else **`skipped`** (no pixel on the ad set → nothing to fire).
- **Firing is async + retried (worker, not the request path):** a `pending` event enqueues
  `CAPI_DISPATCH` (`jobId capi:{id}`, `attempts:5`, exp backoff). `dispatchConversion` resolves the
  **fresh** buyer token at send time (campaign.buyer → `FbConnection`, decrypted) — *not* frozen at
  ingest, so a rotated token is used — and POSTs Facebook CAPI (`@knn/fb/capi.ts`,
  `/{pixelId}/events`). `event_id = clickId` (Facebook dedupes against the in-browser pixel if any);
  `event_name` from the ad's `pxe` (`search→Search`, `lander→ViewContent`, `adclick→Lead`);
  `user_data.fbc = fb.1.{clickMs}.{fbclid}` + ip + ua; `custom_data = {value, currency}`.
- **Error policy:** broken connection (err 190) or missing pixel → **terminal `failed`** (no retry —
  retrying can't fix it). Rate-limit / transient → rethrow so **BullMQ retries** with backoff;
  `status` stays `pending`. Already-`sent` → no-op (`skipped`). Mirrors the launch pipeline's D12/D13 stance.
- **Pixel frozen at ingest, token resolved at send (deliberate split):** the *pixel* is the ad set's
  promoted-object pixel captured on the `ConversionEvent`; the *token* is looked up fresh in the worker.
  Pixels don't rotate; tokens do (60-day churn, D13) — so freeze the stable one, resolve the volatile one late.

### 2026-05-28 — D21: Dashboards extend the bespoke CSS-module design system (not Tailwind/shadcn)

- **Decision:** build the Phase 10 dashboards on the **existing hand-crafted design system** (`apps/web`
  CSS-modules + the `ui.tsx` primitives, driven by the KNN brand tokens in `globals.css`) rather than
  introduce **Tailwind v4 + shadcn/ui** as the original plan named. Charts are **hand-rolled SVG**
  (`components/charts.tsx`) and data-fetching is plain typed hooks over the existing `lib/api.ts`
  client (no TanStack Query/Table, no Recharts).
- **Why (deviation from the plan's named stack):** every shipped surface (login, FB connect, campaign
  wizard, approvals) is already CSS-modules with the exact brand tokens (rust/gold/cream, serif display,
  mono metrics) and hits the Stripe/Linear polish bar. Bolting on Tailwind+shadcn would create two
  parallel styling systems, a large refactor, and regression risk on shipped pages — for no visual gain
  on a *bespoke* dark theme we already control. Zero new heavy runtime deps keeps the buyer dashboard
  lean (the `/dashboard` route is ~5 kB of page JS). The plan's stack was a suggestion; the *goal* was
  density + motion + polish in the KNN theme, which the bespoke kit meets.
- **What this adds to the kit:** `StatTile` (KPI), `Segmented` (range control), `Skeleton` (loading), and
  `charts.tsx` (`RevenueChart` — dual-area revenue-vs-spend with a hover guide/tooltip; `Sparkline`).
- **The dashboard data layer is the role-scoped `/api/stats` (D-10a)** — the same Overview serves all
  three roles because the API scopes by actor (buyer→own, company-admin→org via RLS, super→platform).
- **Revisit if** a third-party-heavy surface (e.g. a complex pivot table) ever needs TanStack Table, or
  the design system is opened to non-KNN white-label themes — then shadcn's theming may earn its keep.

### 2026-05-28 — D22: AdSense (Google) connect is a platform singleton; live source is dormant-by-default

- **Decision:** unlike Facebook (one connection **per buyer**, their own ad accounts), AdSense is a
  **single platform account** (the funnel's AFS-approved domain), so `GoogleConnection` is a **global
  singleton** (`id = 'platform'`, no org scope / no RLS — like `channels` & `platform_settings`); a
  **SUPER_ADMIN** connects it. Tokens are AES-256-GCM encrypted (same `TOKEN_ENCRYPTION_KEY` as FB).
- **OAuth:** Google OAuth 2.0 with `access_type=offline` + `prompt=consent` → a **refresh token** (access
  tokens last ~1h). Read-only scope (`adsense.readonly`). `@knn/adsense` adds `buildGoogleAuthUrl`/
  `exchangeGoogleCode`/`refreshGoogleToken` (mirrors `@knn/fb/oauth`) + Management API v2 account/
  ad-client/custom-channel listing. The connect flow lives in `apps/api/.../adsense` (signed state,
  public callback); a super-admin **Connect AdSense** card sits on the Platform page.
- **Channel sync:** `POST /api/adsense/sync` lists the publisher's **AFS** custom channels and upserts
  them into the pool (`channelId` = the channel resource's trailing numeric segment; label only — never
  clobbers a channel's status / current campaign). This is how the placeholder pool gets real ids.
- **Live revenue source is the default, but self-dormant:** the worker's `AttributionDeps.fetchAdsense`
  is now `liveAdsenseFetch` (reads the connection, refreshes the token, pulls the report). It returns `[]`
  when not connected / no account / broken, and logs+swallows a failed report — so it **auto-activates**
  the moment AdSense is connected and AFS access lands, while staying a clean no-op until then (no separate
  Google token-refresh cron — the hourly attribution refreshes lazily). Resolves the build half of
  OPEN_QUESTIONS #13; the remaining blocker is purely external (AFS Management API access + the `GOOGLE_*`
  envs + a `…/api/adsense/callback` redirect URI).

### 2026-05-31 — D23: Two Facebook apps — short-lived LAUNCH token for ad writes, long-lived DATA token for everything else

- **Problem:** the main app's **long-lived (~60d) per-user token trips Facebook's `31/3858385`
  "authenticate your account in Ads Manager" checkpoint** on ad create/modify from the datacenter IP,
  while a fresh **short-lived** token from a *separate* app publishes cleanly (re-confirmed on staging
  2026-05-31: flipping `FB_SKIP_LONGLIVED` on → the relaunch went `ACTIVE`, zero `3858385`). There is no
  API to clear the checkpoint, so the interim fix is to never present the token that trips it for writes.
- **Decision (temporary, `#two-app`, until the checkpoint is solved at the account/IP level):** run TWO
  FB apps. A connection is tagged `app_kind`:
  - **`DATA`** (existing `FB_APP_*`) — long-lived token. ALL reads/sync/insights/CAPI + the daily
    token-refresh. Owns the ad accounts/pages/pixels.
  - **`LAUNCH`** (optional `FB_LAUNCH_*`) — short-lived token. ONLY campaign create/modify (and
    pause/resume). Owns no assets. Reconnected right before launching (token lives ~1–2h).
- **Mechanics:**
  - `FbConnection.appKind` ('DATA' default) + unique key now `(userId, fbUserId, appKind)` — a person can
    hold both apps for the same FB profile. Migration `20260531150608_fb_connection_app_kind` (additive;
    hand-written to skip the pgvector `articles_embedding_idx` DROP footgun).
  - `@knn/fb` `fbAppCreds(kind)` resolves app id/secret/config; **`LAUNCH` falls back to `DATA` when
    `FB_LAUNCH_*` is unset**, so single-app installs are unaffected. `buildAuthUrl`/`exchangeCodeForToken`/
    `getMe` take an `appKind`; `GraphRequest.appKind` makes `appsecret_proof` sign with the **token-issuing
    app's secret** (the one real gotcha — a LAUNCH token must be proofed with the LAUNCH secret).
  - Launch resolves the SAME person's usable `LAUNCH` connection; if a LAUNCH connection exists but is
    expired/broken it returns a clear "reconnect the launch app" 409 (no silent DATA fallback that would
    just re-trip the checkpoint). No launch app / no LAUNCH connection → DATA, exactly as before.
  - The callback stores `LAUNCH` as **short-lived always** (never exchanges for long-lived) and **skips the
    asset sync** (DATA already synced them). Token-refresh only touches `DATA` (LAUNCH "expired" is normal).
  - OAuth redirect URI is **shared** by both apps (add the same `…/api/facebook/callback` to each in Meta);
    the app being connected travels in the signed `state`. Web: a "Connect launch app" button + a
    "Launch app · short-lived" badge per profile.
- **Setup (per environment):** set `FB_LAUNCH_APP_ID` / `FB_LAUNCH_APP_SECRET` / `FB_LAUNCH_CONFIG_ID`,
  turn `FB_SKIP_LONGLIVED` **off** (DATA should be long-lived again now that LAUNCH carries the short
  token), connect both apps. Remove the whole split once the checkpoint is solved (drop `FB_LAUNCH_*`,
  the `app_kind` column, and the LAUNCH branches).

### 2026-06-01 — D24: RSOC term-quality engine + RPC visibility + per-term telemetry (for Google's new RSOC quality signal)

Google's mid-2026 RSOC quality signal **penalizes** related-search terms that lead to irrelevant/low-quality
ads and **discards** weak partner terms — and the penalty drags coverage across the whole page/account. So
term quality is now a multiplier on the entire funnel's RPC, not a per-term yield. Our response, by funnel stage:

- **Preventive (the lever): a deterministic term-quality engine** (`packages/shared/src/terms.ts`, pure +
  unit-tested). `classifyTerm` scores intent (transactional/commercial/informational/navigational),
  high-CPC vertical (insurance/finance/legal/health/home-services/auto/education/B2B/…), plausibility, and a
  conservative sensitive blocklist. `filterTerms` is **rank-first, drop-rarely** — it hard-drops ONLY clearly
  bad terms (sensitive / gibberish / implausible / duplicate), ranks the rest by score (+ optional
  vertical-coherence nudge), caps to N, and **never empties** a non-bad input. _Why rank-first:_ over-dropping
  would shrink the unit → lower fill → lower RPC, inverting the goal.
- **Generation** (`packages/ai/src/openai.ts`): tightened the term prompt (transactional, vertical-anchored,
  plausible, no questions/sensitive/clickbait) AND run the model's output through `filterTerms` (belt +
  suspenders); fall back to cleaned keyword-derived terms so the unit is never empty.
- **Serve-time hygiene** (`apps/article/.../a/[slug]/page.tsx`): the terms-precedence chain (explicit redirect
  terms → article terms → keywords) is run through `cleanTerms`, so even legacy articles + keyword fallbacks
  serve clean, ranked, policy-safe terms.
- **RPC visibility** (`stats.ts` `rpc()`/`displayRpc()` + `RSOC_RPC_DISPLAY_FLOOR`): revenue-per-click surfaced
  on the super-admin Channels-usage, Articles-usage, and AdSense-preview tables. The real money metric (we
  have revenue + clicks at channel grain). AdSense v2 has **no per-term dimension**, so term-grain RPC is not
  possible from reports.
- **Detective — per-term telemetry** (observe-only): AdSense can't see terms, so the **client** is the only
  place term performance is observable. `/search?q=<term>` beacons whether Google served ads (fill) +
  whether an ad was clicked → `term_stat_daily` (term/IST-day: searches/fills/clicks, platform-wide) →
  super-admin **Term performance** card. This is the term-grain "monitor partner terms" signal Google's
  best-practices doc recommends. **Self-dormant** (no client telemetry URL → no rows). Endpoint
  `POST /api/telemetry/term`; read `GET /api/admin/term-performance` (SUPER_ADMIN).
- **Observe-first** (consistent with D22 fill-rate): no auto-pruning / auto-regeneration of dead terms yet —
  surface the data, validate it, then act. Deferred: redirect-level curated-terms override (capability wired
  via the article precedence chain), content-substance hard gate, auto term pruning/regeneration.

### 2026-09-29 — D25: Same-day channel cooldown — a freed channel is never re-issued the same IST day

- **Problem:** revenue maps to a campaign by (channel, IST day) via `channel_assignments.for_day`, and
  when two campaigns hold one channel on the same day the attribution span lookup gives the WHOLE day to
  the latest holder. The pool claims the oldest `AVAILABLE` channel (`ORDER BY created_at`), which is
  usually the one just freed — so a channel released mid-day (Meta rejection, offer removal) went straight
  to the next campaign. Staging, Aug–Sep 2026: 6 of 16 mid-day releases were re-issued the same day (4 of
  4 on Sep 25); the old holder's earlier hourly rows stayed frozen, so revenue was also double-counted.
- **Decision:** `lockedForDay` is no longer cleared on release — it keeps the last IST day the channel
  was held — and every claim query skips `locked_for_day = today` (`channel-pool/channel.service.ts`, the
  legacy global, per-offer domain and global-fallback claims; `reopenCampaign` keeps it too). A channel
  freed mid-day is re-issuable from the next IST day; channels freed by the 00:05 rollover carry
  YESTERDAY's day and stay re-issuable at once. The old holder's tail traffic that day (30-min tokens and
  cookies) is therefore credited to it, not to a newcomer.
- **Cost:** at most that day's mid-day releases sit out until midnight (≤ 4/day observed vs ~1,500 free
  channels). A waiter blocked only by the cooldown gets its channel at the 00:05 rollover drain.
- **Not covered:** out-of-band DB edits that free a channel (they bypass the pool code); re-issue on the
  NEXT day (oldest-first ordering still recycles freed channels quickly — revisit with LRU ordering if
  cross-day tail traffic matters); the article page's historical-channel fallback.

### 2026-09-29 — D26: RSOC pages default to `adsafe: 'low'` and serve ONE related-search unit

- **Benchmark:** the team's RSOC pages tracked in ClickFlare (`search.entertainmentheute.de`, the SAME
  AdSense account `partner-pub-6567805284657549`) made 149–154% ROAS on India traffic Sep 17–29 2026 vs
  42% for this app's pages. Page speed/first screen were comparable (ours faster). Config differences
  read from their live page source: `adsafe: "low"` (ours `medium`), one `relatedsearch` block (ours two).
- **`adsafe`:** the fallback when neither the domain (Domains admin) nor `NEXT_PUBLIC_AFS_ADSAFE` sets one
  is now `'low'` (`apps/article/app/_afs/csa.ts#DEFAULT_ADSAFE`, used by `site-config.ts`, the article
  unit and `/search`). Google: `high` = family-safe only; `medium` = no adult sexual content; **`low` =
  "Returns all types of ads"** (adult included) — the widest advertiser pool. A domain's own `adsafe`
  still wins, so any site can be set stricter.
- **One unit:** the article page fires `_googCsa('relatedsearch', po, rsblock1)` into
  `#relatedsearches1` only (the mid-article `#relatedsearches2` strip, added Aug 5, is removed) — to
  match the profitable pages. This is a CRO choice, not policy: the account HAS Restricted Access
  Features (RAF), so multiple units per page are allowed and a second unit can be restored if fill or
  RPV drops. The Aug 5 "one block returns zero terms" note wasn't measured on this account (the same
  day's blank units were traced to a long `resultsPageBaseUrl`).
- **RAF is account-wide and shared with the ClickFlare business.** Partner terms, multiple units and
  >500 channels all depend on it, and inaccurate `referrerAdCreative` counts toward RAF strikes — so
  this app's rc practice (campaign-level short phrase, not the verbatim ad text) risks the shared RAF.
- **Watch after deploy:** per-host unit fill (`unit:<host>` in `term_stat_daily`, ~91% before) and
  chip CTR / revenue per visit per campaign vs the week before.

### 2026-09-29 — D27: Buyers see and edit what goes to Google — per-ad Referrer Ad Creative + custom RSOC terms, live, no approval

- **Why:** buyers compare against other feeds where they control the `referrerAdCreative` (rc) and the
  keyword list. Here both were invisible and fixed: one campaign-level rc for every ad (D5–D9), and terms
  that always came from the AI article through `cleanTerms`. Google wants rc to be the verbatim text of the
  ad that was clicked, which one shared value can't be when a campaign's ads differ.
- **Model:** `ads.rac_value` is a nullable per-ad override; the effective rc is `effectiveRac(ad, campaign)`
  (the ad's own text, else `campaigns.rac_value`, now "the default"). `campaigns.terms_override text[]` holds
  the buyer's terms; empty means the AI terms. Migration `20260929163154_google_signals_overrides`.
- **Path (no Worker change):** both redirect-config builders in `launch.service.ts` (the launch and
  `syncCampaignRedirectConfigs`, which live edits, offers and pause/resume share) set each ad's
  `adCreative` and add `terms=` to the money URLs (every PAID split + the single-channel article URL),
  never to fallback / white / organic URLs. The `go.*` Worker already signs every destination param into
  the cloak token (`resolve.test.ts` pins that `terms` survives). On the article page, one shared resolver,
  `resolvePublisherTerms` (`packages/shared/src/google-signals.ts`), picks the terms:
  - terms from the **signed** token go to Google **exactly as entered**;
  - an unsigned plaintext `?terms=` (anyone can craft one) still goes through `cleanTerms`, as before;
  - with no custom terms, the output is byte-identical to pre-D27.

  The dashboard view uses the same resolver, so what a buyer sees is what is sent.
- **Live, no approval:** `GET|PUT /api/campaigns/:id/google-signals` is owner-scoped (buyer: own campaigns;
  admin: their org) and writes audit `campaign.google_signals.updated` (before/after). The campaign status
  never changes. For a launched campaign (`fbCampaignId`), the edge configs re-sync inside the request. New
  clicks carry the new values within about a minute: the Worker's KV read uses Cloudflare's default 60 s
  edge cache. Visitors already on a page keep their 30-min token. Facebook is never touched. If the edge
  push fails after the DB save, the API returns 502 "Saved, but the live redirect could not be updated
  yet…". The dashboard keeps the edits, so Save retries the same idempotent PUT.
- **No content rules (Aman's call):** wording is the buyer's decision. *(Superseded for rc words by
  D28: a new rc can't contain a word that makes Google hide the keyword block. Keywords stay free.)* Nothing is filtered, reworded,
  ranked or warned about. Normalization is limited to trimming, collapsing whitespace, turning a comma into
  a space (CSA `terms` is comma-delimited), and case-insensitive de-duplication. The only limits are
  technical: rc ≤ 500 chars, ≤ 10 terms, each ≤ 60 chars. Measured 2026-09-29:
  - rc and terms ride base64-encoded in the signed `?t=` token.
  - The browser repeats the page URL as the `Referer` of every same-origin asset request. Next/Node
    rejects anything over 16 KB of URL + headers with 431, which would silently kill the JS chunks and
    the conversion beacon.
  - At the first draft caps (20 × 100 terms) an all-Devanagari worst case gave a 10.4 KB page URL.
    Add a ~4 KB rc cookie and a 12 KB referer, and Node returns 431. At 10 × 60 the worst case is
    4.8 KB (`google-signals.test.ts` pins < 6 KB).
  - Google's side isn't the constraint: `syndicatedsearch.goog` accepts ≥ 64 KB URLs. (The request
    carries rc as `kw`, `terms`, `rpbu` with the rc fragment, and `rurl` = the page URL incl. the token.)
  - Real creatives fit: across 127 ads the longest headline + primary text + description is 193 chars.

  One informational line, never a block (Aman, 2026-09-30): Google only uses publisher `terms` when
  a `referrerAdCreative` is sent with them. So when keywords (custom or AI) would go out and an ad
  has no rc, the panel names those ads ("…Ward boy video has none."). Save stays enabled.

  The draft wizard's rc cap was raised from 200 to the same 500, so a live-edited value survives
  clone → draft edit. The wizard's submit-time `racValueIssues` check (≥2 words, ≠ campaign name) is
  unchanged and applies to new drafts only.
- **Per-ad rc follows its creative:** the draft editor (a reopened campaign) and clone recreate ads with
  new ids. Each override moves to the new ad showing the identical creative (type, media, headline,
  primary text, description, CTA). If the creative changed, the override is dropped, because rc must be
  that creative's verbatim text. A clone also keeps `terms_override`.
- **Edges:**
  - Per-ad text on a DRAFT returns 409; set it after submitting.
  - A long Devanagari rc (over ~450 chars) makes the `_rsoc_rc` cookie exceed 4 KB, so the browser
    drops it. `/search` still gets rc from the `#r=` fragment.
  - `/search`'s last-resort Referer lookup returns the campaign default, not a per-ad rc. That only
    matters when both the cookie and the fragment are missing, and rc applies to RSOC requests, not
    `/search` ads.
  - Two saves on one campaign within milliseconds can race their edge pushes. This is the same class as
    offers and pause edits: the next save or resync fixes it.
  - If the Worker ever falls back to a plaintext Location (no token secret), custom terms degrade to the
    cleaned path. rc is unaffected.
  - The dashboard panel shows for every non-draft campaign, on the campaign page.

### 2026-09-30 — D28: Block rc words that make Google hide the keyword block — seeded from live tests, learned daily

- **Finding (live test, 2026-09-30):** on real landing pages, rc passed as `?rc=` exactly like a paid click.

  | rc | Hospital job page | Packing job page | Flat-rent page (control) |
  |---|---|---|---|
  | none | shows | shows | shows |
  | "Hospital Job" / "packing Job" / "Job" | **hidden** | **hidden** | — |
  | "Hospital Careers", "Hospitals are hiring", "Hospital Vacancy 2026" | **hidden** | — | — |
  | "Packing work from home" | — | **hidden** | — |
  | "Free nursing course in India" / "Free flat on rent" / "Flat on rent free listing" | **hidden** | — | **hidden** |
  | "Nursing course fees in India", "Patient care assistant course fees" | shows | — | — |
  | "Packing company near me", "Packing ki naukri" | — | shows | — |
  | "Flat on rent", "Flat on rent Job" | — | — | shows |

  - Job-seeking wording hides the block on job pages. "Free" hides it on any page.
  - When the block does show, Google fills it with its own job chips, so job keywords themselves aren't
    banned; it reacts to the rc.
  - Hindi was mixed ("हॉस्पिटल में नौकरी" showed 2/2, "पैकिंग की नौकरी" hid 1/1), so it's not seeded.
  - Real traffic agrees: Sept 2026 campaigns whose rc reads like job-seeking got **17 keyword clicks per
    100 visits vs 60** for the rest (ROAS 18% vs 57%). "Carpenter Job" got 0 and "Hospital Job" 0.9.
  - **Test-method trap:** any page-URL param Google isn't told to ignore (`?x=1`, the old `?testRc=`,
    `?adtest=1`) hides the block by itself. Always pass rc as `?rc=`, which is in `ignoredPageParams`.
    This is why earlier `adtest`/`testRc` browser tests were "inconclusive".
- **Second round (2026-09-30):** tested on the two live job pages, 2 loads per winner.

  | Result | rc words |
  |---|---|
  | **Hid the block** | Jobs, Vacancies, Opportunity/Opportunities, Recruitment, Employment, Openings, Staff Required, Salary |
  | **Showed it** (both pages) | Naukri, Bharti, Duty, Kaam |
  | **Showed it** (hospital page only) | Work |

  - "patient care assistant" hid the block 3/3, while "Patient care assistant course fees" showed it.
  - Added in migration `20260929220000_rc_blocked_terms_job_words`: opportunity, recruitment,
    employment, opening, salary, staff required. That makes 12 seeds.
  - "patient care assistant" is not added, because it would also block the working "…course fees" rc.
  - Tested on job pages only: Allow a word (e.g. salary, opening, opportunity) if another vertical
    needs it.
- **Decision (Aman):** keep a list of such words and stop buyers from putting them in a new rc.
  - **Storage:** `rc_blocked_terms` is global (no org_id / RLS, like `term_stat_daily`). Terms are
    normalized: lowercase, whole words, plurals folded.
  - **Three sources:**
    - SEED — tested words, shipped in migration `20260929210517_rc_blocked_terms`: job, career, hiring,
      vacancy, free, work from home.
    - LEARNED — added by the daily learner.
    - MANUAL — added by a super-admin.
  - **ALLOWED** is a super-admin override: the word is never blocked and never re-learned.
- **Learner** (`learnRcBlockedTerms` in `packages/shared/src/rc-blocked-terms.ts`, run by
  `learnRcTerms` via the worker cron, daily at 03:40 IST, or "Learn now"):
  - It uses the last 30 IST days.
  - A campaign's keyword-click rate is AFS requests ÷ FB link clicks, since /search is only reached
    from a chip.
  - A campaign is **suppressed** when its rate is below 35% of the median (campaigns with ≥ 100 visits
    only).
  - It greedily picks the word that explains the most suppressed campaigns not already explained by a
    known blocked word. That word needs:
    - ≥ 3 suppressed campaigns;
    - ≥ 3 different wordings;
    - ≥ 75% of all campaigns using it suppressed.

    Topic words that ride along ("hospital" in "Hospital Job") are therefore never learned.
  - Replayed on the Aug–Sep data (48 campaigns), it learns exactly **job** and **career**, and nothing
    beyond the seeds (pinned in `rc-blocked-terms.test.ts` with a fixture).
  - Known false positive: "Driving Career: Executive Chauffeur" performs well, so a super-admin can Allow
    "career" if needed.
  - New learned words ping the alert webhook.
- **Enforcement:** only on **new** rc text.
  - The Sent to Google PUT returns 400 for a changed campaign-default or per-ad rc that contains a
    blocked word. Existing saved values stay untouched and show an amber warning.
  - Submit adds the explanation to the 422 issues list.
  - The wizard and panel flag the word inline and disable Save/Submit.
  - Launching already-approved campaigns is not blocked.
  - The message tells buyers to change the **ad's wording**, because rc must stay the ad's real text.
    Putting a different rc than the ad says would misreport the ad to Google and risk the shared
    account's RAF.
- **UI:** super-admin page Platform → **RC words** (evidence per word, Block a word, Allow/Block, Learn
  now). `GET /api/campaigns/rc-blocked-terms` (any signed-in user);
  `GET|POST /api/admin/rc-terms`, `PATCH /api/admin/rc-terms/:id`, `POST /api/admin/rc-terms/learn`
  (super-admin); `POST /api/internal/learn-rc-terms` (worker).

### 2026-09-30 — D29: Analytics speaks ClickFlare — EPV / RPC / vCVR, exact under Google's click masking; table redesign

- **Problem:** the Analytics "RPC" meant revenue ÷ **Facebook clicks**, which is ClickFlare's **EPV**. The
  campaign dropdown's "RPC" meant revenue ÷ **Google ad clicks**, and ClickFlare's RPC is revenue ÷
  conversions (in search arbitrage, the paid ad click). One label carried two meanings. A buyer comparing
  our $0.011 "RPC" with ClickFlare's $0.112 saw a 10× gap that was mostly definitional.
- **Definitions** (`packages/shared/src/unit-economics.ts`, named exactly like ClickFlare):

  | Metric | Formula | ClickFlare name |
  |---|---|---|
  | EPV | revenue ÷ visits (FB link clicks) | EPV |
  | CPC | spend ÷ visits | CPV |
  | RPC | revenue ÷ Google ad clicks | RPC (revenue per conversion) |
  | vCVR | Google ad clicks ÷ visits | vCVR |
  | Conv (FB) | Facebook's pixel `Search` count | (Facebook-side) |
  | CPA (FB) | spend ÷ Conv (FB) | (Facebook-side) |
  | CVR (FB) | Conv (FB) ÷ visits | (Facebook-side) |

  Sub-dollar unit prices show 3 decimals (`formatUnitUsd`), so $0.011 and $0.014 don't both read "$0.01".
- **Google click masking:** *(Superseded by D30: RPC and vCVR now use our own ad-click tracking, so
  nothing is masked or hidden.)* AdSense reports a channel-day with fewer than 10 ad clicks as 0 clicks, but
  still reports the earnings. In Aug–Sep that was 14% of revenue and 36% of earning campaign-days. A naive
  RPC would divide that revenue by nothing and inflate. So `isMaskedAfsDay` flags a masked day (earned,
  < 10 clicks), and RPC and vCVR leave it out on **both** sides (revenue and clicks; visits and clicks).
  - An offers campaign's day is masked if **any** of its channels was masked. Visits can't be split per
    channel, and the campaign rollup's summed clicks would hide it (`forceMasked` from
    `offer_revenue_daily`).
  - `CampaignPerf` gains `adClicks`, `adClickRevenueUsd`, `adClickVisits` and `maskedDays` (after the
    buyer's cut).
  - The per-offer tab gets `rpcUsd` and `maskedDays` with the same rule. It previously divided masked
    revenue by the reported clicks.
  - The UI shows "~value" (partial) or "hidden", with the reason on hover.
- **Table redesign** (`apps/web/app/dashboard/analytics/*`):
  - **One column registry** (`columns.tsx`) drives the headers, cells, totals, picker and CSV, so they
    can't drift.
  - **Two-row header:** Results · Per visit & per click · Traffic · Facebook, with group dividers.
  - **Column picker:** presets Essentials / Funnel / Facebook / All plus custom checkboxes, remembered per
    browser. Essentials: Spend, Revenue, Profit, ROI, EPV, CPC, RPC, vCVR, Budget. That fits a 1512px
    screen with no sideways scroll.
  - **Pinned while scrolling:** header, campaign column and totals row. The expanded breakdown pins to the
    table's visible width.
  - **Campaign cell:** buyer, company and channel sit under the name (the Buyer/Company columns are gone;
    their filters stay). On phones, status moves there too.
  - **Header definitions:** each label explains itself on hover or focus (dotted underline), and screen
    readers get the definition.
  - **Rows:** clicking the row toggles the breakdown; actions are icon buttons (Pause/Resume, Open
    campaign).
  - **Breakdown tabs** are renamed Ads / Websites / Countries / Hours, all with the same columns (incl.
    visits, EPV, CVR (FB)). Revenue-based columns are marked estimated (`*` plus a note), since Google
    reports revenue per campaign and the split is by Facebook conversions. Each ad notes when its split fell
    back to visits or impressions. Every tab has a total row.
  - **Summary:** Results (Spend, Revenue, Profit, ROI) plus unit economics (EPV vs CPC, CPC, RPC, vCVR).
  - **CSV** carries every metric plus the hidden-day count.

### 2026-09-30 — D30: RPC and vCVR count our own ad clicks — ClickFlare's Dynamic payout, never hidden

- **Problem:** D29 divided by Google's AdSense click count, and Google reports 0 clicks on any channel-day
  with fewer than 10. On staging most campaigns are that small, so RPC and vCVR read "hidden" on nearly
  every row. ClickFlare never hides them.
- **What ClickFlare actually shows** (checked against its API, 2026-09-30):
  - Its RPC is the **Dynamic payout** column: `dynamicPayout` = revenue ÷ conversions, to the cent.
  - Conversions are counted **at most once per visit**: in its two largest campaigns, no visit or click id
    had more than one.
  - It shows the value on small rows too: 76 of 77 rows with 1–9 conversions had one.
- **Change:** "ad clicks" = our own `adclick` funnel events (`conversion_events`, event `Search`, at most
  one per visit). That is the same signal Facebook's CAPI gets, and the same unit ClickFlare counts.
  - RPC = revenue ÷ ad clicks; vCVR = ad clicks ÷ visits. The values are live, and a campaign with 0 ad
    clicks shows RPC "—".
  - Clicks are bucketed by IST business day on `created_at`, the moment the beacon landed.
  - The Websites tab credits each click to the website it happened on, by the page URL's host. When one
    host serves several offers, the click's `#c=` channel picks the offer, then traffic share splits the
    rest (`creditAdClicksToOffers`). Host is the key because channels roll over: only 44% of clicks still
    carry the offer's current channel, while 100% match an offer host.
  - The masked-day machinery is gone: `isMaskedAfsDay`, `adClickEconomics`, `maskedDays`, "~"/"hidden",
    and the CSV hidden-day column.
  - Migration `20260929224916_conversion_events_ad_click_index` adds `(campaign_id, event_name,
    created_at)`, so the count is index-only at production volume. It's additive.
- **Accuracy vs Google** (staging, 14 days, days where Google shows clicks):
  - **Detection is complete.** Every click our page detects comes to 101–117% of Google's reported clicks;
    Google's number leaves out the days it hides.
  - **Per visit reads lower than per click.** The once-per-visit count is 72% of Google's clicks, because a
    visitor who clicks averages ~1.4 ads.
  - **So RPC reads ~1.4× revenue-per-Google-click.** For example, $0.047 instead of $0.034 — exactly how
    ClickFlare's Dynamic payout reads. vCVR is "share of visits with an ad click" (20.5% vs Google's
    clicks-per-visit 28.2%).
- **Kept as is:**
  - Revenue still comes from AdSense, and the platform cut still applies.
  - Visits are still Facebook link clicks.
  - Conv / CPA / CVR (FB) are still Facebook's own count. It is usually below Ad clicks, because Facebook
    can't match every visitor.
  - Today's RPC climbs through the day, because AdSense earnings lag the clicks by a few hours.
