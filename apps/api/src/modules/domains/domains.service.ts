import { randomUUID } from 'node:crypto';
import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import { discoverChannelsInRanges, listCustomChannels, parseChannelRanges, refreshGoogleToken } from '@knn/adsense';
import { decryptToken, encryptToken } from '@knn/fb';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/**
 * Domain (website) management — Phase C. A domain is a monetized article host mapped to
 * ONE AFS account (⇒ its pubId), with its own channel-id allocation. Global (platform-
 * level, super-admin). Verification is a liveness check: the domain must serve our
 * article app at `/api/site-verify` (proving DNS points to us); admin-controlled domains
 * don't need a cryptographic proof. Per-domain channel sync imports only the domain's
 * id ranges from its AFS account, tagging each Channel with `domainId`.
 */

export interface DomainRow {
  id: string;
  host: string;
  afsAccountId: string;
  afsLabel: string | null;
  afsPubId: string | null;
  channelRanges: string | null;
  styleId: string | null;
  adsafe: string | null;
  status: string;
  verifyToken: string;
  verifiedAt: string | null;
  lastCheck: string | null;
  channelCount: number;
  createdAt: string;
}

const MAX_DOMAIN_CHANNELS = 2000;

export interface CreateDomainInput {
  host: string;
  afsAccountId: string;
  channelRanges?: string;
  styleId?: string;
  adsafe?: string;
}

/** Normalize a user/edge-supplied host: lowercase, strip scheme, then path, then port. */
function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}

/**
 * Edge on-demand-TLS gate (Caddy `ask` endpoint). Returns true iff `host` is a
 * registered Domain. Allowed regardless of status: a cert must be issued on the
 * first HTTPS hit BEFORE liveness verification can succeed (verification fetches
 * `https://host/api/site-verify`), so gating on LIVE would be a chicken-and-egg.
 * Unregistered hosts are refused → Caddy won't mint certs for arbitrary domains.
 */
export async function isDomainRegistered(rawHost: string): Promise<boolean> {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  const row = await withSystem((tx) => tx.domain.findUnique({ where: { host }, select: { id: true } }));
  return row !== null;
}

/** Per-host AFS monetization config the article edge renders with (Phase D funnel). */
export interface SiteConfig {
  host: string;
  pubId: string;
  styleId: string | null;
  adsafe: string | null;
}

/**
 * Resolve a registered host → the AFS config its article pages should render with:
 * the mapped AFS account's pubId plus the domain's own style/adsafe. This is what
 * makes one article app serve many websites, each monetizing under its OWN AFS
 * account. Returns null for an unregistered host (or one whose AFS account has no
 * pubId yet) → the article app falls back to its build-time env defaults.
 */
export async function resolveSiteConfig(rawHost: string): Promise<SiteConfig | null> {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const domain = await withSystem((tx) =>
    tx.domain.findUnique({ where: { host }, include: { afsAccount: { select: { afsPubId: true } } } }),
  );
  if (!domain || !domain.afsAccount.afsPubId) return null;
  return { host, pubId: domain.afsAccount.afsPubId, styleId: domain.styleId, adsafe: domain.adsafe };
}

/** DNS guidance shown to the admin: point the host at our article ingress. */
export function dnsGuidance(): { cnameTarget: string } {
  // The article app's host is the canonical ingress; point new domains there.
  let host = env.ARTICLE_DOMAIN;
  try {
    host = new URL(env.ARTICLE_DOMAIN).host;
  } catch {
    /* ARTICLE_DOMAIN may already be a bare host */
  }
  return { cnameTarget: host };
}

