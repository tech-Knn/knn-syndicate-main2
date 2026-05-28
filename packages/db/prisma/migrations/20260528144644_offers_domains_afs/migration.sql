-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_DNS', 'VERIFYING', 'LIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "OfferKind" AS ENUM ('PAID', 'ORGANIC');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "domain_id" UUID;

-- AlterTable
ALTER TABLE "google_connections" ADD COLUMN     "afs_pub_id" TEXT,
ADD COLUMN     "label" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "domains" (
    "id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "afs_account_id" TEXT NOT NULL,
    "channel_ranges" TEXT,
    "style_id" TEXT,
    "adsafe" TEXT,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_DNS',
    "verify_token" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "last_check" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "weight_pct" INTEGER NOT NULL DEFAULT 0,
    "kind" "OfferKind" NOT NULL DEFAULT 'PAID',
    "channel_ref" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domains_host_key" ON "domains"("host");

-- CreateIndex
CREATE INDEX "domains_afs_account_id_idx" ON "domains"("afs_account_id");

-- CreateIndex
CREATE INDEX "offers_campaign_id_idx" ON "offers"("campaign_id");

-- CreateIndex
CREATE INDEX "offers_org_id_idx" ON "offers"("org_id");

-- CreateIndex
CREATE INDEX "channels_domain_id_idx" ON "channels"("domain_id");

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_afs_account_id_fkey" FOREIGN KEY ("afs_account_id") REFERENCES "google_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: offers are per-campaign org-scoped business data (domains + google_connections
-- are platform-global, like channels — no RLS, super-admin via routes).
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "offers"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
