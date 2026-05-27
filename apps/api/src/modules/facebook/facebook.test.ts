import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';
import { signFbState } from './state.js';

const suffix = Date.now().toString(36);
const slug = `fb-co-${suffix}`;
const buyerEmail = `fb-buyer-${suffix}@a.com`;
const BUYER_PW = 'buyer-pw-123';

let app: FastifyInstance;
let orgId = '';
let buyerId = '';

/** A fetch double that answers the Graph API endpoints the connect flow touches. */
function goodFbFetch(): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.includes('/oauth/access_token'))
      return json({ access_token: 'tok-long', token_type: 'bearer', expires_in: 60 * 24 * 3600 });
    if (url.includes('/me/adaccounts'))
      return json({
        data: [
          { account_id: 'act_123', name: 'Main Account', currency: 'USD', timezone_name: 'Asia/Kolkata', account_status: 1 },
        ],
      });
    if (url.includes('/me/accounts'))
      return json({ data: [{ id: 'page_1', name: 'My Page', instagram_business_account: { id: 'ig_1' } }] });
    if (url.includes('/adspixels')) return json({ data: [{ id: 'px_1', name: 'Main Pixel' }] });
    if (url.includes('/me')) return json({ id: 'fbuser_1', name: 'Test User' });
    return json({ error: { message: 'unexpected', code: 1 } }, 400);
  }) as unknown as typeof fetch;
}

/** A fetch double whose ad-account read returns the expired-token error (code 190). */
function brokenTokenFetch(): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/me/adaccounts'))
      return json({ error: { code: 190, error_subcode: 460, message: 'Session expired' } }, 400);
    if (url.includes('/me/accounts')) return json({ data: [] });
    return json({ data: [] });
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'FB Co', slug } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: {
        orgId: org.id,
        email: buyerEmail,
        name: 'FB Buyer',
        passwordHash: await hashPassword(BUYER_PW),
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.ACTIVE,
      },
    });
    buyerId = buyer.id;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

async function bearer(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: buyerEmail, password: BUYER_PW },
  });
  return res.json<{ accessToken: string }>().accessToken;
}

describe('facebook integration', () => {
  it('rejects unauthenticated access to connection endpoints', async () => {
    const authUrl = await app.inject({ method: 'GET', url: '/api/facebook/auth-url' });
    expect(authUrl.statusCode).toBe(401);
    const status = await app.inject({ method: 'GET', url: '/api/facebook/status' });
    expect(status.statusCode).toBe(401);
  });

  it('returns 503 for auth-url when Facebook is not configured', async () => {
    const token = await bearer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/facebook/auth-url',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('reports no connection before connecting', async () => {
    const token = await bearer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/facebook/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false });
  });

  it('completes the OAuth callback: stores the connection and syncs the graph', async () => {
    vi.stubGlobal('fetch', goodFbFetch());
    const state = await signFbState({ userId: buyerId, orgId });
    const cb = await app.inject({
      method: 'GET',
      url: `/api/facebook/callback?code=test-code&state=${encodeURIComponent(state)}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('fb_connected=1');

    const token = await bearer();
    const status = await app.inject({
      method: 'GET',
      url: '/api/facebook/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json<{ connected: boolean; status: string; fbUserId: string }>();
    expect(body.connected).toBe(true);
    expect(body.status).toBe('ACTIVE');
    expect(body.fbUserId).toBe('fbuser_1');

    const accounts = await app.inject({
      method: 'GET',
      url: '/api/facebook/accounts',
      headers: { authorization: `Bearer ${token}` },
    });
    const accountList = accounts.json<{ accounts: { id: string; fbAccountId: string; currency: string }[] }>().accounts;
    expect(accountList).toHaveLength(1);
    expect(accountList[0]?.fbAccountId).toBe('act_123');
    expect(accountList[0]?.currency).toBe('USD');

    const pages = await app.inject({
      method: 'GET',
      url: '/api/facebook/pages',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pages.json<{ pages: { fbPageId: string }[] }>().pages[0]?.fbPageId).toBe('page_1');

    const accountId = accountList[0]?.id ?? '';
    const pixels = await app.inject({
      method: 'GET',
      url: `/api/facebook/accounts/${accountId}/pixels`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pixels.json<{ pixels: { fbPixelId: string }[] }>().pixels[0]?.fbPixelId).toBe('px_1');
  });

  it('marks the connection broken when a resync hits an expired token (D13)', async () => {
    vi.stubGlobal('fetch', brokenTokenFetch());
    const token = await bearer();
    const sync = await app.inject({
      method: 'POST',
      url: '/api/facebook/sync',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sync.statusCode).toBe(409);

    const status = await app.inject({
      method: 'GET',
      url: '/api/facebook/status',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = status.json<{ status: string; lastError: string | null }>();
    expect(body.status).toBe('CONNECTION_BROKEN');
    expect(body.lastError).toBeTruthy();
  });

  it('refuses to resync a broken connection until reconnected', async () => {
    const token = await bearer();
    const sync = await app.inject({
      method: 'POST',
      url: '/api/facebook/sync',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sync.statusCode).toBe(409);
  });

  it('disconnects and forgets the connection', async () => {
    const token = await bearer();
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/facebook/connection',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: '/api/facebook/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.json()).toEqual({ connected: false });
  });
});