async function withCounts(
  rows: {
    id: string;
    host: string;
    afsAccountId: string;
    channelRanges: string | null;
    styleId: string | null;
    adsafe: string | null;
    status: string;
    verifyToken: string;
    verifiedAt: Date | null;
    lastCheck: string | null;
    createdAt: Date;
    afsAccount: { label: string | null; afsPubId: string | null };
  }[],
): Promise<DomainRow[]> {
  const counts = await withSystem((tx) =>
    tx.channel.groupBy({ by: ['domainId'], where: { domainId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
  );
  const byDomain = new Map(counts.map((c) => [c.domainId, c._count._all]));
  return rows.map((d) => ({
    id: d.id,
    host: d.host,
    afsAccountId: d.afsAccountId,
    afsLabel: d.afsAccount.label,
    afsPubId: d.afsAccount.afsPubId,
    channelRanges: d.channelRanges,
    styleId: d.styleId,
    adsafe: d.adsafe,
    status: d.status,
    verifyToken: d.verifyToken,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    lastCheck: d.lastCheck,
    channelCount: byDomain.get(d.id) ?? 0,
    createdAt: d.createdAt.toISOString(),
  }));
}

export async function listDomains(): Promise<DomainRow[]> {
  return withSystem(async (tx) => {
    const rows = await tx.domain.findMany({
      orderBy: { createdAt: 'asc' },
      include: { afsAccount: { select: { label: true, afsPubId: true } } },
    });
    return withCounts(rows);
  });
}

export async function createDomain(actor: AuthContext, input: CreateDomainInput): Promise<DomainRow> {
  const host = normalizeHost(input.host);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new AppError(400, 'Enter a valid domain host (e.g. articles.example.com)');
  return withSystem(async (tx) => {
    const afs = await tx.googleConnection.findUnique({ where: { id: input.afsAccountId } });
    if (!afs) throw new AppError(404, 'AFS account not found');
    if (await tx.domain.findUnique({ where: { host } })) throw new AppError(409, 'Domain already registered');
    const created = await tx.domain.create({
      data: {
        host,
        afsAccountId: input.afsAccountId,
        channelRanges: input.channelRanges?.trim() || null,
        styleId: input.styleId?.trim() || null,
        adsafe: input.adsafe?.trim() || null,
        verifyToken: randomUUID(),
        status: 'PENDING_DNS',
      },
      include: { afsAccount: { select: { label: true, afsPubId: true } } },
    });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.created', entityType: 'domain', entityId: created.id, details: { host } });
    return (await withCounts([created]))[0]!;
  });
}

export async function updateDomain(
  actor: AuthContext,
  id: string,
  input: Partial<Pick<CreateDomainInput, 'afsAccountId' | 'channelRanges' | 'styleId' | 'adsafe'>>,
): Promise<DomainRow> {
  return withSystem(async (tx) => {
    if (input.afsAccountId && !(await tx.googleConnection.findUnique({ where: { id: input.afsAccountId } }))) {
      throw new AppError(404, 'AFS account not found');
    }
    const updated = await tx.domain.update({
      where: { id },
      data: {
        ...(input.afsAccountId ? { afsAccountId: input.afsAccountId } : {}),
        ...(input.channelRanges !== undefined ? { channelRanges: input.channelRanges.trim() || null } : {}),
        ...(input.styleId !== undefined ? { styleId: input.styleId.trim() || null } : {}),
        ...(input.adsafe !== undefined ? { adsafe: input.adsafe.trim() || null } : {}),
      },
      include: { afsAccount: { select: { label: true, afsPubId: true } } },
    });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.updated', entityType: 'domain', entityId: id });
    return (await withCounts([updated]))[0]!;
  });
}

export async function deleteDomain(actor: AuthContext, id: string): Promise<void> {
  await withSystem(async (tx) => {
    const offers = await tx.offer.count({ where: { domainId: id } });
    if (offers > 0) throw new AppError(409, 'Domain is used by live offers — remove them first');
    // Drop this domain's channels from the pool. They belong to THIS website's AFS
    // allocation, so they must NOT fall back to the global pool (a legacy campaign could
    // grab them and attribution would look in the wrong AFS account). No offer references
    // the domain here, so its channels are AVAILABLE; they can be re-imported if it returns.
    await tx.channel.deleteMany({ where: { domainId: id, status: 'AVAILABLE' } });
    await tx.domain.delete({ where: { id } });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.deleted', entityType: 'domain', entityId: id });
  });
}

export interface VerifyDeps {
  fetch: typeof fetch;
}
const defaultVerifyDeps: VerifyDeps = { fetch: (input, init) => fetch(input, init) };

/** Liveness check: the host must serve our article app's /api/site-verify. */
export async function verifyDomain(actor: AuthContext, id: string, deps: VerifyDeps = defaultVerifyDeps): Promise<DomainRow> {
  const domain = await withSystem((tx) => tx.domain.findUnique({ where: { id } }));
  if (!domain) throw new AppError(404, 'Domain not found');
  let ok = false;
  let detail = '';
  try {
    const ctrl = AbortSignal.timeout(8000);
    const res = await deps.fetch(`https://${domain.host}/api/site-verify`, { signal: ctrl });
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; host?: string };
      ok = body.ok === true;
      detail = ok ? 'serving the article app' : 'unexpected response';
    } else {
      detail = `HTTP ${res.status}`;
    }
  } catch (err) {
    detail = `unreachable: ${String(err).slice(0, 80)}`;
  }
  return withSystem(async (tx) => {
    const updated = await tx.domain.update({
      where: { id },
      data: {
        status: ok ? 'LIVE' : 'ERROR',
        verifiedAt: ok ? new Date() : undefined,
        lastCheck: `${new Date().toISOString()} — ${detail}`,
      },
      include: { afsAccount: { select: { label: true, afsPubId: true } } },
    });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: ok ? 'domain.verified' : 'domain.verify_failed', entityType: 'domain', entityId: id });
    return (await withCounts([updated]))[0]!;
  });
}

