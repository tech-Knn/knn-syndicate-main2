-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'RESERVED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'ASSIGNED', 'CANCELLED');

-- NOTE: Prisma proposed `DROP INDEX "articles_embedding_idx"` here — that's our
-- pgvector ivfflat cosine index (raw-SQL created; Prisma can't see the Unsupported
-- vector column's index). Removed so the index is preserved.

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "channel_id" TEXT NOT NULL,
    "label" TEXT,
    "status" "ChannelStatus" NOT NULL DEFAULT 'AVAILABLE',
    "current_campaign_id" UUID,
    "locked_for_day" TEXT,
    "assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_assignments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "channel_ref" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "for_day" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "channel_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_queue" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMP(3),

    CONSTRAINT "campaign_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_channel_id_key" ON "channels"("channel_id");

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");

-- CreateIndex
CREATE INDEX "channel_assignments_campaign_id_idx" ON "channel_assignments"("campaign_id");

-- CreateIndex
CREATE INDEX "channel_assignments_channel_ref_released_at_idx" ON "channel_assignments"("channel_ref", "released_at");

-- CreateIndex
CREATE INDEX "channel_assignments_org_id_for_day_idx" ON "channel_assignments"("org_id", "for_day");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_queue_campaign_id_key" ON "campaign_queue"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_queue_status_enqueued_at_idx" ON "campaign_queue"("status", "enqueued_at");

-- Row-Level Security (D2). `channels` is a GLOBAL platform pool (no org_id, no RLS,
-- like platform_settings); the per-campaign attribution + the wait queue are
-- org-scoped. The assignment worker runs under withSystem (RLS-bypassing).
ALTER TABLE "channel_assignments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "channel_assignments"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "campaign_queue" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_queue"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
