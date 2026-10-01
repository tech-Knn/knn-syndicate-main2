import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

// Admin-issued, single-use password reset links (D37): who may issue one, that it works exactly once, that it signs the user out
// everywhere, and that the token itself is never stored.

const suffix = Date.now().toString(36);
const PW = 'old-password-123';
const NEW_PW = 'brand-new-password-456';

let app: FastifyInstance;
const ids: Record<string, string> = {};
const email = (k: string): string => `pr-${k}-${suffix}@a.com`.toLowerCase(); // the login schema lowercases emails

async function makeUser(key: string, orgId: string, role: string, status: string = USER_STATUS.ACTIVE): Promise<void> {
  const u = await withSystem(async (tx) =>
    tx.user.create({ data: { orgId, email: email(key), name: `User ${key}`, passwordHash: await hashPassword(PW), role: role as never, status: status as never } }),
  );
  ids[key] = u.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const plat = await tx.organization.create({ data: { name: 'PR Plat', slug: `pr-plat-${suffix}`, isPlatform: true } });
    const a = await tx.organization.create({ data: { name: 'PR A', slug: `pr-a-${suffix}` } });
    const b = await tx.organization.create({ data: { name: 'PR B', slug: `pr-b-${suffix}` } });
    ids.plat = plat.id;
    ids.orgA = a.id;
    ids.orgB = b.id;
  });
  await makeUser('super', ids.plat!, ROLES.SUPER_ADMIN);
  await makeUser('super2', ids.plat!, ROLES.SUPER_ADMIN);
  await makeUser('adminA', ids.orgA!, ROLES.COMPANY_ADMIN);
  await makeUser('adminA2', ids.orgA!, ROLES.COMPANY_ADMIN);
  await makeUser('buyerA', ids.orgA!, ROLES.MEDIA_BUYER);
  await makeUser('buyerA2', ids.orgA!, ROLES.MEDIA_BUYER);
  await makeUser('buyerB', ids.orgB!, ROLES.MEDIA_BUYER);
  await makeUser('suspended', ids.orgA!, ROLES.MEDIA_BUYER, USER_STATUS.SUSPENDED);
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.organization.deleteMany({ where: { id: { in: [ids.plat!, ids.orgA!, ids.orgB!] } } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

const login = (key: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: email(key), password } });
// Credential endpoints are rate-limited per IP, so each actor signs in once and the token is reused.
const tokenCache = new Map<string, string>();
async function bearer(key: string): Promise<string> {
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const res = await login(key, PW);
  expect(res.statusCode).toBe(200);
  const token = res.json<{ accessToken: string }>().accessToken;
  tokenCache.set(key, token);
  return token;
}
async function issue(actor: string, target: string) {
  return app.inject({ method: 'POST', url: `/api/admin/users/${ids[target]}/password-reset`, headers: { authorization: `Bearer ${await bearer(actor)}` } });
}
const reset = (token: string, password = NEW_PW) => app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password } });
async function issued(actor: string, target: string): Promise<string> {
  const res = await issue(actor, target);
  expect(res.statusCode).toBe(201);
  return res.json<{ token: string }>().token;
}

