import { env } from '@knn/config';
import { FbConnectionStatus, withSystem } from '@knn/db';
import {
  FB_SCOPES,
  type FbAppKind,
  FbConnectionBrokenError,
  buildAuthUrl,
  checkAssetAccess,
  decryptToken,
  encryptToken,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchAdAccounts,
  fetchBusinessPixels,
  fetchPages,
  fetchPixels,
  fetchPromotePages,
  getMe,
  graphRequest,
  hasLaunchApp,
  hasVerifyApp,
  isFbConfigured,
} from '@knn/fb';
import { ROLES } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { signFbState, verifyFbState } from './state.js';

/** A connected Facebook profile (one OAuth connection). A user may have several. */
export interface FbProfile {
  id: string;
  fbUserId: string;
  name: string;
  /** Which app this connection is for: DATA (sync/reads/CAPI) or LAUNCH (short-lived, ad writes). */
  appKind: FbAppKind;
  status: FbConnectionStatus;
  scopes: string[];
  tokenExpiresAt: Date;
  lastError: string | null;
  connectedAt: Date;
  adAccountCount: number;
  pageCount: number;
}

/** A profile plus its owner — for the super-admin platform oversight view. */
export interface FbProfileWithOwner extends FbProfile {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  orgId: string;
  orgName: string;
}

export interface SyncResult {
  adAccounts: number;
  pages: number;
  pixels: number;
}

function profileName(c: { fbName: string | null; fbUserId: string }): string {
  return c.fbName?.trim() || `Profile ${c.fbUserId}`;
}

/** Build the Facebook OAuth dialog URL for the authenticated user (spec §5.2.1). The
 *  `appKind` picks which app to connect — DATA (default), the optional LAUNCH app, or the
 *  optional Advanced-Access VERIFY app. */
export async function getAuthUrl(auth: AuthContext, appKind: FbAppKind = 'DATA'): Promise<{ url: string }> {
  if (!isFbConfigured()) {
    throw new AppError(503, 'Facebook integration is not configured on this environment');
  }
  if (appKind === 'LAUNCH' && !hasLaunchApp()) {
    throw new AppError(503, 'The Facebook launch app is not configured on this environment');
  }
  if (appKind === 'VERIFY' && !hasVerifyApp()) {
    throw new AppError(503, 'The Facebook verification app is not configured on this environment');
  }
  const state = await signFbState({ userId: auth.userId, orgId: auth.orgId, appKind });
  return { url: buildAuthUrl(state, appKind) };
}

/**
 * Fetch the account graph from Facebook (network — done OUTSIDE any txn), then
 * persist it in a single transaction so we never hold a DB transaction open
 * across slow Graph API calls. Idempotent upsert keyed on the FB-side ids.
 */
