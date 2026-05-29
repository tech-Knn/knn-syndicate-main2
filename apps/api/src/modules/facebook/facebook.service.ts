import { env } from '@knn/config';
import { FbConnectionStatus, withSystem } from '@knn/db';
import {
  FB_SCOPES,
  FbConnectionBrokenError,
  buildAuthUrl,
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

/** Build the Facebook OAuth dialog URL for the authenticated user (spec §5.2.1). */
export async function getAuthUrl(auth: AuthContext): Promise<{ url: string }> {
  if (!isFbConfigured()) {
    throw new AppError(503, 'Facebook integration is not configured on this environment');
  }
  const state = await signFbState({ userId: auth.userId, orgId: auth.orgId });
  return { url: buildAuthUrl(state) };
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
  const { userId, orgId } = await verifyFbState(state);

  const short = await exchangeCodeForToken(code);
  // Diagnostic: optionally keep the short-lived token (skip the long-lived exchange) to
  // test whether the long-lived/never-expiring token is what trips the ad-publish
  // security checkpoint (err 31/3858385). Default path exchanges for ~60-day long-lived.
  const tok = env.FB_SKIP_LONGLIVED ? short : await exchangeForLongLivedToken(short.accessToken);
  const me = await getMe(tok.accessToken);

  const accessTokenEnc = encryptToken(tok.accessToken);
  const tokenExpiresAt = new Date(Date.now() + tok.expiresInSec * 1_000);
  const scopes = FB_SCOPES.join(',');

  const conn = await withSystem((tx) =>
    tx.fbConnection.upsert({
      where: { userId_fbUserId: { userId, fbUserId: me.id } },
      create: {
        orgId,
        userId,
        fbUserId: me.id,
        fbName: me.name,
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

  // Best-effort initial sync. A broken token here is recorded; other transient
  // failures leave the connection ACTIVE so the buyer can retry from the UI.
  try {
    await syncFromFacebook({ connectionId: conn.id, orgId, accessToken: tok.accessToken });
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markConnectionBroken(conn.id, err.message);
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
      select: { id: true, userId: true, orgId: true, accessTokenEnc: true, status: true },
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
  const accessToken = decryptToken(conn.accessTokenEnc);
  try {
    // Refresh the profile's display name too, so profiles connected before names
    // were stored get their real name on a re-sync (no full reconnect needed).
    const me = await getMe(accessToken);
    await withSystem((tx) => tx.fbConnection.update({ where: { id: conn.id }, data: { fbName: me.name } }));
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
    // …then return the union (the synced managed pages now include the promote pages).
    return tx.fbPage.findMany({
      where: { connectionId },
      orderBy: { name: 'asc' },
      select: { id: true, fbPageId: true, name: true, instagramId: true },
    });
  });
}

export async function listPixels(auth: AuthContext, adAccountId: string) {
  const account = await loadOwnedAccount(auth, adAccountId);
  return runScoped(auth, (tx) => tx.fbPixel.findMany({ where: { adAccountId: account.id }, orderBy: { name: 'asc' } }));
}

/** Disconnect one profile (deletes the connection + cascades its accounts/pages/pixels). */
export async function disconnect(auth: AuthContext, connectionId: string): Promise<void> {
  await loadConnection(auth, connectionId);
  await runScoped(auth, (tx) => tx.fbConnection.delete({ where: { id: connectionId } }));
}
