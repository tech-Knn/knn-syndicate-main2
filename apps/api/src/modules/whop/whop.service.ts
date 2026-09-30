import { randomUUID } from 'node:crypto';
import { env } from '@knn/config';
import { type Prisma, type TxClient, WhopConnectionStatus, withSystem } from '@knn/db';
import { decryptToken, encryptToken } from '@knn/fb';
import { ROLES, type WhopChecklist, type WhopEnvironment } from '@knn/shared';
import { type WhopClient, type WhopHealth, type WhopSocialAccount, createWhopClient, isWhopError, runWhopHealthCheck, whopApi } from '@knn/whop';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import { whopToAppError } from '../../lib/whop-errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/**
 * Whop Ads connections (D33). A user connects a Whop business with its `biz_` id + an Account API key.
 * The key is encrypted at rest (AES-256-GCM, same as our other tokens) and never returned, logged or
 * put in an error. Whop has its OWN tables: fb_* lookups are provider-blind, so a Whop row there could
 * be handed to Facebook calls.
 */

export interface WhopPageView {
  /** Whop's social account id, `sacc_…`. */
  id: string;
  platform: string;
  name: string | null;
  username: string | null;
  verified: boolean;
  error: string | null;
}

export interface WhopConnectionView {
  id: string;
  bizId: string;
  environment: WhopEnvironment;
  label: string | null;
  /** Last four characters of the key: the only part of it we ever show. */
  apiKeyLast4: string;
  status: 'ACTIVE' | 'BROKEN';
  lastError: string | null;
  reportingCurrency: string | null;
  apiVersionDate: string;
  checklist: WhopChecklist | null;
  lastCheckedAt: string | null;
  connectedAt: string;
  pages: WhopPageView[];
}

export interface WhopConnectionWithOwner extends WhopConnectionView {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  orgId: string;
  orgName: string;
}

export interface WhopStatus {
  /** Whether this user may use Whop Ads at all (global flag AND the company switch). */
  enabled: boolean;
  /** Whether they may connect a sandbox business. */
  allowSandbox: boolean;
}

export interface ConnectInput {
  bizId: string;
  apiKey: string;
  label?: string;
  environment: WhopEnvironment;
}

// ── access gate ─────────────────────────────────────────────────────────────────────────────────

/**
 * Whop Ads is off unless BOTH the global flag and the user's company switch are on. A super-admin
 * (who belongs to the platform org, which has no switch) only needs the global flag.
 */
export async function whopStatus(auth: AuthContext): Promise<WhopStatus> {
  if (!env.WHOP_ADS_ENABLED) return { enabled: false, allowSandbox: false };
  if (auth.role === ROLES.SUPER_ADMIN) return { enabled: true, allowSandbox: true };
  const org = await withSystem((tx) => tx.organization.findUnique({ where: { id: auth.orgId }, select: { whopEnabled: true } }));
  return { enabled: Boolean(org?.whopEnabled), allowSandbox: env.WHOP_ALLOW_SANDBOX };
}

/**
 * Is Whop Ads on for a company: the global flag AND its switch. For flows with no signed-in user (the internal
 * launch runs as the buyer but the worker's status sync does not), where `whopStatus(auth)` cannot be used.
 */
export async function whopEnabledForOrg(orgId: string): Promise<boolean> {
  if (!env.WHOP_ADS_ENABLED) return false;
  const org = await withSystem((tx) => tx.organization.findUnique({ where: { id: orgId }, select: { whopEnabled: true } }));
  return Boolean(org?.whopEnabled);
}

