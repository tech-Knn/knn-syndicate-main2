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

**Testing footgun:** worker tests share one Postgres and use GLOBAL (cross-org) scans (channel pool,
meta-rejection, attribution), so `vitest.config.ts` sets `fileParallelism: false` — don't re-enable
it or files will leak fixtures into each other's scans. (Cross-*package* concurrency can still surface
a caught "FB stats pull failed" log from a foreign campaign — benign; per-campaign errors are caught.)
