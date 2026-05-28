-- Per-ad daily FB cost stats broken down by a dimension (country / hour) for the
-- Analytics drill-down. Revenue is allocated at read time (AFS has no geo/hour).
CREATE TABLE "ad_stats_dim_daily" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "ad_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "day" TEXT NOT NULL,
  "dim" TEXT NOT NULL,
  "dim_value" TEXT NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "conversions" INTEGER NOT NULL DEFAULT 0,
  "spend_minor" INTEGER NOT NULL DEFAULT 0,
  "spend_usd_minor" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_stats_dim_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_stats_dim_daily_ad_id_day_dim_dim_value_key" ON "ad_stats_dim_daily"("ad_id", "day", "dim", "dim_value");
CREATE INDEX "ad_stats_dim_daily_campaign_id_dim_day_idx" ON "ad_stats_dim_daily"("campaign_id", "dim", "day");
CREATE INDEX "ad_stats_dim_daily_org_id_idx" ON "ad_stats_dim_daily"("org_id");

-- Tenant isolation (RLS), mirroring the other per-org daily tables. The attribution
-- worker runs under withSystem (app_bypass_rls); buyer/admin reads match their org.
ALTER TABLE "ad_stats_dim_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_stats_dim_daily"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