async function freshTokenFor(acc: { id: string; accessTokenEnc: string; refreshTokenEnc: string | null; tokenExpiresAt: Date }): Promise<string> {
  if (acc.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptToken(acc.accessTokenEnc);
  if (!acc.refreshTokenEnc) throw new AppError(409, 'AFS token expired — reconnect the account');
  const r = await refreshGoogleToken(decryptToken(acc.refreshTokenEnc));
  await withSystem((tx) =>
    tx.googleConnection.update({
      where: { id: acc.id },
      data: { accessTokenEnc: encryptToken(r.accessToken), tokenExpiresAt: new Date(Date.now() + r.expiresInSec * 1000), status: 'ACTIVE', lastError: null },
    }),
  );
  return r.accessToken;
}

/** Import this domain's AFS channels (its id ranges) into the pool, tagged with domainId. */
export async function syncDomainChannels(
  actor: AuthContext,
  id: string,
  rangesSpec?: string,
): Promise<{ synced: number; added: number; ranges: string }> {
  const domain = await withSystem((tx) => tx.domain.findUnique({ where: { id }, include: { afsAccount: true } }));
  if (!domain) throw new AppError(404, 'Domain not found');
  if (!domain.afsAccount.adsenseAdClient) throw new AppError(409, 'The domain\'s AFS account has no AFS ad client resolved — reconnect it');

  const spec = (rangesSpec ?? domain.channelRanges ?? '').trim();
  const ranges = parseChannelRanges(spec);
  if (ranges.length === 0) throw new AppError(400, 'Set the channel id range(s) for this domain first (e.g. 09000-09500)');

  const token = await freshTokenFor(domain.afsAccount);
  const channels = await discoverChannelsInRanges(token, domain.afsAccount.adsenseAdClient, ranges, undefined, MAX_DOMAIN_CHANNELS);

  const added = await withSystem(async (tx) => {
    const existing = new Set((await tx.channel.findMany({ select: { channelId: true } })).map((c) => c.channelId));
    const fresh = channels.filter((ch) => !existing.has(ch.channelId));
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.channel.createMany({
        data: fresh.slice(i, i + 500).map((ch) => ({ channelId: ch.channelId, label: ch.displayName ?? null, status: 'AVAILABLE' as const, domainId: id })),
        skipDuplicates: true,
      });
    }
    await tx.domain.update({ where: { id }, data: { channelRanges: spec } });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.channels.synced', entityType: 'domain', entityId: id, details: { ranges: spec, discovered: channels.length, added: fresh.length } });
    return fresh.length;
  });
  return { synced: channels.length, added, ranges: spec };
}

// ── Channel browser + selective import (pick channels by NAME, not just by range) ──

export interface AfsChannelRow {
  channelId: string;
  /** The AdSense custom-channel name (human-friendly — what the admin selects by). */
  displayName: string | null;
  /** Already in our pool? */
  imported: boolean;
  /** Pool status if imported (AVAILABLE/ASSIGNED) — an ASSIGNED channel can't be removed. */
  status: string | null;
}

export interface BrowseChannelsDeps {
  /** List up to `max` of the ad client's custom channels (id + displayName). */
  fetchChannels: (token: string, adClient: string, max: number) => Promise<{ channelId: string; displayName?: string }[]>;
}
const defaultBrowseDeps: BrowseChannelsDeps = {
  fetchChannels: (token, adClient, max) => listCustomChannels(token, adClient, undefined, max),
};

