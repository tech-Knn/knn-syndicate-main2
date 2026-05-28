-- CreateTable
CREATE TABLE "afs_channel_catalog" (
    "id" UUID NOT NULL,
    "afs_account_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "display_name" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "afs_channel_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "afs_channel_catalog_afs_account_id_idx" ON "afs_channel_catalog"("afs_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "afs_channel_catalog_afs_account_id_channel_id_key" ON "afs_channel_catalog"("afs_account_id", "channel_id");
