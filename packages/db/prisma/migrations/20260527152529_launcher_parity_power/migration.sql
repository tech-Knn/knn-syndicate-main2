-- AlterTable
ALTER TABLE "ad_sets" ADD COLUMN     "advantage_audience" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "attribution_window" TEXT,
ADD COLUMN     "conversion_type" TEXT NOT NULL DEFAULT 'instant',
ADD COLUMN     "cost_cap_cents" INTEGER,
ADD COLUMN     "device_platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "exclude_countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mobile_os" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "roas_factor" DECIMAL(8,2),
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "adset_name_template" TEXT,
ADD COLUMN     "name_template" TEXT,
ADD COLUMN     "special_ad_categories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "launcher_presets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launcher_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "launcher_presets_org_id_idx" ON "launcher_presets"("org_id");

-- Row-Level Security (multi-tenancy, DECISION D2) — reuses app_current_org()/app_bypass_rls().
ALTER TABLE "launcher_presets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "launcher_presets"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
