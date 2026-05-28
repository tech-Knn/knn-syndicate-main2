import { withSystem } from '@knn/db';
import { ROLES, USER_STATUS, type Role, type UserStatus } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import type { AddOrgUserInput, CreateOrgInput, UserAction } from './admin.schemas.js';

export interface PublicUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  approvedAt: Date | null;
}

function toPublicUser(u: PublicUser): PublicUser {
  return {
    id: u.id,
    orgId: u.orgId,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    approvedAt: u.approvedAt,
  };
}

/** Create a company + its first COMPANY_ADMIN (ACTIVE). Super-admin only. */
export async function createOrganization(
  actor: AuthContext,
  input: CreateOrgInput,
): Promise<{ orgId: string; adminId: string }> {
  const passwordHash = await hashPassword(input.adminPassword);
  return withSystem(async (tx) => {
    if (await tx.organization.findUnique({ where: { slug: input.slug } })) {
      throw new AppError(409, 'Company slug already exists');
    }
    if (await tx.user.findUnique({ where: { email: input.adminEmail } })) {
      throw new AppError(409, 'Admin email already registered');
    }
    const org = await tx.organization.create({ data: { name: input.name, slug: input.slug } });
    const admin = await tx.user.create({
      data: {
        orgId: org.id,
        name: input.adminName,
        email: input.adminEmail,
        passwordHash,
        role: ROLES.COMPANY_ADMIN,
        status: USER_STATUS.ACTIVE,
        approvedById: actor.userId,
        approvedAt: new Date(),
      },
    });
    await writeAudit(tx, {
      orgId: org.id,
      actorId: actor.userId,
      action: 'org.created',
      entityType: 'organization',
      entityId: org.id,
      details: { slug: org.slug, adminEmail: admin.email },
    });
    return { orgId: org.id, adminId: admin.id };
  });
}

/** Company settings exposed to the admin UI (approval + launch modes). */
export interface OrgSettings {
  id: string;
  name: string;
  autoApprove: boolean;
  autoLaunch: boolean;
}
const orgSettingsSelect = { id: true, name: true, autoApprove: true, autoLaunch: true } as const;

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  isPlatform: boolean;
  autoApprove: boolean;
  autoLaunch: boolean;
  buyerCount: number;
  adminCount: number;
  pendingCount: number;
  createdAt: string;
}

/** Add an ACTIVE user (admin or buyer) to an existing company. Super-admin only. */
export async function addOrgUser(actor: AuthContext, orgId: string, input: AddOrgUserInput): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);
  return withSystem(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true, isPlatform: true } });
    if (!org) throw new AppError(404, 'Company not found');
    if (org.isPlatform) {
      // The platform org holds SUPER_ADMIN staff only — never client admins/buyers.
      // Create a real company (its own org + slug) for clients instead.
      throw new AppError(400, 'Cannot add company users to the platform organization. Create a company instead.');
    }
    if (await tx.user.findUnique({ where: { email: input.email } })) {
      throw new AppError(409, 'Email already registered');
    }
    const user = await tx.user.create({
      data: {
        orgId,
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
        status: USER_STATUS.ACTIVE,
        approvedById: actor.userId,
        approvedAt: new Date(),
      },
    });
    await writeAudit(tx, { orgId, actorId: actor.userId, action: 'org.user.added', entityType: 'user', entityId: user.id, details: { email: user.email, role: input.role } });
    return toPublicUser(user);
  });
}

/** All companies (super-admin only — route-guarded) with their user counts + modes. */
export async function listOrganizations(): Promise<OrgRow[]> {
  return withSystem(async (tx) => {
    // The platform org (KNN staff / super-admins) is not a client company — it must
    // never appear in the Registered companies list.
    const orgs = await tx.organization.findMany({ where: { isPlatform: false }, orderBy: { createdAt: 'asc' } });
    const byRole = await tx.user.groupBy({ by: ['orgId', 'role'], _count: { _all: true } });
    const pending = await tx.user.groupBy({ by: ['orgId'], where: { status: USER_STATUS.PENDING }, _count: { _all: true } });
    const buyerByOrg = new Map<string, number>();
    const adminByOrg = new Map<string, number>();
    for (const r of byRole) {
      if (r.role === ROLES.MEDIA_BUYER) buyerByOrg.set(r.orgId, r._count._all);
      if (r.role === ROLES.COMPANY_ADMIN) adminByOrg.set(r.orgId, r._count._all);
    }
    const pendingByOrg = new Map(pending.map((p) => [p.orgId, p._count._all]));
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      isPlatform: o.isPlatform,
      autoApprove: o.autoApprove,
      autoLaunch: o.autoLaunch,
      buyerCount: buyerByOrg.get(o.id) ?? 0,
      adminCount: adminByOrg.get(o.id) ?? 0,
      pendingCount: pendingByOrg.get(o.id) ?? 0,
      createdAt: o.createdAt.toISOString(),
    }));
  });
}

