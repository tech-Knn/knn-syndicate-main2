-- Per-term RSOC telemetry (observe-only). AdSense v2 reports have no per-query/term dimension, so
-- term-level performance is only observable client-side: when a visitor clicks a related-search
-- chip → /search?q=<term>, the page beacons whether Google served ads (fill) + whether an ad was
-- clicked. Aggregated per term per IST business day. Platform-wide; super-admin visibility only.
-- Self-dormant: no client telemetry URL configured → no rows written.
--
-- NB: hand-written (migrate diff also re-emits the pgvector `DROP INDEX articles_embedding_idx`
-- and a redirect_domains id-default tweak — both stripped here as unrelated noise).

-- CreateTable
CREATE TABLE "term_stat_daily" (
  "id" UUID NOT NULL,
  "term" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "searches" INTEGER NOT NULL DEFAULT 0,
  "fills" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "term_stat_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "term_stat_daily_term_day_key" ON "term_stat_daily" ("term", "day");

-- CreateIndex
CREATE INDEX "term_stat_daily_day_idx" ON "term_stat_daily" ("day");
