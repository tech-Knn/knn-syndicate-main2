export interface NotificationInput {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

/**
 * Notification sink. For now this logs the intent; the durable in-app signal is
 * the entity's own state (e.g. `FbConnection.status = CONNECTION_BROKEN`). A real
 * email provider + a persisted in-app notifications feed plug in here later.
 */
export async function notify(input: NotificationInput): Promise<void> {
  console.log(
    `[notify:${input.type}] org=${input.orgId} user=${input.userId} :: ${input.title} — ${input.body}`,
  );
}