async function syncFromFacebook(args: {
  connectionId: string;
  orgId: string;
  accessToken: string;
}): Promise<SyncResult> {
  const { connectionId, orgId, accessToken } = args;

  const [accounts, pages] = await Promise.all([
    fetchAdAccounts(accessToken),
    fetchPages(accessToken),
  ]);
  // BM-owned pixels, fetched ONCE per unique Business Manager (resolved cheaply from
  // fetchAdAccounts' business{id}) — not per ad account, which made sync slow.
  const businessIds = [...new Set(accounts.map((a) => a.businessId).filter((b): b is string => !!b))];
  const bizPixelEntries = await Promise.all(
    businessIds.map(async (bid) => [bid, await fetchBusinessPixels(bid, accessToken)] as const),
  );
  const bizPixels = new Map(bizPixelEntries);

  // Pixels usable by each account = the account's own pixels PLUS its BM's pixels
  // (a fresh ad account has none of its own). Merge + dedupe by FB pixel id.
  const pixelsByAccount = await Promise.all(
    accounts.map(async (account) => {
      const own = await fetchPixels(account.fbAccountId, accessToken);
      const biz = account.businessId ? (bizPixels.get(account.businessId) ?? []) : [];
      const byId = new Map<string, (typeof own)[number]>();
      for (const p of [...own, ...biz]) byId.set(p.fbPixelId, p);
      return { fbAccountId: account.fbAccountId, pixels: [...byId.values()] };
    }),
  );

  let pixelCount = 0;
  await withSystem(async (tx) => {
    const internalId = new Map<string, string>();
    for (const a of accounts) {
      const row = await tx.fbAdAccount.upsert({
        where: { connectionId_fbAccountId: { connectionId, fbAccountId: a.fbAccountId } },
        create: {
          orgId,
          connectionId,
          fbAccountId: a.fbAccountId,
          name: a.name,
          currency: a.currency,
          timezone: a.timezone,
          status: a.status,
        },
        update: { name: a.name, currency: a.currency, timezone: a.timezone, status: a.status },
      });
      internalId.set(a.fbAccountId, row.id);
    }

    for (const p of pages) {
      await tx.fbPage.upsert({
        where: { connectionId_fbPageId: { connectionId, fbPageId: p.fbPageId } },
        create: { orgId, connectionId, fbPageId: p.fbPageId, name: p.name, instagramId: p.instagramId },
        update: { name: p.name, instagramId: p.instagramId },
      });
    }

    for (const { fbAccountId, pixels } of pixelsByAccount) {
      const adAccountId = internalId.get(fbAccountId);
      if (!adAccountId) continue;
      for (const px of pixels) {
        await tx.fbPixel.upsert({
          where: { adAccountId_fbPixelId: { adAccountId, fbPixelId: px.fbPixelId } },
          create: { orgId, adAccountId, fbPixelId: px.fbPixelId, name: px.name },
          update: { name: px.name },
        });
        pixelCount += 1;
      }
    }
  });

  return { adAccounts: accounts.length, pages: pages.length, pixels: pixelCount };
}

/**
 * Mark a connection broken (DECISION D13): flip status to CONNECTION_BROKEN, stash
 * the error, and emit a notification so the buyer can one-click reconnect. The
 * durable in-app signal is the row's own `status` — polling/launches for this
 * profile stop until it's reconnected. Keyed by connection id (a user can have many).
 */
export async function markConnectionBroken(connectionId: string, message: string): Promise<void> {
  await withSystem(async (tx) => {
    const conn = await tx.fbConnection.findUnique({ where: { id: connectionId } });
    if (!conn) return;
    await tx.fbConnection.update({
      where: { id: connectionId },
      data: { status: FbConnectionStatus.CONNECTION_BROKEN, lastError: message },
    });
    await notify({
      orgId: conn.orgId,
      userId: conn.userId,
      type: 'fb_connection_broken',
      title: 'Facebook connection lost',
      body: `Reconnect the Facebook profile “${profileName(conn)}” to resume ad launches and stats.`,
    });
  });
}

/**
 * OAuth callback: exchange the code for a long-lived token, identify the FB profile,
 * store the encrypted token, and run an initial sync. Called from a PUBLIC route
 * (Facebook redirects the browser here), so trust comes entirely from the signed
 * `state`, not a session. Upserts on (userId, fbUserId): connecting a NEW profile
 * adds a row; reconnecting the SAME profile refreshes it.
 */
