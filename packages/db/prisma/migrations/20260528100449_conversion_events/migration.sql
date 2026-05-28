-- NOTE: Prisma proposed `DROP INDEX "articles_embedding_idx"` (the pgvector ivfflat
-- index on the Unsupported vector column it can't see). Removed to preserve it.

-- CreateTable
CREATE TABLE "conversion_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "ad_id" UUID NOT NULL,
    "click_id" TEXT NOT NULL,
    "fbclid" TEXT,
    "pixel_fb_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "value_minor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "client_ip" TEXT,
    "client_ua" TEXT,
    "event_source_url" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fb_response" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversion_events_click_id_key" ON "conversion_events"("click_id");

-- CreateIndex
CREATE INDEX "conversion_events_org_id_created_at_idx" ON "conversion_events"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "conversion_events_campaign_id_created_at_idx" ON "conversion_events"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "conversion_events_status_idx" ON "conversion_events"("status");

-- Row-Level Security (D2): org-scoped. The public /api/events ingest + the CAPI
-- dispatch worker write/read under withSystem (RLS-bypassing); tenant dashboards read scoped.
ALTER TABLE "conversion_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "conversion_events"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
