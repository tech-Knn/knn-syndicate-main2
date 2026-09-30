-- D32 phase 2: Whop Ads launch. Additive only: an enum, one defaulted column on campaigns (every existing row is
-- FACEBOOK), and nullable Whop id columns on campaigns / ad_sets / ads. The unique indexes are on brand-new columns,
-- where every value is NULL, so they cannot conflict. No RLS change: no new table.
-- (Prisma also proposed dropping articles_embedding_idx and a redirect_domains default: both are known drift, see
-- packages/db/CLAUDE.md, and are intentionally left out. `migrate dev` itself cannot run here because it wants an
-- interactive yes for the unique indexes; this SQL is `migrate diff` with those two lines removed.)

-- CreateEnum
CREATE TYPE "AdProvider" AS ENUM ('FACEBOOK', 'WHOP');

-- AlterTable
ALTER TABLE "ad_sets" ADD COLUMN     "whop_ad_group_id" TEXT;

-- AlterTable
ALTER TABLE "ads" ADD COLUMN     "whop_ad_id" TEXT,
ADD COLUMN     "whop_file_id" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "ad_provider" "AdProvider" NOT NULL DEFAULT 'FACEBOOK',
ADD COLUMN     "whop_biz_id" TEXT,
ADD COLUMN     "whop_campaign_id" TEXT,
ADD COLUMN     "whop_connection_id" UUID,
ADD COLUMN     "whop_delivery_status" TEXT,
ADD COLUMN     "whop_issues" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "whop_page_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ad_sets_whop_ad_group_id_key" ON "ad_sets"("whop_ad_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_whop_ad_id_key" ON "ads"("whop_ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_whop_campaign_id_key" ON "campaigns"("whop_campaign_id");

-- CreateIndex
CREATE INDEX "campaigns_ad_provider_status_idx" ON "campaigns"("ad_provider", "status");
