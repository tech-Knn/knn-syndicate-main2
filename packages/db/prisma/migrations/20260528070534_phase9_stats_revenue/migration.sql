-- NOTE: Prisma proposed `DROP INDEX "articles_embedding_idx"` (our pgvector ivfflat
-- cosine index on the Unsupported vector column it can't see). Removed to preserve it.

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_stats_daily" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ad_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "spend_minor" INTEGER NOT NULL DEFAULT 0,
    "spend_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_stats_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_revenue_daily" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "channel_ref" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "afs_clicks" INTEGER NOT NULL DEFAULT 0,
    "revenue_minor" INTEGER NOT NULL DEFAULT 0,
    "revenue_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_revenue_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_revenue_daily" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ad_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "allocated_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "visible_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "margin_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "basis" TEXT NOT NULL DEFAULT 'conversions',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_revenue_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_day_currency_key" ON "fx_rates"("day", "currency");

-- CreateIndex
CREATE INDEX "ad_stats_daily_org_id_day_idx" ON "ad_stats_daily"("org_id", "day");

-- CreateIndex
CREATE INDEX "ad_stats_daily_campaign_id_day_idx" ON "ad_stats_daily"("campaign_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ad_stats_daily_ad_id_day_key" ON "ad_stats_daily"("ad_id", "day");

-- CreateIndex
CREATE INDEX "campaign_revenue_daily_org_id_day_idx" ON "campaign_revenue_daily"("org_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_revenue_daily_campaign_id_day_key" ON "campaign_revenue_daily"("campaign_id", "day");

-- CreateIndex
CREATE INDEX "ad_revenue_daily_org_id_day_idx" ON "ad_revenue_daily"("org_id", "day");

-- CreateIndex
CREATE INDEX "ad_revenue_daily_campaign_id_day_idx" ON "ad_revenue_daily"("campaign_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ad_revenue_daily_ad_id_day_key" ON "ad_revenue_daily"("ad_id", "day");

-- Row-Level Security (D2). `fx_rates` is a GLOBAL table (no org_id / no RLS, like
-- channels & platform_settings). The three per-org stats/revenue tables are scoped;
-- the stats/attribution worker runs under withSystem (RLS-bypassing).
ALTER TABLE "ad_stats_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_stats_daily"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "campaign_revenue_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_revenue_daily"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "ad_revenue_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_revenue_daily"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
