-- Optional per-company domain ownership: NULL = shared (any company), set = restricted
-- to that company's buyers. ON DELETE SET NULL so removing a company frees its domains.
ALTER TABLE "domains" ADD COLUMN "owner_org_id" UUID;

ALTER TABLE "domains"
  ADD CONSTRAINT "domains_owner_org_id_fkey"
  FOREIGN KEY ("owner_org_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "domains_owner_org_id_idx" ON "domains"("owner_org_id");