/** 404 (not 403) when off, so the feature is invisible rather than merely forbidden. */
async function assertEnabled(auth: AuthContext): Promise<WhopStatus> {
  const status = await whopStatus(auth);
  if (!status.enabled) throw new AppError(404, 'Not found');
  return status;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const baseUrlFor = (environment: WhopEnvironment): string => (environment === 'SANDBOX' ? env.WHOP_SANDBOX_API_BASE : env.WHOP_API_BASE);

function clientFor(conn: { apiKeyEnc: string; environment: WhopEnvironment; apiVersionDate: string }): WhopClient {
  return createWhopClient({ apiKey: decryptToken(conn.apiKeyEnc), baseUrl: baseUrlFor(conn.environment), versionDate: conn.apiVersionDate });
}

type ConnectionRow = Prisma.WhopConnectionGetPayload<{ include: { socialAccounts: true } }>;

function toView(c: ConnectionRow): WhopConnectionView {
  return {
    id: c.id,
    bizId: c.bizId,
    environment: c.environment,
    label: c.label,
    apiKeyLast4: c.apiKeyLast4,
    status: c.status,
    lastError: c.lastError,
    reportingCurrency: c.reportingCurrency,
    apiVersionDate: c.apiVersionDate,
    checklist: (c.checks as unknown as WhopChecklist | null) ?? null,
    lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
    connectedAt: c.connectedAt.toISOString(),
    pages: c.socialAccounts
      .slice()
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map((p) => ({ id: p.whopId, platform: p.platform, name: p.name, username: p.username, verified: p.verified, error: p.error })),
  };
}

const credentialsDetail = (h: WhopHealth): string | null => h.checklist.items.find((i) => i.key === 'credentials')?.detail ?? null;

/** Replace a connection's stored pages with what Whop reported. */
async function syncPages(tx: TxClient, conn: { id: string; orgId: string }, pages: readonly WhopSocialAccount[]): Promise<void> {
  await tx.whopSocialAccount.deleteMany({ where: { connectionId: conn.id, whopId: { notIn: pages.map((p) => p.id) } } });
  for (const p of pages) {
    const data = { platform: p.platform, name: p.name, username: p.username, externalId: p.external_id, verified: p.verified, error: p.error, syncedAt: new Date() };
    await tx.whopSocialAccount.upsert({
      where: { connectionId_whopId: { connectionId: conn.id, whopId: p.id } },
      create: { orgId: conn.orgId, connectionId: conn.id, whopId: p.id, ...data },
      update: data,
    });
  }
}

/** Save a health check: checklist, status, currency, and the page list (only when Whop let us read it). */
async function persistHealth(tx: TxClient, conn: { id: string; orgId: string; label: string | null }, health: WhopHealth): Promise<void> {
  const ok = health.keyStatus === 'ok';
  const unreachable = health.keyStatus === 'unreachable';
  await tx.whopConnection.update({
    where: { id: conn.id },
    data: {
      ...(unreachable ? {} : { status: ok ? WhopConnectionStatus.ACTIVE : WhopConnectionStatus.BROKEN, lastError: ok ? null : credentialsDetail(health) }),
      label: health.accountTitle ?? conn.label,
      reportingCurrency: health.reportingCurrency ?? undefined,
      checks: health.checklist as unknown as Prisma.InputJsonValue,
      lastCheckedAt: new Date(health.checklist.checkedAt),
    },
  });
  if (health.pagesRead) await syncPages(tx, conn, health.pages);
}

async function loadConnection(auth: AuthContext, id: string): Promise<ConnectionRow> {
  const conn = await runScoped(auth, (tx) => tx.whopConnection.findUnique({ where: { id }, include: { socialAccounts: true } }));
  // A user can touch only their own connections; a super-admin can touch any (oversight).
  if (!conn || (auth.role !== ROLES.SUPER_ADMIN && conn.userId !== auth.userId)) throw new AppError(404, 'Whop connection not found');
  return conn;
}

/**
 * Run a Whop call for a connection. A rejected key (401) marks the connection BROKEN, alerts once, and
 * answers with a clear message; every other Whop failure is mapped to a plain-language response.
 */
async function withWhop<T>(auth: AuthContext, conn: ConnectionRow, fn: (client: WhopClient) => Promise<T>): Promise<T> {
  try {
    return await fn(clientFor(conn));
  } catch (err) {
    if (!isWhopError(err)) throw err;
    if (err.kind === 'auth' && conn.status !== WhopConnectionStatus.BROKEN) await markBroken(conn, 'Whop rejected the API key. Reconnect with a working key.');
    throw whopToAppError(err);
  }
}

/**
 * Flip a connection to BROKEN and tell its owner, ONCE. Conditional on the connection still being ACTIVE and (when the caller
 * knows it) on the key that just failed: a buyer who reconnected meanwhile has a new key, and an old key's late 401 must not
 * break the connection they just fixed; two jobs failing at once must not notify twice.
 */
async function markBroken(conn: { id: string; orgId: string; userId: string; bizId: string; label: string | null; apiKeyEnc?: string }, reason: string): Promise<void> {
  const res = await withSystem((tx) =>
    tx.whopConnection.updateMany({
      where: { id: conn.id, status: WhopConnectionStatus.ACTIVE, ...(conn.apiKeyEnc ? { apiKeyEnc: conn.apiKeyEnc } : {}) },
      data: { status: WhopConnectionStatus.BROKEN, lastError: reason },
    }),
  );
  if (res.count === 0) return;
  await notify({
    orgId: conn.orgId,
    userId: conn.userId,
    type: 'whop_connection_broken',
    title: 'Whop connection needs attention',
    body: `${conn.label ?? conn.bizId} (${conn.bizId}): ${reason}`,
  });
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────

/** The caller's own connections. */
export async function listConnections(auth: AuthContext): Promise<WhopConnectionView[]> {
  await assertEnabled(auth);
  const rows = await runScoped(auth, (tx) =>
    tx.whopConnection.findMany({ where: { userId: auth.userId }, orderBy: { connectedAt: 'asc' }, include: { socialAccounts: true } }),
  );
  return rows.map(toView);
}

/** Every connection on the platform with its owner (super-admin oversight; route-guarded). */
export async function listAllConnections(auth: AuthContext): Promise<WhopConnectionWithOwner[]> {
  if (auth.role !== ROLES.SUPER_ADMIN) throw new AppError(403, 'Only a super admin can see all Whop connections');
  await assertEnabled(auth);
  const rows = await withSystem((tx) =>
    tx.whopConnection.findMany({
      orderBy: { connectedAt: 'desc' },
      include: { socialAccounts: true, user: { select: { id: true, name: true, email: true, organization: { select: { id: true, name: true } } } } },
    }),
  );
  return rows.map((r) => ({
    ...toView(r),
    ownerId: r.user.id,
    ownerName: r.user.name,
    ownerEmail: r.user.email,
    orgId: r.user.organization.id,
    orgName: r.user.organization.name,
  }));
}

export async function getConnection(auth: AuthContext, id: string): Promise<WhopConnectionView> {
  await assertEnabled(auth);
  return toView(await loadConnection(auth, id));
}

/**
 * Connect (or reconnect) a Whop business. The key is verified against Whop BEFORE anything is stored:
 * a key that cannot even read the business's campaigns is refused with Whop's reason, so the user is
 * never left with a dead connection. Reconnecting the same business replaces its key.
 */
export async function connect(auth: AuthContext, input: ConnectInput): Promise<WhopConnectionView> {
  const status = await assertEnabled(auth);
  if (input.environment === 'SANDBOX' && !status.allowSandbox) throw new AppError(403, 'Sandbox connections are not enabled here.');

  const apiKey = input.apiKey.trim();
  const client = createWhopClient({ apiKey, baseUrl: baseUrlFor(input.environment), versionDate: env.WHOP_API_VERSION_DATE });
  const health = await runWhopHealthCheck(whopApi(client), { bizId: input.bizId, environment: input.environment });

  if (health.keyStatus === 'unreachable') throw new AppError(502, credentialsDetail(health) ?? 'Whop did not answer. Try again in a minute.', { checklist: health.checklist });
  if (!health.checklist.canDraft) throw new AppError(400, credentialsDetail(health) ?? 'Whop would not accept this key for that business.', { checklist: health.checklist });

  const enc = encryptToken(apiKey);
  const conn = await runScoped(auth, async (tx) => {
    const data = {
      label: health.accountTitle ?? input.label ?? null,
      apiKeyEnc: enc,
      apiKeyLast4: apiKey.slice(-4),
      apiVersionDate: env.WHOP_API_VERSION_DATE,
      status: WhopConnectionStatus.ACTIVE,
      lastError: null,
    };
    const row = await tx.whopConnection.upsert({
      where: { userId_bizId_environment: { userId: auth.userId, bizId: input.bizId, environment: input.environment } },
      create: { orgId: auth.orgId, userId: auth.userId, bizId: input.bizId, environment: input.environment, ...data },
      update: data,
    });
    await persistHealth(tx, row, health);
    await writeAudit(tx, {
      orgId: auth.orgId,
      actorId: auth.userId,
      action: 'whop.connected',
      entityType: 'whop_connection',
      entityId: row.id,
      details: { bizId: input.bizId, environment: input.environment, canLaunch: health.checklist.canLaunch },
    });
    return row;
  });
  return toView(await loadConnection(auth, conn.id));
}

/** Re-run the checklist against Whop now and save the result. */
export async function recheck(auth: AuthContext, id: string): Promise<WhopConnectionView> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  const health = await runWhopHealthCheck(whopApi(clientFor(conn)), { bizId: conn.bizId, environment: conn.environment });
  await withSystem((tx) => persistHealth(tx, conn, health));
  const becameBroken = conn.status === WhopConnectionStatus.ACTIVE && !['ok', 'unreachable'].includes(health.keyStatus);
  if (becameBroken) {
    await notify({
      orgId: conn.orgId,
      userId: conn.userId,
      type: 'whop_connection_broken',
      title: 'Whop connection needs attention',
      body: `${conn.label ?? conn.bizId} (${conn.bizId}): ${credentialsDetail(health) ?? 'the key no longer works'}`,
    });
  }
  return toView(await loadConnection(auth, id));
}

/**
 * Disconnect: deletes the stored key and its pages. Refused while campaigns are LIVE on the business: once the key is
 * gone they keep spending at Whop with no way to pause them from here (pause, budgets and the status sync all need it).
 * Paused or finished campaigns do not block it: they cost nothing, and reconnecting the same business picks them up again.
 */
export async function disconnect(auth: AuthContext, id: string): Promise<void> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  const live = await withSystem((tx) =>
    tx.campaign.count({
      where: { adProvider: 'WHOP', status: { in: ['ACTIVE', 'LAUNCHING'] }, OR: [{ whopConnectionId: id }, { whopBizId: conn.bizId, buyerId: conn.userId }] },
    }),
  );
  if (live > 0) {
    throw new AppError(409, `${live} campaign${live === 1 ? ' is' : 's are'} live on this business. Pause ${live === 1 ? 'it' : 'them'} first: without the key they would keep spending on Whop and could not be paused from here.`);
  }
  await runScoped(auth, async (tx) => {
    await tx.whopConnection.delete({ where: { id } });
    await writeAudit(tx, { orgId: conn.orgId, actorId: auth.userId, action: 'whop.disconnected', entityType: 'whop_connection', entityId: id, details: { bizId: conn.bizId, environment: conn.environment } });
  });
}

