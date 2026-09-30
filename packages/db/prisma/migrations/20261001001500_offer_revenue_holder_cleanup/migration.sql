-- Data fix (no schema change). `offer_revenue_daily` rows are derived from the AdSense report, one per (offer, day).
-- Until now every report day was credited to the offer that holds the channel TODAY, so a channel reused by a new
-- campaign copied its previous holders' days onto the new campaign: the Articles page showed the new campaign
-- earning the channel's whole previous week, and those days were counted twice (once for the real holder).
--
-- Remove exactly the rows that are contradicted by the channel's own assignment history: another campaign held that
-- channel that day and this row's campaign did not. Rows for days nobody held the channel are left alone. The
-- attribution job (attribution.service.ts) now credits each day to that day's holder and heals the same rows on every
-- re-pull; nothing else reads a wrongly attributed row back.
DELETE FROM "offer_revenue_daily" o
WHERE EXISTS (
        SELECT 1 FROM "channel_assignments" ca
        WHERE ca."channel_ref" = o."channel_ref" AND ca."for_day" = o."day"
      )
  AND NOT EXISTS (
        SELECT 1 FROM "channel_assignments" ca
        WHERE ca."channel_ref" = o."channel_ref" AND ca."for_day" = o."day" AND ca."campaign_id" = o."campaign_id"
      );
