import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

const suffix = Date.now().toString(36);
const slugA = `co-a-${suffix}`;
const adminEmail = `admin-${suffix}@a.com`;
const superEmail = `super-${suffix}@a.com`;
const buyerEmail = `buyer-${suffix}@a.com`;
const buyerBEmail = `buyer-b-${suffix}@b.com`;
const ADMIN_PW = 'admin-pw-123';
const SUPER_PW = 'super-pw-123';
const BUYER_PW = 'buyer-pw-123';

let app: FastifyInstance;
let orgAId = '';
let orgBId = '';
let buyerBId = '';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const orgA = await tx.organization.create({ data: { name: 'Co A', slug: slugA } });
    const orgB = await tx.organization.create({ data: { name: 'Co B', slug: `co-b-${suffix}` } });
    orgAId = orgA.id;
    orgBId = orgB.id;
    await tx.user.create({
      data: {
        orgId: orgA.id,
        email: adminEmail,
        name: 'Admin A',
        passwordHash: await hashPassword(ADMIN_PW),
        role: ROLES.COMPANY_ADMIN,
        status: USER_STATUS.ACTIVE,
      },
    });
    await tx.user.create({
      data: {
        orgId: orgA.id,
        email: superEmail,
        name: 'Super',
        passwordHash: await hashPassword(SUPER_PW),
        role: ROLES.SUPER_ADMIN,
        status: USER_STATUS.ACTIVE,
      },
    });
    const buyerB = await tx.user.create({
      data: {
        orgId: orgB.id,
        email: buyerBEmail,
        name: 'Buyer B',
        passwordHash: await hashPassword(BUYER_PW),
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.PENDING,
      },
    });
    buyerBId = buyerB.id;
  });
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } }));
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

async function bearer(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return res.json<{ accessToken: string }>().accessToken;
}

describe('auth lifecycle', () => {
  it('signs up a buyer as PENDING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { name: 'Buyer A', email: buyerEmail, password: BUYER_PW, companySlug: slugA },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: USER_STATUS.PENDING });
  });

  it('blocks login while PENDING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: buyerEmail, password: BUYER_PW },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a company admin sees only their org users', async () => {
    const token = await bearer(adminEmail, ADMIN_PW);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const emails = res.json<{ users: { email: string; orgId: string }[] }>().users.map((u) => u.email);
    expect(emails).toContain(buyerEmail);
    expect(emails).not.toContain(buyerBEmail); // org B is invisible (RLS)
  });

  it('a buyer cannot approve users (403)', async () => {
    // approve the pending buyer first so it can log in, then check authz
    const adminToken = await bearer(adminEmail, ADMIN_PW);
    const buyer = await withSystem((tx) => tx.user.findUnique({ where: { email: buyerEmail } }));
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${buyer?.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });
    const buyerToken = await bearer(buyerEmail, BUYER_PW);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${buyerBId}`,
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('login works after approval and /me returns the user', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: buyerEmail, password: BUYER_PW },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken } = login.json<{ accessToken: string; refreshToken: string }>();
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(buyerEmail);
  });

  it('rotates refresh tokens (old token is revoked)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: buyerEmail, password: BUYER_PW },
    });
    const first = login.json<{ refreshToken: string }>().refreshToken;

    const rotate = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first } });
    expect(rotate.statusCode).toBe(200);

    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first } });
    expect(reuse.statusCode).toBe(401); // rotation revoked the old one
  });

  it('logout revokes the refresh token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: buyerEmail, password: BUYER_PW },
    });
    const token = login.json<{ refreshToken: string }>().refreshToken;
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: token } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: token } });
    expect(after.statusCode).toBe(401);
  });

  it('a company admin cannot approve a user in another org (RLS => 404)', async () => {
    const token = await bearer(adminEmail, ADMIN_PW);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${buyerBId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a super admin can approve a user in any org', async () => {
    const token = await bearer(superEmail, SUPER_PW);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${buyerBId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { status: string } }>().user.status).toBe(USER_STATUS.ACTIVE);
  });
});
