# @knn/worker — background jobs (BullMQ + node-cron)

Runs all async/scheduled work: stats pull, revenue attribution, channel maintenance, FB launch,
token refresh, article generation, meta-rejection checks, conversion dispatch (CAPI), notifications.

## Invariants

- **Workers create their OWN Redis connection** via `createConnection()` from `@knn/queue` — never
  reuse the shared producer connection (BullMQ best practice).
- **Crons run on the business timezone** (`env.BUSINESS_TIMEZONE`, IST). Midnight channel cleanup
  is `5 0 * * *` IST (Phase 6). Daily revenue buckets/finalization use the IST business day.
- **Channel assignment is single-writer (D11)**: assign inside a txn with
  `SELECT … FOR UPDATE SKIP LOCKED`. Two campaigns approved at once must never grab the same
  channel. There's a 100-concurrent stress test guarding this (Phase 6).
- **Attribution (D8/D15, `src/attribution/`)**: pull FB insights per ad → `ad_stats_daily`
  (cost + the conversion signal); pull AdSense revenue per channel → `campaign_revenue_daily`
  (mapped to the campaign that held the channel that IST day via `ChannelAssignment.for_day`);
  then split each campaign's gross USD across its ads via `allocateCampaignRevenue` (`@knn/shared`)
  — conversions → clicks → impressions → `unallocated` (OPEN_QUESTIONS #1) — apply the revenue cut
  (buyer override ?? org default) → `ad_revenue_daily`. The `ATTRIBUTION` queue runs `hourly`
  (today) + `finalize` (trailing FB/AdSense windows, §5.8).
- **Storage is DAILY, not the plan's `ad_stats_hourly`** — attribution + AFS reporting are daily and
  FB's hourly breakdown is timezone-fragile; the cron PULLS hourly to keep "today" fresh. Day key =
  IST business day (FB uses the ad-account tz; OPEN_QUESTIONS #14).
- **Every revenue/stats write is an upsert keyed on (entity, day)** → finalization re-pulls are
  idempotent (no double counting). All attribution runs under `withSystem` (cross-org; rows carry org_id).
- **AdSense source = `liveAdsenseFetch`** (`attribution/adsense-source.ts`), the default
  `AttributionDeps.fetchAdsense`. It reads the platform `GoogleConnection` (super-admin's AdSense
  connect), refreshes the access token on demand, and pulls the per-channel report. **Self-dormant:**
  returns `[]` when not connected / no account / `CONNECTION_BROKEN`, and logs+swallows a failed report
  (so a transient AFS error can't fail attribution — FB cost stats still populate). Tests inject fakes;
  with no connection it no-ops exactly like the old dormant path (AFS access is OPEN_QUESTIONS #4/#13).
  Multi-currency (D15): native spend/revenue + a USD field via the daily `FxRate` (`fx.service.ts`).
- **FB calls go through the per-ad-account rate-limit queue** (D12) with backoff + circuit breaker;
  respect the `BATCHED` state. The SDK does no backoff itself.
- **Conversion dispatch (D20, `src/capi-dispatch.ts`, `CAPI_DISPATCH` queue):** fires Facebook CAPI for one
  `ConversionEvent`. The **pixel is frozen on the event at ingest**; the **buyer token is resolved fresh
  here** (campaign.buyer → `FbConnection`, decrypted) so a token rotated since ingest is used — never read
  the token at ingest. Error policy mirrors the launcher: broken connection (err 190) or missing pixel →
  **terminal `failed`** (do NOT rethrow — retrying can't fix it); rate-limit/transient → **rethrow** so
  BullMQ retries (status stays `pending`); already-`sent` → no-op. Idempotent on `event_id = clickId`
  (Facebook also dedupes against the in-browser pixel). Don't move token resolution earlier or add a retry
  on the terminal cases.
- **Whop dispatch (D33, `src/whop-dispatch.ts`, `WHOP_DISPATCH` queue):** the Whop sibling of the above. A
  `conversion_events` row with `provider = 'whop'` is reported to Whop's Events API with `@knn/whop`
  `buildWhopEvent`. The business, the landing URL and Whop's click ids are **frozen on the row at ingest**
  (`provider_context`), because this job cannot read the edge KV; the API key is resolved **fresh here**
  (the campaign buyer's own connection first). Policy by error KIND, never message text: `auth` (401) →
  terminal, flip the connection to BROKEN once + notify once; `permission` (403) → terminal, names the missing
  permission, connection stays ACTIVE; `validation`/`not_found`/`conflict`/`payment_required` → terminal;
  `rate_limited`/`server`/`network`/`timeout` → record and **rethrow** (BullMQ retries; the client itself
  retries only once). When BullMQ's retries run out, `failExhaustedWhopEvent` settles the row as `failed` so
  nothing sits `pending` forever (the CAPI path has no such handler). Events older than 27 days are never sent
  (Whop refuses 28). Idempotent: Whop keeps one copy of an `event_name` + `event_id` (= the click id). The
  Facebook and Whop paths never share a row, a queue or a retry policy: one row is one send.

- **Whop status sync + spend (D33 phase 2, `src/jobs/whop-reconcile.ts`, `src/attribution/whop-stats.ts`, `src/lib/whop-auth.ts`):**
  the Whop twins of the Facebook reconcile and insights pull, run inside the same crons (`META_REJECTION_CHECK` and
  `ATTRIBUTION`: no new queue; each provider runs independently, so one's failure never stops the other).
  - **Sync:** one bulk `listCampaigns` per business, `listAds` only for the campaigns it listed (a batch Whop refuses is
    re-read campaign by campaign; a campaign whose ads cannot be read is skipped, never decided on). Then: EVERY ad rejected (or Whop's
    `all_ads_rejected`) → `META_REJECTED` (pause at Whop best-effort, `stopRouting`, notify); SOME ads rejected → the campaign keeps
    running and the buyer is told once per ad (`campaign.ads_rejected`; unlike Facebook's D14), pause / resume mirrored (if the edge resync fails the
    status is given back and nothing is announced), deleted-in-Whop →
    `ARCHIVED` only on the **second consecutive** tick whose direct read says 404 (the first leaves `not_found` in
    `whop_delivery_status`; any real answer clears it), billing failure notified once per episode (`payment_failed` is stored
    in the delivery word, and the notice follows a successful mirror), Whop's words mirrored for display
    (`shared/whop-status.ts` is the table).
  - **Every write is conditional on what the tick read** (`updateMany` on id + status + `whop_campaign_id`; mirrors on the Whop
    id they mirror). Keep it that way: a buyer's pause, or a relaunch swapping the Whop campaign mid-tick, must never be
    overwritten. **`stopRouting` is edge-first:** re-publish the KV, and only then release the channel (released first, the
    next holder could be credited with a stopped campaign's clicks); each is tried three times (`afterMove`, injectable
    `sleep`). A stopped campaign is no longer in the scan, so nothing would retry a failure: `repairHeldChannels` runs first on
    every pass and finishes the routing of stopped Whop campaigns that still hold a channel (the channel is the marker). The
    buyer notice reports what actually happened.
  - **Safe defaults: no connection / broken key / outage / unreadable = skip, never archive or release.** 401 and 403 break the
    connection once (CAS on the key that failed: a reconnect is never undone by a late answer); transport failures do not. A
    pass has a 5-minute budget and stops after three businesses in a row fail to ANSWER (`nextTransportFailures`: a 429 is
    `limited`, a 401 is `fatal`, both are Whop answering and reset the run; an unusable key is `skipped`, neutral). Businesses
    are visited in a stable order rotated to a random start (`rotate`, `deps.rand`), so an early stop never starves the same
    ones. The company switch is not consulted (a live campaign must keep being watched); only the global `WHOP_ADS_ENABLED`.
  - **Stuck launches** (`LAUNCHING`, no write to the campaign, its ad sets or ads for 15 min) are settled from Whop's word
    (`launchVerdict`): past draft → `ACTIVE`/`PAUSED` + audit + "live" notice; draft or no Whop campaign → `PROCESSING` (ids
    kept); a 404 twice → `PROCESSING`; unreadable → wait. The marker write holds `updatedAt` still, or it would look alive.
  - **Spend:** per business per IST day (`time_zone=Asia/Kolkata`, `stats_to` = the last second of the day) into
    `ad_stats_daily`. `conversions` = our own first-party ad-click events per ad (counted by `createdAt`, like Analytics);
    Whop's `submitted_applications` only for a campaign-day on which we recorded none (one scale per campaign-day).
    **Never erases:** "Whop reported something" is decided from Whop's own figures ALONE (never from our conversion count) and
    only then is the row rewritten; otherwise only `conversions` refreshes (a conversions-only row if none exists). A
    relaunched ad has no history. Only campaigns Whop still lists are asked about.
  - The worker resolves a campaign's connection itself (`lib/whop-auth.ts`: by id **and org**, else the buyer's connection to
    the same `whop_biz_id`), mirroring the API. **Tests are global scans:** the Whop tests inject an `adsFor` that refuses any
    connection outside their own org, and clear their org's campaigns between tests, because an unrelated Whop campaign would
    otherwise read as "deleted".

**Testing footgun:** worker tests share one Postgres and use GLOBAL (cross-org) scans (channel pool,
meta-rejection, attribution), so `vitest.config.ts` sets `fileParallelism: false` — don't re-enable
it or files will leak fixtures into each other's scans. (Cross-*package* concurrency can still surface
a caught "FB stats pull failed" log from a foreign campaign — benign; per-campaign errors are caught.)
**Never assert on a GLOBAL aggregate** (e.g. `rolloverChannels().released`, the `processQueue()` count) —
the api package's tests run concurrently against the same DB and can inflate it. Assert your own fixtures'
observable state instead (your channel's `currentCampaignId`/status, your campaign's `channelId`, your
attribution spans). Phase 11 relaxed the rollover/queue tests this way; the api+worker concurrent run is green.
