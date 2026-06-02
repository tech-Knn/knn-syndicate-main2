-- Cloaker decision telemetry (observe-first ad-ID verification): money-vs-white per campaign/day
-- + the would-be-enforce outcome for paid clicks. (pgvector DROP INDEX + redirect_domains footguns stripped.)
CREATE TABLE "cloak_stat_daily" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "money" INTEGER NOT NULL DEFAULT 0,
    "white" INTEGER NOT NULL DEFAULT 0,
    "verified_match" INTEGER NOT NULL DEFAULT 0,
    "verified_mismatch" INTEGER NOT NULL DEFAULT 0,
    "macro_missing" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloak_stat_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cloak_stat_daily_day_idx" ON "cloak_stat_daily"("day");

-- CreateIndex
CREATE UNIQUE INDEX "cloak_stat_daily_campaign_id_day_key" ON "cloak_stat_daily"("campaign_id", "day");
