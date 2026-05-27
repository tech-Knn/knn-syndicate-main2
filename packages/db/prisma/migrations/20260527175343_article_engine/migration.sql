-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "articles" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "query" TEXT,
    "raw_content" TEXT NOT NULL,
    "compliant_content" TEXT NOT NULL,
    "embedding" vector(1536),
    "status" "ArticleStatus" NOT NULL DEFAULT 'READY',
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");

-- CreateIndex
CREATE INDEX "articles_org_id_idx" ON "articles"("org_id");

-- pgvector ivfflat index for cosine similarity reuse (D16). lists=100 is fine for
-- the expected article volume; REINDEX once the table is well-populated for best recall.
CREATE INDEX "articles_embedding_idx" ON "articles" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Row-Level Security (multi-tenancy, D2) — same tenant_isolation policy as every
-- other business table. Articles are reused only within a tenant (never cross-org).
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "articles"
  USING (app_bypass_rls() OR "org_id" = app_current_org())
  WITH CHECK (app_bypass_rls() OR "org_id" = app_current_org());
