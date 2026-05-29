-- Per-offer article variant (A/B testing): the article served on this offer's website.
-- NULL → the campaign's default article (Campaign.article_id). Nullable, no FK (reusable).
ALTER TABLE "offers" ADD COLUMN "article_id" UUID;
