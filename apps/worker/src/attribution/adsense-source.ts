import { withSystem } from '@knn/db';
import { type ChannelDayRevenue, fetchChannelReport, refreshGoogleToken } from '@knn/adsense';
import { decryptToken, encryptToken } from '@knn/fb';

/**
 * Live AFS revenue source for attribution (D8). Reads the platform's single
 * `GoogleConnection` (the super-admin's AdSense connect), refreshes the short-lived
 * access token on demand from the offline refresh token, and pulls the per-channel
 * daily report. Designed to be the DEFAULT `fetchAdsense`:
 *  - Not connected (or no account / CONNECTION_BROKEN) → returns [] (true no-op, so the
 *    dormant state and the test DB both behave like there's no AdSense).
 *  - Connected but the report fails (e.g. AFS access not yet granted, or a 5xx) → log +
 *    return [] so a transient AdSense failure can't fail the whole attribution run
 *    (FB cost stats still populate). It self-heals once access lands.
 */

const PLATFORM = 'platform';

interface ConnRow {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date;
}

async function freshToken(c: ConnRow): Promise<string | null> {
  if (c.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptToken(c.accessTokenEnc);
  if (!c.refreshTokenEnc) return null;
  try {
    const r = await refreshGoogleToken(decryptToken(c.refreshTokenEnc));
    await withSystem((tx) =>
      tx.googleConnection.update({
        where: { id: PLATFORM },
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
        where: { id: PLATFORM },
        data: { status: 'CONNECTION_BROKEN', lastError: String(err).slice(0, 200) },
      }),
    ).catch(() => undefined);
    return null;
  }
}

export async function liveAdsenseFetch(params: {
  since: string;
  until: string;
  channelIds: string[];
}): Promise<ChannelDayRevenue[]> {
  const conn = await withSystem((tx) => tx.googleConnection.findUnique({ where: { id: PLATFORM } }));
  if (!conn || !conn.adsenseAccount || conn.status !== 'ACTIVE') return [];
  const token = await freshToken(conn);
  if (!token) return [];
  try {
    return await fetchChannelReport({
      accessToken: token,
      account: conn.adsenseAccount,
      since: params.since,
      until: params.until,
      channelIds: params.channelIds,
    });
  } catch (err) {
    console.error('[attribution] AdSense revenue pull failed:', String(err).slice(0, 200));
    return [];
  }
}
