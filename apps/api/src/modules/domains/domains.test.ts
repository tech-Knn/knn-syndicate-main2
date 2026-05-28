import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { encryptToken } from '@knn/fb';
import {
  createDomain,
  deleteDomain,
  importAllChannels,
  isDomainRegistered,
  listDomainAfsChannels,
  listDomains,
  resolveSiteConfig,
  setDomainChannels,
  syncDomainChannels,
  updateDomain,
  verifyDomain,
} from './domains.service.js';

const suffix = Date.now().toString(36);
const HOST = `articles-${suffix}.example.com`;
const CH = String(80000 + (Date.now() % 9000)); // numeric, high range (avoid pool-scan pollution)

let orgId = '';
let userId = '';
let afsId = '';
let buyerId = '';
let campaignId = '';
const auth = () => ({ userId, orgId, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE });

function stubFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) }) as Response) as unknown as typeof fetch;
}
/** AdSense customchannels stub for the per-domain sync (one channel in range). */
function adsenseStub(): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    const body = u.includes('/customchannels')
      ? { customChannels: [{ name: `accounts/p/adclients/c/customchannels/${CH}`, displayName: 'Auto US' }] }
      : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'Dom Co', slug: `dom-${suffix}` } })).id;
    userId = (await tx.user.create({ data: { orgId, email: `dom-s-${suffix}@a.com`, name: 'S', passwordHash: 'x', role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } })).id;
    buyerId = (await tx.user.create({ data: { orgId, email: `dom-b-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    afsId = (await tx.googleConnection.create({
      data: {
        accessTokenEnc: encryptToken('fake-access'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        adsenseAccount: `accounts/pub-${suffix}`,
        adsenseAdClient: `accounts/pub-${suffix}/adclients/partner-pub-${suffix}`,
        afsPubId: `partner-pub-${suffix}`,
        label: 'AFS Test',
        status: 'ACTIVE',
      },
    })).id;
    campaignId = (await tx.campaign.create({ data: { orgId, buyerId, name: 'c', status: 'ACTIVE', keywords: [] } })).id;
  });
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.channel.deleteMany({ where: { channelId: CH } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } }); // cascades domains
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await closeQueues();
  await prisma.$disconnect();
});

describe('domain management', () => {
  let domainId = '';

  it('creates a domain (PENDING_DNS, mapped to its AFS pubId)', async () => {
    const d = await createDomain(auth(), { host: HOST, afsAccountId: afsId, channelRanges: `${CH}-${CH}` });
    domainId = d.id;
    expect(d.host).toBe(HOST);
    expect(d.status).toBe('PENDING_DNS');
    expect(d.afsPubId).toBe(`partner-pub-${suffix}`);
    expect(d.verifyToken).toBeTruthy();
  });

  it('rejects a duplicate host', async () => {
    await expect(createDomain(auth(), { host: HOST, afsAccountId: afsId })).rejects.toThrow('already registered');
  });

  it('verify → LIVE when the host serves the article app', async () => {
    const d = await verifyDomain(auth(), domainId, { fetch: stubFetch({ ok: true, app: 'knn-article', host: HOST }) });
    expect(d.status).toBe('LIVE');
    expect(d.verifiedAt).toBeTruthy();
  });

  it('verify → ERROR when the host is unreachable', async () => {
    const d = await verifyDomain(auth(), domainId, { fetch: stubFetch({}, false) });
    expect(d.status).toBe('ERROR');
  });

  it('per-domain sync imports the range, tagging channels with domainId', async () => {
    vi.stubGlobal('fetch', adsenseStub());
    const r = await syncDomainChannels(auth(), domainId, `${CH}-${CH}`);
    expect(r.synced).toBe(1);
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { channelId: CH } }));
    expect(ch?.domainId).toBe(domainId);
    const mine = (await listDomains()).find((x) => x.id === domainId);
    expect(mine?.channelCount).toBe(1);
  });

  it('edge ask gate: registered host (any case/scheme/port) allowed, unknown refused', async () => {
    expect(await isDomainRegistered(HOST)).toBe(true);
    expect(await isDomainRegistered(`HTTPS://${HOST.toUpperCase()}:443/`)).toBe(true); // normalized
    expect(await isDomainRegistered(`nope-${suffix}.example.com`)).toBe(false);
    expect(await isDomainRegistered('')).toBe(false);
  });

  it('site-config resolves per-host pubId + the domain style/adsafe; null for unknown', async () => {
    await updateDomain(auth(), domainId, { styleId: '9988776655', adsafe: 'low' });
    const cfg = await resolveSiteConfig(`HTTPS://${HOST.toUpperCase()}/`); // normalized
    expect(cfg).toMatchObject({ host: HOST, pubId: `partner-pub-${suffix}`, styleId: '9988776655', adsafe: 'low' });
    expect(await resolveSiteConfig(`nope-${suffix}.example.com`)).toBeNull();
  });

  it('browses AFS channels by name and selectively imports/removes them', async () => {
    const fakeChannels = [
      { channelId: '70001', displayName: 'Maximizer US' },
      { channelId: '70002', displayName: 'Maximizer UK' },
      { channelId: '70003', displayName: 'Mukul Team' },
    ];
    const deps = { fetchChannels: async () => fakeChannels };

    const all = await listDomainAfsChannels(auth(), domainId, {}, deps);
    expect(all.channels).toHaveLength(3);
    expect(all.channels.every((c) => !c.imported)).toBe(true);

    // Filter by name (the human-friendly selector).
    const max = await listDomainAfsChannels(auth(), domainId, { q: 'maximizer' }, deps);
    expect(max.channels.map((c) => c.channelId).sort()).toEqual(['70001', '70002']);

    // Import the two selected (label = the AFS name).
    expect((await setDomainChannels(auth(), domainId, { add: [{ channelId: '70001', label: 'Maximizer US' }, { channelId: '70002', label: 'Maximizer UK' }] })).added).toBe(2);
    const imported = await withSystem((tx) => tx.channel.findUnique({ where: { channelId: '70001' }, select: { label: true, domainId: true } }));
    expect(imported).toMatchObject({ label: 'Maximizer US', domainId });

    // They now show as imported in the browser.
    const after = await listDomainAfsChannels(auth(), domainId, { q: 'maximizer' }, deps);
    expect(after.channels.every((c) => c.imported)).toBe(true);

    // Remove an AVAILABLE one.
    expect((await setDomainChannels(auth(), domainId, { remove: ['70001'] })).removed).toBe(1);
    expect(await withSystem((tx) => tx.channel.findUnique({ where: { channelId: '70001' } }))).toBeNull();

    // Cleanup (don't leak global channels into other suites).
    await withSystem((tx) => tx.channel.deleteMany({ where: { channelId: { in: ['70001', '70002', '70003'] } } }));
  });

  it('browses from the local catalog when synced (no live API scan)', async () => {
    await withSystem((tx) =>
      tx.afsChannelCatalog.createMany({
        data: [
          { afsAccountId: afsId, channelId: '90001', displayName: 'Catalog One' },
          { afsAccountId: afsId, channelId: '90002', displayName: 'Catalog Two' },
        ],
      }),
    );
    // fetchChannels throws → proves the catalog path is used (zero live API calls).
    const deps = {
      fetchChannels: async (): Promise<{ channelId: string; displayName?: string }[]> => {
        throw new Error('should not hit the live AdSense API when the catalog is synced');
      },
    };
    const r = await listDomainAfsChannels(auth(), domainId, { q: 'catalog' }, deps);
    expect(r.channels.map((c) => c.channelId).sort()).toEqual(['90001', '90002']);
    await withSystem((tx) => tx.afsChannelCatalog.deleteMany({ where: { afsAccountId: afsId } }));
  });

  it('import-all pulls every (matching) channel from the API in one shot', async () => {
    const fake = [
      { channelId: '71001', displayName: 'Pihu A' },
      { channelId: '71002', displayName: 'Pihu B' },
      { channelId: '71003', displayName: 'Ajeet C' },
    ];
    const deps = { fetchChannels: async () => fake };
    expect(await importAllChannels(auth(), domainId, { q: 'pihu' }, deps)).toMatchObject({ added: 2, matched: 2 });
    expect((await importAllChannels(auth(), domainId, {}, deps)).added).toBe(1); // only the remaining 'Ajeet C'
    const count = await withSystem((tx) => tx.channel.count({ where: { channelId: { in: ['71001', '71002', '71003'] } } }));
    expect(count).toBe(3);
    await withSystem((tx) => tx.channel.deleteMany({ where: { channelId: { in: ['71001', '71002', '71003'] } } }));
  });

  it('bulk imports a numeric channel-id RANGE in one shot (the 1000-channel case)', async () => {
    // A block of contiguous ids 72000..72004 + one outside the range.
    const fake = [
      ...Array.from({ length: 5 }, (_, i) => ({ channelId: String(72000 + i), displayName: `Block ${i}` })),
      { channelId: '79999', displayName: 'Outside' },
    ];
    const deps = { fetchChannels: async () => fake };
    // Browse the range → only the 5 in-range show.
    const browse = await listDomainAfsChannels(auth(), domainId, { range: '72000-72004' }, deps);
    expect(browse.channels.map((c) => c.channelId).sort()).toEqual(['72000', '72001', '72002', '72003', '72004']);
    // Import the whole range in one call.
    const r = await importAllChannels(auth(), domainId, { range: '72000-72004' }, deps);
    expect(r).toMatchObject({ added: 5, matched: 5 });
    const inPool = await withSystem((tx) => tx.channel.count({ where: { channelId: { in: ['72000', '72001', '72002', '72003', '72004'] } } }));
    expect(inPool).toBe(5);
    const outside = await withSystem((tx) => tx.channel.findUnique({ where: { channelId: '79999' } }));
    expect(outside).toBeNull(); // out-of-range id not imported
    await withSystem((tx) => tx.channel.deleteMany({ where: { channelId: { in: ['72000', '72001', '72002', '72003', '72004', '79999'] } } }));
  });

  it('blocks delete while offers reference the domain, allows it after', async () => {
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId, domainId, weightPct: 100, kind: 'PAID' } }));
    await expect(deleteDomain(auth(), domainId)).rejects.toThrow('live offers');
    await withSystem((tx) => tx.offer.deleteMany({ where: { domainId } }));
    await deleteDomain(auth(), domainId);
    expect((await listDomains()).find((d) => d.id === domainId)).toBeUndefined();
  });
});
