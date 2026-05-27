-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'LAUNCHING', 'ACTIVE', 'PAUSED', 'REJECTED', 'BATCHED', 'QUEUED_NO_CHANNEL', 'META_REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CampaignObjective" AS ENUM ('OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION');

-- CreateEnum
CREATE TYPE "AdCreativeType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "objective" "CampaignObjective" NOT NULL DEFAULT 'OUTCOME_SALES',
    "optimization_goal" TEXT NOT NULL DEFAULT 'OFFSITE_CONVERSIONS',
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "rac_value" TEXT,
    "fallback_url" TEXT,
    "ad_account_id" UUID,
    "page_id" UUID,
    "article_id" UUID,
    "channel_id" UUID,
    "fb_campaign_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_sets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "daily_budget_cents" INTEGER NOT NULL,
    "billing_event" TEXT NOT NULL DEFAULT 'IMPRESSIONS',
    "optimization_goal" TEXT NOT NULL DEFAULT 'OFFSITE_CONVERSIONS',
    "targeting" JSONB NOT NULL DEFAULT '{}',
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "fb_ad_set_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ad_set_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "primary_text" TEXT NOT NULL,
    "description" TEXT,
    "cta" TEXT NOT NULL DEFAULT 'LEARN_MORE',
    "creative_type" "AdCreativeType" NOT NULL DEFAULT 'IMAGE',
    "upload_id" UUID,
    "redirect_id" TEXT NOT NULL,
    "pxe_event" TEXT NOT NULL DEFAULT 'search',
    "pixel_id" UUID,
    "fallback_url" TEXT,
    "beneficiary" TEXT,
    "fb_ad_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "kind" "AdCreativeType" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_org_id_status_idx" ON "campaigns"("org_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_buyer_id_idx" ON "campaigns"("buyer_id");

-- CreateIndex
CREATE INDEX "ad_sets_org_id_idx" ON "ad_sets"("org_id");

-- CreateIndex
CREATE INDEX "ad_sets_campaign_id_idx" ON "ad_sets"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_redirect_id_key" ON "ads"("redirect_id");

-- CreateIndex
CREATE INDEX "ads_org_id_idx" ON "ads"("org_id");

-- CreateIndex
CREATE INDEX "ads_ad_set_id_idx" ON "ads"("ad_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "uploads_storage_key_key" ON "uploads"("storage_key");

-- CreateIndex
CREATE INDEX "uploads_org_id_idx" ON "uploads"("org_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_set_id_fkey" FOREIGN KEY ("ad_set_id") REFERENCES "ad_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-Level Security (multi-tenancy, DECISION D2) — reuses app_current_org()/app_bypass_rls().
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaigns"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "ad_sets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_sets"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "ads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ads"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "uploads"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
