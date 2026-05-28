-- Allow multiple Facebook profiles per user.
-- A user may connect several FB profiles; each profile carries its display name.
ALTER TABLE "fb_connections" ADD COLUMN "fb_name" TEXT;

-- Drop the one-connection-per-user unique constraint.
DROP INDEX "fb_connections_user_id_key";

-- One row per (user, FB profile): reconnecting the same profile updates it; a new
-- profile creates a new row. Plus a plain index for per-user listing.
CREATE INDEX "fb_connections_user_id_idx" ON "fb_connections"("user_id");
CREATE UNIQUE INDEX "fb_connections_user_id_fb_user_id_key" ON "fb_connections"("user_id", "fb_user_id");
