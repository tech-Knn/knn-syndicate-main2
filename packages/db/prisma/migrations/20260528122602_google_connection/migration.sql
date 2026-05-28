-- CreateTable
-- (global singleton — no RLS, like channels & platform_settings; SUPER_ADMIN-only via routes)
CREATE TABLE "google_connections" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "google_email" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '',
    "adsense_account" TEXT,
    "adsense_ad_client" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "connected_by_id" UUID,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_connections_pkey" PRIMARY KEY ("id")
);
