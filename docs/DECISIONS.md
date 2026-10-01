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
  for a manual retry. Resumable partial-failure launch is a Phase 11 hardening follow-up (OPEN_QUESTIONS #10)
  — **done, see D32** (the launch now records each Facebook id as it is created and resumes; `attempts:1` stays).
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
- **Definitions** (`packages/shared/src/unit-economics.ts`, named exactly like ClickFlare). *(Superseded by
  D30: every count now comes from our own funnel. Visits are landings, CPC became CPV, and CTR/CVR follow
  ClickFlare.)*

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
- **Google click masking:** *(Superseded by D30: RPC and vCVR now use our own funnel tracking, so
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

### 2026-09-30 — D30: Analytics counts our own funnel, exactly like ClickFlare — Visits → Clicks → Conversions, never hidden

- **Problem:**
  - **Hidden values.** D29 divided by Google's AdSense click count, and Google reports 0 clicks on any
    channel-day with fewer than 10. On staging most campaigns are that small, so RPC and vCVR read
    "hidden" on nearly every row. ClickFlare never hides them.
  - **Visits weren't landings.** "Visits" were Facebook link clicks. About 11% of those never load the
    page (staging, 7 days: 12,382 clicks → 10,969 landings), so vCVR wasn't a landing-page → conversion
    rate.
- **What ClickFlare actually computes** (checked against its API, 2026-09-30):
  - **RPC = Dynamic payout** = revenue ÷ conversions, to the cent.
  - **vCVR = visitCvr** = conversions ÷ visits.
  - **At most one conversion per visit:** in its two largest campaigns, no visit or click id had more
    than one.
  - **Small rows still show values:** 76 of 77 rows with 1–9 conversions had one.
  - **No landing-page clicks in your setup:** Clicks, and so CTR and CVR, are 0 on every campaign.
- **Change: every count is our own funnel event**, recorded once per visit in `conversion_events` — the
  same events Facebook CAPI receives. Live, never hidden.

  | Our count | Event | ClickFlare |
  |---|---|---|
  | Visits (landed) | `lander` → `ViewContent` | Visits |
  | Keyword clicks | `search` → `AddToCart` | Clicks |
  | Ad clicks | `adclick` → `Search` | Conversions |

  | Metric | Formula | ClickFlare |
  |---|---|---|
  | EPV | revenue ÷ visits | EPV |
  | CPV (was "CPC") | spend ÷ visits | CPV |
  | RPC | revenue ÷ ad clicks | Dynamic payout |
  | vCVR | ad clicks ÷ visits | vCVR — landing page → conversion |
  | CTR | keyword clicks ÷ visits | CTR |
  | CVR | ad clicks ÷ keyword clicks | CVR (vCVR = CTR × CVR) |

  - **Facebook's own numbers keep their "(FB)" suffix:** FB clicks, CTR (FB), CPC (FB), Conv (FB),
    CPA (FB), CVR (FB). Land rate = visits ÷ FB clicks shows the clicks lost before the page loads.
    Profitability is unchanged: EPV vs CPV compares revenue with spend over the same denominator.
  - **Presets:**
    - Essentials: Spend, Revenue, Profit, ROI, EPV, CPV, RPC, vCVR, Budget (still fits 1512px).
    - Funnel: adds Visits, Keyword clicks, CTR, Ad clicks, CVR.
    - Facebook: Facebook-side columns plus Land rate.
    - Saved column picks moved to `knn.analytics.columns.v3`, because keys changed meaning.
  - **Ads tab:** the same metrics per ad. The funnel is exact per ad, since each event carries its ad;
    revenue-based columns stay "estimated".
  - **Websites tab:** visits, vCVR, ad clicks, revenue, EPV and RPC per website, plus a total row. Events
    are credited by page host (`creditToOffers`); when a host is shared, the results-page `#c=` channel
    picks the offer, then traffic share splits the rest. Host is the key because channels roll over: only
    44% of clicks still carry the offer's current channel, while 100% match an offer host.
  - **Countries / Hours tabs:** Facebook-only columns, labeled so. Our events carry no country, and
    Facebook's hours are in the ad account's time zone.
  - **Bucketing:** clicks count by IST business day on `created_at`, the moment the beacon landed.
  - **Removed:** the masked-day machinery (`isMaskedAfsDay`, `adClickEconomics`, `maskedDays`,
    "~"/"hidden", the CSV hidden-day column).
  - **Migration:** `20260929224916_conversion_events_ad_click_index` adds `(campaign_id, event_name,
    created_at)`; it's additive. Locally the whole analytics call takes ~100 ms over 193k events.
- **Accuracy vs Google** (staging, 14 days):
  - **Detection is complete.** Every ad click our pages detect comes to 101–117% of Google's reported
    clicks.
  - **Per visit reads lower than per click.** Counting once per visit gives ~72% of Google's clicks,
    because a visitor who clicks averages ~1.4 ads.
  - **So RPC reads ~1.4× revenue-per-Google-click**, just as ClickFlare's Dynamic payout does.
- **Kept as is:**
  - Revenue still comes from AdSense, and the platform cut still applies.
  - The rc-word learner (D28) still measures keyword clicks per 100 **FB clicks**, because its
    thresholds were calibrated on that.
  - Today's RPC climbs through the day, because AdSense earnings lag the clicks by a few hours.

### 2026-09-30 — D32: A rate-limited launch resumes instead of rebuilding — Facebook ids are recorded as each object is created

- **Read first:** this was written on a checkout where **D31** (the BATCHED re-drive cron,
  `apps/worker/src/jobs/batched-redrive.ts`) and its "Known gap" note are **not present** — not on this branch,
  `origin/main` or any other remote branch. So this entry stands alone instead of extending that note. It is the fix
  for that gap: the re-drive re-runs `launchCampaign` on a BATCHED campaign, and this makes that safe. When D31 lands,
  point its "Known gap" here.
- **Problem:**
  - `createFbStructure` created the campaign, then each ad set, then per ad an image/video upload + creative + ad, all
    ACTIVE, and wrote the Facebook ids only at the very end (`persistFbIds`).
  - A rate limit mid-build (`FbRateLimitError`, after the per-account limiter's retries and breaker, D12) parked the
    campaign in BATCHED and answered 200. Everything already created stayed on Facebook — live, possibly spending — with
    no id recorded, and the next launch (the buyer's Launch, auto-launch, a re-drive) built a second complete structure.
- **Decision — what "launched" means:**
  - **`campaigns.fb_campaign_id` keeps its one meaning: the whole structure is built.** It is written only when the build
    completes.
  - **Progress of an unfinished build lives in a new nullable `campaigns.fb_pending_campaign_id`, plus the existing
    `ad_sets.fb_ad_set_id` and `ads.fb_ad_id`.** Each is written in its own small transaction, right after the Graph call
    that created it and before the next call. Migration `20260930103000_campaign_fb_pending_campaign_id` — additive,
    nullable, no backfill.
  - **Why not persist `fb_campaign_id` early plus a "fully built" marker** (or make each check verify the children):
    every reader treats `fb_campaign_id` as "launched" — the launch's own early return and claim, the worker auto-launch
    gate (`triggerAutoLaunch`), the meta-rejection reconcile scan, the attribution scan, google-signals `live`,
    `relaunchCampaign` — and there can be readers not visible from one checkout (the D31 sweep is one). Changing the
    column's meaning means finding and changing all of them, and one miss silently treats a half-built campaign as live or
    a BATCHED one as done. Keeping the meaning and putting the new state in a new column changes none of them.
  - **Why not delete/pause what was created when a rate limit aborts the build:** the cleanup calls go through the same
    per-account limiter, whose breaker is already open after 5 consecutive rate limits (5-minute cooldown) — they fail
    exactly when they are needed.
- **How a launch resumes:**
  - **The atomic LAUNCHING claim is unchanged** (`UPDATE … WHERE fb_campaign_id IS NULL AND status IN (PROCESSING,
    BATCHED)`), so exactly one caller builds.
  - **No extra Facebook calls.** The recorded campaign and ad sets are reused, and an ad that has an id is skipped
    entirely (no upload, creative or create). A recorded ad set or ad is trusted only under the recorded campaign; a
    brand-new Facebook campaign or ad set clears whatever was recorded below it.
  - **An ad interrupted before its `createFbAd`** redoes its image upload and creative (an unreferenced creative costs
    nothing); a video is uploaded again.
  - **Completion is ONE commit:** `fb_campaign_id` ← the campaign, pending cleared, every id, status ACTIVE, audit
    `campaign.launched` (now with `resumed`). Before, the ids and the status were two commits.
  - **One campaign, one redirect host and one white domain.** Both are recorded with the pending campaign and kept on
    resume while still eligible. Otherwise the least-loaded ranking moves between attempts — exactly when rate limits hit,
    under load — and one campaign ends up with creatives on several hosts while only the last is recorded for
    blast-radius reporting (and a CLOAKER ad's visible display link stops matching its fallback page).
  - **Test launch is unchanged** (a fresh PAUSED structure, ids written at the end). It now refuses (409) over an
    unfinished build, which it would otherwise take over and orphan.
- **Changing or restarting a campaign with an unfinished build:**
  - A resume reuses what exists, which is only right while the config is unchanged — and "Reopen & edit" is offered on
    BATCHED and PROCESSING campaigns. So the reopen route now calls `reopenCampaignForEdit`: it pauses the unfinished
    Facebook campaign, drops every recorded id, then reopens. A campaign launched after the edit builds from scratch.
  - **Failure policy mirrors pause/resume and the budget edits.** A rate limit, an ad-account security hold (368) or a
    dead token stops the reopen with the usual error and changes nothing (reopening anyway would strand a live campaign;
    the buyer retries once it clears). Any other Facebook error (typically: deleted in Ads Manager), or an ad account that
    is no longer connected, lets the reopen go ahead and tells the buyer (notification) which Facebook campaign to pause
    by hand. Audited as `campaign.fb_build_discarded`.
  - **The edge config is republished inactive after a discard** (B1): the unfinished build's configs were written
    `active:true` with the channel that reopening releases, and its ads may still be live.
  - **`reopenCampaign` on its own fails closed** (409) while a build is unfinished. **`relaunchCampaign`** (the ops
    "start over") pauses and forgets the unfinished campaign too — now with the owner's write credential (the LAUNCH app's
    when they have one; it used the raw DATA token) and a notification when the pause fails, instead of silently leaving
    a live campaign. It stays best-effort: it never blocks. The Reopen confirmation and the BATCHED banner say so.
- **D19 kept:** `FB_LAUNCH` stays `attempts:1`, and a failure that is not a rate limit still reverts to PROCESSING for a
  human. Resumability makes a manual relaunch safe, not blind auto-retry wise — a deterministic rejection just repeats,
  and retrying into a 368 hold makes the checkpoint worse. The rule is now pinned by a worker test.
- **Known gaps:**
  - **Crash window.** If Facebook created an object but our write then fails (DB outage, process killed right then), it
    is unrecorded. It is logged as `ORPHAN RISK` with its id. Facebook has no idempotency key for these creates, and
    finding strays by listing would add calls to every launch.
  - **Live while BATCHED.** Ads created before the limit hit keep delivering (their edge config stays active), but
    attribution and the status reconcile only see the campaign once `fb_campaign_id` is set. Deliberately not paused:
    that needs calls during a rate limit, plus an un-pause on resume. Their edge configs carry no `expectedAdId` until
    the launch completes (the resolver then uses its legacy paid-click routing, as in any launch's pre-resync window),
    and any sync while BATCHED — e.g. a live offer edit — derives `active:false` from the status (as before).
  - **The auto-launch job can't re-drive a BATCHED campaign by itself — verified on real Redis (bullmq 5.77).** The
    `FB_LAUNCH` job id is `launch-<campaignId>` and completed jobs are retained (`removeOnComplete: 200`); BullMQ silently
    ignores an `add()` whose id still exists, so a later `triggerAutoLaunch` for the same campaign enqueues nothing.
    Pre-existing and unchanged here. A queue-based re-drive (D31) has to enqueue with a unique id per attempt, drop the
    retention, or call the internal launch endpoint directly.
  - **Reopen racing a launch.** If a launch claims the campaign while a reopen is pausing its Facebook campaign, the
    reopen stops (409) and that launch resumes a campaign that is now paused on Facebook. The 30-minute status reconcile
    mirrors it as PAUSED and the buyer can resume it; nothing is lost or duplicated.
  - **A host that leaves its pool mid-build.** Resuming keeps the redirect host and white domain only while they are
    still eligible; if one was retired or flagged, the rest of the build uses a fresh one (logged), and only that one is
    recorded — the ads already created still link to the old one.
  - **Stuck LAUNCHING (pre-existing).** A process killed mid-build leaves LAUNCHING, which nothing recovers. The recorded
    ids now make it safe to flip such a campaign back to BATCHED (the launch resumes), but there is no sweeper yet.
  - **Campaigns already BATCHED before this ships** may have live objects left by the old behaviour, with no id to find
    them by — check Ads Manager for duplicates of those.
  - **Not verified against live Facebook.** Tests use a scripted Graph client. Assumed: a rate-limited create creates
    nothing, and a recorded object is still valid on the next attempt.
- **Tests:** `launch-resume.test.ts` (API, real Postgres, scripted Facebook, 40 tests): a rate limit at each of the 15
  Graph calls of a 2-ad-set × 2-ad campaign → BATCHED → a second launch → exactly one campaign, two ad sets and four ads
  ever created, all recorded; plus ids recorded before the next call, only the missing calls made, repeated limits, two
  racing resumes, a non-rate-limit failure, host stability and host switching, and the reopen / relaunch / test-launch
  guards. **37 of the 40 fail on the pre-change code**; the other 3 guard behaviour that must not change. Worker: an
  unfinished build still passes the auto-launch gate, and the job keeps `attempts:1` (`enqueueFbLaunch` is injectable, so
  this needs no mocked module).

### 2026-09-30 — D33: Whop Ads is a second ad provider — a buyer connects a Whop business with its ID and an API key; Meta ads only

_Numbering: this was written as D32 and renumbered to D33 when it was merged with `main`, where the resumable Facebook launch had taken D32 in the meantime. Its commits (`1c7ba09`, `bae553e`) still say "D32"; in the docs and code "D32" is the resumable Facebook launch and "D33" is Whop Ads. D31 (the `BATCHED` re-drive sweep) is still on another branch._

- **Why:** Whop resells Meta advertising. Whop owns the Meta ad account (one per Whop business) and exposes it
  through a REST API, so a buyer with a Whop business can run campaigns without their own Facebook ad account
  or Business Manager. The brief: the buyer adds only the business ID and an API key; the page, payment
  method, pixel and going live are guided and checked; nothing that exists may break.
- **Decided with Aman (2026-09-30):**

  | Question | Decision |
  |---|---|
  | Who owns a connection? | The buyer adds and connects their own Whop business, like Facebook. A super-admin can see all. |
  | Cloaking | Whop only needs a destination link. Funnel mode (NORMAL / CLOAKER) applies exactly as it does for Facebook. ~~We add nothing Whop-specific to get past Whop's own pixel check; if Whop rejects a link, the buyer sees Whop's message.~~ **Superseded the same day by the tracking design below:** the Whop pixel goes on the page Whop's check sees. |
  | Who turns it on? | The global flag `WHOP_ADS_ENABLED` AND a per-company switch only a super-admin flips (`organizations.whop_enabled`). Off by default. When off, every route answers 404 and the nav item is hidden. |
  | Scope | Meta ads only. No audiences, AI creatives or lead forms. |
  | Test access | Aman creates a Whop sandbox account and key, saved in `~/whop-sandbox.env` outside the repo. |
  | Column labels | Columns that come from a platform are labelled by source: "(FB)" and "(Whop)". |

- **What Whop's API gives us** (OpenAPI 1.0.0, read 2026-09-29):
  - **Auth:** an Account API key (`Authorization: Bearer`) plus the business ID (`biz_…`). Production is
    `api.whop.com/api/v1`; the sandbox is `sandbox-api.whop.com/api/v1`, same API and separate data.
  - **Versioned by date** (`Api-Version-Date`). We pin `2026-09-29` (`WHOP_API_VERSION_DATE`). The ad copy
    shape changed on 2026-09-24-1, so never send an older date.
  - **Limits:** 600 requests a minute per operation and credential. POSTs take an `Idempotency-Key` (kept 24 h).
  - **Objects:** ad campaign (`adcamp_`) → ad group (`adgrp_`) → ad (`ad_`). Stats ride on those objects.
  - **No Meta ids *in its API*.** Whop's API doesn't expose the Meta ad account, pixel or ad ids, so no Facebook path that
    assumes them can be reused. (Corrected 2026-10-01, D38: Meta's real ad, ad-set and campaign ids DO arrive on every real click,
    as `utm_meta_ad_id` / `utm_meta_adset_id` / `utm_meta_campaign_id`; we just cannot know an ad's id in advance.)
  - **Launch gates:** a signed ads agreement, a payment method, a Facebook page, and the Whop pixel on any
    external destination (`validate_pixel`). Drafts need none of them.
  - **Reserved click parameters** (`utm_meta_*`, `utm_source`, `wacid`, `wasid`, `waid`, …) belong to Whop.
    Our links must not reuse them.
- **Architecture**
  - **Separate everything.** New tables `whop_connections` and `whop_social_accounts` (RLS like `fb_*`), a new
    package `@knn/whop`, routes under `/api/ad-providers/whop/*`. The `fb_*` tables, `/api/facebook/*` and
    `@knn/fb` are untouched.
  - **Connect = verify, then store.** The key is checked against Whop before anything is saved. It is encrypted
    with the same AES-256-GCM helper as Facebook and Google tokens, only its last four characters are ever
    shown, and it never appears in a response, an error or the audit trail (tested); no Whop code logs it.
    Reconnecting replaces the key. Disconnecting deletes the row, and with it the key.
  - **One checklist, from live reads:** key works · key permissions · ads agreement · payment method ·
    reporting currency · Facebook page · Whop pixel. The design: from phase 2 a buyer can build campaigns as
    drafts as soon as the key works (`canDraft`), and launching needs every step (`canLaunch`). Each step says
    what to do, with a button where we can do it for them (connect Meta Business, create a Whop-managed page,
    check again).
  - **Permissions can't be listed.** Whop has no call that returns what a key may do. The check probes the
    read permissions and reports the write ones as confirmed on first use; the error then names the missing
    permission.
  - **BROKEN means Whop said so.** A connection turns BROKEN only when Whop rejects the key, the key lost access,
    or it belongs to another business. An outage never breaks it. One `whop_connection_broken` notification per
    break; a later good check recovers it.
  - **Access is per user.** An owner sees and manages only their own connections; a super-admin sees all
    (`GET /connections/all`). For buyers, sandbox connections need `WHOP_ALLOW_SANDBOX=true` (off by default, for
    local and staging); a super-admin can always connect a sandbox business, so the platform owner can test
    in any environment.
  - **Client behaviour:** retries only what is safe (reads, and POSTs that carry an `Idempotency-Key`);
    a `Retry-After` longer than the cap is raised to the caller instead of slept on; its own limiter is keyed by
    a hash of the credential, not by an account id.
- **Risks found in the existing Facebook code, and how Whop stays clear of them:**
  - **Provider-blind credential lookups** (`resolveCampaignReadAuth` picks any live connection; an unknown app
    kind falls through to DATA) → Whop credentials never live in `fb_connections`, so they cannot be picked up.
  - **`Campaign.fbCampaignId != null` means "launched"** in about eight places → Phase 2 adds `isLaunched()`
    before a Whop campaign can exist.
  - **About twenty `instanceof` Facebook-error branches** → Phase 2 introduces neutral error kinds. Whop errors
    never flow through the Facebook branches.
  - **Facebook status reconcile can archive a campaign and release its channel** → Whop campaigns are excluded
    until they have their own reconcile.
  - **A `ConversionEvent` row is also an Analytics count** → Phase 3 defines how Whop events are counted once.
  - **The Facebook rate limiter is process-local and keyed by raw account id** → Whop has its own.
  - **About fifteen test files insert raw `fb_*` rows with minimal fields** → no new required columns on `fb_*`.
- **Risk disclosed to the owner once:** Whop's terms make the advertiser responsible for Meta's ad policies, and
  Whop can suspend an account after a 5-business-day cure period. The cloaking decision above was made with
  that in view.
- **Phases:**
  1. **Connect — built and tested (this entry).** Connection, checklist, page and pixel steps, the company
     switch, the dashboard page, the mock Whop API. Nothing launches yet.
  2. **Build and launch — built and tested 2026-09-30** (second addendum below): `isLaunched()`, Whop ids on
     campaign / ad set / ad, a provider choice in the wizard, draft-first launch that resumes and is idempotent, pause /
     resume, budget edit, relaunch, reopen, clone. (Neutral error kinds were not needed: Whop failures never enter a
     Facebook branch, because the launch routes by provider before anything runs.)
  3. **Pixel, events, stats** — **tracking built 2026-09-30** (first addendum below): the Whop pixel on the
     page Whop's check sees, Whop's click parameters kept through the redirect, conversion events to Whop.
     **Status sync, spend in the IST day and "(FB)" / "(Whop)" column labels built 2026-09-30** (second addendum).
  4. **Operate** — webhooks, payment-failed banner with retry, notifications, super-admin overview, runbook.
  - **Phase 0 (sandbox spike)** answers the questions listed in `OPEN_QUESTIONS.md` #15 and gates phase 3. It
    waits for the sandbox key.
- **Docs:** `docs/WHOP.md` (setup, checklist, permissions, testing, operations, API), `packages/whop/CLAUDE.md`.

#### D33 addendum, 2026-09-30 (later): tracking — the pixel on the page Whop checks, server events for the rest

- **Owner's direction (Aman).** Put the complete Whop pixel on the **white page** and let it fire there; send the
  real conversions from the **money page** server-to-server, the way ClickFlare already runs Whop campaigns for
  the team. Aman also reports that Whop support confirmed **in writing** that search-arbitrage funnels are
  allowed. That confirmation is not in the repository: keep a copy with the company records (this decision
  leans on it). This supersedes the "add nothing Whop-specific to get past Whop's pixel check" row above.
- **What the sandbox and ClickFlare showed** (details and open items: `OPEN_QUESTIONS.md` #15):
  - Whop checks an ad's destination **when the ad is created** (`POST /ads`, even as a draft): 400 "The Whop
    pixel was not detected on <url>" until it passes. It loads the URL, **follows redirects**, and reads the
    final page's source for the pixel (recent pixel events from that page also count; a whop.com page needs none).
    ClickFlare's docs say the same: "Whop requires its pixel on external landing pages before an ad can go live.
    The Conversion API does not replace it."
  - A server event (`POST /events`) is attributed from the landing URL's `wacid`/`wasid`/`waid`, `fbclid`, IP and
    user agent; the visitor cookie (`_wuid`) is optional. ClickFlare's live mapping is Page Visit → `view_content`,
    Click Button → `add_to_cart`, Search → `submit_application`: the same three steps as our funnel.
- **Design**
  - **The go-link decides.** A Whop campaign's redirect config carries `whop: { bizId }`. For such a config the
    Worker also counts Whop's own click signal as paid; records Whop's ids and the landing URL (only Whop's
    parameters, validated) beside the click; and tags the **non-paid** landing with a signed `_ws` scope. The
    money route never carries it. Facebook configs have no `whop` block and route exactly as before.
  - **The pixel appears only behind a verified scope.** The white Worker (and the article, in NORMAL funnel
    mode, where the non-paid landing is the plain article) renders the business's pixel in `<head>` only when a
    request carries a valid `_ws`: an HMAC of the business id (`WHOP_SCOPE_SECRET`), so a stranger cannot make
    our pages report into someone else's Whop account. A direct visit, a crawler or a forged link sees the same
    clean page as ever. The variant is `private, no-store`. It fires the ordinary page view only: no conversion
    event is ever wired on a page.
  - **Conversions go server-side.** Ingest marks a click with a `whop` block as a Whop send (`provider = 'whop'`,
    business, landing URL and click ids frozen in `provider_context`) and queues it on `WHOP_DISPATCH`; the worker
    posts it to Whop's Events API with ClickFlare's payload shape. One row is one send, and still exactly one row
    for Analytics (D30). Facebook rows are untouched (`provider` defaults to `facebook`).
  - **Failures are explicit.** A rejected key breaks the connection once and notifies once; a missing permission
    names itself; refusals are terminal; outages retry; and unlike CAPI, a row whose retries run out is settled
    as `failed` instead of sitting `pending` forever.
- **Trade-offs we accepted**
  - The white site's rule "no shared ID, ever" now has one narrow, documented exception. The business id is
    visible in that page's source, but only to visitors who arrived through that business's go-link (Whop's
    check, a reviewer following the ad), never to a direct visit. White sites of one business carry the same id
    for those visitors, which is the price of Whop's requirement.
  - The Whop pixel check sees the white page, not the money page. If Whop ever renders the final destination
    with a real browser and compares it with what users see, this design stops being enough; ClickFlare users
    share that exposure today.
  - The redirect Worker stays dependency-free, so it holds its own copy of Whop's click parser (a test proves it
    agrees with `@knn/shared`); the scope token and the pixel loader are verbatim copies in the white Worker and
    the article app, each guarded by a test that fails on drift.
- **Not done yet (deploy)**
  - ~~Nothing writes `whop.bizId` into a KV config until a Whop campaign can be launched.~~ **Done in phase 2:** a Whop
    campaign's config is built only by `syncCampaignRedirectConfigs` (`launch-routing.ts`), which emits `whop: { bizId }`;
    the inline builder in `launchCampaign` is Facebook only.
  - `WHOP_SCOPE_SECRET` must be set as a secret in three places, with the same value: the redirect Worker and the
    white Worker (wrangler secrets, the white one on the white Cloudflare account) and the article app's runtime
    env. Unset anywhere = no pixel there (the safe default).
  - Whop-specific ad-id verification under `CLOAK_VERIFY_MODE=enforce` (an `expectedWhopAdId` matched against
    `waid`) waits until the ad id is known after creation.

#### D33 addendum, 2026-09-30 (phase 2): build and launch campaigns on Whop

- **What was built.** A buyer can choose **Whop** in the wizard, submit, and launch; pause, resume, change budgets,
  relaunch, reopen and clone; and the worker keeps the campaign's status and spend in step with Whop. Facebook's code
  path is unchanged: `launchCampaign`, `setCampaignActive`, the budget edits and `relaunchCampaign` each ask one question
  first (`campaignProvider`) and hand a Whop campaign to its own service before any side effect or Facebook-only rule
  (the $2 floor) can run. Details and the buyer-facing behaviour: `docs/WHOP.md`.
- **Decisions**
  - **A provider column, never a borrowed one.** `Campaign.adProvider` (`FACEBOOK` default, so every existing row is
    unchanged). Whop's ids live in their own columns (`whop_campaign_id`, `whop_ad_group_id`, `whop_ad_id`,
    `whop_file_id`, all unique). A Whop id is never stored in an `fb_*` column: `Ad.fbAdId` being set is what makes the
    cloaker's enforce mode white-page every click, so nothing Whop-side may ever stand in for it. "Launched" is asked
    through `isLaunched()` (`@knn/shared`), which for Whop means *has a Whop campaign and its status is ACTIVE, PAUSED or
    META_REJECTED*: a Whop draft that failed a gate exists at Whop but is not launched.
  - **The launch is draft-first and resumable, because Whop's model allows it.** A standalone Whop campaign is a draft and
    nothing spends until the last call (`PATCH status: active`), so every Whop id is saved the moment it exists, every
    create carries an `Idempotency-Key`, and a retry reuses what exists. Whop checks the pixel on an ad's URL when the ad
    is *created*, so the edge config is written first (active, with the `whop` block) and a preflight asks Whop's own
    checker what it sees before anything is built. Order and failure handling: `docs/WHOP.md`.
  - **Key epoch, not a timestamp.** Whop replays a repeated idempotency key for 24 h. A rebuilt tree (reopen, relaunch, a
    campaign deleted in Whop) would get the *discarded* objects back under the old keys (a test caught exactly this on
    relaunch). `campaigns.whop_key_epoch` is part of every key and is bumped wherever Whop ids are cleared, so the
    protection survives a retry, a restart and a second launch attempt, which a salt held in memory would not.
  - **A draft never points at Whop objects.** `updateCampaign` replaces a draft's ad sets and ads wholesale, so ids kept on a
    draft would be lost with the rows and the next launch would build a second set beside the old one. Reopening clears the
    ids in the reopen's own transaction, then deletes the Whop campaign; a failed delete leaves a clean draft plus an audited,
    notified orphan (a Whop *draft* cannot spend). `deleteCampaign` does the same, as a safety net.
  - **Pause and resume tell Whop first.** The local status follows only once Whop agreed, so the two can never disagree in the
    dangerous direction. "Already in that state at Whop" is success.
  - **Whop launch errors are the buyer's to fix, in Whop's words.** Whop's 400s name what is missing; we wrap them
    ("Whop would not launch this campaign: …"), keep them on the campaign (`whop_issues`, shown on its page) and notify,
    because an auto-launch fails while the buyer is away. A 401 breaks the connection (once), a 429 parks the campaign in
    `BATCHED`, everything else reverts the claim so the launch can be repeated.
  - **Submitting needs a working connection, not a complete checklist.** A missing payment method or page is Whop's to say
    at launch, and the buyer fixes it in Whop without re-review. The checklist's pixel row became informational for the same
    reason the preflight exists: the pixel lives on our page and is checked per ad.
  - **The launch never reports "not launched" while Whop may be running it.** `PATCH active` is the one call with
    consequences, so after any Whop error on it the campaign is read back: still a draft → the failure is real (the claim is
    given back, the error shown); no longer a draft → adopted as launched; unreadable → the campaign stays `LAUNCHING` with
    its edge config *active* and the buyer is told to wait (`whop_launch_unconfirmed`), because reverting would send paid
    clicks to the white page while Whop spends. Saving the result once Whop is live is retried, and if it still fails the
    campaign stays `LAUNCHING` too (`whop_launch_unrecorded`). A relaunch goes on only once the old Whop campaign is
    confirmed paused, a draft or gone (a second campaign must never run beside a live one).
  - **Status sync is conservative by construction.** Only an explicit answer from a successful read changes a campaign, and
    every write is conditional on the row still being what the tick read (`UPDATE … WHERE id, status, whop_campaign_id`;
    mirrors on the Whop id they mirror), so a buyer's pause here, or a relaunch that swapped the Whop campaign between read
    and write, loses nothing. A rejected ad (or `all_ads_rejected` / `in_appeal`) → `META_REJECTED` with routing stopped, the same
    stop-and-release a Facebook `DISAPPROVED` ad triggers, **and the campaign is paused at Whop too** (best effort, and the buyer
    is told whether it worked): our redirect no longer sends it traffic, so a still-delivering ad would only burn money.
    Pause / resume are mirrored, and the edge config must follow: if it cannot be updated the status is given back and nothing
    is announced (a resumed campaign whose edge still says "inactive" would send paid clicks to the white page while it runs). **Deleted in Whop → archived only on the second consecutive tick**
    whose direct read says 404 (the first leaves a `not_found` marker in `whop_delivery_status`; any real answer clears it):
    archiving is one-way and releases a channel, and one wrong answer from an API we only partly control must not do that to
    a live campaign. No connection, a broken key, an outage, unreadable ads: skip. A pass is bounded (5 minutes, and it stops
    after three businesses in a row fail to ANSWER: a rate limit or a rejected key is Whop answering) and fair (stable order,
    random start, so a stopped pass does not starve the same businesses every time). The company switch is **not** consulted:
    a live campaign must keep being watched even after a company's Whop switch is turned off.
  - **Stopping routing is durable, and in the one safe order.** Rejection and archiving are one-way and the campaign then
    leaves the scan, so two effects that can fail afterwards (the API is deploying, the KV is down) must not be lost. They are
    done edge-first: the edge config is re-published (it then stops emitting the channel), and only then is the channel released
    (it can be handed to someone else at once, so releasing first could credit the next holder with a rejected page's clicks:
    the Facebook path's own B1 comment names that risk and only logs it). If the edge cannot be updated the channel stays held,
    and that is the marker: every pass begins by finishing the routing of stopped Whop campaigns that still hold a channel. The
    buyer is told what actually happened.
  - **A launch that went quiet is settled from Whop's own word.** After 15 minutes without a write to the campaign, its ad
    sets or its ads (a live launch touches the row each time it saves an id) the sync asks Whop what became of it: past draft
    → completed here (`ACTIVE`, or `PAUSED` if paused meanwhile; audited; the buyer told it is live); a draft, or no Whop
    campaign → back to `PROCESSING` with the ids kept, so a relaunch continues; a campaign Whop says does not exist → the same,
    after two consecutive misses; unreadable → left alone. (The first version reset every quiet launch to `PROCESSING` without
    asking, which is wrong exactly when the launch had succeeded and only its save had failed.)
  - **Spend: our own events weigh the revenue split, Whop's count is only the fallback, and recorded spend is never erased.**
    Whop reads are windowed per IST day into `ad_stats_daily`. Revenue is split (D8) by the ad's conversions. Every ad has its
    own go-link, so our first-party ad-click events map to exactly one ad and are exact; Whop's `submitted_applications` (its
    last-click count of the same event, which lags and matches only a subset) is used for a campaign-day only when we
    recorded none. One scale per campaign-day, never per ad. (The first version preferred Whop's `results`; Whop's OpenAPI
    spec shows `results` follows the ad group's optimization goal and is null when goals differ, while
    `submitted_applications` is the field for our money event, and ours are the more complete count.) A row is written only
    when Whop reports something for the ad and day: after a relaunch our ad row points at a new Whop ad with no history, and
    "zero" for the days before it existed must not overwrite what the old ad really spent. "Reported" is decided from Whop's own
    figures alone, never from our conversion count (a first version let our events make an idle Whop day look reported, which
    zeroed a relaunched ad's spend whenever we held any event for that day); on such a day only the conversion count refreshes.
    Our events are counted by `createdAt`, the day Analytics counts them by and the column the index is on.
  - **Switching a campaign's network keeps what the new network cannot run, visibly.** A special ad category is a compliance
    declaration; a placement or bid strategy shapes delivery. Dropping them silently on a Facebook → Whop switch (as the first
    version did) meant the shared gate that exists to refuse them could never fire and the campaign went out without the
    declared category. Now they are kept, marked "not on Whop", and reported by `whopUnsupportedProblems` (Review, the switch
    message, an inline warning) until the buyer removes them or switches back; only what belongs to the other network is cleared
    (account, page, pixel, schedule, display links), and the buyer is told what was.
  - **Budget floor $1.00, and a live edit sends only the amount.** Whop documents no minimum. The draft schema already refuses
    under $1.00 for every network, so the wizard uses that (a lower figure used to pass the wizard and fail the save with a bare
    "Validation failed"); Whop's own, higher minimum is said at launch in its words. A live edit sends only `budget_amount`:
    per the spec Whop refuses a change of budget type or optimization once launched.
  - **Disconnect is refused while a campaign is live on the business.** Without the key we could not pause it.
  - **One ads network, two labels.** Analytics names network-sourced columns "(FB)", "(Whop)" or "(FB/Whop)" by the rows in
    view (the registry keeps one definition per metric; labels are rewritten at render, unchanged for all-Facebook views).
- **Independent review, two rounds.** Three read-only reviewers (launch correctness, worker and money, web and regressions) went
  over the working tree before this was written up; two more then re-reviewed the rewritten worker code and the wizard. Their reports are model output: every claim was checked against the code (and Whop
  facts against Whop's OpenAPI spec) before anything changed. What held up and was fixed: the lost-activation and unsaved-result
  holes and the quiet-launch reset (above); a relaunch that replayed the old Whop campaign (the key epoch) and did not stop it
  first; connection resolution without an org check; a rejected key's late 401 breaking a connection the buyer had just
  reconnected; spend erased after a relaunch; weights on the wrong field; unconditional writes and a one-shot archive in the
  sync; side effects after a status change that could skip each other; an unbounded pass; and in the wizard a $0.01 floor the
  server refuses, selections that outlived their connection, labels for a business that was no longer the one picked,
  Instagram accounts offered as pages, duplicated issue lines, and a provider switch that kept schedules and old server errors.
  The second round found, and fixed: spend erased whenever we held our own conversions for the ad-day (the worst: it made the
  never-erase rule false exactly after a relaunch); three failing businesses starving everything behind them in a fixed order,
  and a rate limit counted as an outage; side effects after a stop that could be lost for good and a notice that claimed a
  channel was released when it was not; a stale-selection effect that would have let a company admin's Save wipe a buyer's Whop
  business (it now applies to the campaign's own buyer only); a network switch that silently dropped a declared category;
  tooltips that called our own recorded ad clicks "Whop's count"; stale Facebook labels after a round trip; and a Whop switch
  turned off after a draft existed.
- **Proven:** the mock Whop over real HTTP + real Postgres: launch (campaign, group, creative upload, ad, activate), resume
  after a failure mid-way without duplicates or re-uploads, payment-method refusal then success, rate limit → `BATCHED`,
  broken key, a campaign deleted in Whop, a lost activation answer and an unreadable one, an unsaved result, two launches at
  once (one Whop campaign), relaunch and reopen-then-relaunch with fresh keys, pause / resume / budgets, disconnect guard; the
  status sync (42 tests: CAS against a change made mid-tick, two-strike archive, pause-on-rejection and its failure, the
  edge-first stop and its repair, stuck-launch verdicts, breaker, fairness and budget), the spend pull (22: never erases, even
  with our own events, own-first weights, Whop fallback, conversions-only rows, fairness), connection handling (17) and FX (3),
  including the revenue split using those rows; the wizard in a browser against the real API and the mock Whop (floor,
  pickers, issue list, broken and deleted connections, provider switch), and a real launch that ends in the pixel preflight's
  "could not load" message, recorded on the campaign and shown on its page. `pnpm --filter @knn/whop sandbox-check` replays
  the Whop flow against the real sandbox (13 checks, including that a deleted campaign reads as `not_found` and leaves the list).
- **Not known until real delivery** (`OPEN_QUESTIONS.md` #15): Whop's minimum budget and the exact payment-method and
  agreement refusal texts (the sandbox business has no payment method, which is also what stops a real launch there); video
  creatives; how long Meta's review takes and what a rejection message says; whether a server event is attributed.
- **Not done on purpose:** no automatic re-drive of `BATCHED` campaigns on this branch (a manual launch is the retry; the
  automatic, capped one is D31 on another branch, see the merge note); Whop country / hour breakdowns are not pulled;
  webhooks and a payment-retry button are phase 4.
- **Merge note for D31** (the `BATCHED` re-drive sweep, worktree `clever-elion-46b8d7`, not merged here): it picks `BATCHED`
  campaigns with `fbCampaignId` null in auto-launch companies and calls `POST /api/internal/launch/:id`. A Whop campaign
  always matches, and that is fine, even good: the call goes through `launchCampaign`, which routes by provider, and a Whop
  launch is resumable and claim-guarded, so a re-drive never duplicates anything (D31's own "known gap", an unresumable
  Facebook build, does not exist for Whop). Keep its eligibility free of `fbCampaignId != null` meaning "launched", and expect
  a textual conflict in `apps/worker/src/index.ts` (both branches add crons) and `launch-trigger.ts` (its comment).

### 2026-10-01 — D34: A resumed campaign gets a channel back (the rollover takes a paused campaign's)

**Problem.** The 00:05 IST rollover releases the channels of every campaign that is not in a holding state
(`PROCESSING / LAUNCHING / ACTIVE / BATCHED`), and `PAUSED` is not one: a paused campaign must not sit on a channel the pool needs.
But nothing gave one back on resume, in either provider. A campaign paused across midnight came back `ACTIVE` holding nothing:
its money-page clicks had no AFS channel and its revenue went unattributed (staging showed all 49 paused Facebook campaigns
holding 0 channels, so every one of them would have resumed that way).

**Decision.** Keep releasing paused campaigns' channels (the pool stays honest) and re-acquire on resume, two ways:
1. **Resume asks (`requestChannelsForResumedCampaign`, API).** After the status change and the edge sync, `setCampaignActive`
   (Facebook) and `setWhopCampaignActive` enqueue the existing `rebalance` job: assign what is missing (same
   `SKIP LOCKED` claim, same same-day cooldown D25, status untouched on an ACTIVE campaign) and re-publish the edge config so it
   carries the channel. Best-effort: the resume already succeeded. Bulk resume goes through the same function.
2. **A sweep catches the rest (`restoreChannelsForActiveCampaigns`, worker).** Every 30 minutes, after both status reconciles,
   every `ACTIVE` campaign with a PAID offer lacking a channel is given one (`assignOfferChannels(id, { queue: false })`) and its
   edge config re-published. This covers a resume made in the network's own dashboard and mirrored by the sync, a lost request,
   and an empty pool (retried each pass).

**Why never queue or change status.** The campaign is live at the network. Queuing it (`QUEUED_NO_CHANNEL`) would not stop the
spend, only hide it, and `ACTIVE -> PROCESSING` is not a legal move. It stays `ACTIVE` and is served when a channel frees up.
Clicks in that gap carry no channel; the sweep (at most 30 minutes) bounds it when a channel is free.

**Not changed:** channels are still released at rollover for PAUSED, `META_REJECTED`, etc.; a same-day pause/resume keeps its
channel (the release only happens at midnight).

### 2026-10-01 — D35: every buyer's data is in IST days, whatever timezone their ad account or Whop account uses

**Requirement (Aman):** many buyers, each with their own timezone settings on Meta and Whop; the numbers in our tool must be IST-perfect regardless.

**Audit (what decides a "day" at each source):**
- **Whop** — already independent of the buyer. Every spend read sends an explicit window (`stats_from` / `stats_to` = the IST day's bounds as UTC instants) and `time_zone=Asia/Kolkata`. The account timezone setting in Whop's dashboard only changes what Whop's own screens show, its daily-budget reset and the times typed into its own scheduler. Our scheduled start/end times are exact instants.
- **AdSense** — one platform account; its report days are IST-like (checked earlier), the same for every buyer.
- **Facebook** — was NOT independent: insights days are labelled in the ad account's timezone (open question #14). With buyers on other zones, spend landed on the wrong day against that day's revenue (a Los Angeles "Sept 30" is 12:30 IST Sept 30 to 12:30 IST Oct 1).

**Decision.** `ReadAuth` now carries the ad account's timezone. If it keeps IST's clock all year (`sharesBusinessClock`: IST and its `Asia/Calcutta` alias) the daily read is unchanged. Otherwise the pull asks Facebook for the **hourly** breakdown over the IST window widened by one account-day each side (never past the account's own today), places each hour at its real instant (`zonedInstantUtc`, DST-safe) and sums it into the IST day it falls in (`rebucketHourlyToBusinessDays`); days outside the window are dropped. The same rows feed the Analytics hour drill-down (shown in ad account time, as labelled), so there is no extra call. Cost: the hourly read is up to 24x the rows of the daily one, only for non-IST accounts, still through the per-account rate limiter.

**Not covered:** the Analytics country drill-down for a non-IST account is still labelled in account days (display only; it never feeds spend, revenue or ROI). Unreadable hour labels are skipped and logged, never guessed.

**Unverified against live Facebook:** staging has no launched campaign on a non-IST account. The hourly call is the same request the existing hour drill-down already makes for IST accounts; the re-bucketing is proven by unit and integration tests (including a conservation test and a DST test), not by a live non-IST account.

### 2026-10-01 — D36: Whop spend and AdSense revenue refresh every 15 minutes; Facebook stays hourly

**Why.** Aman asked for fresher Whop and AdSense numbers. Their quotas are not the limit (Whop: 600 requests a minute per operation and key, paced by us at 500, and a pass is one or two reads per business; AdSense: one report per AFS account per pass, against a project cap of 500/min and 10,000/day: about 100 calls a day per account at this cadence). Facebook is: about three insights calls per campaign per pass against per-ad-account limits, which is why it is not touched.

**What runs.** A new `ATTRIBUTION` job kind `fast` on cron `0,30,45 * * * *` (IST); the hourly pass at :15 reads the same two sources, so together they are read every 15 minutes. `runFastAttribution`: Whop spend for today (plus yesterday's Whop spend in the first 6 hours of the IST day, like the hourly pass), AdSense revenue for today, then revenue allocation for today from the latest rows of every provider. Same upserts as before, so running it more often cannot double anything. The queue still runs one attribution job at a time.

**Guards (`shouldRunFastJob`).** A `fast` job that waited more than 10 minutes behind a long Facebook pass is dropped (the next is already due), and one that starts within 5 minutes of a full pass or of the previous quarter-hour pass is skipped, so jobs never run back to back after a backlog and the 00/06/12/18 finalization is not repeated seconds later.

**Freshness indicator.** The buyer-facing "last updated" (`sync.metrics.at`, hourly hint) is deliberately still written only by the hourly and finalization passes, so a Facebook campaign never looks fresher than it is. The quarter-hour pass writes its own `sync.metrics_fast.at` (not shown in the UI yet; the hint is therefore pessimistic for Whop-only buyers).

**What it cannot fix.** The sources' own lag: Whop's figures for a window arrive hours late and AdSense's estimates are revised for days, so many quarter-hour reads will return the same numbers. That is why the 6-hourly finalization re-reads (3 days Whop, 8 days AdSense) stay.

### 2026-10-01 — D37: password reset without email — an admin issues a single-use link

**Problem.** There was no way to reset a password (no "forgot password", no admin action, no email service): a password was only ever set when the account was created, so a buyer who lost theirs was locked out.

**Decision.** An admin issues a **single-use reset link** and hands it over any channel (WhatsApp, Telegram, Slack...). The user opens it and chooses their own password, so the admin never learns it. Nothing needs email.
- **Who may issue:** a SUPER_ADMIN, for anyone except another super admin; a COMPANY_ADMIN, for the MEDIA_BUYERs of their own company only. Never yourself ("ask another admin"). A company admin resetting a peer admin would be an account takeover between peers, and another company's users are invisible (RLS 404). A locked-out super admin uses the existing `pnpm db:reset-admin` (`packages/db/scripts/reset-superadmin.ts`).
- **Token:** 256 random bits, returned to the admin ONCE and stored only as a SHA-256 hash (`password_reset_tokens`, migration `20261001150000`, RLS like `refresh_tokens`). Valid 24 hours, single use. Issuing a new link deletes the user's earlier unused ones.
- **Using it (`POST /api/auth/reset-password`, public, rate-limited like login):** the link is claimed atomically (`updateMany` on "unused and not expired", so two requests with one link cannot both win); every failure (unknown, used, expired) gives the same message; a too-short password is refused BEFORE the link is claimed, so a typo does not burn it. On success the password changes and every refresh token of the user is revoked (signed out everywhere; an access token already issued runs out on its own within minutes). The account's approval status is untouched: a suspended or pending user still cannot sign in.
- **Link format:** `<this site>/reset-password#<token>`. The token sits in the URL **fragment**, which browsers never send to a server or in a Referer header; the page reads it once and removes it from the address bar.
- **Audit:** `user.password_reset_issued` (actor = the admin) and `user.password_reset_completed` (actor = the user). The issue response is `Cache-Control: no-store`.
- **UI:** "Reset password" on the Team page (company admins for their buyers, platform for anyone) and on the Companies member list; a dialog shows the link with "Copy link" and "Copy as message" (a ready sentence for chat).

**Not built (deliberately):** a self-service "forgot password" (no safe way to prove identity without an email/SMS channel) and a logged-in "change my password" screen (separate, small; say so if wanted).

### 2026-10-01 — D38: a Whop click must carry something Meta fills in at click time (observe first)

**Problem.** For a Whop campaign the money page was gated on Whop's own signals: a well-formed `wacid` / `wasid` / `waid`, or
`utm_whop=true`. All of them are fixed text in the ad's link, so anyone holding the link (a reviewer, a scraper, a spy tool) matches.
A Facebook campaign is gated on `fbclid` (Meta adds it per click) and, when enforced, the `kaid={{ad.id}}` macro; neither applied to Whop.

**What the data showed (staging, 529 real Whop money-page views).** `fbclid` is on 526 of them. 416 carry Whop's ids, and all 416 also
carry Meta's real numeric ad id in `utm_meta_ad_id` (plus ad-set id, campaign id, placement): Whop writes Meta's `{{ad.id}}` placeholder
into the link and Meta fills it in when someone clicks.

**Decision.** A new check for a Whop config (`whopDynamicOutcome`, `apps/redirect/src/whop-click.ts`): `match` = an `fbclid` or a numeric
`utm_meta_ad_id`; `mismatch` = `utm_meta_ad_id` present but not a number (the placeholder was never filled in: template, preview,
copied URL); `missing` = neither. It is recorded in the existing cloaker counters (`verified_match` / `verified_mismatch` /
`macro_missing`; no schema change). A separate switch, `WHOP_GATE_MODE` (`observe` default | `enforce`, in `wrangler.toml`), decides
whether it routes:
- **observe (live default):** routing is exactly as before; the counters show what enforce WOULD turn away.
- **enforce:** a Whop click without a `match` goes to the white page. Flip it only when the counters show real clicks are all `match`.

It is independent of `CLOAK_VERIFY_MODE` (the Facebook ad-id gate) and does nothing to a Facebook campaign. It is a shape check, not an
exact match: Whop creates the Meta ad, so we cannot know its id beforehand, and a deliberate faker can type a number. It stops the link
template, previews and copied URLs. A stricter later step (pin an ad's Meta id from its first real clicks and require it) is not built.

**Rollout.** Deploy the Worker (`cd apps/redirect && pnpm dlx wrangler deploy`; read the variables list: `WHOP_GATE_MODE` appears as
`observe`). Watch Platform → Cloaker for the Whop campaigns for a day or two. Enforce only after `mismatch` + `missing` are a rounding error.

