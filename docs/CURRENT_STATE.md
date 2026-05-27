# Current State

> Update at the end of every session. A new session should read this first (after `CLAUDE.md`).

_Last updated: 2026-05-27 — Phase 0 COMPLETE._

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

## In progress

- Nothing — Phase 1 closed. Ready for Phase 2.

## Next

- **Phase 2 (Facebook integration)** — OAuth connect, AES-256 token encryption, account/page/pixel
  sync, the per-ad-account rate-limit queue + backoff + circuit breaker (the `BATCHED` state), and
  `CONNECTION_BROKEN` handling. Stand up the Hetzner staging box (FB needs public HTTPS URLs); see
  memory `deploy-workflow`.

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
