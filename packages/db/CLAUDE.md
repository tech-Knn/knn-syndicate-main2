# @knn/db — Prisma schema, migrations, client

Single source of truth for the data model. Exposes one shared `PrismaClient` singleton.

## Invariants

- **Migrations are immutable once applied.** Never edit a migration in `prisma/migrations/`; add a
  new one. `pnpm db:migrate` (dev) / `pnpm db:deploy` (prod) — both load the root `.env` via
  `dotenv-cli`.
- **⚠️ pgvector index footgun:** Prisma can't see the `articles_embedding_idx` ivfflat index (it's on
  an `Unsupported("vector(1536)")` column), so it proposes `DROP INDEX "articles_embedding_idx"` in
  **every** new migration. **Always create new migrations with `migrate dev --create-only`, delete that
  DROP line, then `migrate:deploy`.** If `migrate dev` already applied a DROP, re-create the index
  (`CREATE INDEX articles_embedding_idx ON articles USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)`)
  and fix the recorded checksum (`migrate reset` is blocked for AI agents).
- **Multi-tenancy (Phase 1)**: every business table carries `org_id`, and **RLS policies** enforce
  isolation. The app must `SET app.current_org = <id>` on the connection/txn for each request
  (the tenant guard). RLS is defense-in-depth on top of service-layer scoping (D2).
- **pgvector**: article embeddings are `vector(1536)` (OpenAI `text-embedding-3-small`) with an
  ivfflat cosine index. The `vector` extension is declared in the datasource `extensions`.
- **Money**: store native amount + a USD-converted field; integer-cents internally. Never sum
  across currencies (D15).
- **Campaign-level vs ad-level (D5–D9, D27)**: keywords, the default RAC, article FK, channel FK and
  the buyer's custom RSOC `terms_override` live on `campaigns`; `redirect_id` (unique) lives on `ads`.
  The ONE per-ad exception is `ads.rac_value`, an optional Referrer Ad Creative override (D27; null → the
  campaign's). Read it through `effectiveRac()` (`@knn/shared`). Don't add other per-ad offer fields.
- **Facebook ids & the resumable launch**: `campaigns.fb_campaign_id` non-null ⇔ the WHOLE Facebook structure
  (campaign → ad sets → ads) is built — every reader (auto-launch gate, meta-rejection/attribution scans,
  google-signals `live`, the launch's own "already launched" check, the BATCHED re-drive) treats it as "launched",
  so **never set it early**. A launch interrupted by a rate limit or failure records what already exists in
  `campaigns.fb_pending_campaign_id` + `ad_sets.fb_ad_set_id` + `ads.fb_ad_id`, each written the moment its object is
  created; the next launch resumes from those and creates only the rest. Child ids are only valid under a non-null
  `fb_pending_campaign_id`. A launch-completing write moves pending → `fb_campaign_id` and flips the status in one
  commit; reopen / relaunch pause + clear an unfinished build so an edited campaign never resumes stale objects.
  A rate-limited (BATCHED) campaign therefore still has `fb_campaign_id IS NULL` — a "BATCHED and not launched" query keeps working.

Phase 0 has only `platform_settings`. The full schema (orgs, users, campaigns, adsets, ads,
channels, articles, revenue, …) is built phase by phase.
