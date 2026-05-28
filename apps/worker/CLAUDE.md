# @knn/worker — background jobs (BullMQ + node-cron)

Runs all async/scheduled work: stats pull, revenue attribution, channel maintenance, FB launch,
token refresh, article generation, meta-rejection checks, notifications.

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
- **AdSense is injected + dormant** — `AttributionDeps.fetchAdsense` is undefined by default (AFS
  access is OPEN_QUESTIONS #4/#13), so `pullAdsenseRevenue` cleanly no-ops; tests inject fakes.
  Multi-currency (D15): native spend/revenue + a USD field via the daily `FxRate` (`fx.service.ts`).
- **FB calls go through the per-ad-account rate-limit queue** (D12) with backoff + circuit breaker;
  respect the `BATCHED` state. The SDK does no backoff itself.

**Testing footgun:** worker tests share one Postgres and use GLOBAL (cross-org) scans (channel pool,
meta-rejection, attribution), so `vitest.config.ts` sets `fileParallelism: false` — don't re-enable
it or files will leak fixtures into each other's scans. (Cross-*package* concurrency can still surface
a caught "FB stats pull failed" log from a foreign campaign — benign; per-campaign errors are caught.)