export async function handleCallback(code: string, state: string): Promise<void> {
  const { userId, orgId, appKind } = await verifyFbState(state);

  const short = await exchangeCodeForToken(code, appKind);
  // The LAUNCH app's whole point is a SHORT-lived token (it clears the 31/3858385 ad-publish
  // checkpoint), so we NEVER exchange it for a long-lived one. The DATA app exchanges for a
  // ~60-day long-lived token, unless FB_SKIP_LONGLIVED is set for the legacy single-app
  // diagnostic. (Once a LAUNCH app is configured, leave FB_SKIP_LONGLIVED off — DATA wants long.)
  const tok =
    appKind === 'LAUNCH' || env.FB_SKIP_LONGLIVED
      ? short
      : await exchangeForLongLivedToken(short.accessToken, appKind);
  const me = await getMe(tok.accessToken, appKind);

  const accessTokenEnc = encryptToken(tok.accessToken);
  const tokenExpiresAt = new Date(Date.now() + tok.expiresInSec * 1_000);
  const scopes = FB_SCOPES.join(',');

  const conn = await withSystem((tx) =>
    tx.fbConnection.upsert({
      where: { userId_fbUserId_appKind: { userId, fbUserId: me.id, appKind } },
      create: {
        orgId,
        userId,
        fbUserId: me.id,
        fbName: me.name,
        appKind,
        accessTokenEnc,
        tokenExpiresAt,
        scopes,
        status: FbConnectionStatus.ACTIVE,
      },
      update: {
        fbName: me.name,
        accessTokenEnc,
        tokenExpiresAt,
        scopes,
        status: FbConnectionStatus.ACTIVE,
        lastError: null,
      },
    }),
  );

  // The LAUNCH connection holds only a token for ad writes — it does NOT own ad
  // accounts/pages/pixels (the DATA connection already synced those for the same person),
  // so skip the asset sync. DATA and the Advanced-Access VERIFY app both own + sync assets,
  // so run the best-effort initial sync: a broken token is recorded; other transient failures
  // leave it ACTIVE so the buyer can retry from the UI.
  if (appKind !== 'LAUNCH') {
    try {
      await syncFromFacebook({ connectionId: conn.id, orgId, accessToken: tok.accessToken });
    } catch (err) {
      if (err instanceof FbConnectionBrokenError) {
        await markConnectionBroken(conn.id, err.message);
      }
    }
  }
}

/** The authenticated user's own connected profiles (with asset counts). */
export async function listProfiles(auth: AuthContext): Promise<FbProfile[]> {
  return runScoped(auth, async (tx) => {
    const conns = await tx.fbConnection.findMany({
      where: { userId: auth.userId },
      orderBy: { connectedAt: 'asc' },
      include: { _count: { select: { adAccounts: true, pages: true } } },
    });
    return conns.map((c) => ({
      id: c.id,
      fbUserId: c.fbUserId,
      name: profileName(c),
      appKind: c.appKind as FbAppKind,
      status: c.status,
      scopes: c.scopes ? c.scopes.split(',') : [],
      tokenExpiresAt: c.tokenExpiresAt,
      lastError: c.lastError,
      connectedAt: c.connectedAt,
      adAccountCount: c._count.adAccounts,
      pageCount: c._count.pages,
    }));
  });
}

/** ALL connected profiles across the platform (super-admin oversight only). */
export async function listAllProfiles(): Promise<FbProfileWithOwner[]> {
  return withSystem(async (tx) => {
    const conns = await tx.fbConnection.findMany({
      orderBy: { connectedAt: 'desc' },
      include: {
        _count: { select: { adAccounts: true, pages: true } },
        user: { select: { id: true, name: true, email: true, orgId: true } },
      },
    });
    const orgIds = [...new Set(conns.map((c) => c.user.orgId))];
    const orgs = await tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));
    return conns.map((c) => ({
      id: c.id,
      fbUserId: c.fbUserId,
      name: profileName(c),
      appKind: c.appKind as FbAppKind,
      status: c.status,
      scopes: c.scopes ? c.scopes.split(',') : [],
      tokenExpiresAt: c.tokenExpiresAt,
      lastError: c.lastError,
      connectedAt: c.connectedAt,
      adAccountCount: c._count.adAccounts,
      pageCount: c._count.pages,
      ownerId: c.user.id,
      ownerName: c.user.name,
      ownerEmail: c.user.email,
      orgId: c.user.orgId,
      orgName: orgMap.get(c.user.orgId) ?? '—',
    }));
  });
}

/**
 * Load one connection the actor may act on: a user can touch only their own
 * profiles; a super-admin can touch any (oversight). Returns 404 otherwise.
 */
async function loadConnection(auth: AuthContext, connectionId: string) {
  const conn = await runScoped(auth, (tx) =>
    tx.fbConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, userId: true, orgId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true },
    }),
  );
  if (!conn) throw new AppError(404, 'Facebook profile not found');
  if (auth.role !== ROLES.SUPER_ADMIN && conn.userId !== auth.userId) {
    throw new AppError(404, 'Facebook profile not found');
  }
  return conn;
}