/** How many of the account's channels to scan per LIVE browse (bounds the 100k account). */
const CHANNEL_SCAN_CAP = 20000;

/**
 * Filter channels by an optional name/id substring (`q`) AND an optional numeric id
 * range spec (`range`, e.g. "00500-01499, 02000-02100"). The range is how an admin bulk-
 * selects a contiguous block of ~1000 ids without ticking each one.
 */
function filterChannels(
  all: { channelId: string; displayName?: string }[],
  q?: string,
  range?: string,
): { channelId: string; displayName?: string }[] {
  const needle = (q ?? '').trim().toLowerCase();
  const ranges = parseChannelRanges((range ?? '').trim());
  return all.filter((c) => {
    if (needle && !(c.displayName ?? '').toLowerCase().includes(needle) && !c.channelId.includes(needle)) return false;
    if (ranges.length > 0) {
      const n = /^\d+$/.test(c.channelId) ? Number(c.channelId) : null;
      if (n === null || !ranges.some((r) => n >= r.start && n <= r.end)) return false;
    }
    return true;
  });
}

interface AfsAccountConn {
  id: string;
  adsenseAdClient: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date;
}

/**
 * Where the channel browser gets an account's channels: the LOCAL catalog (synced from
 * AdSense — instant, full 100k coverage) when populated, else a bounded LIVE API scan
 * (for accounts not yet catalog-synced + the test path). Sync the catalog from the
 * Platform page to make 100k-channel browsing fast.
 */
async function accountChannelSource(
  afsAccount: AfsAccountConn,
  deps: BrowseChannelsDeps,
): Promise<{ channelId: string; displayName?: string }[]> {
  const cat = await withSystem((tx) =>
    tx.afsChannelCatalog.findMany({ where: { afsAccountId: afsAccount.id }, select: { channelId: true, displayName: true } }),
  );
  if (cat.length > 0) return cat.map((c) => ({ channelId: c.channelId, displayName: c.displayName ?? undefined }));
  if (!afsAccount.adsenseAdClient) {
    throw new AppError(409, "The domain's AFS account has no channel catalog yet — sync it from the Platform page (or reconnect the account)");
  }
  const token = await freshTokenFor(afsAccount);
  return deps.fetchChannels(token, afsAccount.adsenseAdClient, CHANNEL_SCAN_CAP);
}

/**
 * Browse a domain's AFS account custom channels by name/id (Phase: channel selection).
 * AdSense channels have an arbitrary NAME + the real numeric channel id (the `ch` value);
 * the admin searches by name and picks which ids to use, rather than guessing a range.
 * `q` filters by name OR id substring; results are capped (`limit`) and flagged
 * `imported` (already in our pool). Super-admin only.
 */
export async function listDomainAfsChannels(
  actor: AuthContext,
  id: string,
  opts: { q?: string; range?: string; limit?: number } = {},
  deps: BrowseChannelsDeps = defaultBrowseDeps,
): Promise<{ channels: AfsChannelRow[]; scanned: number; total: number; truncated: boolean }> {
  void actor;
  const domain = await withSystem((tx) => tx.domain.findUnique({ where: { id }, include: { afsAccount: true } }));
  if (!domain) throw new AppError(404, 'Domain not found');

  const all = await accountChannelSource(domain.afsAccount, deps);

  const filtered = filterChannels(all, opts.q, opts.range);
  // Show up to the import cap so the table == what select-all / import will act on.
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 2000);
  const page = filtered.slice(0, limit);

  // Mark which of the SHOWN ids are already in our pool (targeted query on ≤limit ids).
  const ids = page.map((c) => c.channelId);
  const existing = ids.length
    ? await withSystem((tx) => tx.channel.findMany({ where: { channelId: { in: ids } }, select: { channelId: true, status: true } }))
    : [];
  const byId = new Map(existing.map((e) => [e.channelId, e.status]));

  return {
    channels: page.map((c) => ({
      channelId: c.channelId,
      displayName: c.displayName ?? null,
      imported: byId.has(c.channelId),
      status: byId.get(c.channelId) ?? null,
    })),
    scanned: all.length,
    total: filtered.length,
    truncated: filtered.length > limit || all.length >= CHANNEL_SCAN_CAP,
  };
}

