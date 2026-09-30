-- Resumable Facebook launch: remember the Facebook campaign of a build that has not finished.
--
-- Until now the FB ids were written only after the WHOLE structure was built, so a Facebook rate
-- limit mid-build left live objects on Facebook with no id recorded, and the re-drive built a second
-- structure. `campaigns.fb_campaign_id` keeps meaning "fully built" (every reader relies on that);
-- the in-progress campaign id lives here, next to the existing `ad_sets.fb_ad_set_id` / `ads.fb_ad_id`
-- (which are now written as each object is created).
--
-- Additive + nullable: every existing row is NULL (nothing in progress), so no backfill and no
-- behaviour change until a launch is interrupted.
-- Hand-authored: no `migrate dev` drift lines (pgvector `DROP INDEX "articles_embedding_idx"`,
-- `redirect_domains.id DROP DEFAULT`) — see packages/db/CLAUDE.md.

ALTER TABLE "campaigns" ADD COLUMN "fb_pending_campaign_id" TEXT;