/** The business's Facebook / Instagram pages, read live from Whop and saved. */
export async function listPages(auth: AuthContext, id: string): Promise<WhopPageView[]> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  const pages = await withWhop(auth, conn, (client) => whopApi(client).allSocialAccounts(conn.bizId));
  await withSystem((tx) => syncPages(tx, conn, pages.filter((p) => p.platform === 'facebook' || p.platform === 'instagram')));
  return toView(await loadConnection(auth, id)).pages;
}

/** Start Whop's Meta Business sign-in. The user finishes on Meta, then returns to `redirectUrl`. */
export async function startMetaConnect(auth: AuthContext, id: string, redirectUrl: string): Promise<{ authorizeUrl: string }> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  // Only our own dashboard may be the return address (never an arbitrary URL).
  if (new URL(redirectUrl).origin !== new URL(env.WEB_DOMAIN).origin) throw new AppError(400, 'The return address must be this dashboard.');
  const res = await withWhop(auth, conn, (client) => whopApi(client).connectMetaBusiness({ accountId: conn.bizId, redirectUrl }));
  await runScoped(auth, (tx) => writeAudit(tx, { orgId: conn.orgId, actorId: auth.userId, action: 'whop.meta_connect_started', entityType: 'whop_connection', entityId: id }));
  return { authorizeUrl: res.authorize_url };
}

