import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import type { AppError } from '../../lib/errors.js';
import { addOrgUser, listUsers } from './admin.service.js';

// Tenant-isolation regression: a COMPANY_ADMIN must never see — or be able to act
// on — a SUPER_ADMIN, even when one shares their org (e.g. the platform org). And
// client users must never be added into the platform org at all.

const suffix = Date.now().toString(36);
const PW = 'admin-svc-pw-1234';

let platformOrgId = '';
let clientOrgId = '';
let superId = '';
let platformAdminId = '';
let clientAdminId = '';

const adminAuth = (userId: string, orgId: string) => ({
  userId,
  orgId,
  role: ROLES.COMPANY_ADMIN,
  status: USER_STATUS.ACTIVE,
});
const superAuth = () => ({ userId: superId, orgId: platformOrgId, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE });

beforeAll(async () => {
  await withSystem(async (tx) => {
    const platform = await tx.organization.create({ data: { name: 'KNN', slug: `plat-${suffix}`, isPlatform: true } });
    const client = await tx.organization.create({ data: { name: 'Client', slug: `client-${suffix}` } });
    platformOrgId = platform.id;
    clientOrgId = client.id;
    superId = (await tx.user.create({ data: { orgId: platform.id, email: `svc-super-${suffix}@a.com`, name: 'Super', passwordHash: 'x', role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } })).id;
    // A company-admin mistakenly sitting in the platform org (the bug scenario).
    platformAdminId = (await tx.user.create({ data: { orgId: platform.id, email: `svc-plat-admin-${suffix}@a.com`, name: 'Plat Admin', passwordHash: 'x', role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } })).id;
    clientAdminId = (await tx.user.create({ data: { orgId: client.id, email: `svc-client-admin-${suffix}@a.com`, name: 'Client Admin', passwordHash: 'x', role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } })).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.user.deleteMany({ where: { orgId: { in: [platformOrgId, clientOrgId] } } });
    await tx.organization.deleteMany({ where: { id: { in: [platformOrgId, clientOrgId] } } });
  });
  await prisma.$disconnect();
});

describe('listUsers isolation', () => {
  it('hides SUPER_ADMINs from a COMPANY_ADMIN, even in the same org', async () => {
    const users = await listUsers(adminAuth(platformAdminId, platformOrgId));
    expect(users.some((u) => u.role === ROLES.SUPER_ADMIN)).toBe(false);
    expect(users.some((u) => u.id === superId)).toBe(false);
    // The admin still sees themselves.
    expect(users.some((u) => u.id === platformAdminId)).toBe(true);
  });

  it('still shows SUPER_ADMINs to a SUPER_ADMIN', async () => {
    const users = await listUsers(superAuth());
    expect(users.some((u) => u.id === superId)).toBe(true);
  });
});

describe('addOrgUser guards', () => {
  it('refuses to add a client user to the platform org', async () => {
    await expect(
      addOrgUser(superAuth(), platformOrgId, { name: 'X', email: `svc-x-${suffix}@a.com`, password: PW, role: ROLES.COMPANY_ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 } satisfies Partial<AppError>);
  });

  it('adds a user to a real company', async () => {
    const u = await addOrgUser(superAuth(), clientOrgId, { name: 'New Buyer', email: `svc-nb-${suffix}@a.com`, password: PW, role: ROLES.MEDIA_BUYER });
    expect(u.orgId).toBe(clientOrgId);
    expect(u.status).toBe(USER_STATUS.ACTIVE);
    expect(clientAdminId).toBeTruthy();
  });
});
