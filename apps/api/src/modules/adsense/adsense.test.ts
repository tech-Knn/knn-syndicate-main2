import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { encryptToken } from '@knn/fb';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';
import {
  disconnectAccount,
  handleCallback,
  listAfsAccounts,
  setAccountLabel,
  syncChannelCatalog,
  syncChannels,
} from './adsense.service.js';
import { signAdsenseState } from './state.js';

const superAuth = () => ({ userId: superId, orgId, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE });

const suffix = Date.now().toString(36);
const PW = 'adsense-pw-1234';
const superEmail = `ads-super-${suffix}@a.com`;
const buyerEmail = `ads-buyer-${suffix}@a.com`;
// Numeric id in a high range (90000-98999) — channels are filtered by numeric range now,
// and a high id avoids polluting the worker's cross-org channel-pool scans.
const TEST_CH = String(90000 + (Date.now() % 9000));

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
    await tx.googleConnection.deleteMany({ where: { OR: [{ id: 'platform' }, { adsenseAccount: 'accounts/pub-1' }] } });
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

  it('connects: onboards every visible AFS account with its pubId', async () => {
    vi.stubGlobal('fetch', googleFetchStub());
    const dest = await handleCallback('the-code', await signAdsenseState(superId, orgId));
    expect(dest).toContain('adsense=connected');

    const accounts = await listAfsAccounts();
    const acc = accounts.find((a) => a.account === 'accounts/pub-1');
    expect(acc).toBeTruthy();
    expect(acc!.afsPubId).toBe('ca-pub-1'); // trailing segment of the AFS ad client
    expect(acc!.status).toBe('ACTIVE');
  });

  it('relabels and disconnects an account by id', async () => {
    vi.stubGlobal('fetch', googleFetchStub());
    await handleCallback('c2', await signAdsenseState(superId, orgId));
    const acc = (await listAfsAccounts()).find((a) => a.account === 'accounts/pub-1')!;
    const relabeled = await setAccountLabel(superAuth(), acc.id, 'AFS One');
    expect(relabeled.label).toBe('AFS One');
    await disconnectAccount(superAuth(), acc.id);
    expect((await listAfsAccounts()).find((a) => a.id === acc.id)).toBeUndefined();
  });

  it('syncChannels imports the selected ranges (legacy primary account)', async () => {
    await withSystem((tx) =>
      tx.googleConnection.create({
        data: {
          id: 'platform',
          accessTokenEnc: encryptToken('fake-access'),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
          adsenseAccount: 'accounts/pub-legacy',
          adsenseAdClient: 'accounts/pub-1/adclients/ca-pub-1',
          status: 'ACTIVE',
        },
      }),
    );
    vi.stubGlobal('fetch', googleFetchStub());
    const result = await syncChannels(superAuth(), '90000-99999');
    expect(result.synced).toBe(1);
    expect(result.ranges).toBe('90000-99999');
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { channelId: TEST_CH } }));
    expect(ch?.status).toBe('AVAILABLE');
  });

  it('syncChannelCatalog mirrors the account channels locally (wipe + reinsert)', async () => {
    const afs = await withSystem((tx) =>
      tx.googleConnection.create({
        data: { accessTokenEnc: encryptToken('x'), tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `accounts/pub-cat-${suffix}`, adsenseAdClient: `adc-cat-${suffix}`, afsPubId: `pp-cat-${suffix}`, label: 'Cat AFS', status: 'ACTIVE' },
      }),
    );
    const r1 = await syncChannelCatalog(superAuth(), afs.id, {
      listChannels: async () => [
        { channelId: '95001', displayName: 'Team Alpha' },
        { channelId: '95002', displayName: 'Team Beta' },
      ],
    });
    expect(r1.synced).toBe(2);
    expect(await withSystem((tx) => tx.afsChannelCatalog.count({ where: { afsAccountId: afs.id } }))).toBe(2);

    // Re-sync with a different set → mirror replaces (wipe + reinsert).
    const r2 = await syncChannelCatalog(superAuth(), afs.id, { listChannels: async () => [{ channelId: '95003', displayName: 'Team Gamma' }] });
    expect(r2.synced).toBe(1);
    const rows = await withSystem((tx) => tx.afsChannelCatalog.findMany({ where: { afsAccountId: afs.id }, select: { channelId: true } }));
    expect(rows.map((r) => r.channelId)).toEqual(['95003']);

    await withSystem((tx) => tx.afsChannelCatalog.deleteMany({ where: { afsAccountId: afs.id } }));
    await withSystem((tx) => tx.googleConnection.deleteMany({ where: { id: afs.id } }));
  });
});