export interface ChannelSelection {
  add?: { channelId: string; label?: string }[];
  remove?: string[];
}

/**
 * Apply a channel selection to a domain's pool: import the chosen ids (label = the AFS
 * name) as AVAILABLE channels tagged to the domain, and/or remove ids — but only ones
 * that are AVAILABLE for this domain (never an ASSIGNED channel a campaign is using).
 */
export async function setDomainChannels(actor: AuthContext, id: string, sel: ChannelSelection): Promise<{ added: number; removed: number }> {
  const domain = await withSystem((tx) => tx.domain.findUnique({ where: { id }, select: { id: true } }));
  if (!domain) throw new AppError(404, 'Domain not found');

  return withSystem(async (tx) => {
    let added = 0;
    let removed = 0;
    const adds = sel.add ?? [];
    if (adds.length > 0) {
      const seen = new Set(
        (await tx.channel.findMany({ where: { channelId: { in: adds.map((a) => a.channelId) } }, select: { channelId: true } })).map((c) => c.channelId),
      );
      const fresh = adds.filter((a) => !seen.has(a.channelId));
      for (let i = 0; i < fresh.length; i += 500) {
        const r = await tx.channel.createMany({
          data: fresh.slice(i, i + 500).map((a) => ({ channelId: a.channelId, label: a.label ?? null, status: 'AVAILABLE' as const, domainId: id })),
          skipDuplicates: true,
        });
        added += r.count;
      }
    }
    const removes = sel.remove ?? [];
    if (removes.length > 0) {
      // Only AVAILABLE channels of THIS domain — an ASSIGNED channel is in use.
      const r = await tx.channel.deleteMany({ where: { channelId: { in: removes }, domainId: id, status: 'AVAILABLE' } });
      removed = r.count;
    }
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.channels.selected', entityType: 'domain', entityId: id, details: { added, removed } });
    return { added, removed };
  });
}

/** Cap on a single "import all" so a slip on the 100k-channel account can't flood the pool. */
const IMPORT_ALL_CAP = 2000;

/**
 * Import EVERY channel the AFS account returns (optionally filtered by name/id `q`) into
 * the domain's pool, straight from the API — no ticking. For a dedicated account leave `q`
 * empty (imports all, ≤cap); on the shared 100k account pass a team name as `q` so you only
 * pull yours. Capped at {@link IMPORT_ALL_CAP}; `cappedAt` is set when more matched than imported.
 */
export async function importAllChannels(
  actor: AuthContext,
  id: string,
  opts: { q?: string; range?: string } = {},
  deps: BrowseChannelsDeps = defaultBrowseDeps,
): Promise<{ added: number; matched: number; scanned: number; cappedAt?: number }> {
  const domain = await withSystem((tx) => tx.domain.findUnique({ where: { id }, include: { afsAccount: true } }));
  if (!domain) throw new AppError(404, 'Domain not found');

  const all = await accountChannelSource(domain.afsAccount, deps);
  const matched = filterChannels(all, opts.q, opts.range);
  const toImport = matched.slice(0, IMPORT_ALL_CAP);

  const added = await withSystem(async (tx) => {
    const seen = new Set(
      (await tx.channel.findMany({ where: { channelId: { in: toImport.map((c) => c.channelId) } }, select: { channelId: true } })).map((c) => c.channelId),
    );
    const fresh = toImport.filter((c) => !seen.has(c.channelId));
    let n = 0;
    for (let i = 0; i < fresh.length; i += 500) {
      const r = await tx.channel.createMany({
        data: fresh.slice(i, i + 500).map((c) => ({ channelId: c.channelId, label: c.displayName ?? null, status: 'AVAILABLE' as const, domainId: id })),
        skipDuplicates: true,
      });
      n += r.count;
    }
    const tag = (opts.range ?? '').trim() || (opts.q ? `name:${opts.q}` : 'all');
    await tx.domain.update({ where: { id }, data: { channelRanges: tag } });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'domain.channels.import_all', entityType: 'domain', entityId: id, details: { q: opts.q, range: opts.range, matched: matched.length, added: n } });
    return n;
  });
  return { added, matched: matched.length, scanned: all.length, cappedAt: matched.length > IMPORT_ALL_CAP ? IMPORT_ALL_CAP : undefined };
}
