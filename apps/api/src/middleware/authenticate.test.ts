import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { signAccessToken } from '../lib/jwt.js';
import { authenticate } from './authenticate.js';

// `authenticate` is a Fastify preHandler (declares a `this: FastifyInstance`); call it as a plain
// async (req, reply) fn in the unit test.
const run = authenticate as unknown as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Security regression (audit High, deduped from 5 dimensions): `authenticate` must re-check the
 * user's status against the DB on EVERY request, so a suspend takes effect immediately instead of
 * lingering for the access-token's lifetime (~15 min) during which a suspended buyer could keep
 * launching campaigns and spending money. We mint a still-valid token, then suspend the user, and
 * assert the next request is rejected.
 */
const suffix = Date.now().toString(36);
let orgId = '';
let userId = '';

function ctx(token?: string): { req: FastifyRequest; reply: FastifyReply; status: () => number } {
  let statusCode = 0;
  const reply = {
    code(c: number) {
      statusCode = c;
      return reply;
    },
    send() {
      return reply;
    },
  } as unknown as FastifyReply;
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, auth: undefined } as unknown as FastifyRequest;
  return { req, reply, status: () => statusCode };
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Auth Co', slug: `auth-${suffix}` } });
    orgId = org.id;
    userId = (
      await tx.user.create({
        data: { orgId, email: `auth-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
      })
    ).id;
  });
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await prisma.$disconnect();
});

describe('authenticate — per-request status re-check (revocation)', () => {
  it('accepts an ACTIVE user and populates auth from the DB (authoritative role/org)', async () => {
    const token = await signAccessToken({ sub: userId, org: orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });
    const { req, reply, status } = ctx(token);
    await run(req, reply);
    expect(status()).toBe(0); // no error sent → passed through
    expect(req.auth?.userId).toBe(userId);
    expect(req.auth?.orgId).toBe(orgId);
    expect(req.auth?.role).toBe(ROLES.MEDIA_BUYER);
  });

  it('rejects (401) a SUSPENDED user even with a still-valid access token', async () => {
    const token = await signAccessToken({ sub: userId, org: orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });
    await withSystem((tx) => tx.user.update({ where: { id: userId }, data: { status: USER_STATUS.SUSPENDED } }));
    const { req, reply, status } = ctx(token);
    await run(req, reply);
    expect(status()).toBe(401);
    expect(req.auth).toBeUndefined();
  });

  it('rejects (401) a missing/garbage token', async () => {
    const { req, reply, status } = ctx(undefined);
    await run(req, reply);
    expect(status()).toBe(401);
  });
});
