-- Per-ad display link: the visible URL caption shown in the Facebook ad (link_data.caption),
-- independent of the cloaked /go/{redirect_id} destination. Nullable → FB derives the display URL
-- from the destination domain (prior behavior) when unset.
--
-- NB: hand-written (migrate diff also re-emits the pgvector `DROP INDEX articles_embedding_idx`
-- noise — stripped).

-- AlterTable
ALTER TABLE "ads" ADD COLUMN "display_link" TEXT;
