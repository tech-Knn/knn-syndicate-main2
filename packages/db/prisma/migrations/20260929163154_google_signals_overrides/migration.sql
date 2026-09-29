-- D27: buyer-editable Google signals (live, no approval).
--   ads.rac_value            — per-ad Referrer Ad Creative override (null → campaign.rac_value).
--   campaigns.terms_override — buyer's custom RSOC terms, sent as entered (empty → AI article terms).
-- Additive + nullable/defaulted: existing rows keep today's behavior (campaign rc, AI terms).
-- Hand-edited: removed Prisma's spurious `DROP INDEX "articles_embedding_idx"` (pgvector footgun,
-- see packages/db/CLAUDE.md) and an unrelated `redirect_domains.id DROP DEFAULT` drift line.

ALTER TABLE "ads" ADD COLUMN "rac_value" TEXT;

ALTER TABLE "campaigns" ADD COLUMN "terms_override" TEXT[] DEFAULT ARRAY[]::TEXT[];
