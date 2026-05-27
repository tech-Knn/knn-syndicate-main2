import type { Prisma, TxClient } from '@knn/db';

export interface AuditEntry {
  /** Tenant the action belongs to (null for platform-global actions). */
  orgId: string | null;
  /** The user who performed the action (null = system/automated). */
  actorId: string | null;
  /** Dotted action name, e.g. `campaign.approved`. */
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Append an entry to the audit trail. Call this inside the same transaction as
 * the state change so the record and the change commit (or roll back) together.
 * RLS applies: under `withTenant` the `orgId` must equal the active org; under
 * `withSystem` (super-admin) any org is allowed.
 */
export async function writeAudit(tx: TxClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      orgId: entry.orgId,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      details: entry.details,
      ip: entry.ip ?? null,
    },
  });
}
