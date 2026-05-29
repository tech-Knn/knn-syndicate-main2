-- Platform redirect domains (the go.* hosts the Cloudflare redirect Worker serves).
-- The DEFAULT one is what new ad creatives link to. Global (no org_id), super-admin managed.
CREATE TABLE "redirect_domains" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "host" TEXT NOT NULL,
  "label" TEXT,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "last_check" TEXT,
  "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "redirect_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "redirect_domains_host_key" ON "redirect_domains"("host");

-- Enforce at most one default at the DB level (partial unique index).
CREATE UNIQUE INDEX "redirect_domains_one_default" ON "redirect_domains"("is_default") WHERE "is_default" = true;
