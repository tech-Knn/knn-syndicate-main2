import { withSystem } from '@knn/db';
import { type ChannelDayRevenue, bareChannelId, fetchChannelReport, qualifyChannelId, refreshGoogleToken } from '@knn/adsense';
import { decryptToken, encryptToken } from '@knn/fb';

/**
 * Live **multi-account** AFS revenue source for attribution (Phase F). Each offer's
 * channels belong to its website's AFS account, so a campaign can earn across several
 * accounts — this pulls each account's channels with ITS OWN token and merges. Reads the
 * `GoogleConnection` rows (the super-admin's AdSense connects), refreshing each short-lived
 * access token on demand. Designed to be the DEFAULT `fetchAdsense`:
 *  - An account not connected / no adsenseAccount / CONNECTION_BROKEN → skipped (so the
 *    dormant state and the test DB behave like there's no AdSense).
 *  - An account's report fails (AFS access not granted, 5xx) → logged + skipped, so one
 *    bad account can't fail the whole attribution run (FB cost + other accounts still land).
 */

interface ConnRow {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date;
  afsPubId?: string | null;
}

async function freshTokenFor(c: ConnRow): Promise<string | null> {
  if (c.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptToken(c.accessTokenEnc);
  if (!c.refreshTokenEnc) return null;
  try {
    const r = await refreshGoogleToken(decryptToken(c.refreshTokenEnc));
    await withSystem((tx) =>
      tx.googleConnection.update({
        where: { id: c.id },
        data: {
          accessTokenEnc: encryptToken(r.accessToken),
          tokenExpiresAt: new Date(Date.now() + r.expiresInSec * 1000),
          status: 'ACTIVE',
          lastError: null,
        },
      }),
    );
    return r.accessToken;
  } catch (err) {
    await withSystem((tx) =>
      tx.googleConnection.update({
        where: { id: c.id },
        data: { status: 'CONNECTION_BROKEN', lastError: String(err).slice(0, 200) },
      }),
    ).catch(() => undefined);
    return null;
  }
}

export async function liveAdsenseFetch(params: {
  since: string;
  until: string;
  /** Channels grouped by their AFS account, so each is pulled with the right token. */
  accounts: { afsAccountId: string; channelIds: string[] }[];
}): Promise<ChannelDayRevenue[]> {
  const out: ChannelDayRevenue[] = [];
  for (const acc of params.accounts) {
    if (acc.channelIds.length === 0) continue;
    const conn = await withSystem((tx) => tx.googleConnection.findUnique({ where: { id: acc.afsAccountId } }));
    if (!conn || !conn.adsenseAccount || conn.status !== 'ACTIVE') continue;
    const token = await freshTokenFor(conn);
    if (!token) continue;
    try {
      // The report keys channels as `{afsPubId}:{code}` (OQ#4, confirmed live); our pool
      // stores the bare code. Qualify the filter with the account's pubId, then strip it
      // back so the returned channelId matches `Channel.channelId` upstream.
      const rows = await fetchChannelReport({
        accessToken: token,
        account: conn.adsenseAccount,
        since: params.since,
        until: params.until,
        channelIds: acc.channelIds.map((id) => qualifyChannelId(conn.afsPubId, id)),
      });
      for (const r of rows) out.push({ ...r, channelId: bareChannelId(r.channelId) });
    } catch (err) {
      console.error(`[attribution] AdSense revenue pull failed for account ${acc.afsAccountId}:`, String(err).slice(0, 200));
    }
  }
  return out;
}
