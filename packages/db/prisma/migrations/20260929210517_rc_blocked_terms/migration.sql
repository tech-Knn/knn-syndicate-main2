-- D28: Referrer Ad Creative words that make Google hide the related-search keyword block.
-- Platform-wide table (no org_id, no RLS — like term_stat_daily / platform_settings).
-- Hand-edited: removed Prisma's spurious `DROP INDEX "articles_embedding_idx"` (pgvector footgun,
-- see packages/db/CLAUDE.md) and an unrelated `redirect_domains.id DROP DEFAULT` drift line.

-- CreateEnum
CREATE TYPE "RcTermSource" AS ENUM ('SEED', 'LEARNED', 'MANUAL');

-- CreateEnum
CREATE TYPE "RcTermStatus" AS ENUM ('BLOCKED', 'ALLOWED');

-- CreateTable
CREATE TABLE "rc_blocked_terms" (
    "id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "source" "RcTermSource" NOT NULL,
    "status" "RcTermStatus" NOT NULL DEFAULT 'BLOCKED',
    "note" TEXT,
    "suppressed_campaigns" INTEGER,
    "campaigns_using" INTEGER,
    "keyword_clicks_per_100" DOUBLE PRECISION,
    "baseline_per_100" DOUBLE PRECISION,
    "learned_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rc_blocked_terms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rc_blocked_terms_term_key" ON "rc_blocked_terms"("term");

-- CreateIndex
CREATE INDEX "rc_blocked_terms_status_idx" ON "rc_blocked_terms"("status");

-- Seed: words verified on live landing pages on 2026-09-30 (rc passed as `?rc=` exactly like a real
-- paid click; a "hidden" block = Google returned no related-search unit). Terms are stored
-- normalized (lowercase, stemmed tokens) — see packages/shared/src/rc-blocked-terms.ts.
INSERT INTO "rc_blocked_terms" ("id", "term", "source", "status", "note", "updated_at") VALUES
  (gen_random_uuid(), 'job', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Job", "Job", "packing Job" hid the keyword block on job pages. Sept 2026 traffic: job-wording rc campaigns got 17 keyword clicks per 100 visits vs 60 for the rest (ROAS 18% vs 57%).', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'career', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Careers" hid the keyword block. Aug–Sep traffic: 8 of 10 campaigns using it were suppressed.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'hiring', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospitals are hiring" hid the keyword block on a job page.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vacancy', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Vacancy 2026" hid the keyword block on a job page.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'free', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Free nursing course in India", "Free flat on rent" and "Flat on rent free listing" all hid the keyword block — on job AND non-job pages.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'work from home', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Packing work from home" hid the keyword block on a job page.', CURRENT_TIMESTAMP)
ON CONFLICT ("term") DO NOTHING;
