import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whopAdsApi } from './ads.js';
import { WhopClient } from './client.js';
import { whopPixelTag } from './pixel.js';
import { type MockWhop, startMockWhop } from './testing/mock-whop.js';

const BIZ = 'biz_AdsTest12345';
const KEY = 'k_ads_full';
let mock: MockWhop;
let site: ReturnType<typeof createServer>;
let withPixel = '';
let withoutPixel = '';

beforeAll(async () => {
  mock = await startMockWhop();
  // A tiny website standing in for our white page: one URL carries the pixel, one does not.
  site = createServer((req, res) => {
    if (req.url?.startsWith('/pixel')) res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head>${whopPixelTag([BIZ])}</head><body>hi</body></html>`);
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>plain</body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  withPixel = `${base}/pixel`;
  withoutPixel = `${base}/plain`;
});
afterAll(async () => {
  await mock.close();
  await new Promise((r) => site.close(r));
});
beforeEach(() => {
  mock.businesses.clear();
  mock.addBusiness({ bizId: BIZ, apiKey: KEY, title: 'Acme' });
  mock.requests.length = 0;
  mock.failures.length = 0;
  mock.fileProcessingPolls = 0;
});

const client = (apiKey = KEY) => new WhopClient({ apiKey, baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 1, maxRetries: 1, sleep: async () => undefined });
const api = (apiKey = KEY) => whopAdsApi(client(apiKey), { sleep: async () => undefined });
const biz = () => mock.businesses.get(BIZ)!;
const png = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));

/** A campaign with one ad group and one ad pointing at a page that carries the pixel. */
async function seed(over: { url?: string } = {}) {
  const a = api();
  const campaign = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', idempotencyKey: `c-${Math.random()}` });
  const group = await a.createAdGroup({ ad_campaign_id: campaign.id, title: 'G', budget_amount: 10, conversion_event: 'submit_application', idempotencyKey: `g-${Math.random()}` });
  const ad = await a.createAd({ ad_group_id: group.id, title: 'Ad One', url: over.url ?? withPixel, headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: `a-${Math.random()}` });
  return { a, campaign, group, ad };
}

describe('creative upload', () => {
  it('creates the record, PUTs the bytes to storage without the API key, and waits until ready', async () => {
    const file = await api().uploadCreative({ filename: 'hero.png', bytes: png });
    expect(file).toMatchObject({ upload_status: 'ready', size: 4096, content_type: 'image/png' });
    const put = mock.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers.authorization).toBeUndefined(); // the key never goes to storage
    expect(put.headers['content-type']).toBe('image/png');
    expect(mock.requests.find((r) => r.path === '/files')!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('keeps polling while Whop processes the file', async () => {
    mock.fileProcessingPolls = 3;
    const file = await api().uploadCreative({ filename: 'hero.png', bytes: png });
    expect(file.upload_status).toBe('ready');
    expect(mock.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/files/')).length).toBe(4);
  });

  it('gives up with a timeout error when the file never becomes ready', async () => {
    mock.fileProcessingPolls = 10_000;
    await expect(api().uploadCreative({ filename: 'hero.png', bytes: png, pollMs: 1, timeoutMs: 30 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('starts over with a fresh record after a transient failure', async () => {
    mock.failures.push({ status: 503 }, { status: 503 }); // the client's own one retry is used up too
    const file = await api().uploadCreative({ filename: 'hero.png', bytes: png, idempotencyKey: 'up-1' });
    expect(file.upload_status).toBe('ready');
    const creates = mock.requests.filter((r) => r.method === 'POST' && r.path === '/files');
    expect(creates.map((r) => r.headers['idempotency-key'])).toEqual(['up-1', 'up-1', 'up-1:retry']); // the retry is a NEW key
  });

  it('restarts an expired upload link under a FRESH key, never the one whose record just failed', async () => {
    // What a leftover record looks like an hour later: the first PUT is refused, a new record works.
    // (The mock reads the property twice for a refused PUT: once to decide, once to answer.)
    let reads = 0;
    Object.defineProperty(mock, 'uploadFailureStatus', { get: () => (reads++ < 2 ? 403 : null), set: () => undefined, configurable: true });
    try {
      const file = await api().uploadCreative({ filename: 'hero.png', bytes: png, idempotencyKey: 'stale-1' });
      expect(file.upload_status).toBe('ready');
      const keys = mock.requests.filter((r) => r.method === 'POST' && r.path === '/files').map((r) => String(r.headers['idempotency-key']));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe('stale-1');
      expect(keys[1]).toMatch(/^stale-1:r[a-z0-9]+0$/); // a key Whop has never seen, so no replay of the dead link
    } finally {
      Object.defineProperty(mock, 'uploadFailureStatus', { value: null, writable: true, configurable: true });
    }
  });

  it('gives up on a link that keeps being refused after two fresh tries, and never mistakes it for a bad key', async () => {
    mock.uploadFailureStatus = 403;
    // 'validation', never 'auth' (which would break the connection): a 403 from storage says nothing about our key.
    await expect(api().uploadCreative({ filename: 'hero.png', bytes: png, idempotencyKey: 'exp-1' })).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('expired') });
    const keys = mock.requests.filter((r) => r.method === 'POST' && r.path === '/files').map((r) => String(r.headers['idempotency-key']));
    expect(keys).toHaveLength(3); // the original and two fresh tries, then it stops
    expect(new Set(keys).size).toBe(3);
    mock.uploadFailureStatus = null;
  });

  it('retries a storage outage on fresh records (twice at most), and reports an unreachable storage as a network error', async () => {
    mock.uploadFailureStatus = 503;
    try {
      await expect(api().uploadCreative({ filename: 'hero.png', bytes: png, idempotencyKey: 'out-1' })).rejects.toMatchObject({ kind: 'server' });
      const keys = mock.requests.filter((r) => r.method === 'POST' && r.path === '/files').map((r) => String(r.headers['idempotency-key']));
      expect(keys).toHaveLength(3);
      expect(keys[1]).toBe('out-1:retry'); // a transient failure's first retry is deterministic
      expect(new Set(keys).size).toBe(3);
    } finally {
      mock.uploadFailureStatus = null;
    }
    await expect(client().upload('http://127.0.0.1:1/dead', {}, png)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('launching a campaign', () => {
  it('creates a draft campaign, an ad group and an ad, none of which is delivering yet', async () => {
    const { campaign, group, ad } = await seed();
    expect(campaign).toMatchObject({ status: 'draft', delivery_status: 'draft', objective: 'leads', budget_optimization: 'ad_group' });
    expect(group).toMatchObject({ status: 'active', delivery_status: 'draft', conversion_event: 'submit_application', budget_amount: 10 });
    expect(ad).toMatchObject({ status: 'active', delivery_status: 'draft', ad_campaign: { id: campaign.id }, ad_group: { id: group.id } });
  });

  it('refuses an ad whose destination does not carry the Whop pixel, with Whop\'s own words', async () => {
    const a = api();
    const campaign = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads' });
    const group = await a.createAdGroup({ ad_campaign_id: campaign.id, title: 'G', budget_amount: 10 });
    await expect(a.createAd({ ad_group_id: group.id, title: 'A', url: withoutPixel, headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] })).rejects.toMatchObject({
      kind: 'validation',
      message: `The Whop pixel was not detected on ${withoutPixel}. Install it on the destination so conversions can be tracked: https://docs.whop.com/developer/ads/pixel`,
    });
    // A whop.com page needs none.
    await expect(a.createAd({ ad_group_id: group.id, title: 'A', url: 'https://whop.com/store', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] })).resolves.toMatchObject({ url: 'https://whop.com/store' });
  });

  it('rejects Whop\'s reserved click parameters in an ad\'s own url_parameters', async () => {
    const a = api();
    const campaign = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads' });
    const group = await a.createAdGroup({ ad_campaign_id: campaign.id, title: 'G', budget_amount: 10 });
    await expect(a.createAd({ ad_group_id: group.id, title: 'A', url: withPixel, url_parameters: { waid: 'x', mine: '1' }, headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] })).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('waid') });
  });

  it('checks the launch gates in Whop\'s order: creative, then page, then payment method, then agreement', async () => {
    biz().payment = null;
    biz().agreement = 'pending_signature';
    const { a, campaign, ad } = await seed();
    const launch = () => a.launchCampaign(campaign.id);
    await expect(launch()).rejects.toMatchObject({ message: 'Add a creative to these ads before launching: Ad One' });

    const file = await a.uploadCreative({ filename: 'hero.png', bytes: png });
    await a.updateAd(ad.id, { creatives: [{ id: file.id }] });
    await expect(launch()).rejects.toMatchObject({ message: 'Connect a Facebook page to launch these ads: Ad One' });

    await a.updateAd(ad.id, { social_accounts: [{ id: 'sacc_MockPage1' }] });
    await expect(launch()).rejects.toMatchObject({ message: 'Connect an ads payment method before launching' });

    biz().payment = { primary: { type: 'card', id: 'payt_1', card_brand: 'visa', last4: '4242' }, backup: null };
    await expect(launch()).rejects.toMatchObject({ message: expect.stringContaining('agreement') });

    biz().agreement = 'signed';
    expect(await launch()).toMatchObject({ status: 'active', delivery_status: 'processing' });
    expect((await a.getAd(ad.id)).delivery_status).toBe('processing');
  });

  it('refuses a page that cannot be used for ads, and an unknown or unfinished creative', async () => {
    const { a, ad } = await seed();
    biz().pages[0]!.error = 'The page was restricted.';
    await expect(a.updateAd(ad.id, { social_accounts: [{ id: 'sacc_MockPage1' }] })).rejects.toMatchObject({ message: expect.stringContaining('cannot be used') });
    await expect(a.updateAd(ad.id, { social_accounts: [{ id: 'sacc_Nope' }] })).rejects.toMatchObject({ message: expect.stringContaining('Unknown') });
    await expect(a.updateAd(ad.id, { creatives: [{ id: 'file_nope' }] })).rejects.toMatchObject({ message: expect.stringContaining('Unknown creative') });
  });

  async function launched() {
    const s = await seed();
    const file = await s.a.uploadCreative({ filename: 'hero.png', bytes: png });
    await s.a.updateAd(s.ad.id, { creatives: [{ id: file.id }], social_accounts: [{ id: 'sacc_MockPage1' }] });
    await s.a.launchCampaign(s.campaign.id);
    return s;
  }

  it('lets Whop and Meta move a launched campaign along, and we read the outcome', async () => {
    const { a, campaign } = await launched();
    mock.settle(BIZ, campaign.id, { delivery_status: 'active' });
    expect(await a.getCampaign(campaign.id)).toMatchObject({ delivery_status: 'active', issues: [] });
    mock.settle(BIZ, campaign.id, { delivery_status: 'all_ads_rejected', issues: [{ message: 'The ad violates a Meta policy.' }] });
    const c = await a.getCampaign(campaign.id);
    expect(c.delivery_status).toBe('all_ads_rejected');
    expect(c.issues[0]).toMatchObject({ message: 'The ad violates a Meta policy.', resource_type: 'ad_campaign' });
  });

  it('pauses and resumes; resuming needs a payment method', async () => {
    const { a, campaign } = await launched();
    expect(await a.pauseCampaign(campaign.id)).toMatchObject({ status: 'paused', delivery_status: 'paused' });
    biz().payment = null;
    await expect(a.unpauseCampaign(campaign.id)).rejects.toMatchObject({ message: expect.stringContaining('payment method') });
    biz().payment = { primary: { type: 'card', id: 'payt_1' }, backup: null };
    expect(await a.unpauseCampaign(campaign.id)).toMatchObject({ status: 'active' });
    // Only an active one can be paused.
    await a.pauseCampaign(campaign.id);
    await expect(a.pauseCampaign(campaign.id)).rejects.toMatchObject({ kind: 'validation' });
  });

  it('edits an ad group\'s budget and deletes a campaign with everything under it', async () => {
    const { a, campaign, group, ad } = await seed();
    expect((await a.updateAdGroup(group.id, { budget_amount: 25 })).budget_amount).toBe(25);
    await a.deleteCampaign(campaign.id);
    await expect(a.getCampaign(campaign.id)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.getAdGroup(group.id)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.getAd(ad.id)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('enforces where the budget lives: on the ad group by default, or on the campaign, never both', async () => {
    const a = api();
    await expect(a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', budget_amount: 5 })).rejects.toMatchObject({ message: expect.stringContaining("can't be set") });
    const cbo = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', budget_optimization: 'ad_campaign', budget_amount: 40 });
    await expect(a.createAdGroup({ ad_campaign_id: cbo.id, title: 'G', budget_amount: 10 })).rejects.toMatchObject({ message: expect.stringContaining("can't be set") });
    const abo = await a.createCampaign({ account_id: BIZ, title: 'C2', platform: 'meta', objective: 'leads' });
    await expect(a.createAdGroup({ ad_campaign_id: abo.id, title: 'G' })).rejects.toMatchObject({ message: 'budget_amount is required' });
  });
});

describe('reading a business in bulk (status and spend syncs)', () => {
  it('lists every campaign across pages', async () => {
    const a = api();
    for (let i = 0; i < 105; i++) await a.createCampaign({ account_id: BIZ, title: `C${i}`, platform: 'meta', objective: 'leads' });
    const all = await a.listCampaigns({ accountId: BIZ });
    expect(all).toHaveLength(105);
    expect(new Set(all.map((c) => c.id)).size).toBe(105); // no page repeats or skips a row
    expect(mock.requests.filter((r) => r.method === 'GET' && r.path === '/ad_campaigns')).toHaveLength(2);
  });

  it('lists the ads of the campaigns asked for, in chunks of 100 campaign ids', async () => {
    const a = api();
    const group = async (title: string) => {
      const c = await a.createCampaign({ account_id: BIZ, title, platform: 'meta', objective: 'leads' });
      const g = await a.createAdGroup({ ad_campaign_id: c.id, title, budget_amount: 5 });
      await a.createAd({ ad_group_id: g.id, title: `ad ${title}`, url: withPixel, headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] });
      return c.id;
    };
    const one = await group('one');
    const two = await group('two');
    await group('not asked for');
    const ads = await a.listAds({ accountId: BIZ, campaignIds: [one, two] });
    expect(ads.map((x) => x.title).sort()).toEqual(['ad one', 'ad two']);
    // More than 100 campaign ids are sent as several requests, never one oversized one.
    mock.requests.length = 0;
    await a.listAds({ accountId: BIZ, campaignIds: Array.from({ length: 230 }, (_, i) => `adcamp_${i}`) });
    const requests = mock.requests.filter((r) => r.path === '/ads');
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => (r.query.ad_campaign_ids as string[]).length)).toEqual([100, 100, 30]);
  });

  it('passes the stats window and the time zone through', async () => {
    await api().listCampaigns({ accountId: BIZ, stats: { from: '2026-09-29', to: '2026-09-30', timeZone: 'Asia/Kolkata' } });
    expect(mock.requests.at(-1)!.query).toMatchObject({ stats_from: '2026-09-29', stats_to: '2026-09-30', time_zone: 'Asia/Kolkata' });
  });
});

