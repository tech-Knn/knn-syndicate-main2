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

interface Profile {
  id: string;
  fbUserId: string;
  name: string;
  status: string;
  lastError: string | null;
  adAccountCount: number;
  pageCount: number;
}

let app: FastifyInstance;
let orgId = '';
let buyerId = '';

/** A fetch double that answers the Graph API endpoints the connect flow touches. */
function goodFbFetch(meId = 'fbuser_1', meName = 'Test User'): typeof fetch {
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
    if (url.includes('/promote_pages'))
      return json({ data: [{ id: 'pg_promote', name: 'Promotable Page' }] });
    if (url.includes('/me')) return json({ id: meId, name: meName });
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

const h = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
async function profiles(token: string): Promise<Profile[]> {
  const res = await app.inject({ method: 'GET', url: '/api/facebook/profiles', headers: h(token) });
  return res.json<{ profiles: Profile[] }>().profiles;
}
async function connect(meId: string, meName: string): Promise<void> {
  vi.stubGlobal('fetch', goodFbFetch(meId, meName));
  const state = await signFbState({ userId: buyerId, orgId });
  const cb = await app.inject({ method: 'GET', url: `/api/facebook/callback?code=c&state=${encodeURIComponent(state)}` });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toContain('fb_connected=1');
  vi.unstubAllGlobals();
}

describe('facebook integration', () => {
  it('rejects unauthenticated access to connection endpoints', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/facebook/auth-url' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/facebook/profiles' })).statusCode).toBe(401);
  });

  it('auth-url returns a Facebook dialog URL when configured (else 503)', async () => {
    const token = await bearer();
    const res = await app.inject({ method: 'GET', url: '/api/facebook/auth-url', headers: h(token) });
    if (res.statusCode === 503) return; // no FB app creds in this environment
    expect(res.statusCode).toBe(200);
    const url = res.json<{ url: string }>().url;
    expect(url).toContain('facebook.com');
    expect(url).toContain('dialog/oauth');
  });

  it('lists no profiles before connecting', async () => {
    const token = await bearer();
    expect(await profiles(token)).toEqual([]);
  });

  it('completes the OAuth callback: stores a profile and syncs its graph', async () => {
    await connect('fbuser_1', 'Test User');
    const token = await bearer();
    const list = await profiles(token);
    expect(list).toHaveLength(1);
    const p = list[0]!;
    expect(p.fbUserId).toBe('fbuser_1');
    expect(p.name).toBe('Test User');
    expect(p.status).toBe('ACTIVE');
    expect(p.adAccountCount).toBe(1);
    expect(p.pageCount).toBe(1);

    // Per-profile drill-down.
    const accounts = await app.inject({ method: 'GET', url: `/api/facebook/profiles/${p.id}/accounts`, headers: h(token) });
    const accountList = accounts.json<{ accounts: { id: string; fbAccountId: string; currency: string }[] }>().accounts;
    expect(accountList).toHaveLength(1);
    expect(accountList[0]?.fbAccountId).toBe('act_123');

    const pages = await app.inject({ method: 'GET', url: `/api/facebook/profiles/${p.id}/pages`, headers: h(token) });
    expect(pages.json<{ pages: { fbPageId: string }[] }>().pages[0]?.fbPageId).toBe('page_1');

    // Aggregated launcher assets.
    const aggAccounts = await app.inject({ method: 'GET', url: '/api/facebook/accounts', headers: h(token) });
    expect(aggAccounts.json<{ accounts: unknown[] }>().accounts).toHaveLength(1);

    const accountId = accountList[0]?.id ?? '';
    const pixels = await app.inject({ method: 'GET', url: `/api/facebook/accounts/${accountId}/pixels`, headers: h(token) });
    expect(pixels.json<{ pixels: { fbPixelId: string }[] }>().pixels[0]?.fbPixelId).toBe('px_1');
  });

  it('connects a SECOND profile for the same user (multi-profile)', async () => {
    await connect('fbuser_2', 'Second Profile');
    const token = await bearer();
    const list = await profiles(token);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.fbUserId).sort()).toEqual(['fbuser_1', 'fbuser_2']);
  });

  it('lists pages promotable by an ad account (scoped page picker)', async () => {
    vi.stubGlobal('fetch', goodFbFetch());
    const token = await bearer();
    const accounts = await app.inject({ method: 'GET', url: '/api/facebook/accounts', headers: h(token) });
    const accountId = accounts.json<{ accounts: { id: string }[] }>().accounts[0]?.id ?? '';
    const res = await app.inject({ method: 'GET', url: `/api/facebook/accounts/${accountId}/pages`, headers: h(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ pages: { fbPageId: string }[] }>().pages.some((p) => p.fbPageId === 'pg_promote')).toBe(true);
  });

  it('falls back to the connection pages when an ad account can promote none (fresh account)', async () => {
    const emptyPromote = vi.fn(async (input: unknown) => {
      const url = String(input);
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/promote_pages')) return json({ data: [] }); // fresh account: nothing promotable
      return json({ data: [] });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', emptyPromote);
    const token = await bearer();
    const accounts = await app.inject({ method: 'GET', url: '/api/facebook/accounts', headers: h(token) });
    const accountId = accounts.json<{ accounts: { id: string }[] }>().accounts[0]?.id ?? '';
    const res = await app.inject({ method: 'GET', url: `/api/facebook/accounts/${accountId}/pages`, headers: h(token) });
    expect(res.statusCode).toBe(200);
    // promote_pages empty → fell back to the synced connection page so the buyer isn't stuck.
    expect(res.json<{ pages: { fbPageId: string }[] }>().pages.some((p) => p.fbPageId === 'page_1')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('marks a profile broken when a resync hits an expired token (D13)', async () => {
    vi.stubGlobal('fetch', brokenTokenFetch());
    const token = await bearer();
    const target = (await profiles(token)).find((p) => p.fbUserId === 'fbuser_1')!;
    const sync = await app.inject({ method: 'POST', url: `/api/facebook/profiles/${target.id}/sync`, headers: h(token) });
    expect(sync.statusCode).toBe(409);
    vi.unstubAllGlobals();

    const after = (await profiles(token)).find((p) => p.id === target.id)!;
    expect(after.status).toBe('CONNECTION_BROKEN');
    expect(after.lastError).toBeTruthy();
  });

  it('refuses to resync a broken profile until reconnected', async () => {
    const token = await bearer();
    const target = (await profiles(token)).find((p) => p.fbUserId === 'fbuser_1')!;
    const sync = await app.inject({ method: 'POST', url: `/api/facebook/profiles/${target.id}/sync`, headers: h(token) });
    expect(sync.statusCode).toBe(409);
  });

  it('disconnects one profile and leaves the other', async () => {
    const token = await bearer();
    const target = (await profiles(token)).find((p) => p.fbUserId === 'fbuser_1')!;
    const del = await app.inject({ method: 'DELETE', url: `/api/facebook/profiles/${target.id}`, headers: h(token) });
    expect(del.statusCode).toBe(204);
    const remaining = await profiles(token);
    expect(remaining.map((p) => p.fbUserId)).toEqual(['fbuser_2']);
  });
});
