# Current State

> Update at the end of every session. A new session should read this first (after `CLAUDE.md`).

_Last updated: 2026-05-27 — Phase 2 (Facebook integration) COMPLETE + DEPLOYED to staging with FB app configured. Only a human OAuth consent (connect a FB **test** ad account) remains to exercise a live round-trip._

## Done

- Planning complete; 12-phase roadmap approved (see the plan + `DECISIONS.md` D1–D18).
- **Phase 0 — DONE (gate green).** Monorepo (pnpm + Turborepo, TS strict, ESLint flat, Prettier).
  `infra/docker-compose.yml` (Postgres 16 + pgvector 0.8.2, Redis 7) running via Colima.
  Packages: `@knn/config` (validated env, zod), `@knn/shared` (constants, IST datetime,
  conversion-weighted money allocator — 14 unit tests), `@knn/queue` (BullMQ + Bull-Board feed),
  `@knn/db` (Prisma 6 + pgvector + `platform_settings`, first migration applied + seeded). Apps:
  `@knn/api` (Fastify — `/health` checks db+redis, Bull-Board at `/admin/queues` behind basic
  auth), `@knn/redirect` (Hono — health + placeholder `/go/:id`, lean ioredis), `@knn/worker`
  (BullMQ heartbeat + IST midnight cron stub), `@knn/web` + `@knn/article` (Next 15, branded).
  Root + per-module `CLAUDE.md`, `/docs`, GitHub Actions CI.
  - **Verified:** typecheck (9 pkgs), lint (0 errors), test (20 passing), build (5 pkgs incl. 2
    Next builds), and **runtime of the built bundles**: api `/health` → `{db:up,redis:up}`,
    Bull-Board 401→200 with auth, redirect `/go/:id` → 302, worker boots on `Asia/Kolkata`.

- **Phase 1 — multi-tenancy + RLS foundation DONE (verified).** Schema: `organizations`,
  `users` (Role / UserStatus / OrgStatus enums), `refresh_tokens`, `audit_log` (migration
  `20260527075938_auth_multitenancy`). Real RLS: a NON-superuser app role (`knn_app`, created by
  `pnpm db:bootstrap`) so policies actually apply; per-transaction GUCs `app.current_org` /
  `app.bypass_rls` drive `tenant_isolation` policies on all four tables; `@knn/db` exposes
  `withTenant(orgId, fn)` and `withSystem(fn)`. **6 isolation tests pass** (cross-org reads return
  nothing, `WITH CHECK` blocks cross-org writes, `withSystem` sees all). App now connects via
  `APP_DATABASE_URL`; migrations use `DATABASE_URL` (owner).

- **Phase 1 — auth layer DONE (verified).** bcrypt(12) hashing, JWT access (15m, via `jose`) +
  DB-backed rotating refresh tokens (7d); routes `signup`/`login`/`refresh`/`logout`/`me`;
  signup→PENDING→admin approve/reject; `authenticate` + `requireRole` middleware; `runScoped`
  tenant guard; admin endpoints (create org + first company-admin, list/approve users). Seed
  creates the platform org + a SUPER_ADMIN (`super@knn.local`). **Phase 1 COMPLETE** — 35 tests
  pass (9 auth lifecycle + 6 RLS + …), plus an HTTP smoke on the built bundle (login → /me →
  admin all 200; unauth/bad-password 401); lint/typecheck/build all green.

- **Staging deployed to Hetzner (2026-05-27).** Box `rsoc-staging` (CPX32, Falkenstein, Ubuntu
  24.04, IP `178.105.241.185`) in the KNN project. Full stack runs via
  `deploy/docker-compose.staging.yml` and is **verified healthy** (all 7 services up, api
  `db:up/redis:up`, `knn_app` RLS role bootstrapped, super admin `admin@rsoc.app` seeded). Code in
  `/opt/rsoc`; secrets in `/opt/rsoc/deploy/.env.staging`. See memory `staging-deployment`.

- **Staging is LIVE with TLS (2026-05-27).** DNS on Cloudflare (zone `rsoc.app`; Namecheap NS →
  `damian`/`gina.ns.cloudflare.com`; staging A records grey-cloud → `178.105.241.185`). Caddy
  (`edge` profile) issued Let's Encrypt certs. Verified end-to-end over public HTTPS:
  - `https://app.staging.rsoc.app/` → 200 (dashboard) · `/api/auth/login` → 200 + tokens
  - `https://articles.staging.rsoc.app/` → 200 · `https://go.staging.rsoc.app/go/x` → 302
  - Super-admin `admin@rsoc.app` login works. See memory `staging-deployment`.

