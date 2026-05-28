import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import {
  buildGoogleAuthUrl,
  discoverChannels,
  exchangeGoogleCode,
  isGoogleConfigured,
  listAccounts,
  listAdClients,
  refreshGoogleToken,
} from '@knn/adsense';
import { decryptToken, encryptToken } from '@knn/fb';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { signAdsenseState, verifyAdsenseState } from './state.js';

/**
 * Platform AdSense (Google) connection — connect/status/sync/disconnect. AdSense is a
 * single platform account (D7 funnel domain), so the connection is a global singleton
 * (`google_connections.id = 'platform'`), connected by a SUPER_ADMIN; routes guard it.
 * Tokens are AES-256-GCM encrypted (same key as FbConnection). The short-lived access
 * token is refreshed on demand from the offline refresh token.
 */

const PLATFORM = 'platform';

export interface AdsenseStatus {
  connected: boolean;
  email?: string | null;
  account?: string | null;
  adClient?: string | null;
  status?: string;
  scopes?: string[];
  connectedAt?: string;
  tokenExpiresAt?: string;
}

export async function getStatus(): Promise<AdsenseStatus> {
  return withSystem(async (tx) => {
    const c = await tx.googleConnection.findUnique({ where: { id: PLATFORM } });
    if (!c) return { connected: false };
    return {
      connected: true,
      email: c.googleEmail,
      account: c.adsenseAccount,
      adClient: c.adsenseAdClient,
      status: c.status,
      scopes: c.scopes ? c.scopes.split(' ') : [],
      connectedAt: c.connectedAt.toISOString(),
      tokenExpiresAt: c.tokenExpiresAt.toISOString(),
    };
  });
}

export async function getAuthUrl(actor: AuthContext): Promise<{ url: string }> {
  if (!isGoogleConfigured()) throw new AppError(503, 'Google / AdSense is not configured on this server');
  const state = await signAdsenseState(actor.userId, actor.orgId);
  return { url: buildGoogleAuthUrl(state) };
}

/** Public callback. Returns a WEB_DOMAIN redirect URL (success or error param). */
export async function handleCallback(code: string, state: string): Promise<string> {
  const back = (q: string): string => `${env.WEB_DOMAIN}/dashboard/platform?${q}`;
  let userId: string;
  let orgId: string;
  try {
    ({ userId, orgId } = await verifyAdsenseState(state));
  } catch {
    return back('adsense_error=bad_state');
  }
  try {
    const tokens = await exchangeGoogleCode(code);
    // Best-effort account + AFS ad-client discovery (may fail before AFS access is granted).
    let account: string | undefined;
    let adClient: string | undefined;
    try {
      account = (await listAccounts(tokens.accessToken))[0]?.name;
      if (account) {
        const clients = await listAdClients(tokens.accessToken, account);
        adClient = (clients.find((c) => c.productCode === 'AFS') ?? clients[0])?.name;
      }
    } catch {
      /* connect anyway; sync later once AFS access lands */
    }
    await withSystem(async (tx) => {
      await tx.googleConnection.upsert({
        where: { id: PLATFORM },
        create: {
          id: PLATFORM,
          googleEmail: tokens.email ?? null,
          accessTokenEnc: encryptToken(tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
          scopes: tokens.scope,
          adsenseAccount: account ?? null,
          adsenseAdClient: adClient ?? null,
          status: 'ACTIVE',
          connectedById: userId,
        },
        update: {
          googleEmail: tokens.email ?? undefined,
          accessTokenEnc: encryptToken(tokens.accessToken),
          // Only overwrite the refresh token when Google returns a new one.
          ...(tokens.refreshToken ? { refreshTokenEnc: encryptToken(tokens.refreshToken) } : {}),
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
          scopes: tokens.scope,
          ...(account ? { adsenseAccount: account } : {}),
          ...(adClient ? { adsenseAdClient: adClient } : {}),
          status: 'ACTIVE',
          lastError: null,
          connectedById: userId,
        },
      });
      await writeAudit(tx, {
        orgId,
        actorId: userId,
        action: 'adsense.connected',
        entityType: 'google_connection',
        entityId: PLATFORM,
        details: { account: account ?? null },
      });
    });
    return back('adsense=connected');
  } catch {
    return back('adsense_error=exchange_failed');
  }
}

interface ConnRow {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date;
}

/** Decrypt the access token, refreshing (and persisting) if it's within 60s of expiry. */
async function freshAccessToken(c: ConnRow): Promise<string> {
  if (c.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptToken(c.accessTokenEnc);
  if (!c.refreshTokenEnc) throw new AppError(409, 'AdSense access token expired and no refresh token — reconnect');
  const refreshed = await refreshGoogleToken(decryptToken(c.refreshTokenEnc));
  await withSystem((tx) =>
    tx.googleConnection.update({
      where: { id: PLATFORM },
      data: {
        accessTokenEnc: encryptToken(refreshed.accessToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSec * 1000),
        status: 'ACTIVE',
        lastError: null,
      },
    }),
  );
  return refreshed.accessToken;
}

/** Pull the publisher's AFS custom channels and upsert them into the global pool. */
export async function syncChannels(actor: AuthContext): Promise<{ synced: number; account: string | null }> {
  const conn = await withSystem((tx) => tx.googleConnection.findUnique({ where: { id: PLATFORM } }));
  if (!conn) throw new AppError(409, 'AdSense is not connected');
  if (!conn.adsenseAccount) throw new AppError(409, 'No AdSense account resolved yet — reconnect once AFS access is granted');

  const token = await freshAccessToken(conn);
  const channels = await discoverChannels(token, conn.adsenseAccount, { afsOnly: true });

  await withSystem(async (tx) => {
    for (const ch of channels) {
      await tx.channel.upsert({
        where: { channelId: ch.channelId },
        create: { channelId: ch.channelId, label: ch.displayName ?? null, status: 'AVAILABLE' },
        update: { label: ch.displayName ?? undefined }, // never clobber status / current campaign
      });
    }
    await writeAudit(tx, {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'adsense.channels.synced',
      entityType: 'channel',
      entityId: 'pool',
      details: { synced: channels.length },
    });
  });
  return { synced: channels.length, account: conn.adsenseAccount };
}

export async function disconnect(actor: AuthContext): Promise<void> {
  await withSystem(async (tx) => {
    await tx.googleConnection.deleteMany({ where: { id: PLATFORM } });
    await writeAudit(tx, {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'adsense.disconnected',
      entityType: 'google_connection',
      entityId: PLATFORM,
    });
  });
}
