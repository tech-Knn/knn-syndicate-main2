import { FbConnectionStatus, type TxClient, withSystem } from '@knn/db';
import { type FbAppKind, decryptToken } from '@knn/fb';

export interface ReadAuth {
  /** The stable Meta ad-account id (`act_…` numeric body) to gate the call by + read against. */
  fbAccountId: string;
  /** The account's native currency (same for a given Meta account across connections) — for FX. */
  currency: string;
  token: string;
  /** The issuing app, so `appsecret_proof` is signed with that app's secret (DATA/VERIFY/LAUNCH). */
  appKind: FbAppKind;
}

/**
 * Resolve a READ token for a campaign's ad account by its STABLE Meta `fbAccountId`, against the
 * buyer's CURRENT healthy (ACTIVE) connection — NOT the internal, connection-bound `adAccountId`
 * row the campaign happens to store.
 *
 * Why: the campaign pins an internal `FbAdAccount.id` (a row scoped to one connection). After a
 * reconnect or an app switch (DATA→VERIFY) the same Meta ad account is owned by a *different*
 * connection row; the pinned id then points at a stale/expired connection and every read silently
 * no-ops (status + spend go stale with no "broken connection" signal — the bug behind #3/#5).
 * Keying on the stable Meta id + the live connection makes reads survive reconnects, and returning
 * the connection's `appKind` makes `appsecret_proof` correct for non-DATA tokens.
 *
 * Returns null only when NO healthy connection currently owns the account (a genuine reconnect
 * state — surfaced to the buyer by the Analytics connection-health banner).
 */
export async function resolveCampaignReadAuth(
  campaign: { fbAccountId: string | null; adAccountId: string | null },
  tx?: TxClient,
): Promise<ReadAuth | null> {
  const run = async (db: TxClient): Promise<ReadAuth | null> => {
    // The stable Meta ad-account id: prefer the one persisted on the campaign (survives a deleted
    // connection row); fall back to the pinned internal row's fbAccountId while it still exists.
    let stableId = campaign.fbAccountId;
    if (!stableId && campaign.adAccountId) {
      const ref = await db.fbAdAccount.findUnique({ where: { id: campaign.adAccountId }, select: { fbAccountId: true } });
      stableId = ref?.fbAccountId ?? null;
    }
    if (!stableId) return null; // orphaned + not yet backfilled — recoverCampaignAccountId() handles it
    // Pick a live row for that Meta account under any ACTIVE connection (most-recently updated wins
    // — the connection the buyer is actually using now).
    const live = await db.fbAdAccount.findFirst({
      where: { fbAccountId: stableId, connection: { status: FbConnectionStatus.ACTIVE } },
      orderBy: { updatedAt: 'desc' },
      select: { fbAccountId: true, currency: true, connection: { select: { accessTokenEnc: true, appKind: true } } },
    });
    if (!live) return null;
    return {
      fbAccountId: live.fbAccountId,
      currency: live.currency,
      token: decryptToken(live.connection.accessTokenEnc),
      appKind: live.connection.appKind as FbAppKind,
    };
  };
  // Reuse the caller's transaction when given (attribution runs inside one); else open our own.
  return tx ? run(tx) : withSystem(run);
}
