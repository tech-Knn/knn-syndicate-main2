import { withSystem } from '@knn/db';
import { AppError } from '../../lib/errors.js';

export interface RedirectDomainDTO {
  id: string;
  host: string;
  label: string | null;
  isDefault: boolean;
  lastCheck: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

const select = {
  id: true,
  host: true,
  label: true,
  isDefault: true,
  lastCheck: true,
  verifiedAt: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  host: string;
  label: string | null;
  isDefault: boolean;
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

/** The `go.*` redirect domains the platform can attach to ad creatives (super-admin). */
export async function listRedirectDomains(): Promise<RedirectDomainDTO[]> {
  const rows = await withSystem((tx) =>
    tx.redirectDomain.findMany({ select, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
  );
  return rows.map(toDTO);
}

/** Add a redirect domain. The FIRST one added becomes the default automatically. */
export async function createRedirectDomain(hostInput: string, label?: string): Promise<RedirectDomainDTO> {
  const host = normalizeHost(hostInput);
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new AppError(400, 'Enter a valid hostname, e.g. go.example.com');
  }
  return withSystem(async (tx) => {
    const existing = await tx.redirectDomain.findUnique({ where: { host }, select: { id: true } });
    if (existing) throw new AppError(409, `${host} is already added`);
    const count = await tx.redirectDomain.count();
    const row = await tx.redirectDomain.create({
      data: { host, label: label?.trim() || null, isDefault: count === 0 },
      select,
    });
    return toDTO(row);
  });
}

/** Make a domain the default (what new ad creatives link to). Unsets any prior default. */
export async function setDefaultRedirectDomain(id: string): Promise<RedirectDomainDTO> {
  return withSystem(async (tx) => {
    const row = await tx.redirectDomain.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new AppError(404, 'Redirect domain not found');
    // Clear the current default first so the partial-unique index allows the switch.
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
 * Reachability check: hit `https://{host}/health/live` (the redirect Worker's health route)
 * and record the result. A domain only actually works once its DNS points at the Worker and
 * the Worker route is live — this surfaces that without guessing.
 */
export async function verifyRedirectDomain(id: string): Promise<RedirectDomainDTO> {
  const row = await withSystem((tx) => tx.redirectDomain.findUnique({ where: { id }, select: { host: true } }));
  if (!row) throw new AppError(404, 'Redirect domain not found');

  let lastCheck: string;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`https://${row.host}/health/live`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    ok = res.ok;
    lastCheck = ok ? `ok ${res.status}` : `unexpected ${res.status}`;
  } catch (err) {
    lastCheck = `unreachable: ${(err as Error).message}`.slice(0, 200);
  }

  const updated = await withSystem((tx) =>
    tx.redirectDomain.update({
      where: { id },
      data: { lastCheck, verifiedAt: ok ? new Date() : undefined },
      select,
    }),
  );
  return toDTO(updated);
}
