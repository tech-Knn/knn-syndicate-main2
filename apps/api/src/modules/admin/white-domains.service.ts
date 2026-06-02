import { withSystem } from '@knn/db';
import { AppError } from '../../lib/errors.js';
import { probeHost } from './redirect-domains.service.js';

/**
 * The WHITE domain pool — the clean, separately-hosted content sites used as the cloaker funnel's
 * fallback + FB display link (served by the @knn/white Worker on a separate Cloudflare account).
 * A flat, super-admin-managed pool; launch rotates least-loaded across the active + healthy ones.
 */
export interface WhiteDomainDTO {
  id: string;
  host: string;
  label: string | null;
  isActive: boolean;
  healthy: boolean;
  lastCheck: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

const select = {
  id: true,
  host: true,
  label: true,
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
  isActive: boolean;
  healthy: boolean;
  lastCheck: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
};

function toDTO(r: Row): WhiteDomainDTO {
  return {
    id: r.id,
    host: r.host,
    label: r.label,
    isActive: r.isActive,
    healthy: r.healthy,
    lastCheck: r.lastCheck,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function normalizeHost(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}

export async function listWhiteDomains(): Promise<WhiteDomainDTO[]> {
  const rows = await withSystem((tx) => tx.whiteDomain.findMany({ select, orderBy: { createdAt: 'asc' } }));
  return rows.map(toDTO);
}

export async function createWhiteDomain(hostInput: string, label?: string): Promise<WhiteDomainDTO> {
  const host = normalizeHost(hostInput);
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new AppError(400, 'Enter a valid hostname, e.g. readoranow.com');
  }
  return withSystem(async (tx) => {
    const existing = await tx.whiteDomain.findUnique({ where: { host }, select: { id: true } });
    if (existing) throw new AppError(409, `${host} is already added`);
    const row = await tx.whiteDomain.create({ data: { host, label: label?.trim() || null }, select });
    return toDTO(row);
  });
}

export async function updateWhiteDomain(id: string, input: { label?: string | null; isActive?: boolean }): Promise<WhiteDomainDTO> {
  return withSystem(async (tx) => {
    const row = await tx.whiteDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'White domain not found');
    const updated = await tx.whiteDomain.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label?.trim() || null } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select,
    });
    return toDTO(updated);
  });
}

export async function deleteWhiteDomain(id: string): Promise<void> {
  await withSystem(async (tx) => {
    const row = await tx.whiteDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'White domain not found');
    await tx.whiteDomain.delete({ where: { id } });
  });
}

/** Reachability check: the white site serves a 200 homepage. Records `healthy` + `lastCheck`. */
export async function verifyWhiteDomain(id: string): Promise<WhiteDomainDTO> {
  const row = await withSystem((tx) => tx.whiteDomain.findUnique({ where: { id }, select: { host: true } }));
  if (!row) throw new AppError(404, 'White domain not found');
  const { ok, lastCheck } = await probeHost(row.host, '/');
  const updated = await withSystem((tx) =>
    tx.whiteDomain.update({ where: { id }, data: { healthy: ok, lastCheck, verifiedAt: ok ? new Date() : undefined }, select }),
  );
  return toDTO(updated);
}