/** Ask Whop to create a Whop-managed Facebook page (the business needs a logo, banner and description). */
export async function createManagedPage(auth: AuthContext, id: string): Promise<WhopConnectionView> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  await withWhop(auth, conn, (client) => whopApi(client).createFacebookPage({ accountId: conn.bizId, idempotencyKey: randomUUID() }));
  await runScoped(auth, (tx) => writeAudit(tx, { orgId: conn.orgId, actorId: auth.userId, action: 'whop.page_created', entityType: 'whop_connection', entityId: id }));
  return recheck(auth, id);
}

/** Clear a resolved page error on Whop's side, then re-check. */
export async function refreshPage(auth: AuthContext, id: string, pageId: string): Promise<WhopConnectionView> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  if (!conn.socialAccounts.some((p) => p.whopId === pageId)) throw new AppError(404, 'Page not found on this connection');
  await withWhop(auth, conn, (client) => whopApi(client).refreshSocialAccount({ id: pageId, accountId: conn.bizId, idempotencyKey: randomUUID() }));
  return recheck(auth, id);
}

export interface PixelCheckResult {
  installed: boolean;
  lastSeenDays: number | null;
  /** Days since each event last fired (e.g. `{ view_content: 0 }`). */
  lastFiredDays: Record<string, number>;
  /** True when the URL is hosted on Whop itself, so no snippet is needed. */
  nativeTracking: boolean;
  /** Whether Whop could load the page (null when no URL was given). */
  reachable: boolean | null;
  url: string | null;
}

/** Ask Whop whether its pixel is installed: for the whole business, or for one page when `url` is given. */
export async function checkPixel(auth: AuthContext, id: string, url?: string): Promise<PixelCheckResult> {
  await assertEnabled(auth);
  const conn = await loadConnection(auth, id);
  const res = await withWhop(auth, conn, (client) => whopApi(client).validatePixel({ accountId: conn.bizId, url }));
  return {
    installed: res.installed,
    lastSeenDays: res.last_seen_days ?? null,
    lastFiredDays: res.last_fired_days ?? {},
    nativeTracking: Boolean(res.native_tracking),
    reachable: res.reachable ?? null,
    url: res.url ?? null,
  };
}

// Shared with the campaign launch and controls (apps/api/src/modules/campaigns/whop-*.ts).
export { clientFor as whopClientFor, markBroken as markWhopConnectionBroken };
