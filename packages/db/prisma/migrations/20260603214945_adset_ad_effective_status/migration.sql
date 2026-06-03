-- Add the live Facebook delivery state (effective_status) to ad sets and ads. The worker
-- reconcile job mirrors FB's per-entity effective_status here (display-only; the campaign's
-- status governs the redirect). Null until the first sync after launch.
--
-- NOTE: prisma migrate dev --create-only also emitted two spurious diffs that were STRIPPED
-- (same as migration 20260603031500_funnel_mode_and_domain_pools):
--   • `DROP INDEX "articles_embedding_idx"` — Prisma can't see the ivfflat index on the
--     Unsupported("vector") column, so it proposes dropping it in every migration. Keep it.
--   • `ALTER TABLE "redirect_domains" ALTER COLUMN "id" DROP DEFAULT` — would break uuid
--     inserts (the schema declares @default(uuid())). Recurring shadow-DB artifact.

-- AlterTable
ALTER TABLE "ad_sets" ADD COLUMN     "effective_status" TEXT;

-- AlterTable
ALTER TABLE "ads" ADD COLUMN     "effective_status" TEXT;