- **Phase 2 — Facebook integration DONE (gate green).** New `@knn/fb` package: AES-256-GCM token
  crypto, `fetch`-based Graph client, error classification (`FbConnectionBrokenError` /
  `FbRateLimitError` / `FbApiError`), per-ad-account `FbRateLimiter` (concurrency cap + exponential
  backoff honoring `x-business-use-case-usage` + circuit breaker — D12), OAuth (long-lived ~60d token
  exchange, `FB_SCOPES`), and account/page/pixel sync → DTOs. See `packages/fb/CLAUDE.md`.
  - **Schema** (migration `20260527104653_fb_integration`, RLS on all 4 tables): `FbConnection`
    (one per user, encrypted token, `status` ACTIVE/CONNECTION_BROKEN), `FbAdAccount`, `FbPage`,
    `FbPixel` (lander/search/adclick event slots for the D10 `pxe` selector, populated later).
  - **API** `apps/api/src/modules/facebook`: signed OAuth `state` (jose, 10m, purpose-checked);
    `GET /api/facebook/auth-url` (503 if FB unconfigured), public `GET /callback` (exchange → encrypt
    → upsert connection → best-effort sync → 302 back to `WEB_DOMAIN/dashboard/facebook`),
    `GET /status|/accounts|/pages|/accounts/:id/pixels`, `POST /sync`, `DELETE /connection`. All
    reads go through `runScoped` (RLS-scoped); the callback uses `withSystem` (no session yet).
    Sync fetches from FB **outside** any txn, then upserts in one txn (no open txn across network).
  - **Worker** daily `token-refresh` job (02:30 IST cron → `TOKEN_REFRESH` queue): extends tokens in
    a 10-day window, degrades expired/190 → `CONNECTION_BROKEN` + notify, nudges re-auth ~day 55 (D13).
  - **Verified:** typecheck (10 pkgs), lint (0), build (5). **Tests:** FB integration (7, real PG +
    mocked Graph — connect+sync, broken-token→CONNECTION_BROKEN+notify, scoped lists, auth guards),
    token-refresh (5, real PG + injected clock — extend/degrade/proactive), `@knn/fb` unit (12 —
    classification, BUC throttle→retryAfterMs, limiter backoff/breaker, DTO mapping).

## In progress

- Nothing — Phase 2 code-complete and green. Ready for Phase 3.

## Next

- **Phase 3 (Ad launcher)** — Campaign→Adset→Ad(s) schema (campaign-level keywords/RAC/article-ref/
  channel-ref per D5–D7; per-ad `redirect_id` + `pxe` per D9/D10), multipart creative upload, the
  multi-step wizard UI, DRAFT→PENDING_APPROVAL. Pixel-event mapping (`landerEvent`/`searchEvent`/
  `adclickEvent` on `FbPixel`) gets wired to the `pxe` selector here.

## Staging now runs Phase 2 with Facebook configured (2026-05-27)

- Shipped the Phase 2 tree to the box (`git archive HEAD` → `tar -x` into `/opt/rsoc`), set
  `FB_APP_ID` (906408948523489) + `FB_APP_SECRET` in `/opt/rsoc/deploy/.env.staging` (redirect URI
  was already `https://app.staging.rsoc.app/api/facebook/callback`), rebuilt `knn-app:latest`, and
  `up -d --build` (the `migrate` one-shot applied `fb_integration`). **Verified:** migrate exit 0 +
  "All migrations applied"; the 4 `fb_*` tables exist; api container has all 3 FB vars (so
  `isFbConfigured()` → true, `auth-url` no longer 503); public `GET /api/facebook/callback` → `302`
  to `/dashboard/facebook?fb_error=missing_code` over HTTPS.
- **Remaining = a human step (not code):** the live OAuth round-trip needs someone to open the
  `auth-url` and consent in a Facebook account that is an admin/developer/tester on the app, then
  connect a FB **test** ad account (D18 — never connect a real/prod ad account on staging). The app
  can stay in **Development mode** for this (no business verification needed for app-role users).
  There's no "Connect Facebook" button in the UI yet — that lands with the dashboard (Phase 10);
  for now trigger it via `GET /api/facebook/auth-url` (authenticated) and open the returned URL.

## New setup step

- After `pnpm db:migrate`, run **`pnpm db:bootstrap`** once per environment to create the
  non-superuser `knn_app` role that RLS depends on. (CI must run it before tests — TODO when we
  touch CI next.)

## Notes / gotchas for the next session

- Runtime Node is 25; `.nvmrc` pins 22. If a tool misbehaves, try Node 22.
- `pnpm db:*` scripts load the root `.env` via `dotenv-cli`.
- Bull-Board basic-auth creds are in `.env` (`BULL_BOARD_USER`/`PASSWORD`).
- External dependencies not yet provisioned: real domains, Facebook App + business verification,
  AdSense AFS API access, AI keys (see `OPEN_QUESTIONS.md`).