/** Re-pull the account graph for one of the actor's profiles. */
export async function resync(auth: AuthContext, connectionId: string): Promise<SyncResult> {
  const conn = await loadConnection(auth, connectionId);
  if (conn.status === FbConnectionStatus.CONNECTION_BROKEN) {
    throw new AppError(409, 'Facebook connection is broken — reconnect first');
  }
  const appKind = conn.appKind as FbAppKind;
  const accessToken = decryptToken(conn.accessTokenEnc);
  try {
    // Refresh the profile's display name too, so profiles connected before names
    // were stored get their real name on a re-sync (no full reconnect needed).
    const me = await getMe(accessToken, appKind);
    await withSystem((tx) => tx.fbConnection.update({ where: { id: conn.id }, data: { fbName: me.name } }));
    // A LAUNCH connection holds only a write token — it owns no ad accounts/pages/pixels
    // (those live on the same person's DATA connection), so never sync assets under it.
    if (appKind === 'LAUNCH') return { adAccounts: 0, pages: 0, pixels: 0 };
    return await syncFromFacebook({ connectionId: conn.id, orgId: conn.orgId, accessToken });
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markConnectionBroken(conn.id, err.message);
      throw new AppError(409, 'Facebook connection is broken — reconnect');
    }
    throw err;
  }
}

/** Ad accounts for one profile (the Facebook-tab drill-down). */
export async function listProfileAccounts(auth: AuthContext, connectionId: string) {
  await loadConnection(auth, connectionId);
  return runScoped(auth, (tx) => tx.fbAdAccount.findMany({ where: { connectionId }, orderBy: { name: 'asc' } }));
}

/** Pages for one profile (the Facebook-tab drill-down). */
export async function listProfilePages(auth: AuthContext, connectionId: string) {
  await loadConnection(auth, connectionId);
  return runScoped(auth, (tx) => tx.fbPage.findMany({ where: { connectionId }, orderBy: { name: 'asc' } }));
}

/** The actor's own connection ids (across all their profiles). */
async function ownConnectionIds(auth: AuthContext): Promise<string[]> {
  const conns = await runScoped(auth, (tx) =>
    tx.fbConnection.findMany({ where: { userId: auth.userId }, select: { id: true } }),
  );
  return conns.map((c) => c.id);
}

/** All ad accounts the actor can use to launch (aggregated across their profiles). */
export async function listAccounts(auth: AuthContext) {
  const ids = await ownConnectionIds(auth);
  if (ids.length === 0) return [];
  return runScoped(auth, (tx) =>
    tx.fbAdAccount.findMany({ where: { connectionId: { in: ids } }, orderBy: { name: 'asc' } }),
  );
}

/** All pages the actor can use to launch (aggregated across their profiles). */
export async function listPages(auth: AuthContext) {
  const ids = await ownConnectionIds(auth);
  if (ids.length === 0) return [];
  return runScoped(auth, (tx) =>
    tx.fbPage.findMany({ where: { connectionId: { in: ids } }, orderBy: { name: 'asc' } }),
  );
}

/** Ad account belonging to the actor (any of their profiles), or any for a super-admin. */
async function loadOwnedAccount(auth: AuthContext, adAccountId: string) {
  const account = await runScoped(auth, (tx) =>
    tx.fbAdAccount.findFirst({
      where: { id: adAccountId },
      select: {
        id: true,
        fbAccountId: true,
        connection: { select: { id: true, userId: true, accessTokenEnc: true, status: true } },
      },
    }),
  );
  if (!account || (auth.role !== ROLES.SUPER_ADMIN && account.connection.userId !== auth.userId)) {
    throw new AppError(404, 'Ad account not found');
  }
  return account;
}

/**
 * Pages selectable for a campaign on this ad account: the UNION of the account's
 * `promote_pages` (which may include client pages the user doesn't directly manage)
 * and the profile's own managed pages (from `/me/accounts`). `promote_pages` ALONE
 * gives false negatives — Facebook's Ads Manager lets you pick any page you manage in
 * the same Business Manager even when `promote_pages` is empty — so restricting to it
 * wrongly blocked usable pages. Facebook still validates the exact page↔account pairing
 * at launch. The live promote pages are upserted so client-only pages are captured too.
 */
