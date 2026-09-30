import { type Prisma, WhopConnectionStatus, withSystem } from '@knn/db';
import { type WhopAdsApi, type WhopApiError, type WhopClient, isWhopError, whopAdsApi, whopApi, type WhopApi } from '@knn/whop';
import { AppError } from '../../lib/errors.js';
import { whopToAppError } from '../../lib/whop-errors.js';
import { markWhopConnectionBroken, whopClientFor, whopEnabledForOrg } from './whop.service.js';

/**
 * Whop access for campaign flows that have no signed-in Whop user behind them (D32, phase 2): the launch that
 * the worker triggers as the buyer, the status sync, the spend pull. `whop.service.ts` resolves a connection from
 * the caller's own `auth`; here it is resolved from the CAMPAIGN, because the campaign is what names the business.
 */

export type WhopConnectionRow = Prisma.WhopConnectionGetPayload<object>;

/** What identifies a campaign's Whop business. The connection id can be stale (a disconnect deletes the row). */
export interface WhopCampaignRef {
  orgId: string;
  buyerId: string;
  whopConnectionId: string | null;
  whopBizId: string | null;
}

/**
 * The connection a campaign runs through: the one it was launched with, or, when that row is gone (a disconnect
 * followed by a reconnect makes a new row), the buyer's connection to the SAME business (`whopBizId` is frozen
 * on the campaign at launch). Null when neither exists, which callers treat as "cannot talk to Whop".
 */
export async function resolveCampaignConnection(ref: WhopCampaignRef): Promise<WhopConnectionRow | null> {
  return withSystem(async (tx) => {
    if (ref.whopConnectionId) {
      const byId = await tx.whopConnection.findUnique({ where: { id: ref.whopConnectionId } });
      // Defence in depth: a connection is only ever the campaign's own company's, whatever id is stored.
      if (byId && byId.orgId === ref.orgId) return byId;
    }
    if (!ref.whopBizId) return null;
    const rows = await tx.whopConnection.findMany({ where: { userId: ref.buyerId, orgId: ref.orgId, bizId: ref.whopBizId }, orderBy: { connectedAt: 'desc' } });
    return rows.find((r) => r.status === WhopConnectionStatus.ACTIVE) ?? rows[0] ?? null;
  });
}

export interface WhopSession {
  conn: WhopConnectionRow;
  client: WhopClient;
  ads: WhopAdsApi;
  api: WhopApi;
}

export function whopSession(conn: WhopConnectionRow, opts: { sleep?: (ms: number) => Promise<void> } = {}): WhopSession {
  const client = whopClientFor(conn);
  return { conn, client, ads: whopAdsApi(client, opts), api: whopApi(client) };
}

/**
 * Everything a Whop action needs before it may touch Whop: the feature is on for the company, the campaign has a
 * connection, and that connection still works. Answers with the reason in words (409) so the UI can say what to do.
 * `ignoreSwitch` is for an EMERGENCY STOP (pausing a live campaign): switching Whop Ads off, the natural reaction to an
 * incident, must never leave live campaigns that can no longer be paused.
 */
export async function requireWhopConnection(ref: WhopCampaignRef, what: string, opts: { ignoreSwitch?: boolean } = {}): Promise<WhopConnectionRow> {
  if (!opts.ignoreSwitch && !(await whopEnabledForOrg(ref.orgId))) throw new AppError(409, `Whop Ads isn't switched on for your company, so ${what} is unavailable.`);
  const conn = await resolveCampaignConnection(ref);
  if (!conn) throw new AppError(409, `This campaign's Whop business is no longer connected. Reconnect it in Settings → Whop, then ${what}.`);
  if (conn.status === WhopConnectionStatus.BROKEN) {
    throw new AppError(409, `This Whop connection needs attention (${conn.lastError ?? 'its key was rejected'}). Reconnect it in Settings → Whop, then ${what}.`);
  }
  return conn;
}

/**
 * Turn a Whop failure into the AppError a user sees. A rejected key (401) also flips the connection to BROKEN
 * (once) and alerts the owner, exactly as the connection screens do. Returns the error so a caller that needs to
 * look at the kind first (the launch: a rate limit parks the campaign) can decide before throwing.
 */
export async function whopFailure(conn: WhopConnectionRow, err: WhopApiError): Promise<AppError> {
  if (err.kind === 'auth' && conn.status !== WhopConnectionStatus.BROKEN) {
    await markWhopConnectionBroken(conn, 'Whop rejected the API key. Reconnect with a working key.').catch(() => undefined);
  }
  return whopToAppError(err);
}

/** Run Whop calls for a connection, mapping any Whop failure to a plain-language AppError. */
export async function withWhop<T>(conn: WhopConnectionRow, fn: (s: WhopSession) => Promise<T>, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  try {
    return await fn(whopSession(conn, opts));
  } catch (err) {
    if (isWhopError(err)) throw await whopFailure(conn, err);
    throw err;
  }
}
