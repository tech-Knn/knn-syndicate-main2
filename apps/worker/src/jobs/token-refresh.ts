import { FbConnectionStatus, withSystem } from '@knn/db';
import {
  FbConnectionBrokenError,
  decryptToken,
  encryptToken,
  exchangeForLongLivedToken,
} from '@knn/fb';

/**
 * Facebook long-lived user tokens last ~60 days (DECISION D13). This job runs
 * daily and: extends tokens entering the refresh window, degrades expired ones
 * to CONNECTION_BROKEN (graceful degradation — polling/launches stop), and nudges
 * a proactive re-auth (~day 55) when Facebook can no longer meaningfully extend
 * the token. The durable signal is the row's `status`; `notify` is the email /
 * in-app feed seam (a console stub for now).
 */
const DAY_MS = 24 * 60 * 60 * 1_000;
export const REFRESH_WITHIN_DAYS = 10;
export const PROACTIVE_NOTIFY_DAYS = 5;

interface Notification {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

export interface TokenRefreshDeps {
  now?: () => number;
  notify?: (n: Notification) => void;
}

export interface TokenRefreshSummary {
  scanned: number;
  refreshed: number;
  broken: number;
  proactiveNotified: number;
}

function defaultNotify(n: Notification): void {
  console.log(`[notify:${n.type}] org=${n.orgId} user=${n.userId} :: ${n.title} — ${n.body}`);
}

async function degrade(
  connectionId: string,
  userId: string,
  orgId: string,
  message: string,
  notify: (n: Notification) => void,
): Promise<void> {
  await withSystem((tx) =>
    tx.fbConnection.update({
      where: { id: connectionId },
      data: { status: FbConnectionStatus.CONNECTION_BROKEN, lastError: message },
    }),
  );
  notify({
    orgId,
    userId,
    type: 'fb_connection_broken',
    title: 'Facebook connection lost',
    body: 'Reconnect your Facebook profile to resume ad launches and stats.',
  });
}

export async function refreshFbTokens(deps: TokenRefreshDeps = {}): Promise<TokenRefreshSummary> {
  const now = deps.now ?? Date.now;
  const notify = deps.notify ?? defaultNotify;
  const nowMs = now();

  // DATA connections only. LAUNCH connections hold short-lived tokens by design (they clear
  // the 31/3858385 checkpoint); trying to extend one would fail, and "expired" is its normal
  // resting state — the buyer reconnects the launch app right before launching, so we must
  // not degrade/notify on it here.
  const connections = await withSystem((tx) =>
    tx.fbConnection.findMany({ where: { status: FbConnectionStatus.ACTIVE, appKind: 'DATA' } }),
  );

  const summary: TokenRefreshSummary = {
    scanned: connections.length,
    refreshed: 0,
    broken: 0,
    proactiveNotified: 0,
  };

  for (const conn of connections) {
    const msToExpiry = conn.tokenExpiresAt.getTime() - nowMs;

    if (msToExpiry <= 0) {
      await degrade(conn.id, conn.userId, conn.orgId, 'Access token expired', notify);
      summary.broken += 1;
      continue;
    }

    if (msToExpiry > REFRESH_WITHIN_DAYS * DAY_MS) continue; // healthy, far from expiry

    try {
      const refreshed = await exchangeForLongLivedToken(decryptToken(conn.accessTokenEnc));
      const newExpiry = new Date(nowMs + refreshed.expiresInSec * 1_000);
      await withSystem((tx) =>
        tx.fbConnection.update({
          where: { id: conn.id },
          data: { accessTokenEnc: encryptToken(refreshed.accessToken), tokenExpiresAt: newExpiry },
        }),
      );
      summary.refreshed += 1;

      // If Facebook couldn't meaningfully extend it, prompt re-auth before it dies.
      if (newExpiry.getTime() - nowMs <= PROACTIVE_NOTIFY_DAYS * DAY_MS) {
        notify({
          orgId: conn.orgId,
          userId: conn.userId,
          type: 'fb_reauth_soon',
          title: 'Reconnect Facebook soon',
          body: 'Your Facebook access expires shortly. Reconnect to avoid interruption.',
        });
        summary.proactiveNotified += 1;
      }
    } catch (err) {
      if (err instanceof FbConnectionBrokenError) {
        await degrade(conn.id, conn.userId, conn.orgId, err.message, notify);
        summary.broken += 1;
      } else {
        console.error(`[token-refresh] connection ${conn.id} failed:`, (err as Error).message);
      }
    }
  }

  return summary;
}