export async function listAccountPages(auth: AuthContext, adAccountId: string) {
  const account = await loadOwnedAccount(auth, adAccountId);
  if (account.connection.status === FbConnectionStatus.CONNECTION_BROKEN) {
    throw new AppError(409, 'Facebook connection is broken — reconnect first');
  }

  let pages;
  try {
    pages = await fetchPromotePages(account.fbAccountId, decryptToken(account.connection.accessTokenEnc));
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markConnectionBroken(account.connection.id, err.message);
      throw new AppError(409, 'Facebook connection is broken — reconnect');
    }
    throw err;
  }

  const connectionId = account.connection.id;
  return runScoped(auth, async (tx) => {
    // Capture any promote-only (client) pages into fb_pages…
    for (const p of pages) {
      await tx.fbPage.upsert({
        where: { connectionId_fbPageId: { connectionId, fbPageId: p.fbPageId } },
        create: { orgId: auth.orgId, connectionId, fbPageId: p.fbPageId, name: p.name, instagramId: p.instagramId },
        update: { name: p.name },
      });
    }
    // …then return the pages eligible for THIS ad account. When `promote_pages` lists pages, that IS
    // the account's eligible set — restrict to it, so a Business-Manager/agency account that can only
    // promote a subset (e.g. quiroxa-35) doesn't offer pages Facebook rejects at launch. When it comes
    // back EMPTY (a known FB quirk — an account can still advertise a managed page Ads Manager offers),
    // fall back to the connection's managed pages rather than wrongly showing nothing.
    const eligibleFbPageIds = pages.map((p) => p.fbPageId);
    return tx.fbPage.findMany({
      where: eligibleFbPageIds.length ? { connectionId, fbPageId: { in: eligibleFbPageIds } } : { connectionId },
      orderBy: { name: 'asc' },
      select: { id: true, fbPageId: true, name: true, instagramId: true },
    });
  });
}

export async function listPixels(auth: AuthContext, adAccountId: string) {
  const account = await loadOwnedAccount(auth, adAccountId);
  return runScoped(auth, (tx) => tx.fbPixel.findMany({ where: { adAccountId: account.id }, orderBy: { name: 'asc' } }));
}

/**
 * TEMP super-admin diagnostic (remove after use): for ad accounts whose name matches `q`, ask Facebook
 * directly — via the owning connection's token — what `promote_pages` returns vs the account's Business
 * Manager + the user's own pages. Used to explain why a restricted account (e.g. quiroxa-35) shows pages
 * Ads Manager rejects. Never returns the token. System-context (cross-org) — super-admin only at the route.
 */
export async function debugAdAccountPages(q: string) {
  const accounts = await withSystem((tx) =>
    tx.fbAdAccount.findMany({
      where: q ? { name: { contains: q, mode: 'insensitive' } } : undefined,
      include: { connection: { select: { appKind: true, status: true, accessTokenEnc: true } } },
      take: 8,
    }),
  );
  const safe = async <T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const results = [];
  for (const a of accounts) {
    const appKind = a.connection.appKind as FbAppKind;
    const token = decryptToken(a.connection.accessTokenEnc);
    const promote = await safe(() =>
      graphRequest<{ data?: { id: string; name?: string }[] }>({ path: `/act_${a.fbAccountId}/promote_pages`, params: { fields: 'id,name', limit: '200' }, accessToken: token, accountId: a.fbAccountId, appKind }),
    );
    const info = await safe(() =>
      graphRequest<{ name?: string; account_status?: number; business?: { id: string; name: string } }>({ path: `/act_${a.fbAccountId}`, params: { fields: 'name,account_status,business' }, accessToken: token, accountId: a.fbAccountId, appKind }),
    );
    const mine = await safe(() =>
      graphRequest<{ data?: { id: string }[] }>({ path: '/me/accounts', params: { fields: 'id', limit: '200' }, accessToken: token, appKind }),
    );
    results.push({
      name: a.name,
      fbAccountId: a.fbAccountId,
      connStatus: a.connection.status,
      appKind,
      business: info.ok ? info.data.business ?? null : `ERR: ${info.error}`,
      accountStatus: info.ok ? info.data.account_status : undefined,
      promotePagesCount: promote.ok ? promote.data.data?.length ?? 0 : `ERR: ${promote.error}`,
      promotePagesSample: promote.ok ? (promote.data.data ?? []).slice(0, 12).map((p) => p.name ?? p.id) : undefined,
      meAccountsCount: mine.ok ? mine.data.data?.length ?? 0 : `ERR: ${mine.error}`,
    });
  }
  return { count: results.length, results };
}

