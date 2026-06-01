import { env } from '@knn/config';
import { buildNotificationPayload } from '@knn/shared';

export interface WorkerNotification {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

/**
 * Worker notification sink — the human alert for the worker's silent-failure events (a proactively
 * expired/broken FB token in token-refresh, a Facebook ad disapproval in meta-rejection). Mirrors the
 * api sink: always logs, then best-effort POSTs to the Slack-compatible `NOTIFY_WEBHOOK_URL`.
 * Self-dormant (no URL → console only) and never throws (a cron must not die on a notify failure).
 */
export function sendNotification(n: WorkerNotification): void {
  console.log(`[notify:${n.type}] org=${n.orgId} user=${n.userId} :: ${n.title} — ${n.body}`);
  if (!env.NOTIFY_WEBHOOK_URL) return;
  // Fire-and-forget: don't make callers await the webhook (they treat notify as sync).
  void fetch(env.NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildNotificationPayload(n)),
  }).catch((err) => console.error(`[notify] webhook POST failed for ${n.type}:`, err instanceof Error ? err.message : String(err)));
}