describe('idempotency and permissions', () => {
  it('replays the first answer for a repeated Idempotency-Key and creates nothing new', async () => {
    const a = api();
    const first = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', idempotencyKey: 'same-key' });
    const again = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', idempotencyKey: 'same-key' });
    expect(again.id).toBe(first.id);
    expect(biz().ads.campaigns.size).toBe(1);
    const other = await a.createCampaign({ account_id: BIZ, title: 'C', platform: 'meta', objective: 'leads', idempotencyKey: 'another-key' });
    expect(other.id).not.toBe(first.id);
    expect(biz().ads.campaigns.size).toBe(2);
  });

  it('names the missing permission', async () => {
    mock.addBusiness({ bizId: 'biz_ReadOnly1234', apiKey: 'k_ro', permissions: ['ad_campaign:basic:read'] });
    const ro = api('k_ro');
    await expect(ro.createCampaign({ account_id: 'biz_ReadOnly1234', title: 'C', platform: 'meta', objective: 'leads' })).rejects.toMatchObject({ kind: 'permission', message: expect.stringContaining('ad_campaign:create') });
  });

  it('answers not_found for an id that does not exist', async () => {
    await expect(api().getAd('ad_doesnotexist1')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(api().launchCampaign('adcamp_doesnotexist')).rejects.toMatchObject({ kind: 'not_found' });
  });
});
