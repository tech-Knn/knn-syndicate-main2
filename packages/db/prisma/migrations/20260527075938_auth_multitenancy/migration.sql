-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'MEDIA_BUYER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_platform" BOOLEAN NOT NULL DEFAULT false,
    "default_revenue_cut_pct" DECIMAL(5,4) NOT NULL DEFAULT 0.30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEDIA_BUYER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "revenue_cut_pct" DECIMAL(5,4),
    "fallback_url" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "org_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_org_id_status_idx" ON "users"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (multi-tenancy, DECISION D2)
-- Tenant context is supplied per-transaction via GUCs set by the app's tenant
-- guard: `app.current_org` (the active org uuid) and `app.bypass_rls` ('on' for
-- SUPER_ADMIN / system contexts). The runtime app connects as a NON-superuser,
-- NON-owner role so these policies actually apply; the owner role (migrations)
-- bypasses RLS as usual.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.bypass_rls', true) = 'on'
$$;

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
  USING (app_bypass_rls() OR "id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "id" = app_current_org());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
