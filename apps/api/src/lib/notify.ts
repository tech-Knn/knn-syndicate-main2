import { env } from '@knn/config';
import { buildNotificationPayload } from '@knn/shared';

export interface NotificationInput {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

/**
 * Notification sink. The durable in-app signal is still the entity's own state (e.g.
 * `FbConnection.status = CONNECTION_BROKEN`); this is the *human alert* on top. It ALWAYS logs (the
 * record), then best-effort POSTs to the configured Slack-compatible webhook so a person is actually
 * paged on CONNECTION_BROKEN / launch failure / meta-rejection / failed CAPI. Self-dormant: no
 * `NOTIFY_WEBHOOK_URL` → console only (prior behavior). NEVER throws — a notify failure must not
 * break the caller (a launch / pause / cron path).
 */
export async function notify(input: NotificationInput): Promise<void> {
  console.log(`[notify:${input.type}] org=${input.orgId} user=${input.userId} :: ${input.title} — ${input.body}`);
  if (!env.NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildNotificationPayload(input)),
    });
  } catch (err) {
    console.error(`[notify] webhook POST failed for ${input.type}:`, err instanceof Error ? err.message : String(err));
  }
}
