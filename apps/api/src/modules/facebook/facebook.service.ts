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
  fetchPages,
  fetchPixels,
  getMe,
  isFbConfigured,
} from '@knn/fb';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { signFbState, verifyFbState } from './state.js';

export interface ConnectionStatus {
  connected: boolean;
  status?: FbConnectionStatus;
  fbUserId?: string;
  scopes?: string[];
  tokenExpiresAt?: Date;
  lastError?: string | null;
  connectedAt?: Date;
}

export interface SyncResult {
  adAccounts: number;
  pages: number;
  pixels: number;
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
  const pixelsByAccount = await Promise.all(
    accounts.map(async (account) => ({
      fbAccountId: account.fbAccountId,
      pixels: await fetchPixels(account.fbAccountId, accessToken),
    })),
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
 * account stop until it's reconnected.
 */
export async function markConnectionBroken(userId: string, message: string): Promise<void> {
  await withSystem(async (tx) => {
    const conn = await tx.fbConnection.findUnique({ where: { userId } });
    if (!conn) return;
    await tx.fbConnection.update({
      where: { userId },
      data: { status: FbConnectionStatus.CONNECTION_BROKEN, lastError: message },
    });
    await notify({
      orgId: conn.orgId,
      userId,
      type: 'fb_connection_broken',
      title: 'Facebook connection lost',
      body: 'Reconnect your Facebook account to resume ad launches and stats.',
    });
  });
}

/**
 * OAuth callback: exchange the code for a long-lived token, identify the user,
 * store the encrypted token, and run an initial sync. Called from a PUBLIC route
 * (Facebook redirects the browser here), so trust comes entirely from the signed
 * `state`, not a session.
 */
export async function handleCallback(code: string, state: string): Promise<void> {
  const { userId, orgId } = await verifyFbState(state);

  const short = await exchangeCodeForToken(code);
  const long = await exchangeForLongLivedToken(short.accessToken);
  const me = await getMe(long.accessToken);

  const accessTokenEnc = encryptToken(long.accessToken);
  const tokenExpiresAt = new Date(Date.now() + long.expiresInSec * 1_000);
  const scopes = FB_SCOPES.join(',');

  const conn = await withSystem((tx) =>
    tx.fbConnection.upsert({
      where: { userId },
      create: {
        orgId,
        userId,
        fbUserId: me.id,
        accessTokenEnc,
        tokenExpiresAt,
        scopes,
        status: FbConnectionStatus.ACTIVE,
      },
      update: {
        fbUserId: me.id,
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
    await syncFromFacebook({ connectionId: conn.id, orgId, accessToken: long.accessToken });
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markConnectionBroken(userId, err.message);
    }
  }
}

/** Re-pull the account graph for the current user's connection. */
export async function resync(auth: AuthContext): Promise<SyncResult> {
  const conn = await runScoped(auth, (tx) => tx.fbConnection.findUnique({ where: { userId: auth.userId } }));
  if (!conn) throw new AppError(404, 'No Facebook connection');
  if (conn.status === FbConnectionStatus.CONNECTION_BROKEN) {
    throw new AppError(409, 'Facebook connection is broken — reconnect first');
  }
  const accessToken = decryptToken(conn.accessTokenEnc);
  try {
    return await syncFromFacebook({ connectionId: conn.id, orgId: conn.orgId, accessToken });
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markConnectionBroken(conn.userId, err.message);
      throw new AppError(409, 'Facebook connection is broken — reconnect');
    }
    throw err;
  }
}

export async function getConnectionStatus(auth: AuthContext): Promise<ConnectionStatus> {
  return runScoped(auth, async (tx) => {
    const conn = await tx.fbConnection.findUnique({ where: { userId: auth.userId } });
    if (!conn) return { connected: false };
    return {
      connected: true,
      status: conn.status,
      fbUserId: conn.fbUserId,
      scopes: conn.scopes ? conn.scopes.split(',') : [],
      tokenExpiresAt: conn.tokenExpiresAt,
      lastError: conn.lastError,
      connectedAt: conn.connectedAt,
    };
  });
}

async function requireConnection(auth: AuthContext): Promise<{ id: string }> {
  const conn = await runScoped(auth, (tx) =>
    tx.fbConnection.findUnique({ where: { userId: auth.userId }, select: { id: true } }),
  );
  if (!conn) throw new AppError(404, 'No Facebook connection');
  return conn;
}

export async function listAccounts(auth: AuthContext) {
  const conn = await requireConnection(auth);
  return runScoped(auth, (tx) =>
    tx.fbAdAccount.findMany({ where: { connectionId: conn.id }, orderBy: { name: 'asc' } }),
  );
}

export async function listPages(auth: AuthContext) {
  const conn = await requireConnection(auth);
  return runScoped(auth, (tx) =>
    tx.fbPage.findMany({ where: { connectionId: conn.id }, orderBy: { name: 'asc' } }),
  );
}

export async function listPixels(auth: AuthContext, adAccountId: string) {
  const conn = await requireConnection(auth);
  return runScoped(auth, async (tx) => {
    const account = await tx.fbAdAccount.findFirst({
      where: { id: adAccountId, connectionId: conn.id },
      select: { id: true },
    });
    if (!account) throw new AppError(404, 'Ad account not found');
    return tx.fbPixel.findMany({ where: { adAccountId: account.id }, orderBy: { name: 'asc' } });
  });
}

export async function disconnect(auth: AuthContext): Promise<void> {
  await runScoped(auth, async (tx) => {
    const conn = await tx.fbConnection.findUnique({ where: { userId: auth.userId }, select: { id: true } });
    if (!conn) throw new AppError(404, 'No Facebook connection');
    await tx.fbConnection.delete({ where: { id: conn.id } });
  });
}
