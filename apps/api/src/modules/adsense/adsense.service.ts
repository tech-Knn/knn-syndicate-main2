import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import {
  buildGoogleAuthUrl,
  discoverChannelsInRanges,
  exchangeGoogleCode,
  isGoogleConfigured,
  listAccounts,
  listAdClients,
  listCustomChannels,
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
    // Onboard EVERY AdSense account visible to this Google login (a login can hold
    // several = the platform's AFS 1/2/3). Each becomes/updates an AfsAccount row keyed
    // by its account resource, with its AFS ad client + pubId. The shared login token is
    // stored on each. Re-connecting updates in place (the legacy `platform` row matches
    // by its account and is preserved + enriched).
    let accounts: { name: string; displayName?: string }[] = [];
    try {
      accounts = await listAccounts(tokens.accessToken);
    } catch {
      /* token can't list accounts — nothing to onboard */
    }
    if (accounts.length === 0) return back('adsense_error=no_accounts');

    await withSystem(async (tx) => {
      for (const acc of accounts) {
        let adClient: string | undefined;
        try {
          const clients = await listAdClients(tokens.accessToken, acc.name);
          adClient = (clients.find((c) => c.productCode === 'AFS') ?? clients[0])?.name;
        } catch {
          /* AFS access not granted yet — record the account, resolve the client later */
        }
        const afsPubId = adClient ? (adClient.split('/').pop() ?? null) : null;
        const existing = await tx.googleConnection.findFirst({ where: { adsenseAccount: acc.name } });
        const common = {
          googleEmail: tokens.email ?? null,
          accessTokenEnc: encryptToken(tokens.accessToken),
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
          scopes: tokens.scope,
          adsenseAccount: acc.name,
          adsenseAdClient: adClient ?? null,
          afsPubId,
          status: 'ACTIVE',
          lastError: null,
          connectedById: userId,
        };
        if (existing) {
          await tx.googleConnection.update({
            where: { id: existing.id },
            data: {
              ...common,
              label: existing.label ?? acc.displayName ?? afsPubId ?? acc.name,
              ...(tokens.refreshToken ? { refreshTokenEnc: encryptToken(tokens.refreshToken) } : {}),
            },
          });
        } else {
          await tx.googleConnection.create({
            data: {
              ...common,
              label: acc.displayName ?? afsPubId ?? acc.name,
              refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
            },
          });
        }
      }
      await writeAudit(tx, {
        orgId,
        actorId: userId,
        action: 'adsense.connected',
        entityType: 'google_connection',
        entityId: 'multi',
        details: { accounts: accounts.length },
      });
    });
    return back('adsense=connected');
  } catch {
    return back('adsense_error=exchange_failed');
  }
}

export interface AfsAccountRow {
  id: string;
  label: string | null;
  afsPubId: string | null;
  account: string | null;
  email: string | null;
  status: string;
  connectedAt: string;
}

function toAfsRow(c: {
  id: string;
  label: string | null;
  afsPubId: string | null;
  adsenseAccount: string | null;
  googleEmail: string | null;
  status: string;
  connectedAt: Date;
}): AfsAccountRow {
  return {
    id: c.id,
    label: c.label,
    afsPubId: c.afsPubId,
    account: c.adsenseAccount,
    email: c.googleEmail,
    status: c.status,
    connectedAt: c.connectedAt.toISOString(),
  };
}

/** All connected AFS accounts (super-admin view). */
export async function listAfsAccounts(): Promise<AfsAccountRow[]> {
  return withSystem(async (tx) => {
    const rows = await tx.googleConnection.findMany({ orderBy: { connectedAt: 'asc' } });
    return rows.map(toAfsRow);
  });
}

export async function setAccountLabel(actor: AuthContext, id: string, label: string): Promise<AfsAccountRow> {
  return withSystem(async (tx) => {
    const updated = await tx.googleConnection.update({ where: { id }, data: { label } });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'adsense.account.relabeled', entityType: 'google_connection', entityId: id });
    return toAfsRow(updated);
  });
}

export async function disconnectAccount(actor: AuthContext, id: string): Promise<void> {
  await withSystem(async (tx) => {
    await tx.googleConnection.deleteMany({ where: { id } });
    await writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'adsense.disconnected', entityType: 'google_connection', entityId: id });
  });
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

/** Per-account fresh access token (refreshes + persists to THAT account, not 'platform'). */
async function freshAccountToken(c: { id: string; accessTokenEnc: string; refreshTokenEnc: string | null; tokenExpiresAt: Date }): Promise<string> {
  if (c.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptToken(c.accessTokenEnc);
  if (!c.refreshTokenEnc) throw new AppError(409, 'AFS access token expired and no refresh token — reconnect');
  const r = await refreshGoogleToken(decryptToken(c.refreshTokenEnc));
  await withSystem((tx) =>
    tx.googleConnection.update({
      where: { id: c.id },
      data: { accessTokenEnc: encryptToken(r.accessToken), tokenExpiresAt: new Date(Date.now() + r.expiresInSec * 1000), status: 'ACTIVE', lastError: null },
    }),
  );
  return r.accessToken;
}

/** Cap on the local catalog mirror per account (covers the ~100k-channel account + headroom). */
const CATALOG_MAX = 200_000;

export interface CatalogSyncDeps {
  listChannels: (token: string, adClient: string, max: number) => Promise<{ channelId: string; displayName?: string }[]>;
}
const defaultCatalogDeps: CatalogSyncDeps = {
  listChannels: (token, adClient, max) => listCustomChannels(token, adClient, undefined, max),
};

/**
 * Sync an AFS account's FULL custom-channel list into the local catalog so the channel
 * browser can search ~100k channels instantly (no live API scan per query). Mirror
 * semantics: wipe + reinsert (batched outside one giant txn). Super-admin only.
 */
export async function syncChannelCatalog(
  actor: AuthContext,
  accountId: string,
  deps: CatalogSyncDeps = defaultCatalogDeps,
): Promise<{ synced: number; account: string | null }> {
  const conn = await withSystem((tx) => tx.googleConnection.findUnique({ where: { id: accountId } }));
  if (!conn) throw new AppError(404, 'AFS account not found');
  if (!conn.adsenseAdClient) throw new AppError(409, 'No AFS ad client resolved yet — reconnect once AFS access is granted');

  const token = await freshAccountToken(conn);
  const channels = await deps.listChannels(token, conn.adsenseAdClient, CATALOG_MAX);

  await withSystem((tx) => tx.afsChannelCatalog.deleteMany({ where: { afsAccountId: accountId } }));
  for (let i = 0; i < channels.length; i += 1000) {
    const batch = channels.slice(i, i + 1000);
    await withSystem((tx) =>
      tx.afsChannelCatalog.createMany({
        data: batch.map((c) => ({ afsAccountId: accountId, channelId: c.channelId, displayName: c.displayName ?? null })),
        skipDuplicates: true,
      }),
    );
  }
  await withSystem((tx) =>
    writeAudit(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'adsense.catalog.synced', entityType: 'google_connection', entityId: accountId, details: { synced: channels.length } }),
  );
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
