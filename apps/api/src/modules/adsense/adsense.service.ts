import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import {
  buildGoogleAuthUrl,
  discoverChannelsInRanges,
  exchangeGoogleCode,
  isGoogleConfigured,
  listAccounts,
  listAdClients,
  parseChannelRanges,
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
  channelRanges?: string | null;
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
      channelRanges: c.channelRanges,
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

/**
 * Import the AFS channels in the admin-selected id ranges into the pool. The AFS
 * account holds 100k+ channels split across teams, so we only pull the ranges this
 * platform owns (`rangesSpec` overrides + persists the stored selection). NEW channels
 * are bulk-inserted; existing ones are left untouched (status / current campaign).
 */
export async function syncChannels(
  actor: AuthContext,
  rangesSpec?: string,
): Promise<{ synced: number; added: number; account: string | null; ranges: string }> {
  const conn = await withSystem((tx) => tx.googleConnection.findUnique({ where: { id: PLATFORM } }));
  if (!conn) throw new AppError(409, 'AdSense is not connected');
  if (!conn.adsenseAdClient) throw new AppError(409, 'No AFS ad client resolved yet — reconnect once AFS access is granted');

  const spec = (rangesSpec ?? conn.channelRanges ?? '').trim();
  const ranges = parseChannelRanges(spec);
  if (ranges.length === 0) {
    throw new AppError(400, 'Select the channel id range(s) to import first (e.g. 03700-05000)');
  }

  const token = await freshAccessToken(conn);
  const channels = await discoverChannelsInRanges(token, conn.adsenseAdClient, ranges);

  const added = await withSystem(async (tx) => {
    const existing = new Set((await tx.channel.findMany({ select: { channelId: true } })).map((c) => c.channelId));
    const fresh = channels.filter((ch) => !existing.has(ch.channelId));
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.channel.createMany({
        data: fresh.slice(i, i + 500).map((ch) => ({
          channelId: ch.channelId,
          label: ch.displayName ?? null,
          status: 'AVAILABLE' as const,
        })),
        skipDuplicates: true,
      });
    }
    // Persist the selected ranges so a re-sync reuses them.
    await tx.googleConnection.update({ where: { id: PLATFORM }, data: { channelRanges: spec } });
    await writeAudit(tx, {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'adsense.channels.synced',
      entityType: 'channel',
      entityId: 'pool',
      details: { ranges: spec, discovered: channels.length, added: fresh.length },
    });
    return fresh.length;
  });
  return { synced: channels.length, added, account: conn.adsenseAccount, ranges: spec };
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
