-- D32: Whop Ads connections. Additive only: two enums, one organizations column, two new tables.
-- (Prisma also proposed dropping articles_embedding_idx and a redirect_domains default: both are
-- known drift, see packages/db/CLAUDE.md, and are intentionally left out.)

-- CreateEnum
CREATE TYPE "WhopEnvironment" AS ENUM ('PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "WhopConnectionStatus" AS ENUM ('ACTIVE', 'BROKEN');

-- AlterTable: the per-company switch. Off by default, so nothing Whop-related shows until enabled.
ALTER TABLE "organizations" ADD COLUMN     "whop_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "whop_connections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "biz_id" TEXT NOT NULL,
    "environment" "WhopEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "label" TEXT,
    "api_key_enc" TEXT NOT NULL,
    "api_key_last4" TEXT NOT NULL,
    "api_version_date" TEXT NOT NULL,
    "status" "WhopConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "reporting_currency" TEXT,
    "checks" JSONB,
    "last_checked_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whop_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whop_social_accounts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "whop_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT,
    "username" TEXT,
    "external_id" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whop_social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whop_connections_user_id_idx" ON "whop_connections"("user_id");

-- CreateIndex
CREATE INDEX "whop_connections_org_id_status_idx" ON "whop_connections"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whop_connections_user_id_biz_id_environment_key" ON "whop_connections"("user_id", "biz_id", "environment");

-- CreateIndex
CREATE INDEX "whop_social_accounts_org_id_idx" ON "whop_social_accounts"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "whop_social_accounts_connection_id_whop_id_key" ON "whop_social_accounts"("connection_id", "whop_id");

-- AddForeignKey
ALTER TABLE "whop_connections" ADD CONSTRAINT "whop_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whop_social_accounts" ADD CONSTRAINT "whop_social_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "whop_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (multi-tenancy, DECISION D2) — same policy as the fb_* tables.
ALTER TABLE "whop_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whop_connections"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "whop_social_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whop_social_accounts"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
