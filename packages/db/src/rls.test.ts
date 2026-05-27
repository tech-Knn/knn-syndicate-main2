import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem, withTenant } from './index.js';

/**
 * Proves multi-tenant isolation (DECISION D2): with the app connecting as the
 * NON-superuser role, RLS must make cross-org reads impossible and block
 * cross-org writes. Requires `pnpm db:bootstrap` to have created the app role.
 */
const suffix = Date.now().toString(36);
const slugA = `rls-a-${suffix}`;
const slugB = `rls-b-${suffix}`;
const emailA = `a-${suffix}@example.com`;
const emailB = `b-${suffix}@example.com`;
const bothEmails = [emailA, emailB];

let orgAId = '';
let orgBId = '';

beforeAll(async () => {
  await withSystem(async (tx) => {
    const a = await tx.organization.create({ data: { name: 'Org A', slug: slugA } });
    const b = await tx.organization.create({ data: { name: 'Org B', slug: slugB } });
    orgAId = a.id;
    orgBId = b.id;
    await tx.user.create({ data: { orgId: a.id, email: emailA, name: 'A', passwordHash: 'x' } });
    await tx.user.create({ data: { orgId: b.id, email: emailB, name: 'B', passwordHash: 'x' } });
  });
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } }));
  await prisma.$disconnect();
});

describe('RLS tenant isolation', () => {
  it('withTenant(A) sees only org A users', async () => {
    const users = await withTenant(orgAId, (tx) =>
      tx.user.findMany({ where: { email: { in: bothEmails } } }),
    );
    expect(users.map((u) => u.email)).toEqual([emailA]);
  });

  it('withTenant(B) sees only org B users', async () => {
    const users = await withTenant(orgBId, (tx) =>
      tx.user.findMany({ where: { email: { in: bothEmails } } }),
    );
    expect(users.map((u) => u.email)).toEqual([emailB]);
  });

  it('no tenant context => RLS denies everything', async () => {
    const users = await prisma.user.findMany({ where: { email: { in: bothEmails } } });
    expect(users).toEqual([]);
  });

  it('withSystem sees across all orgs', async () => {
    const users = await withSystem((tx) =>
      tx.user.findMany({ where: { email: { in: bothEmails } } }),
    );
    expect(users.map((u) => u.email).sort()).toEqual([...bothEmails].sort());
  });

  it('withTenant(A) cannot see org B as an organization', async () => {
    const orgs = await withTenant(orgAId, (tx) =>
      tx.organization.findMany({ where: { id: { in: [orgAId, orgBId] } } }),
    );
    expect(orgs.map((o) => o.id)).toEqual([orgAId]);
  });

  it('WITH CHECK blocks inserting a user into a different org', async () => {
    await expect(
      withTenant(orgAId, (tx) =>
        tx.user.create({
          data: { orgId: orgBId, email: `x-${suffix}@example.com`, name: 'x', passwordHash: 'x' },
        }),
      ),
    ).rejects.toThrow();
  });
});
