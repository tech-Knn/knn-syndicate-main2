/*
  Warnings:

  - You are about to drop the column `pixel_id` on the `ads` table. All the data in the column will be lost.
  - You are about to drop the column `pxe_event` on the `ads` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "BudgetMode" AS ENUM ('AD_SET', 'CAMPAIGN');

-- AlterTable
ALTER TABLE "ad_sets" ADD COLUMN     "age_max" INTEGER NOT NULL DEFAULT 65,
ADD COLUMN     "age_min" INTEGER NOT NULL DEFAULT 18,
ADD COLUMN     "bid_strategy" TEXT,
ADD COLUMN     "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "genders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pixel_id" UUID,
ADD COLUMN     "placement_mode" TEXT NOT NULL DEFAULT 'automatic',
ADD COLUMN     "placements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pxe_event" TEXT NOT NULL DEFAULT 'search',
ALTER COLUMN "daily_budget_cents" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ads" DROP COLUMN "pixel_id",
DROP COLUMN "pxe_event";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "budget_mode" "BudgetMode" NOT NULL DEFAULT 'AD_SET',
ADD COLUMN     "daily_budget_cents" INTEGER,
ADD COLUMN     "query" TEXT;
