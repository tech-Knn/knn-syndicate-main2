-- One connection row per AdSense account: prevents two concurrent super-admin onboards from
-- racing the app-level findFirst-then-create and inserting duplicate google_connections rows for
-- the same account. Postgres treats NULLs as distinct, so dormant/legacy rows with a null
-- adsense_account are unaffected. Index name matches Prisma's `@@unique([adsenseAccount])` default
-- (`<table>_<column>_key`) so there's no schema drift.
--
-- (Hand-authored: `prisma migrate dev` only refused because it wanted an interactive confirmation
-- for the unique-constraint warning in a non-TTY shell — there are no existing duplicates.)

-- CreateIndex
CREATE UNIQUE INDEX "google_connections_adsense_account_key" ON "google_connections"("adsense_account");