export interface LaunchAccessResult {
  status: 'ok' | 'gaps' | 'expired' | 'broken' | 'no_assets';
  total: number;
  accessible: number;
  missing: { type: 'account' | 'page' | 'pixel'; id: string; name: string }[];
}

/**
 * Verify a LAUNCH connection's (short-lived) token can SEE every asset the same person's
 * DATA connection synced — so the buyer knows, right after connecting, that a clone/relaunch
 * won't hit Facebook's "the ad account and pixel don't match" error (which happens when the
 * launch app wasn't granted an asset). Returns the gaps with readable names to re-grant.
 */
export async function checkLaunchAccess(auth: AuthContext, connectionId: string): Promise<LaunchAccessResult> {
  const conn = await loadConnection(auth, connectionId);
  if ((conn.appKind as FbAppKind) !== 'LAUNCH') {
    throw new AppError(400, 'Asset coverage applies only to a launch-app connection');
  }
  if (conn.status === FbConnectionStatus.CONNECTION_BROKEN) return { status: 'broken', total: 0, accessible: 0, missing: [] };
  if (conn.tokenExpiresAt.getTime() <= Date.now()) return { status: 'expired', total: 0, accessible: 0, missing: [] };

  // The SAME person's DATA-synced assets (LAUNCH owns none) — accounts, Pages, pixels.
  const data = await runScoped(auth, async (tx) => {
    const dataConns = await tx.fbConnection.findMany({ where: { userId: conn.userId, appKind: 'DATA' }, select: { id: true } });
    const ids = dataConns.map((c) => c.id);
    if (ids.length === 0) return { accounts: [], pages: [], pixels: [] };
    const [accounts, pages] = await Promise.all([
      tx.fbAdAccount.findMany({ where: { connectionId: { in: ids } }, select: { id: true, fbAccountId: true, name: true } }),
      tx.fbPage.findMany({ where: { connectionId: { in: ids } }, select: { fbPageId: true, name: true } }),
    ]);
    const pixelRows = await tx.fbPixel.findMany({ where: { adAccountId: { in: accounts.map((a) => a.id) } }, select: { fbPixelId: true, name: true } });
    // A pixel can be shared across accounts → dedupe by fbPixelId.
    const pixels = [...new Map(pixelRows.map((p) => [p.fbPixelId, p])).values()];
    return { accounts, pages, pixels };
  });

  const total = data.accounts.length + data.pages.length + data.pixels.length;
  if (total === 0) return { status: 'no_assets', total: 0, accessible: 0, missing: [] };

  const res = await checkAssetAccess(
    decryptToken(conn.accessTokenEnc),
    { accountIds: data.accounts.map((a) => a.fbAccountId), pageIds: data.pages.map((p) => p.fbPageId), pixelIds: data.pixels.map((p) => p.fbPixelId) },
    'LAUNCH',
  );
  const missing = [
    ...res.missingAccountIds.map((id) => ({ type: 'account' as const, id, name: data.accounts.find((a) => a.fbAccountId === id)?.name ?? id })),
    ...res.missingPageIds.map((id) => ({ type: 'page' as const, id, name: data.pages.find((p) => p.fbPageId === id)?.name ?? id })),
    ...res.missingPixelIds.map((id) => ({ type: 'pixel' as const, id, name: data.pixels.find((p) => p.fbPixelId === id)?.name ?? id })),
  ];
  // All assets unreachable usually means a dead/limited token, not 50 individual grant gaps.
  if (missing.length === total) return { status: 'expired', total, accessible: 0, missing: [] };
  return { status: res.ok ? 'ok' : 'gaps', total, accessible: total - missing.length, missing };
}

