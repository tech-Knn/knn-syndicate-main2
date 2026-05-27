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

## In progress

- Nothing — Phase 0 closed. Ready to start Phase 1.

## Next

- **Phase 1 (auth & multi-tenancy / RLS)**: `organizations`, `users` (3 roles + states), JWT
  (15m access / 7d refresh), bcrypt 12, signup→PENDING→approve/reject, Postgres RLS + a
  service-layer tenant guard (`SET app.current_org`), and integration tests proving cross-org
  reads are impossible. See `packages/db/CLAUDE.md` for the RLS invariant.

## Notes / gotchas for the next session

- Runtime Node is 25; `.nvmrc` pins 22. If a tool misbehaves, try Node 22.
- `pnpm db:*` scripts load the root `.env` via `dotenv-cli`.
- Bull-Board basic-auth creds are in `.env` (`BULL_BOARD_USER`/`PASSWORD`).
- External dependencies not yet provisioned: real domains, Facebook App + business verification,
  AdSense AFS API access, AI keys (see `OPEN_QUESTIONS.md`).
