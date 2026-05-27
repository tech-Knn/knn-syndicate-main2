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
- **Attribution (D8)**: pull AdSense revenue per channel (= per campaign), pull FB conversions per
  ad, then split campaign revenue across ads by conversion share via `allocateByWeights`
  (`@knn/shared`). Apply the zero-conversion fallback (OPEN_QUESTIONS #1).
- **FB calls go through the per-ad-account rate-limit queue** (D12) with backoff + circuit breaker;
  respect the `BATCHED` state. The SDK does no backoff itself.

Phase 0 ships a HEALTH-queue heartbeat + a stubbed midnight cron only.
