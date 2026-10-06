-- Why a click was routed to the white page (telemetry only; routing is unchanged).
-- IF NOT EXISTS: four of these were already applied by hand on production.
ALTER TABLE "cloak_stat_daily"
  ADD COLUMN IF NOT EXISTS "white_inactive"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "white_not_paid"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "white_kaid_absent"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "white_kaid_wrong"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "white_whop_no_match" INTEGER NOT NULL DEFAULT 0;
