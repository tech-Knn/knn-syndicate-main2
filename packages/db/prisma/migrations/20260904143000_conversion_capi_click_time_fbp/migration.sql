-- Add fields required to fix CAPI attribution (missing conversions).
--   click_time_ms: original FB-ad-click time (unix ms) — feeds the middle field of the
--     `fbc` identifier. Previously the dispatcher used `event_time` (conversion time)
--     here, which yielded `fb.1.<CONVERSION_TIME>.<fbclid>` and Facebook rejected the
--     attribution ("Server sending modified fbclid value" in Events Manager).
--   fbp: server-minted `_fbp` browser id passed through from the edge KV click record
--     (pure-S2S — no in-browser Meta pixel). Boosts Event Match Quality.
-- Both nullable → any pending rows written before this migration keep working (the
-- dispatcher falls back to `event_time` for legacy rows).

ALTER TABLE "conversion_events" ADD COLUMN "click_time_ms" BIGINT;
ALTER TABLE "conversion_events" ADD COLUMN "fbp" TEXT;
