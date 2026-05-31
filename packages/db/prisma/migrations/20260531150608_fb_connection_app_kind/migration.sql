-- Two-app FB token split (#two-app): tag each connection with the app that issued its
-- token — "DATA" (default; long-lived; sync/reads/CAPI/refresh) or "LAUNCH" (short-lived;
-- create/modify ads only, to dodge the 31/3858385 ad-publish checkpoint). A person can
-- now hold BOTH apps for the same FB profile, so the uniqueness key gains app_kind.
--
-- NB: the `articles_embedding_idx` (ivfflat, pgvector) DROP and a `redirect_domains` id
-- default tweak that `migrate diff` also emitted are stripped — both are Prisma-can't-see-it
-- noise, not part of this change (see packages/db/CLAUDE.md pgvector footgun).

-- DropIndex
DROP INDEX "fb_connections_user_id_fb_user_id_key";

-- AlterTable
ALTER TABLE "fb_connections" ADD COLUMN "app_kind" TEXT NOT NULL DEFAULT 'DATA';

-- CreateIndex
CREATE UNIQUE INDEX "fb_connections_user_id_fb_user_id_app_kind_key" ON "fb_connections"("user_id", "fb_user_id", "app_kind");
