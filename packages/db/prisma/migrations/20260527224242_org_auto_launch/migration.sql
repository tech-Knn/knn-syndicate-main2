-- NOTE: Prisma keeps proposing `DROP INDEX "articles_embedding_idx"` (our pgvector
-- ivfflat index on an Unsupported column it can't see). Removed so the index survives.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "auto_launch" BOOLEAN NOT NULL DEFAULT false;
