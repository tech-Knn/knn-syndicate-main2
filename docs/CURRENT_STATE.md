# Current State

> Update at the end of every session. A new session should read this first (after `CLAUDE.md`).

_Last updated: 2026-05-28 — **Conversion tracking (D20) DEPLOYED to staging** (commit `8eae32e`; gate green; `conversion_events` migration applied on the box, `/api/events` live + returns 204, article rebuilt with `NEXT_PUBLIC_EVENTS_URL` baked into the `/search` bundle, worker CAPI_DISPATCH consumer running). The funnel is now end-to-end: `/search` infers the AFS final-ad click → beacons `POST /api/events` → resolves click→pixel+buyer-token → fires **Facebook CAPI S2S** via the worker. **Back-end click resolution is inert on staging until `CLOUDFLARE_*` (KV) is set + the edge Worker is redeployed via wrangler** (verified: the beacon 204s and logs `KvNotConfiguredError`, as designed). Also done this session: **Phase 9 (stats & revenue, D8/D15) + OpenAI article generator** (deployed to staging). Phases 0–8 done; legacy Node redirect retired (#18). Articles generate via **OpenAI `gpt-4.1-mini`**; needs `OPENAI_API_KEY`. Next: Phase 10 (dashboards). **Live deps:** AdSense AFS + Google OAuth (#4/#13, `@knn/adsense` dormant); CF KV token (click-log + redirect sync), FB test account, `NEXT_PUBLIC_EVENTS_URL` (conversion beacon), OPENAI/INTERNAL_API_* envs._

## Conversion tracking — D20 (committed `8eae32e`; DEPLOYED to staging; back-end inert pending CF KV token)

End-to-end FB conversion signal. The final ads sit in a cross-origin Google iframe so we **infer** the
click the way production AFS trackers (ClickFlare) do, then fire **Facebook Conversions API (CAPI) S2S**.

- **Detector** `apps/article/app/search/conversion-tracker.tsx` (client): on a `message` event, fire once
  if `event.origin` startsWith `https://syndicatedsearch.goog` **and** `document.activeElement` is an
  `IFRAME` **and** not already fired (`sessionStorage knn_conv_fired`) → `sendBeacon` the public events URL
  with `click_id`(=txid)/`value`/`currency`/`url`. Inert unless `NEXT_PUBLIC_EVENTS_URL` is set (baked at
  build — wired through `deploy/Dockerfile` ARG/ENV + compose build args + `.env(.staging).example`).
- **txid threading:** edge Worker (`apps/redirect/src/worker.ts`) now writes `click:{txid}` →
  `{redirectId, fbclid, ts}` to KV (`waitUntil`, 7-day TTL) **only when paid && redirect active**. The
  redirect already threads `txid` → `/a/[slug]` (`related-search-unit.tsx` adds it to the results-page URL)
  → `/search` (`page.tsx` reads `txid/cv/ccy`) → the beacon. The click id is the multi-tenant join key.
- **API** `apps/api/src/modules/events/` — public `POST /api/events` (`events.routes.ts`, query-param
  beacon, always 204, captures ip/ua). `events.service.ts#recordConversion`: KV `readClick` (added to
  `apps/api/src/lib/kv-sync.ts`) → `Ad`(redirectId) → `orgId`/`AdSet.pixelId`+`pxeEvent`/`campaignId`;
  persists a `ConversionEvent` (RLS, `clickId @unique` = idempotent) `pending` (pixel resolved) or
  `skipped` (no pixel); enqueues `CAPI_DISPATCH` (`jobId capi:{id}`, attempts 5, exp backoff) when pending.
- **Worker** `apps/worker/src/capi-dispatch.ts#dispatchConversion` (CAPI_DISPATCH queue, concurrency 4):
  loads the event, resolves the **fresh** buyer token (campaign.buyer → `FbConnection`, decrypted —
  handles rotation since ingest), builds the `CapiEvent` (`event_id=clickId` dedupe, `pxe`→event name,
  `fbc=fb.1.{ms}.{fbclid}`+ip+ua, value/currency), POSTs `@knn/fb/capi.ts` `sendConversionEvent`
  (`/{pixelId}/events`). Success → `sent`+`sentAt`. **Terminal `failed`:** no pixel, broken conn (err 190).
  **Retry (rethrow, stays `pending`):** rate-limit/transient. Already-`sent` → no-op.
- **Schema:** `ConversionEvent` (migration `20260528100449_conversion_events`, RLS `tenant_isolation`,
  pgvector DROP stripped) — `clickId @unique`, `pixelFbId`, `eventName`, `valueMinor`/`currency`,
  `clientIp`/`clientUa`/`eventSourceUrl`/`eventTime`, `status`/`attempts`/`fbResponse`/`sentAt`.
- **New code:** `@knn/shared/conversions.ts` (`pxeToFbEvent`, `buildFbc`), `@knn/fb/capi.ts`,
  `QUEUES.CAPI_DISPATCH`. **Gate green:** typecheck 12 ✓, lint 12 ✓, test (worker 35 incl. capi-dispatch 5,
  api 67 incl. events 4, fb 23 incl. capi 3, shared 57 incl. conversions 4), build 4 ✓.
- **Deployed (2026-05-28):** shipped `8eae32e` to the box, set `NEXT_PUBLIC_EVENTS_URL=https://app.staging.rsoc.app/api/events`
  in `.env.staging`, rebuilt the image (article bundle confirmed to inline the URL), `up -d` ran the
  `conversion_events` migration (RLS=true, pgvector index intact). Smoke: `POST /api/events` → 204;
  `/api/internal` still 403; worker boots the CAPI consumer cleanly.
- **Progress (2026-05-28, second pass):** OpenAI key persisted on the box (validated live, api+worker carry
  it). Edge Worker **redeployed** via wrangler (version `4f902640`, KV binding `REDIRECTS` 0480a994…) — the
  `click:{txid}` write is live. **Funnel + click-log proven live** by a KV round-trip: seeded one
  `redirect:{id}`, hit `go.10linesabout.com/go/…?fbclid=…` → 302 to the funnel article with
  `rc/ch/rac/styleId/txid` (not the fallback), and the Worker wrote `click:{txid}={redirectId,fbclid,ts}`
  (test keys cleaned up). `CLOUDFLARE_ACCOUNT_ID` + `CF_KV_NAMESPACE_ID` prefilled in `.env.staging`.
- **ONE thing left to FIRE conversions live (a CF account secret — user must create it; wrangler's OAuth
  lacks token-management scope so I can't mint it):** create a Cloudflare API token scoped **Account ›
  Workers KV Storage › Edit**, set it as `CLOUDFLARE_API_TOKEN` in `/opt/rsoc/deploy/.env.staging`, recreate
  `api`+`worker`. That single token unblocks BOTH the API's `readClick` (resolve click→pixel→fire CAPI) and
  the launch KV-sync (auto-write `redirect:{id}` configs so real campaigns serve the funnel like the test
  did). Until then the beacon 204s but the server logs `KvNotConfiguredError` → no CAPI fires.

## Article generation — OpenAI (Phase 9.5, amends D16)

Articles generate with **OpenAI `gpt-4.1-mini`** (`@knn/ai/openai.ts` `generateArticleOpenAI`, JSON mode)
— reverse-engineered from live competitors (creatorrule.com / goodprojectideas.com). Output:
`{title, teaser, body_markdown, related_search_terms}`. Skeleton = Define → Benefits → Concrete details
(numbers) → Steps → 3-Q FAQ, 8th-grade, ## headings. **The high-CPC monetization is `related_search_terms`**
(6 commercial-intent queries the model emits) → stored on `articles.related_search_terms` (migration
`20260528080854`) → fed to the content-page CSA `terms` (preferred over campaign keywords). Body renders
via `@knn/shared#articleBlocks` (safe h2/h3/p/ul/ol, no raw HTML); opening paragraph = lead above the AFS
unit. Compliance rewrite runs only when an admin `compliance_prompt` is set. Claude variants kept but not
default. Needs `OPENAI_API_KEY` (empty on staging → generation dormant; set it to go live).

## Phase 9 — Stats & revenue aggregation (code complete; gate green)

Four IST-day-keyed tables (migration `20260528070534_phase9_stats_revenue`; pgvector DROP removed,
RLS on the 3 org tables, `fx_rates` global): `ad_stats_daily` (FB insights per ad: imps/clicks/
conversions + native & USD spend), `campaign_revenue_daily` (gross AFS revenue per campaign, native &
USD, `afs_clicks`, `suppressed`), `ad_revenue_daily` (derived per-ad split: allocated/visible/margin +
`basis`), `fx_rates` (daily USD-per-unit). **Math** in `@knn/shared/money.ts`: `allocateCampaignRevenue`
(D8 conversion share → clicks → impressions → `unallocated`, largest-remainder exact-sum) +
`applyRevenueCut` (buyer override ?? org default) + `toUsdMinor` (D15). **FB insights** =
`@knn/fb/insights.ts` (`fetchAdInsights`/`extractConversions`, rate-limited). **AdSense** =
`@knn/adsense` (`fetchChannelReport`/`parseChannelReport`) — built + tested, **dormant** (injected
`fetchAdsense`, undefined by default; AFS access + Google OAuth pending, #4/#13). **Worker**
`src/attribution/` (`attribution.service.ts` + `fx.service.ts`): `runHourlyAttribution` (today),
`runFinalization` (trailing FB/AdSense windows §5.8); `ATTRIBUTION` queue + `:15`-hourly &
`*/6h` crons. All writes are upserts keyed on (entity, day) → re-pulls idempotent. **Gate met:**
worked examples ($50→1conv; $50→4conv=$12.50ea), zero-conversion fallback, EUR→USD conversion, `<10`
AFS-click suppression, buyer-cut override, and finalization idempotency (`attribution.test.ts`, real PG).
**Footgun fixed:** worker `vitest.config.ts` sets `fileParallelism:false` (global cross-org scans).

## Phase 8 — FB launch pipeline + meta-rejection (code complete; gate met vs mocked FB)

`launchCampaign` (`apps/api/src/modules/campaigns/launch.service.ts`): approved+channel'd campaign →
ensure article → write each ad's redirect config to edge KV (`lib/kv-sync.ts`) → create Campaign→AdSet→Ad
on FB **ACTIVE** (rate-limited, D12) → ACTIVE + notify + audit; FB rate-limit → **BATCHED**; idempotent;
no-channel → 409. Refactored the proven write-path into `resolveLaunchPlan`/`createFbStructure(status)`/
`persistFbIds` (shared with `testLaunchCampaign` PAUSED — folds in task #14). Route `POST /api/campaigns/:id/launch`
(admin). **Meta-rejection (D14):** `checkMetaRejections` (worker, `META_REJECTION_CHECK` queue + 30-min
cron) polls FB `effective_status`; DISAPPROVED → META_REJECTED + release channel + notify. KV env in
`@knn/config` (`CLOUDFLARE_*`/`CF_KV_NAMESPACE_ID`). **Gate met (mocked FB):** launch ACTIVE/BATCHED/
idempotent + rejection→status+notify+release. **Live = external deps** (CF token, FB test account, AI keys).

**Auto-launch (D19, done):** per-company `Organization.autoLaunch` toggle (default OFF = manual gate,
beside auto-approve on the Approvals page). When ON, `triggerAutoLaunch` (worker, `launch-trigger.ts`)
fires the instant a campaign acquires a channel — direct `assign` handler + queue-drain/rollover via an
`onAssigned` callback threaded through `processQueue`/`releaseChannelForCampaign`/`rolloverChannels`. It
gates on `autoLaunch && channelId && !fbCampaignId` → enqueues `FB_LAUNCH` (`attempts:1`, so a partial FB
failure can't double-create) → the worker POSTs the token-guarded `POST /api/internal/launch/:id`
(`x-internal-token`), which runs the same `launchCampaign` on the API (it owns the FB client + on-disk
creatives). Needs `INTERNAL_API_TOKEN`/`INTERNAL_API_URL` in the env. Tests: `launch-trigger.test.ts`
(gating + the HTTP call), an Approvals auto-launch toggle test, and launch-mode-aware notify wording.

## Phase 7 — Redirect engine (complete; deployed to the edge)

Decided on EDGE over single-origin (research: a single region can't hit <50ms globally). **Hono
Cloudflare Worker** (`apps/redirect/src/worker.ts` + `wrangler.toml`, KV namespace `REDIRECTS`
`0480a994…`) live on **`go.10linesabout.com`** (custom domain — scoped to `go`, main site untouched;
resolves to CF Worker IPs, not the origin). `/go/:id` → KV read (`redirect:{id}`) → pure
`resolveRedirect` (`src/resolve.ts`, 11 tests): paid (`fbclid`/`utm_source`) → 302 to the content page
with `rc`/`ch`/`rac`/`styleId` + minted `txid`; organic/paused/unknown → fallback; weighted split
supported. **Benchmarked ~20–25ms steady-state from EU** (Worker compute sub-1ms + KV 1–5ms; gate met).
`workers_dev=false`. **Legacy Node redirect RETIRED (task #18):** removed from the staging
compose + Caddy and deleted from source — `@knn/redirect` is Worker-only now (deploys via `wrangler`,
no origin `build`/`start`), so a stray route flip to the box can't serve unmonetized 302s.
**Remaining (Phase 8):** the origin→KV write-through sync (`redirect:{id}` config per ad) on launch +
a CF API token (Workers KV Edit) on the origin. One test KV key `redirect:test` exists (benchmark).

## Phase 6 — Channel pool & assignment (complete; gate green)

Global AdSense channel pool (`channels`, no RLS) assigned 1:1 to campaigns; per-campaign attribution
span (`channel_assignments`) + FIFO wait queue (`campaign_queue`) are org-scoped (RLS). Migration
`20260527211044_channel_pool` (the auto-generated `DROP INDEX articles_embedding_idx` was removed to
preserve the pgvector index). Service `apps/worker/src/channel-pool/channel.service.ts`:
`assignChannel` (FOR UPDATE SKIP LOCKED → PROCESSING, else enqueue + QUEUED_NO_CHANNEL),
`releaseChannelForCampaign`, `processQueue` (FIFO drain), `rolloverChannels` (IST midnight),
`seedChannels`. Worker runs the `CHANNEL_MAINTENANCE` queue (single writer) + the 00:05 IST rollover
cron; the API enqueues `assign` on approve/auto-approve. **Gate green:** the 100-concurrent stress
test asserts zero double-assignment; FIFO/release/resume/rollover covered (worker 9 tests). Pool via
`packages/db/scripts/seed-channels.ts` (placeholder ids; real AdSense channel ids = OPEN_QUESTIONS #4).

## AFS/RSOC funnel — VALIDATED LIVE (2026-05-28)

The monetization core is proven on a Google-approved domain (`articles.10linesabout.com`, AFS style
"Ajeet" `7465600436`, `partner-pub-6567805284657549`): the **content page** renders related-search
terms (after Google crawls it — the crawl is the hard gate, no bypass), clicking a term → **`/search?q=…`**
renders Google ads. Two-page RSOC via `_googCsa('relatedsearch'|'ads', …)` in `apps/article/app/_afs/csa.ts`.
Config matched to a live arbitrage funnel: `relatedSearchTargeting:'content'`, `referrerAdCreative` (←`rc`),
`ignoredPageParams`, `q` results param, `adsafe` (`NEXT_PUBLIC_AFS_ADSAFE`, default medium), `linkTarget:'_blank'`,
load callbacks. Running `adtest=on` (test mode) — flip off (rebuild) for real revenue. **Pre-warm/crawl an
article before driving FB traffic** (Phase 8). The competitor's `txid`→`/api/events` funnel = the Phase 7
(redirect click id) + Phase 9 (attribution, D8) blueprint. See `docs/DECISIONS.md` + memory `staging-deployment`.

## Phase 5 — Article engine + article frontend (complete; deployed; AFS validated live)

Built against **mocked AI** per the gate; live generation needs `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`
wired (external dep, like FB live-connect) — the clients throw `AiNotConfiguredError` until then.

- **`@knn/ai`** (new package): fetch-based clients (not vendor SDKs, mirroring `@knn/fb`) — `embedText`
  (OpenAI `text-embedding-3-small`, 1536-d), `generateArticle` + `complianceRewrite` (Claude Messages).
  Keys optional → `AiNotConfiguredError`. 8 unit tests (fetch-stub + mocked config).
- **Schema** (migration `20260527175343_article_engine`): `articles` (raw + compliant content,
  `embedding vector(1536)`, ivfflat cosine index, status, slug) + RLS `tenant_isolation`. Campaign
  links via the existing scalar `articleId`.
- **Engine** `apps/api/src/modules/articles/articles.service.ts`: `generateArticleForCampaign` embeds
  the campaign keywords/angle → **reuses** an existing org article when cosine ≥ 0.70 (raw-SQL `<=>`,
  scoped via `withTenant(campaign.orgId)` so reuse never crosses tenants) else **generates** (Claude) →
  **compliance rewrite** → stores both versions + the embedding → attaches to the campaign. Idempotent;
  audits `article.generated` / `article.reused`. Route `POST /api/campaigns/:id/article` (owner/admin).
- **Public read** `GET /api/public/articles/:slug` (no auth, `withSystem`, compliant content only) —
  backs the article frontend without a DB import in the Next app (build-safe).
- **Frontend** `apps/article`: SSR content page `app/a/[slug]` (title, ≤100-word/≤300-char teaser via
  `@knn/shared#articleTeaser`, **RSOC related-search unit**, full body, SEO `generateMetadata`) + results
  page `app/search` (the **ads unit**). Real Google CSA wired (see the AFS section above) — NOT a
  placeholder. Light editorial theme (AdSense-friendly). `robots.txt` allows content, disallows `/search`.
- **Gate green:** typecheck 11/11, lint 11/11, build 5/5, **128 tests** (shared 38 incl. teaser, ai 8,
  api 53 incl. 8 article-engine [generate / reuse / no-reuse / idempotency / authz / public]).
- **In-browser verified** (Preview MCP): seeded one article → `/a/<slug>?q=…&ch=…` rendered title +
  teaser + AFS slot (data-query/channel from the URL) + body, with the SEO title set. Demo data +
  scaffolding cleaned up.

## Phase 4 — Approval system (complete; gate green; verified in-browser; deployed)

- **State machine** in `@knn/shared/campaign-status.ts` — `CAMPAIGN_TRANSITIONS` (the canonical
  campaign lifecycle graph) + `canTransitionCampaign`/`nextCampaignStates`/`isTerminalCampaignStatus`.
  Single source of truth for api + worker; the complete graph is defined now, later phases wire
  routes/jobs to edges. 8 unit tests (legal/illegal transitions, terminal ARCHIVED, self-transition
  forbidden).
- **Schema** (migration `20260527165639_campaign_approval`, additive only — no RLS change):
  `organizations.auto_approve` (Bool) + `campaigns.{reviewed_by_id, reviewed_at, rejection_reason}`.
- **API** `apps/api/src/modules/campaigns/approval.service.ts` + routes: `GET /api/campaigns/pending`
  (admin review queue), `POST /:id/approve`, `POST /:id/reject` (reason required), `POST /:id/reopen`
  (buyer withdraw/revise → DRAFT). `submitCampaign` now honors org **auto-approve** (submit +
  immediate system approval). Admin `GET /api/admin/organization` + `PATCH /organizations/:id/
  auto-approve` toggle (SUPER_ADMIN any org; COMPANY_ADMIN own). `requireRole` guards admin routes;
  RLS isolates COMPANY_ADMIN to their org (cross-org review → 404).
- **Audit** — `apps/api/src/lib/audit.ts#writeAudit` is the **first writer** to `audit_log` (written
  in-txn with the change). Also retrofitted onto the existing admin actions (user status changes,
  org creation).
- **Web** (Phase 10 slice): admin-only **Approvals** page (`/dashboard/approvals`) — review queue
  with offer summary (objective/budget ABO·CBO/geo/keywords/special-ad-cat), Approve + Reject
  (inline reason), and a COMPANY_ADMIN auto-approve toggle. Nav shows "Approvals" for admins.
  Campaigns list shows the rejection reason + **Revise**/**Withdraw** (reopen) actions.
- **Gate green:** typecheck (10) · lint (10) · build (5, incl. both Next apps) · tests — shared 32
  (+8), db 6, fb 14, redirect 2, worker 5, **api 45 (+13 approval/reopen)** = 104 total.
- **In-browser verified** (Preview MCP, local web+api, seeded demo): logged in as a COMPANY_ADMIN →
  Approvals page rendered 3 pending campaigns → **Approve** (Auto Insurance → APPROVED), **Reject**
  with reason (Medicare → REJECTED, reason persisted), **auto-approve toggle** (org flipped to true).
  DB confirmed statuses + `reviewedById` + audit actions `campaign.approved/rejected,
  org.auto_approve.enabled`. (Demo data + scaffolding cleaned up afterward.)

## Audit of Phases 0–4 (2026-05-27)

Full cross-check against the plan's per-phase gates + decisions D1–D18 (two independent
sub-audits + mechanical checks). **Verdict: gates met for Phases 0, 1, 2, 4; Phase 3 PARTIAL.**
- **RLS:** all 13 business tables carry `tenant_isolation` (USING + WITH CHECK); only the global
  `platform_settings` is exempt (correct). Cross-org isolation proven by `rls.test.ts`.
- **No decision violations.** Prisma `CampaignStatus` ⇄ `CAMPAIGN_STATUS` match exactly (no drift).
- **Fixed during the audit:** FB sync now follows cursor pagination (`fetchAllPages`) — previously
  truncated at one page (>200 accounts/pages, >100 pixels); +2 tests. `FB_LOGIN_CONFIG_ID` added to
  `.env.example`.
- **Open gaps (tracked):** (1) **Playwright E2E missing** — Phase 3 gate names it; substituted by
  API integration tests + manual in-browser verification → recommend folding E2E into Phase 10
  (OPEN_QUESTIONS #8, task #16). (2) traffic split deferred to Phase 7 (OPEN_QUESTIONS #9).
  (3) LOW: suspension isn't enforced on a live access token until it expires (≤15m) — standard JWT
  tradeoff, self-heals at refresh; revisit in Phase 11. (4) LOW: `notify` is a console stub (real
  email is Phase 11; durable signal is entity state per D13).

## Phase 3 — Ad launcher (complete, deployed)

- **Schema** (migration `20260527135109_campaigns_adsets_ads`, RLS on all 4 tables): `campaigns`
  (the offer — keywords/RAC/article-ref/channel-ref, D5–D7), `ad_sets`, `ads` (unique `redirect_id`
  D9 + selectable `pxe_event` D10), `uploads` (creative assets). FB asset refs (ad account/page/
  pixel) are scalar so disconnect-churn can't cascade-delete campaigns.
- **Validation** in `@knn/shared/campaigns`: lenient `campaignDraftSchema` + strict
  `campaignSubmitIssues` gate (DRAFT → PENDING_APPROVAL). 8 unit tests.
- **API** `apps/api/src/modules/{campaigns,uploads}`: campaigns CRUD + submit (buyer-scoped;
  FB-asset ownership enforced; only DRAFT editable/deletable) and a validated multipart creative
  upload (type/size). 11 integration tests on real PG (incl. unique redirect ids, 422 issue list,
  buyer-scope 404). `AppError` now carries `details` for the submit-issue list.
- **Web** `apps/web/app/dashboard/campaigns`: campaigns list (status badges, edit/view/delete) + a
  3-step **launch wizard** (Offer → Ad sets & ads w/ creative upload + pixel/pxe → Review) that
  pulls the buyer's live FB ad accounts/pages/pixels, saves drafts, and submits (surfacing server
  issues). `next.config` `extensionAlias` lets Next resolve the shared package's `.js` specifiers.
- **Gate green:** typecheck (10) · lint · build (5) · tests (api 31, shared 22, fb 14, worker 5,
  db 6, redirect 2). **Deployed:** migration applied on staging; `/api/campaigns` + `/api/uploads`
  mounted (401), `/dashboard/campaigns` served (200).
- **Pending = your in-browser walkthrough** of the wizard with real FB data (I can't log into the
  authed dashboard — the super-admin password is custom and I won't fabricate a session). The
  wizard will list the 8 ad accounts you just connected.

## Facebook connect — verified live (2026-05-27)

A real BM completed the self-serve flow on staging: dashboard login → **Connect Facebook** → FLB
consent → callback → token exchange → 60-day long-lived token → synced **8 ad accounts** (USD,
Asia/Kolkata), pages, and per-account pixels; status **Connected**, all five scopes granted. Two
gotchas resolved on the way, worth remembering:

- **Facebook Login for Business needs `config_id`, not `scope`.** The app uses FLB (not classic
  login), so `buildAuthUrl` emits `config_id` (+ `override_default_response_type`) — set via
  `FB_LOGIN_CONFIG_ID` (staging value `26693255093680532`, the "Rsoc.app" login configuration).
  Classic scope-based login is the fallback when that env is empty.
- **`Error validating client secret` = wrong `FB_APP_SECRET`.** The dialog only needs App ID +
  config, so it succeeded while the server-side code→token exchange failed; fixing the secret fixed
  the connect. (Diagnose via `docker compose logs api` on the box — the callback logs the FB error.)

Self-serve connect works **now for app role-holders** (admin/testers); opening it to arbitrary
buyers is the App Review path (deferred — D-OQ: advanced access + Business Verification [done] +
Data Protection Assessment + privacy policy + data-deletion callback). Token renewal is automatic
via the worker's daily token-refresh job.

## Done

- Planning complete; 12-phase roadmap approved (see the plan + `DECISIONS.md` D1–D18).
- **Phase 0 — DONE (gate green).** Monorepo (pnpm + Turborepo, TS strict, ESLint flat, Prettier).
  `infra/docker-compose.yml` (Postgres 16 + pgvector 0.8.2, Redis 7) running via Colima.
  Packages: `@knn/config` (validated env, zod), `@knn/shared` (constants, IST datetime,
  conversion-weighted money allocator — 14 unit tests), `@knn/queue` (BullMQ + Bull-Board feed),
  `@knn/db` (Prisma 6 + pgvector + `platform_settings`, first migration applied + seeded). Apps:
  `@knn/api` (Fastify — `/health` checks db+redis, Bull-Board at `/admin/queues` behind basic
  auth), `@knn/redirect` (Hono — health + placeholder `/go/:id`, lean ioredis), `@knn/worker`
  (BullMQ heartbeat + IST midnight cron stub), `@knn/web` + `@knn/article` (Next 15, branded).
  Root + per-module `CLAUDE.md`, `/docs`, GitHub Actions CI.
  - **Verified:** typecheck (9 pkgs), lint (0 errors), test (20 passing), build (5 pkgs incl. 2
    Next builds), and **runtime of the built bundles**: api `/health` → `{db:up,redis:up}`,
    Bull-Board 401→200 with auth, redirect `/go/:id` → 302, worker boots on `Asia/Kolkata`.

- **Phase 1 — multi-tenancy + RLS foundation DONE (verified).** Schema: `organizations`,
  `users` (Role / UserStatus / OrgStatus enums), `refresh_tokens`, `audit_log` (migration
  `20260527075938_auth_multitenancy`). Real RLS: a NON-superuser app role (`knn_app`, created by
  `pnpm db:bootstrap`) so policies actually apply; per-transaction GUCs `app.current_org` /
  `app.bypass_rls` drive `tenant_isolation` policies on all four tables; `@knn/db` exposes
  `withTenant(orgId, fn)` and `withSystem(fn)`. **6 isolation tests pass** (cross-org reads return
  nothing, `WITH CHECK` blocks cross-org writes, `withSystem` sees all). App now connects via
  `APP_DATABASE_URL`; migrations use `DATABASE_URL` (owner).

- **Phase 1 — auth layer DONE (verified).** bcrypt(12) hashing, JWT access (15m, via `jose`) +
  DB-backed rotating refresh tokens (7d); routes `signup`/`login`/`refresh`/`logout`/`me`;
  signup→PENDING→admin approve/reject; `authenticate` + `requireRole` middleware; `runScoped`
  tenant guard; admin endpoints (create org + first company-admin, list/approve users). Seed
  creates the platform org + a SUPER_ADMIN (`super@knn.local`). **Phase 1 COMPLETE** — 35 tests
  pass (9 auth lifecycle + 6 RLS + …), plus an HTTP smoke on the built bundle (login → /me →
  admin all 200; unauth/bad-password 401); lint/typecheck/build all green.

- **Staging deployed to Hetzner (2026-05-27).** Box `rsoc-staging` (CPX32, Falkenstein, Ubuntu
  24.04, IP `178.105.241.185`) in the KNN project. Full stack runs via
  `deploy/docker-compose.staging.yml` and is **verified healthy** (all 7 services up, api
  `db:up/redis:up`, `knn_app` RLS role bootstrapped, super admin `admin@rsoc.app` seeded). Code in
  `/opt/rsoc`; secrets in `/opt/rsoc/deploy/.env.staging`. See memory `staging-deployment`.

- **Staging is LIVE with TLS (2026-05-27).** DNS on Cloudflare (zone `rsoc.app`; Namecheap NS →
  `damian`/`gina.ns.cloudflare.com`; staging A records grey-cloud → `178.105.241.185`). Caddy
  (`edge` profile) issued Let's Encrypt certs. Verified end-to-end over public HTTPS:
  - `https://app.staging.rsoc.app/` → 200 (dashboard) · `/api/auth/login` → 200 + tokens
  - `https://articles.staging.rsoc.app/` → 200 · `https://go.staging.rsoc.app/go/x` → 302
  - Super-admin `admin@rsoc.app` login works. See memory `staging-deployment`.

- **Phase 2 — Facebook integration DONE (gate green).** New `@knn/fb` package: AES-256-GCM token
  crypto, `fetch`-based Graph client, error classification (`FbConnectionBrokenError` /
  `FbRateLimitError` / `FbApiError`), per-ad-account `FbRateLimiter` (concurrency cap + exponential
  backoff honoring `x-business-use-case-usage` + circuit breaker — D12), OAuth (long-lived ~60d token
  exchange, `FB_SCOPES`), and account/page/pixel sync → DTOs. See `packages/fb/CLAUDE.md`.
  - **Schema** (migration `20260527104653_fb_integration`, RLS on all 4 tables): `FbConnection`
    (one per user, encrypted token, `status` ACTIVE/CONNECTION_BROKEN), `FbAdAccount`, `FbPage`,
    `FbPixel` (lander/search/adclick event slots for the D10 `pxe` selector, populated later).
  - **API** `apps/api/src/modules/facebook`: signed OAuth `state` (jose, 10m, purpose-checked);
    `GET /api/facebook/auth-url` (503 if FB unconfigured), public `GET /callback` (exchange → encrypt
    → upsert connection → best-effort sync → 302 back to `WEB_DOMAIN/dashboard/facebook`),
    `GET /status|/accounts|/pages|/accounts/:id/pixels`, `POST /sync`, `DELETE /connection`. All
    reads go through `runScoped` (RLS-scoped); the callback uses `withSystem` (no session yet).
    Sync fetches from FB **outside** any txn, then upserts in one txn (no open txn across network).
  - **Worker** daily `token-refresh` job (02:30 IST cron → `TOKEN_REFRESH` queue): extends tokens in
    a 10-day window, degrades expired/190 → `CONNECTION_BROKEN` + notify, nudges re-auth ~day 55 (D13).
  - **Verified:** typecheck (10 pkgs), lint (0), build (5). **Tests:** FB integration (7, real PG +
    mocked Graph — connect+sync, broken-token→CONNECTION_BROKEN+notify, scoped lists, auth guards),
    token-refresh (5, real PG + injected clock — extend/degrade/proactive), `@knn/fb` unit (12 —
    classification, BUC throttle→retryAfterMs, limiter backoff/breaker, DTO mapping).

## In progress

- Nothing — Phase 5 code-complete, gate green, verified in-browser. **Not yet committed or shipped to
  staging** (pending go-ahead). When deploying, the article service needs `ARTICLE_API_BASE` set to the
  API origin (e.g. `https://app.staging.rsoc.app`) so its SSR fetch reaches the public article API
  across subdomains; live article generation also needs `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`.
- Phase 4 is committed (`7bef2ca`) + deployed to staging; the FB-pagination audit fix is `b942263`.

## Next

- **Phase 6 (Channel pool & attribution-assignment)** — per-campaign channel assignment via
  `SELECT … FOR UPDATE SKIP LOCKED` in a single-writer worker (D11); FIFO queue; IST lock-for-day,
  release/resume rules, auto-pause → `QUEUED_NO_CHANNEL`; midnight cleanup cron (00:05 IST); history.
  **Gate:** 100-concurrent-approval stress test → zero double-assignment; queue FIFO; release/resume/
  rollover tests. This is where the approved → article → channel pipeline starts wiring together.

## Staging now runs Phase 2 with Facebook configured (2026-05-27)

- Shipped the Phase 2 tree to the box (`git archive HEAD` → `tar -x` into `/opt/rsoc`), set
  `FB_APP_ID` (906408948523489) + `FB_APP_SECRET` in `/opt/rsoc/deploy/.env.staging` (redirect URI
  was already `https://app.staging.rsoc.app/api/facebook/callback`), rebuilt `knn-app:latest`, and
  `up -d --build` (the `migrate` one-shot applied `fb_integration`). **Verified:** migrate exit 0 +
  "All migrations applied"; the 4 `fb_*` tables exist; api container has all 3 FB vars (so
  `isFbConfigured()` → true, `auth-url` no longer 503); public `GET /api/facebook/callback` → `302`
  to `/dashboard/facebook?fb_error=missing_code` over HTTPS.
- **Remaining = a human step (not code):** the live OAuth round-trip needs someone to open the
  `auth-url` and consent in a Facebook account that is an admin/developer/tester on the app, then
  connect a FB **test** ad account (D18 — never connect a real/prod ad account on staging). The app
  can stay in **Development mode** for this (no business verification needed for app-role users).
  for now trigger it via the dashboard's **Connect Facebook** button (see below).

## Dashboard auth shell + Facebook connect UI (2026-05-27, Phase 10 slice)

- Built a real (hand-crafted, no Tailwind/shadcn yet — that's the deliberate Phase 10 setup) UI in
  `apps/web`: `/login` (email+password), an `AuthProvider` with localStorage tokens + single-flight
  401-refresh, a guarded `/dashboard` shell (top nav, user chip, sign out), and `/dashboard/facebook`
  — **Connect** button (`auth-url` → FB dialog), connection status (scopes/expiry/connectedAt),
  synced ad accounts (expandable → pixels) and pages, **Re-sync**, **Disconnect**, and broken-state
  reconnect. Calls the same-origin `/api` (Caddy). Local dev: set `NEXT_PUBLIC_API_BASE=http://localhost:3000`.
- **Deployed to staging + verified in-browser:** `/login` renders (KNN dark theme, serif display);
  an unauthenticated `/dashboard/*` visit redirects to `/login` (client guard). Web build/typecheck/
  lint green; all 8 services healthy.
- **Tokens live in localStorage for now** (standard SPA pattern); Phase 11 hardening should move to
  httpOnly cookies. **The live connect is the user's step** — log in at
  `https://app.staging.rsoc.app/login`, open Facebook, click **Connect**, consent in a Facebook
  account that's an admin/dev/tester on the app, and pick a FB **test** ad account (D18). (Couldn't
  self-verify the authed flow: the staging super-admin password is custom and I won't fabricate a
  user in the shared DB.)

## New setup step

- After `pnpm db:migrate`, run **`pnpm db:bootstrap`** once per environment to create the
  non-superuser `knn_app` role that RLS depends on. (CI must run it before tests — TODO when we
  touch CI next.)

## Notes / gotchas for the next session

- Runtime Node is 25; `.nvmrc` pins 22. If a tool misbehaves, try Node 22.
- `pnpm db:*` scripts load the root `.env` via `dotenv-cli`.
- Bull-Board basic-auth creds are in `.env` (`BULL_BOARD_USER`/`PASSWORD`).
- External dependencies not yet provisioned: real domains, Facebook App + business verification,
  AdSense AFS API access, AI keys (see `OPEN_QUESTIONS.md`).