describe('issuing a reset link', () => {
  it('a company admin gets a link for their own buyer; the raw token is returned once and only its hash is stored', async () => {
    const res = await issue('adminA', 'buyerA');
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ token: string; expiresAt: string; user: { email: string } }>();
    expect(body.user.email).toBe(email('buyerA'));
    expect(body.token.length).toBeGreaterThanOrEqual(40);
    const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);

    const rows = await withSystem((tx) => tx.passwordResetToken.findMany({ where: { userId: ids.buyerA! } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(body.token);
    expect(JSON.stringify(rows)).not.toContain(body.token);
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: ids.buyerA!, action: 'user.password_reset_issued' } }));
    expect(audit?.actorId).toBe(ids.adminA);
  });

  it('a super admin can issue one for an admin and for a buyer in any company', async () => {
    expect((await issue('super', 'adminA')).statusCode).toBe(201);
    expect((await issue('super', 'buyerB')).statusCode).toBe(201);
  });

  it('refuses everything else', async () => {
    expect((await issue('adminA', 'adminA2')).statusCode).toBe(403); // a peer admin: account takeover
    expect((await issue('adminA', 'buyerB')).statusCode).toBe(404); // another company: invisible (RLS)
    expect((await issue('adminA', 'adminA')).statusCode).toBe(400); // yourself
    expect((await issue('adminA', 'super')).statusCode).toBe(404); // a super admin is invisible to a company admin
    expect((await issue('super', 'super2')).statusCode).toBe(403); // not even a super admin
    expect((await issue('super', 'super')).statusCode).toBe(400);
    expect((await issue('buyerA', 'buyerA2')).statusCode).toBe(403); // a buyer cannot issue
    const unauth = await app.inject({ method: 'POST', url: `/api/admin/users/${ids.buyerA}/password-reset` });
    expect(unauth.statusCode).toBe(401);
    const missing = await app.inject({ method: 'POST', url: '/api/admin/users/00000000-0000-4000-8000-000000000001/password-reset', headers: { authorization: `Bearer ${await bearer('super')}` } });
    expect(missing.statusCode).toBe(404);
  });

  it('issuing a new link replaces the earlier unused one', async () => {
    const first = await issued('adminA', 'buyerA2');
    const second = await issued('adminA', 'buyerA2');
    expect((await reset(first)).statusCode).toBe(400);
    expect((await reset(second)).statusCode).toBe(204);
  });
});

describe('using a reset link', () => {
  it('sets the new password, the old one stops working, and the link works exactly once', async () => {
    const token = await issued('adminA', 'buyerA');
    const res = await reset(token);
    expect(res.statusCode).toBe(204);

    expect((await login('buyerA', NEW_PW)).statusCode).toBe(200);
    expect((await login('buyerA', PW)).statusCode).toBe(401);

    const again = await reset(token, 'another-password-789');
    expect(again.statusCode).toBe(400);
    expect((await login('buyerA', NEW_PW)).statusCode).toBe(200); // the second attempt changed nothing
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: ids.buyerA!, action: 'user.password_reset_completed' } }));
    expect(audit?.actorId).toBe(ids.buyerA);
  });

  it('signs the user out everywhere: every refresh token is revoked', async () => {
    const session = await login('buyerB', PW);
    const refreshToken = session.json<{ refreshToken: string }>().refreshToken;
    expect((await reset(await issued('super', 'buyerB'))).statusCode).toBe(204);
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    expect(refreshed.statusCode).toBe(401);
  });

  it('refuses an expired link, an unknown one and one that is not a token, all with the same answer', async () => {
    const token = await issued('adminA', 'buyerA');
    await withSystem((tx) => tx.passwordResetToken.updateMany({ where: { userId: ids.buyerA! }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    const expired = await reset(token);
    const unknown = await reset('x'.repeat(43));
    const junk = await reset('short');
    expect(expired.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(expired.json()).toEqual(unknown.json());
    expect(junk.statusCode).toBeGreaterThanOrEqual(400);
    expect((await login('buyerA', NEW_PW)).statusCode).toBe(200); // still the previous password
  });

  it('a too-short password is refused WITHOUT burning the link', async () => {
    const token = await issued('adminA', 'buyerA');
    expect((await reset(token, 'short')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await reset(token, NEW_PW + '!')).statusCode).toBe(204);
    expect((await login('buyerA', NEW_PW + '!')).statusCode).toBe(200);
  });

  it('does not change who may sign in: a suspended user gets a password but still cannot log in', async () => {
    const token = await issued('adminA', 'suspended');
    expect((await reset(token)).statusCode).toBe(204);
    expect((await login('suspended', NEW_PW)).statusCode).toBe(403);
    const u = await withSystem((tx) => tx.user.findUnique({ where: { id: ids.suspended! }, select: { status: true } }));
    expect(u?.status).toBe(USER_STATUS.SUSPENDED);
  });

  it('two requests racing on one link: exactly one wins', async () => {
    const token = await issued('adminA', 'buyerA2');
    const [a, b] = await Promise.all([reset(token, 'racer-password-one'), reset(token, 'racer-password-two')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 400]);
  });
});
