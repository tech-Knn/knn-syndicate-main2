import { withSystem } from '@knn/db';
import type { FunnelMode } from '@knn/shared';
import { AppError } from '../../lib/errors.js';

export interface RedirectDomainDTO {
  id: string;
  host: string;
  label: string | null;
  isDefault: boolean;
  /** Which funnel mode's traffic this domain serves (NORMAL vs CLOAKER pool segregation). */
  mode: FunnelMode;
  /** Company that exclusively rotates onto this domain; null = shared pool. */
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  /** Selectable for new launches (retire without deleting). */
  isActive: boolean;
  /** Last automated health check verdict. */
  healthy: boolean;
  lastCheck: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

const select = {
  id: true,
  host: true,
  label: true,
  isDefault: true,
  mode: true,
  ownerOrgId: true,
  ownerOrg: { select: { name: true } },
  isActive: true,
  healthy: true,
  lastCheck: true,
  verifiedAt: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  host: string;
  label: string | null;
  isDefault: boolean;
  mode: FunnelMode;
  ownerOrgId: string | null;
  ownerOrg: { name: string } | null;
  isActive: boolean;
  healthy: boolean;
  lastCheck: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
};

function toDTO(r: Row): RedirectDomainDTO {
  return {
    id: r.id,
    host: r.host,
    label: r.label,
    isDefault: r.isDefault,
    mode: r.mode,
    ownerOrgId: r.ownerOrgId,
    ownerOrgName: r.ownerOrg?.name ?? null,
    isActive: r.isActive,
    healthy: r.healthy,
    lastCheck: r.lastCheck,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Strip scheme / path / port → bare lowercase host (e.g. "https://go.x.com/" → "go.x.com"). */
function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/** The `go.*` redirect domains the platform can rotate ad creatives onto (super-admin). */
export async function listRedirectDomains(): Promise<RedirectDomainDTO[]> {
  const rows = await withSystem((tx) =>
    tx.redirectDomain.findMany({ select, orderBy: [{ isDefault: 'desc' }, { mode: 'asc' }, { createdAt: 'asc' }] }),
  );
  return rows.map(toDTO);
}

export interface CreateRedirectDomainInput {
  host: string;
  label?: string;
  mode?: FunnelMode;
  ownerOrgId?: string | null;
  /** false = add but hold out of rotation ("not in use" until assigned). Defaults to true. */
  isActive?: boolean;
}

/** Add a redirect domain. The FIRST one added becomes the default automatically. */
export async function createRedirectDomain(input: CreateRedirectDomainInput): Promise<RedirectDomainDTO> {
  const host = normalizeHost(input.host);
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new AppError(400, 'Enter a valid hostname, e.g. go.example.com');
  }
  return withSystem(async (tx) => {
    const existing = await tx.redirectDomain.findUnique({ where: { host }, select: { id: true } });
    if (existing) throw new AppError(409, `${host} is already added`);
    if (input.ownerOrgId) {
      const org = await tx.organization.findUnique({ where: { id: input.ownerOrgId }, select: { id: true } });
      if (!org) throw new AppError(400, 'Owner company not found');
    }
    const count = await tx.redirectDomain.count();
    const row = await tx.redirectDomain.create({
      data: {
        host,
        label: input.label?.trim() || null,
        isDefault: count === 0,
        mode: input.mode ?? 'CLOAKER',
        ownerOrgId: input.ownerOrgId ?? null,
        isActive: input.isActive ?? true,
      },
      select,
    });
    return toDTO(row);
  });
}

export interface UpdateRedirectDomainInput {
  label?: string | null;
  mode?: FunnelMode;
  ownerOrgId?: string | null;
  isActive?: boolean;
}

/** Edit a redirect domain's pool placement (mode / owner / active / label). */
export async function updateRedirectDomain(id: string, input: UpdateRedirectDomainInput): Promise<RedirectDomainDTO> {
  return withSystem(async (tx) => {
    const row = await tx.redirectDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'Redirect domain not found');
    if (input.ownerOrgId) {
      const org = await tx.organization.findUnique({ where: { id: input.ownerOrgId }, select: { id: true } });
      if (!org) throw new AppError(400, 'Owner company not found');
    }
    const updated = await tx.redirectDomain.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label?.trim() || null } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.ownerOrgId !== undefined ? { ownerOrgId: input.ownerOrgId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select,
    });
    return toDTO(updated);
  });
}

/** Make a domain the default (the launch-time fallback when a buyer's pool is empty). */
export async function setDefaultRedirectDomain(id: string): Promise<RedirectDomainDTO> {
  return withSystem(async (tx) => {
    const row = await tx.redirectDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'Redirect domain not found');
    await tx.redirectDomain.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const updated = await tx.redirectDomain.update({ where: { id }, data: { isDefault: true }, select });
    return toDTO(updated);
  });
}

export async function deleteRedirectDomain(id: string): Promise<void> {
  await withSystem(async (tx) => {
    const row = await tx.redirectDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'Redirect domain not found');
    await tx.redirectDomain.delete({ where: { id } });
  });
}

/**
 * Reachability check: hit `https://{host}/health/live` (the redirect Worker's health route) and
 * record the result + the `healthy` flag (which the launch pool selection + the broken-domain alert
 * read). A domain only works once its DNS points at the Worker and the route is live.
 */
export async function verifyRedirectDomain(id: string): Promise<RedirectDomainDTO> {
  const row = await withSystem((tx) => tx.redirectDomain.findUnique({ where: { id }, select: { host: true } }));
  if (!row) throw new AppError(404, 'Redirect domain not found');
  const { ok, lastCheck } = await probeHost(row.host, '/health/live');
  const updated = await withSystem((tx) =>
    tx.redirectDomain.update({ where: { id }, data: { healthy: ok, lastCheck, verifiedAt: ok ? new Date() : undefined }, select }),
  );
  return toDTO(updated);
}

/** Shared reachability probe (used by verify + the health cron). Returns ok + a short status string. */
export async function probeHost(host: string, path = '/'): Promise<{ ok: boolean; lastCheck: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`https://${host}${path}`, { signal: ctrl.signal, redirect: 'manual' }).finally(() => clearTimeout(t));
    // 2xx/3xx = reachable (the redirect Worker 302s; the white site 200s).
    const ok = res.status >= 200 && res.status < 400;
    return { ok, lastCheck: ok ? `ok ${res.status}` : `unexpected ${res.status}` };
  } catch (err) {
    return { ok: false, lastCheck: `unreachable: ${(err as Error).message}`.slice(0, 200) };
  }
}
