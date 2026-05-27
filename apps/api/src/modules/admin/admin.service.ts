import { withSystem } from '@knn/db';
import { ROLES, USER_STATUS, type Role, type UserStatus } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import type { CreateOrgInput, UserAction } from './admin.schemas.js';

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
        approvedAt: new Date(),
      },
    });
    return { orgId: org.id, adminId: admin.id };
  });
}

export async function listUsers(actor: AuthContext): Promise<PublicUser[]> {
  return runScoped(actor, async (tx) => {
    const users = await tx.user.findMany({ orderBy: { createdAt: 'desc' } });
    return users.map(toPublicUser);
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
    return toPublicUser(updated);
  });
}