/** Members of a specific company (super-admin only — route-guarded). Excludes super-admins. */
export async function listOrgUsers(orgId: string): Promise<PublicUser[]> {
  return withSystem(async (tx) => {
    const users = await tx.user.findMany({
      where: { orgId, role: { not: ROLES.SUPER_ADMIN } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toPublicUser);
  });
}

/** One row of the platform activity log, with actor email + company name resolved. */
export interface AuditRow {
  id: string;
  orgId: string | null;
  orgName: string | null;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  createdAt: string;
}

/** Recent activity (super-admin only — route-guarded). Newest first; capped. */
export async function listAuditLog(opts?: { limit?: number; actions?: string[] }): Promise<AuditRow[]> {
  const take = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  return withSystem(async (tx) => {
    const rows = await tx.auditLog.findMany({
      where: opts?.actions && opts.actions.length > 0 ? { action: { in: opts.actions } } : undefined,
      orderBy: { createdAt: 'desc' },
      take,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const orgIds = [...new Set(rows.map((r) => r.orgId).filter((x): x is string => !!x))];
    const [actors, orgs] = await Promise.all([
      tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }),
      tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    ]);
    const actorMap = new Map(actors.map((a) => [a.id, a.email]));
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      orgName: r.orgId ? (orgMap.get(r.orgId) ?? null) : null,
      actorId: r.actorId,
      actorEmail: r.actorId ? (actorMap.get(r.actorId) ?? null) : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/** The acting admin's own company (id, name, approval + launch modes) — for the settings UI. */
export async function getActingOrg(actor: AuthContext): Promise<OrgSettings> {
  return runScoped(actor, async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: actor.orgId },
      select: orgSettingsSelect,
    });
    if (!org) throw new AppError(404, 'Company not found');
    return org;
  });
}

/** Toggle a company's approval mode (manual review vs. auto-approve). */
export async function setOrgAutoApprove(
  actor: AuthContext,
  orgId: string,
  autoApprove: boolean,
): Promise<OrgSettings> {
  if (actor.role === ROLES.COMPANY_ADMIN && orgId !== actor.orgId) {
    throw new AppError(403, 'You can only change your own company');
  }
  return runScoped(actor, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new AppError(404, 'Company not found');
    const updated = await tx.organization.update({
      where: { id: orgId },
      data: { autoApprove },
      select: orgSettingsSelect,
    });
    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      action: autoApprove ? 'org.auto_approve.enabled' : 'org.auto_approve.disabled',
      entityType: 'organization',
      entityId: orgId,
    });
    return updated;
  });
}

/**
 * Toggle a company's launch mode. When `autoLaunch` is on, an approved campaign
 * that acquires a channel is launched to Facebook automatically (the worker fires
 * the internal launch endpoint); when off, the campaign waits at PROCESSING for an
 * admin to launch it manually (the default "manual gate").
 */
export async function setOrgAutoLaunch(
  actor: AuthContext,
  orgId: string,
  autoLaunch: boolean,
): Promise<OrgSettings> {
  if (actor.role === ROLES.COMPANY_ADMIN && orgId !== actor.orgId) {
    throw new AppError(403, 'You can only change your own company');
  }
  return runScoped(actor, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new AppError(404, 'Company not found');
    const updated = await tx.organization.update({
      where: { id: orgId },
      data: { autoLaunch },
      select: orgSettingsSelect,
    });
    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      action: autoLaunch ? 'org.auto_launch.enabled' : 'org.auto_launch.disabled',
      entityType: 'organization',
      entityId: orgId,
    });
    return updated;
  });
}

export async function listUsers(actor: AuthContext): Promise<PublicUser[]> {
  return runScoped(actor, async (tx) => {
    // Super-admins are platform staff, not org members: a COMPANY_ADMIN must never
    // see (or be offered actions on) a super-admin, even if one happens to share
    // their org. Only super-admins can see other super-admins.
    const where = actor.role === ROLES.SUPER_ADMIN ? {} : { role: { not: ROLES.SUPER_ADMIN } };
    const users = await tx.user.findMany({ where, orderBy: { createdAt: 'desc' } });
    return users.map(toPublicUser);
  });
}

/**
 * Permanently delete a user (super-admin only — route-guarded). Used to clean up a
 * mistakenly-created account so its email can be reused. Cascades to the user's
 * refresh tokens, FB connection, and campaigns (all `onDelete: Cascade`); audit rows
 * keep the (now dangling) actor id as an immutable trail. Guards: cannot delete
 * yourself, and cannot delete a super-admin.
 */
export async function deleteUser(actor: AuthContext, userId: string): Promise<{ id: string }> {
  if (actor.userId === userId) throw new AppError(400, 'You cannot delete your own account');
  return withSystem(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, orgId: true, email: true, role: true } });
    if (!target) throw new AppError(404, 'User not found');
    if (target.role === ROLES.SUPER_ADMIN) throw new AppError(403, 'Cannot delete a super admin');
    await writeAudit(tx, {
      orgId: target.orgId,
      actorId: actor.userId,
      action: 'user.deleted',
      entityType: 'user',
      entityId: userId,
      details: { email: target.email, role: target.role },
    });
    await tx.user.delete({ where: { id: userId } });
    return { id: userId };
  });
}

const ACTION_TO_STATUS: Record<UserAction, UserStatus> = {
  approve: USER_STATUS.ACTIVE,
  reject: USER_STATUS.REJECTED,
  suspend: USER_STATUS.SUSPENDED,
  reactivate: USER_STATUS.ACTIVE,
};

/**
 * Approve / reject / suspend / reactivate a user. Scoped via `runScoped`, so a
 * COMPANY_ADMIN can only ever touch users in their own org (RLS makes other
 * orgs' users invisible → 404). Super-admins can act on anyone but super-admins.
 */
export async function setUserStatus(
  actor: AuthContext,
  userId: string,
  action: UserAction,
): Promise<PublicUser> {
  if (actor.userId === userId) throw new AppError(400, 'You cannot change your own status');
  return runScoped(actor, async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target) throw new AppError(404, 'User not found');
    if (target.role === ROLES.SUPER_ADMIN) throw new AppError(403, 'Cannot modify a super admin');
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        status: ACTION_TO_STATUS[action],
        ...(action === 'approve' ? { approvedById: actor.userId, approvedAt: new Date() } : {}),
      },
    });
    await writeAudit(tx, {
      orgId: updated.orgId,
      actorId: actor.userId,
      action: `user.${action}`,
      entityType: 'user',
      entityId: userId,
    });
    return toPublicUser(updated);
  });
}