/** Disconnect one profile (deletes the connection + cascades its accounts/pages/pixels). */
export async function disconnect(auth: AuthContext, connectionId: string): Promise<void> {
  await loadConnection(auth, connectionId);
  await runScoped(auth, (tx) => tx.fbConnection.delete({ where: { id: connectionId } }));
}

// ── FB tester onboarding (apps in Dev mode → buyers must be added as testers on BOTH apps) ──────────
// Facebook has no API to add a real person as a tester (verified: POST /{app}/roles is unsupported),
// so we capture the buyer's profile in-product, route it to a super-admin to add in the FB dashboard,
// and guide the buyer to approve. This replaces the "DM us your ID" flow.

export interface FbAccessState {
  fbHandle: string | null;
  status: 'NONE' | 'REQUESTED' | 'INVITED';
  connected: boolean; // derived: has ≥1 FbConnection
}
export interface FbAccessRequestRow {
  userId: string;
  name: string;
  email: string;
  orgName: string;
  fbHandle: string | null;
  status: 'REQUESTED' | 'INVITED';
  updatedAt: string;
}
export interface FbAccessRequestList {
  requests: FbAccessRequestRow[];
  /** Deep-links the super-admin uses to add the buyer's profile in each app's Roles page. */
  dataAppRolesUrl: string | null;
  launchAppRolesUrl: string | null;
  /** Where the BUYER approves the invites. */
  approveUrl: string;
}

const APPROVE_URL = 'https://developers.facebook.com/settings/developer/requests/';
function appRolesUrl(appId: string | undefined): string | null {
  return appId ? `https://developers.facebook.com/apps/${appId}/roles/roles/` : null;
}

/** Buyer submits their Facebook profile URL/username → moves them to REQUESTED. */
export async function requestFbAccess(auth: AuthContext, rawHandle: string): Promise<FbAccessState> {
  const fbHandle = (rawHandle ?? '').trim();
  if (!fbHandle) throw new AppError(400, 'Enter your Facebook profile URL or username.');
  if (fbHandle.length > 300) throw new AppError(400, "That doesn't look like a Facebook profile — paste your profile URL.");
  await runScoped(auth, (tx) => tx.user.update({ where: { id: auth.userId }, data: { fbHandle, fbAccessStatus: 'REQUESTED' } }));
  return getFbAccess(auth);
}

/** The buyer's own onboarding state (drives the in-product checklist). */
export async function getFbAccess(auth: AuthContext): Promise<FbAccessState> {
  return runScoped(auth, async (tx) => {
    const u = await tx.user.findUnique({ where: { id: auth.userId }, select: { fbHandle: true, fbAccessStatus: true } });
    const connected = (await tx.fbConnection.count({ where: { userId: auth.userId } })) > 0;
    return { fbHandle: u?.fbHandle ?? null, status: (u?.fbAccessStatus ?? 'NONE') as FbAccessState['status'], connected };
  });
}

/** Super-admin queue: everyone awaiting tester access, + the dashboard deep-links to add them. */
export async function listFbAccessRequests(): Promise<FbAccessRequestList> {
  const users = await withSystem((tx) =>
    tx.user.findMany({
      where: { fbAccessStatus: { in: ['REQUESTED', 'INVITED'] } },
      select: { id: true, name: true, email: true, fbHandle: true, fbAccessStatus: true, updatedAt: true, organization: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
  );
  return {
    requests: users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      orgName: u.organization.name,
      fbHandle: u.fbHandle,
      status: u.fbAccessStatus as 'REQUESTED' | 'INVITED',
      updatedAt: u.updatedAt.toISOString(),
    })),
    dataAppRolesUrl: appRolesUrl(env.FB_APP_ID),
    launchAppRolesUrl: appRolesUrl(env.FB_LAUNCH_APP_ID || env.FB_APP_ID),
    approveUrl: APPROVE_URL,
  };
}

/** Super-admin marks a buyer as added in the FB dashboard → INVITED (awaiting their approval). */
export async function markFbAccessInvited(userId: string): Promise<void> {
  await withSystem((tx) => tx.user.update({ where: { id: userId }, data: { fbAccessStatus: 'INVITED' } }));
}
