import { env } from '@knn/config';
import { type Prisma, WhopConnectionStatus, withSystem } from '@knn/db';
import { decryptToken } from '@knn/fb';
import { type WhopAdsApi, type WhopClient, createWhopClient, isWhopError, whopAdsApi } from '@knn/whop';
import { sendNotification } from './notify.js';

/**
 * How the worker gets at a Whop business for the jobs that are about a CAMPAIGN rather than one conversion event
 * (the status sync, the spend pull). The API has its own copy of the resolution rule (`whop.internal.ts`): the two
 * processes share no code except packages, exactly like the Facebook token helpers in `fb-read-auth.ts`.
 */

export type WhopConnectionRow = Prisma.WhopConnectionGetPayload<object>;

export interface WhopCampaignRef {
  orgId: string;
  buyerId: string;
  whopConnectionId: string | null;
  whopBizId: string | null;
}

/**
 * The connection a campaign runs through: the one it was launched with, or, when that row is gone (a disconnect
 * followed by a reconnect makes a new row), the buyer's connection to the SAME business (`whopBizId` is frozen on the
 * campaign at launch). Always the campaign's own company's. Null when neither exists.
 */
export async function resolveWhopConnection(ref: WhopCampaignRef): Promise<WhopConnectionRow | null> {
  return withSystem(async (tx) => {
    if (ref.whopConnectionId) {
      const byId = await tx.whopConnection.findUnique({ where: { id: ref.whopConnectionId } });
      if (byId && byId.orgId === ref.orgId) return byId;
    }
    if (!ref.whopBizId) return null;
    const rows = await tx.whopConnection.findMany({ where: { userId: ref.buyerId, orgId: ref.orgId, bizId: ref.whopBizId }, orderBy: { connectedAt: 'desc' } });
    return rows.find((r) => r.status === WhopConnectionStatus.ACTIVE) ?? rows[0] ?? null;
  });
}

/** A key that can no longer be decrypted (rotated TOKEN_ENCRYPTION_KEY) throws here; callers treat it as "skip". */
export function whopClientForConnection(conn: Pick<WhopConnectionRow, 'apiKeyEnc' | 'environment' | 'apiVersionDate'>): WhopClient {
  return createWhopClient({
    apiKey: decryptToken(conn.apiKeyEnc),
    baseUrl: conn.environment === 'SANDBOX' ? env.WHOP_SANDBOX_API_BASE : env.WHOP_API_BASE,
    versionDate: conn.apiVersionDate,
    // These are bulk background reads, run in sequence over every business: a slow Whop must cost seconds, not minutes.
    timeoutMs: 15_000,
    maxRetries: 1,
  });
}

export const whopAdsForConnection = (conn: WhopConnectionRow): WhopAdsApi => whopAdsApi(whopClientForConnection(conn));

/**
 * Whop rejected the key (401): flip the connection to BROKEN and tell its owner, ONCE. Conditional on the connection still
 * being ACTIVE and on the key that just failed: a buyer who reconnected meanwhile has a new key (same row), and the old
 * key's late 401 must not break the connection they just fixed; two jobs failing at once must not notify twice.
 */
export async function markWhopConnectionBroken(conn: Pick<WhopConnectionRow, 'id' | 'orgId' | 'userId' | 'bizId' | 'label' | 'apiKeyEnc'>, reason: string): Promise<void> {
  const res = await withSystem((tx) =>
    tx.whopConnection.updateMany({ where: { id: conn.id, status: WhopConnectionStatus.ACTIVE, apiKeyEnc: conn.apiKeyEnc }, data: { status: WhopConnectionStatus.BROKEN, lastError: reason } }),
  );
  if (res.count === 0) return;
  sendNotification({
    orgId: conn.orgId,
    userId: conn.userId,
    type: 'whop_connection_broken',
    title: 'Whop connection needs attention',
    body: `${conn.label ?? conn.bizId} (${conn.bizId}): ${reason}`,
  });
}

/** Whop answers a read in the worker can be skipped on any failure except a rejected key, which also needs acting on. */
export const WHOP_KEY_REJECTED = 'Whop rejected the API key. Reconnect with a working key.';

export type ReadFailureKind = 'fatal' | 'transport' | 'limited' | 'other';

/**
 * What a failed bulk read means for the business it was about, and does what must be done:
 *  - `fatal`: Whop says the key is bad or may not read the ads (401 / 403). The connection is broken (once) and its owner
 *    told; the campaigns it covers go unwatched until they reconnect, which is exactly what BROKEN says out loud.
 *  - `transport`: Whop is slow or down (network, timeout, 5xx). Nobody's fault; try again next tick.
 *  - `limited`: Whop is rate-limiting THIS key (429). Whop is up and answering, so it is not evidence of an outage: skip the
 *    business until the next tick, but it must not count towards "Whop is down".
 *  - `other`: anything else (a refusal of this one request): skip it.
 */
export async function handleWhopReadFailure(conn: WhopConnectionRow, err: unknown): Promise<ReadFailureKind> {
  if (!isWhopError(err)) return 'other';
  if (err.kind === 'auth') {
    await markWhopConnectionBroken(conn, WHOP_KEY_REJECTED).catch(() => undefined);
    return 'fatal';
  }
  if (err.kind === 'permission') {
    await markWhopConnectionBroken(conn, `Whop would not let this key read the business's ads (${err.message}). Give the key that permission in Whop, then reconnect.`).catch(() => undefined);
    return 'fatal';
  }
  if (err.kind === 'rate_limited') return 'limited';
  return ['network', 'timeout', 'server'].includes(err.kind) ? 'transport' : 'other';
}

/** A pass over every business must not hold a queue for hours when Whop is slow: it stops starting new businesses after `ms`. */
export class PassBudget {
  readonly #deadline: number;
  constructor(
    ms: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#deadline = now() + ms;
  }
  expired(): boolean {
    return this.now() > this.#deadline;
  }
}

/** Consecutive businesses that failed on transport: Whop is most likely down, so the rest wait for the next tick. */
export const TRANSPORT_FAILURES_BEFORE_STOP = 3;

/**
 * The next value of the "consecutive transport failures" count after one business. Only a transport failure adds to it. Any
 * outcome that means Whop ANSWERED (a rejected key, a rate limit, a refusal, a success) says it is not down, so the run starts
 * again from zero. `skipped` (we could not even try: a key that will not decrypt) says nothing about Whop either way.
 */
export const nextTransportFailures = (current: number, outcome: 'transport' | 'answered' | 'skipped'): number =>
  outcome === 'transport' ? current + 1 : outcome === 'answered' ? 0 : current;

/**
 * The order businesses are visited in: a stable order (by id) rotated to a random start. A pass can stop early (its time
 * budget, or a run of failures), and with a fixed order it would always be the SAME businesses at the tail that never got
 * read: three persistently failing businesses at the head would starve everyone behind them for good. Rotating gives every
 * business its turn. `fraction` is a number in [0, 1); tests pass their own.
 */
export function rotate<T>(items: readonly T[], fraction: number): T[] {
  if (items.length === 0) return [];
  const start = Math.min(items.length - 1, Math.max(0, Math.floor(fraction * items.length)));
  return [...items.slice(start), ...items.slice(0, start)];
}
