/**
 * Notification payload formatting (pure — no I/O, like the rest of @knn/shared). The actual
 * webhook POST lives in each app's notify sink (api `lib/notify.ts`, worker `lib/notify.ts`); this
 * just builds the Slack-compatible body so the two sinks stay identical without duplicating the shape.
 */

export interface NotificationFields {
  type: string;
  title: string;
  body: string;
  orgId?: string;
  userId?: string;
}

/** A Slack incoming-webhook compatible payload (`{ text }`) for a platform notification. */
export function buildNotificationPayload(n: NotificationFields): { text: string } {
  const scope = [n.orgId ? `org=${n.orgId}` : '', n.userId ? `user=${n.userId}` : ''].filter(Boolean).join(' ');
  return { text: `*[${n.type}]* ${n.title}\n${n.body}${scope ? `\n_${scope}_` : ''}` };
}
