-- CreateTable
CREATE TABLE "offer_revenue_daily" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "channel_ref" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "afs_clicks" INTEGER NOT NULL DEFAULT 0,
    "revenue_minor" INTEGER NOT NULL DEFAULT 0,
    "revenue_usd_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_revenue_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_revenue_daily_org_id_day_idx" ON "offer_revenue_daily"("org_id", "day");

-- CreateIndex
CREATE INDEX "offer_revenue_daily_campaign_id_day_idx" ON "offer_revenue_daily"("campaign_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "offer_revenue_daily_offer_id_day_key" ON "offer_revenue_daily"("offer_id", "day");

-- Row-level security (org isolation) — matches the other per-org revenue tables.
-- The attribution worker runs under withSystem (RLS-bypassing); stats reads are scoped.
ALTER TABLE "offer_revenue_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "offer_revenue_daily"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
