-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_id" UUID;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "auto_approve" BOOLEAN NOT NULL DEFAULT false;
