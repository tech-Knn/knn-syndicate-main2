-- Conversion funnel: a single click can fire several funnel events
-- (ViewContent → AddToCart → Search), so uniqueness moves from `click_id` alone to
-- (`click_id`, `event_name`). Also default the ad-set MAIN conversion event to 'adclick'
-- (→ Facebook custom_event_type SEARCH).

-- DropIndex: the old single-column unique on click_id.
DROP INDEX "conversion_events_click_id_key";

-- AlterTable: main conversion event defaults to the deepest (money) funnel event.
ALTER TABLE "ad_sets" ALTER COLUMN "pxe_event" SET DEFAULT 'adclick';

-- CreateIndex: one row per click per funnel event.
CREATE UNIQUE INDEX "conversion_events_click_id_event_name_key" ON "conversion_events"("click_id", "event_name");
