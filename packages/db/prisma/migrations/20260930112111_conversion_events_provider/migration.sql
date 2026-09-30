-- D32: Whop Ads conversion tracking. Additive only: four columns on conversion_events, all defaulted or nullable,
-- so every existing row and every test that inserts a raw row is untouched ('facebook' is what they all are).
-- (Prisma also proposed dropping articles_embedding_idx and a redirect_domains default: both are known drift,
-- see packages/db/CLAUDE.md, and are intentionally left out.)

-- AlterTable
ALTER TABLE "conversion_events" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'facebook',
ADD COLUMN     "provider_context" JSONB,
ADD COLUMN     "provider_ref" TEXT,
ADD COLUMN     "provider_response" TEXT;
