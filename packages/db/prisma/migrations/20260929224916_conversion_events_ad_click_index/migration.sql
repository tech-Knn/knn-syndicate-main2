-- D30: Analytics counts the ad-click event per campaign over a date range (RPC / vCVR). This index
-- makes that count an index-only scan instead of walking every funnel event in the range.
-- CreateIndex
CREATE INDEX "conversion_events_campaign_id_event_name_created_at_idx" ON "conversion_events"("campaign_id", "event_name", "created_at");
