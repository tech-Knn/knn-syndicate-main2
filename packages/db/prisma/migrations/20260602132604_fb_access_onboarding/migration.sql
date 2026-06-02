-- CreateEnum
CREATE TYPE "FbAccessStatus" AS ENUM ('NONE', 'REQUESTED', 'INVITED');

-- AlterTable: FB tester-onboarding state on users (apps in Dev mode → buyers must be added as testers).
ALTER TABLE "users" ADD COLUMN "fb_access_status" "FbAccessStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN "fb_handle" TEXT;
