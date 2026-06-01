-- RSOC fill-rate metrics (observe-only): per-channel/per-campaign AFS ad requests, matched
-- requests, and impressions per IST day. fill rate = afs_matched_requests / afs_requests
-- ("coverage"). Surfaced to super-admin only in v1; no automated action yet.
--
-- NB: `migrate diff` also emitted a `DROP INDEX articles_embedding_idx` (pgvector — Prisma can't
-- see the ivfflat index) and a `redirect_domains` id-default tweak — both stripped as unrelated noise.

-- AlterTable
ALTER TABLE "campaign_revenue_daily"
  ADD COLUMN "afs_requests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "afs_matched_requests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "afs_impressions" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "offer_revenue_daily"
  ADD COLUMN "afs_requests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "afs_matched_requests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "afs_impressions" INTEGER NOT NULL DEFAULT 0;
