import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';
import { getStatus, handleCallback, syncChannels } from './adsense.service.js';
import { signAdsenseState } from './state.js';

const suffix = Date.now().toString(36);
const PW = 'adsense-pw-1234';
const superEmail = `ads-super-${suffix}@a.com`;
const buyerEmail = `ads-buyer-${suffix}@a.com`;
const TEST_CH = `aff-test-${suffix}`;

let app: FastifyInstance;
let orgId = '';
let superId = '';

async function bearer(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return res.json<{ accessToken: string }>().accessToken;
}
const h = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

/** Routes Google's OAuth + AdSense Management endpoints to canned responses. */
function googleFetchStub(): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    let body: unknown = {};
    if (u.includes('oauth2.googleapis.com') || u.includes('/token')) {
      body = { access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3600, scope: 'adsense.readonly' };
    } else if (u.includes('/customchannels')) {
      body = { customChannels: [{ name: `accounts/pub-1/adclients/ca-pub-1/customchannels/${TEST_CH}`, displayName: 'Auto US' }] };
    } else if (u.includes('/adclients')) {
      body = { adClients: [{ name: 'accounts/pub-1/adclients/ca-pub-1', productCode: 'AFS' }] };
    } else if (u.includes('/accounts')) {
      body = { accounts: [{ name: 'accounts/pub-1', displayName: 'KNN' }] };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const pw = await hashPassword(PW);
    orgId = (await tx.organization.create({ data: { name: 'Ads Co', slug: `ads-${suffix}` } })).id;
    superId = (await tx.user.create({ data: { orgId, email: superEmail, name: 'Super', passwordHash: pw, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } })).id;
    await tx.user.create({ data: { orgId, email: buyerEmail, name: 'Buyer', passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.googleConnection.deleteMany({ where: { id: 'platform' } });
    await tx.channel.deleteMany({ where: { channelId: TEST_CH } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('AdSense connect', () => {
  it('guards management routes to SUPER_ADMIN', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/adsense/status' })).statusCode).toBe(401);
    const buyer = await bearer(buyerEmail);
    expect((await app.inject({ method: 'GET', url: '/api/adsense/status', headers: h(buyer) })).statusCode).toBe(403);
    const sup = await bearer(superEmail);
    const res = await app.inject({ method: 'GET', url: '/api/adsense/status', headers: h(sup) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ connected: boolean }>().connected).toBe(false);
  });

  it('auth-url returns 503 when Google is unconfigured (test env)', async () => {
    const sup = await bearer(superEmail);
    expect((await app.inject({ method: 'GET', url: '/api/adsense/auth-url', headers: h(sup) })).statusCode).toBe(503);
  });

  it('sync is 409 before connecting', async () => {
    const sup = await bearer(superEmail);
    expect((await app.inject({ method: 'POST', url: '/api/adsense/sync', headers: h(sup) })).statusCode).toBe(409);
  });

  it('callback with a bad state redirects with an error', async () => {
    const dest = await handleCallback('code', 'not-a-jwt');
    expect(dest).toContain('adsense_error=bad_state');
  });

  it('connects (exchange + discover) then syncs AFS channels into the pool', async () => {
    vi.stubGlobal('fetch', googleFetchStub());
    const state = await signAdsenseState(superId, orgId);
    const dest = await handleCallback('the-code', state);
    expect(dest).toContain('adsense=connected');

    const status = await getStatus();
    expect(status.connected).toBe(true);
    expect(status.account).toBe('accounts/pub-1');
    expect(status.adClient).toBe('accounts/pub-1/adclients/ca-pub-1');

    const result = await syncChannels({ userId: superId, orgId, role: ROLES.SUPER_ADMIN });
    expect(result.synced).toBe(1);
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { channelId: TEST_CH } }));
    expect(ch?.label).toBe('Auto US');
    expect(ch?.status).toBe('AVAILABLE');
  });
});
