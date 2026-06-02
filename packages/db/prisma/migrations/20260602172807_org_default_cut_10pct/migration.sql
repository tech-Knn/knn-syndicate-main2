-- New companies default to a 10% platform revenue cut (was 30%). SET DEFAULT only affects
-- future inserts; existing organizations keep their current default_revenue_cut_pct.
ALTER TABLE "organizations" ALTER COLUMN "default_revenue_cut_pct" SET DEFAULT 0.10;
