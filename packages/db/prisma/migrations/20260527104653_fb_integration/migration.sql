-- CreateEnum
CREATE TYPE "FbConnectionStatus" AS ENUM ('ACTIVE', 'CONNECTION_BROKEN');

-- CreateTable
CREATE TABLE "fb_connections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "fb_user_id" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '',
    "status" "FbConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fb_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fb_ad_accounts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "fb_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fb_ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fb_pages" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "fb_page_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instagram_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fb_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fb_pixels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ad_account_id" UUID NOT NULL,
    "fb_pixel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lander_event" TEXT,
    "search_event" TEXT,
    "adclick_event" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fb_pixels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fb_connections_user_id_key" ON "fb_connections"("user_id");

-- CreateIndex
CREATE INDEX "fb_connections_org_id_status_idx" ON "fb_connections"("org_id", "status");

-- CreateIndex
CREATE INDEX "fb_connections_status_token_expires_at_idx" ON "fb_connections"("status", "token_expires_at");

-- CreateIndex
CREATE INDEX "fb_ad_accounts_org_id_idx" ON "fb_ad_accounts"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "fb_ad_accounts_connection_id_fb_account_id_key" ON "fb_ad_accounts"("connection_id", "fb_account_id");

-- CreateIndex
CREATE INDEX "fb_pages_org_id_idx" ON "fb_pages"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "fb_pages_connection_id_fb_page_id_key" ON "fb_pages"("connection_id", "fb_page_id");

-- CreateIndex
CREATE INDEX "fb_pixels_org_id_idx" ON "fb_pixels"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "fb_pixels_ad_account_id_fb_pixel_id_key" ON "fb_pixels"("ad_account_id", "fb_pixel_id");

-- AddForeignKey
ALTER TABLE "fb_connections" ADD CONSTRAINT "fb_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fb_ad_accounts" ADD CONSTRAINT "fb_ad_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "fb_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fb_pages" ADD CONSTRAINT "fb_pages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "fb_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fb_pixels" ADD CONSTRAINT "fb_pixels_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "fb_ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (multi-tenancy, DECISION D2) — reuses app_current_org()/app_bypass_rls().
ALTER TABLE "fb_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fb_connections"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "fb_ad_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fb_ad_accounts"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "fb_pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fb_pages"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "fb_pixels" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fb_pixels"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
