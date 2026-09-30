-- D32 phase 2: the epoch that keeps a rebuilt Whop tree from replaying a discarded one's idempotency keys.
-- Additive only: one NOT NULL column with a default, so every existing row becomes epoch 0 (= the keys they
-- already used, which carry no suffix). No RLS change: no new table.

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "whop_key_epoch" INTEGER NOT NULL DEFAULT 0;
