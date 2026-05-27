# Deploy runbook (Hetzner staging / production)

Local dev runs on the Mac; staging + production run on a Hetzner VPS (see memory
`deploy-workflow`). One Docker image runs the whole monorepo as separate service
containers, fronted by **Caddy** (automatic Let's Encrypt TLS) for the three
domains, with Postgres + Redis on the box and **Cloudflare** in front for DNS /
CDN / WAF.

```
Cloudflare (DNS, proxy, WAF)
        │
   Hetzner VPS ── Caddy :80/:443 (auto-TLS)
        │            ├── app.<domain>      → web :3003   (+ /api,/admin → api :3000)
        │            ├── articles.<domain> → article :3001
        │            └── go.<domain>        → redirect :3002
        ├── worker (BullMQ)         ├── postgres (pgvector)   └── redis
```

## Prerequisites

- A Hetzner box (Ubuntu 22.04/24.04; CX22 / CPX21 or larger is plenty for staging).
- Three DNS records pointing at the box's IP: `app.<domain>`, `articles.<domain>`,
  `go.<domain>`. The article domain **must be AdSense-approved**; keep the redirect
  domain separate for cloaking hygiene. If using Cloudflare proxying, set SSL mode
  to **Full (strict)** (Caddy serves a real cert).
- A Facebook App with business verification, configured for **test** ad accounts
  (staging never touches production FB). AdSense AFS API access. AI keys.

## First deploy

```bash
# 1) Provision the box (installs Docker, firewall: SSH/80/443 only)
ssh root@<box> 'bash -s' < deploy/provision.sh

# 2) On the box: get the code + secrets
git clone <repo-url> /opt/knn && cd /opt/knn
cp deploy/.env.staging.example deploy/.env.staging
#    edit deploy/.env.staging — generate secrets with: openssl rand -hex 32
#    (DATABASE_URL password must match POSTGRES_PASSWORD; set strong APP role pw)

# 3) Deploy (builds image, runs migrate→bootstrap→seed, starts apps + Caddy)
bash deploy/deploy.sh
```

`migrate` (a one-shot container) applies migrations, runs `db:bootstrap` to create
the non-superuser `knn_app` role that RLS needs, and seeds the platform org +
super admin (`SEED_SUPERADMIN_EMAIL`). Apps wait for it to finish.

## Subsequent deploys

```bash
cd /opt/knn && bash deploy/deploy.sh     # git pull + rebuild + migrate + restart
```

## Operations

```bash
C="docker compose -f deploy/docker-compose.staging.yml --env-file deploy/.env.staging --profile edge"
$C ps                 # status
$C logs -f api        # tail a service
$C exec api sh        # shell into a container
$C run --rm migrate   # re-run migrations/bootstrap/seed only
$C down               # stop (keeps volumes/data)
```

**Backups:** `docker compose ... exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%F).sql.gz` (schedule daily, 7-day retention — Phase 11). **Restore:** `gunzip -c backup.sql.gz | docker compose ... exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"`.

## Security notes

- Only Caddy is exposed (80/443); Postgres/Redis/app ports are not published.
- `knn_app` is a NON-superuser role so RLS is enforced; migrations use the owner.
- Secrets live only in `deploy/.env.staging` on the box (gitignored). Rotate the
  JWT secrets / DB passwords per environment.

## Prod-hardening TODOs (Phase 11)

- Slim the image (multi-stage prune of dev deps; Next `output: 'standalone'`).
- Run containers as non-root; mount an uploads volume.
- Postgres read replica + Redis Sentinel; separate redirect-engine deploy.
- Automated backups + offsite copy; monitoring/health alerting; PgBouncer.
