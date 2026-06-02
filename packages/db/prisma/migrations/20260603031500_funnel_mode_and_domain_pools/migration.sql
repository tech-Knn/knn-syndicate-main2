-- Funnel mode (NORMAL vs CLOAKER), per-company gate + per-buyer override, and the redirect/white
-- domain pools (mode + company isolation + health). Hand-written from `migrate diff`: the spurious
-- `DROP INDEX "articles_embedding_idx"` (pgvector ivfflat index Prisma can't see) and the
-- `redirect_domains ... ALTER COLUMN "id" DROP DEFAULT` (would break uuid inserts) were stripped.

-- CreateEnum
CREATE TYPE "FunnelMode" AS ENUM ('NORMAL', 'CLOAKER');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "cloaking_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "default_funnel_mode" "FunnelMode" NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "funnel_mode" "FunnelMode";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "redirect_domain_host" TEXT,
ADD COLUMN     "white_domain_host" TEXT;

-- AlterTable
ALTER TABLE "redirect_domains" ADD COLUMN     "healthy" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mode" "FunnelMode" NOT NULL DEFAULT 'CLOAKER',
ADD COLUMN     "owner_org_id" UUID;

-- CreateTable
CREATE TABLE "white_domains" (
    "id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "healthy" BOOLEAN NOT NULL DEFAULT true,
    "last_check" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "white_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "white_domains_host_key" ON "white_domains"("host");

-- CreateIndex
CREATE INDEX "white_domains_is_active_idx" ON "white_domains"("is_active");

-- CreateIndex
CREATE INDEX "redirect_domains_mode_owner_org_id_is_active_idx" ON "redirect_domains"("mode", "owner_org_id", "is_active");

-- CreateIndex
CREATE INDEX "redirect_domains_owner_org_id_idx" ON "redirect_domains"("owner_org_id");

-- AddForeignKey
ALTER TABLE "redirect_domains" ADD CONSTRAINT "redirect_domains_owner_org_id_fkey" FOREIGN KEY ("owner_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
