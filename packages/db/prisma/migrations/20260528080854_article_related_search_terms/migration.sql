-- NOTE: Prisma proposed `DROP INDEX "articles_embedding_idx"` (the pgvector ivfflat
-- index on the Unsupported vector column it can't see). Removed to preserve it.

-- AlterTable
ALTER TABLE "articles" ADD COLUMN     "related_search_terms" TEXT[] DEFAULT ARRAY[]::TEXT[];
