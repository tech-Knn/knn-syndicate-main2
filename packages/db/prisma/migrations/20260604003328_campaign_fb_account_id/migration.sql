-- Stable Meta ad-account id on the campaign, so reads resolve a live token by the Meta id even
-- after the internal fb_ad_accounts row is deleted on a disconnect (D-fix #3).
--
-- NOTE: prisma migrate dev --create-only also emitted two spurious diffs that were STRIPPED
-- (recurring shadow-DB artifacts; same as migrations 20260603031500 / 20260603214945):
--   • `DROP INDEX "articles_embedding_idx"` — the ivfflat index on the Unsupported(vector) column.
--   • `ALTER TABLE "redirect_domains" ALTER COLUMN "id" DROP DEFAULT` — would break uuid inserts.

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "fb_account_id" TEXT;
