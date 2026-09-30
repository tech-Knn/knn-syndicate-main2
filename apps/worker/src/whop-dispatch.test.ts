import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { encryptToken } from '@knn/fb';
import { ROLES, USER_STATUS } from '@knn/shared';
import { WhopApiError, createWhopClient, whopApi } from '@knn/whop';
import { type MockWhop, startMockWhop } from '@knn/whop/testing';
import { type WhopConnectionForDispatch, type WhopDispatchDeps, dispatchWhopEvent, failExhaustedWhopEvent } from './whop-dispatch.js';

const suffix = Date.now().toString(36);
const BIZ = 'biz_5kCAsGozVBmEm1';
const KEY = 'whop_key_dispatch_test_9f8e7d';
const NOW = new Date('2026-09-30T12:00:00Z');

let mock: MockWhop;
let orgId = '';
let buyerId = '';
let otherUserId = '';
let campaignId = '';

const notify = vi.fn();
const deps = (over: Partial<WhopDispatchDeps> = {}): WhopDispatchDeps => ({
  // The real client against the mock over HTTP: headers, retries and errors are all genuine.
  apiFor: (conn: WhopConnectionForDispatch) => {
    void conn;
    return whopApi(createWhopClient({ apiKey: KEY, baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 1, maxRetries: 1, sleep: async () => undefined }));
  },
  notify,
  now: () => NOW,
  enabled: () => true,
  ...over,
});

const context = {
  bizId: BIZ,
  landing: 'https://go.test/go/abc123?wacid=adcamp_ARRzXWlc8gt&wasid=adgrp_adGTsobtDlzz&waid=ad_I2YRNtEkImoX5qB&fbclid=IwAR0x',
  click: { campaignId: 'adcamp_ARRzXWlc8gt', adGroupId: 'adgrp_adGTsobtDlzz', adId: 'ad_I2YRNtEkImoX5qB', utm: { source: 'fb', medium: 'paid_social' } },
};

async function makeEvent(overrides: Record<string, unknown> = {}): Promise<string> {
  const ev = await withSystem((tx) =>
    tx.conversionEvent.create({
      data: {
        orgId,
        campaignId,
        adId: randomUUID(),
        clickId: `tx-${randomUUID()}`,
        fbclid: 'IwAR0x',
        pixelFbId: '',
        eventName: 'Search',
        currency: 'USD',
        clientIp: '203.0.113.9',
        clientUa: 'UA-test',
        eventSourceUrl: 'https://articles.x/a/slug?t=secrettoken',
        eventTime: new Date(NOW.getTime() - 60_000),
        clickTimeMs: BigInt(NOW.getTime() - 120_000),
        fbp: 'fb.1.1790000000000.1234567890',
        provider: 'whop',
        providerContext: context,
        status: 'pending',
        ...overrides,
      },
      select: { id: true },
    }),
  );
  return ev.id;
}
const row = (id: string) => withSystem((tx) => tx.conversionEvent.findUniqueOrThrow({ where: { id } }));
const connection = () => withSystem((tx) => tx.whopConnection.findFirstOrThrow({ where: { orgId, userId: buyerId } }));

beforeAll(async () => {
  mock = await startMockWhop();
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'WD Co', slug: `wd-${suffix}` } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `wd-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    otherUserId = (await tx.user.create({ data: { orgId, email: `wd2-${suffix}@a.com`, name: 'C', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    campaignId = (await tx.campaign.create({ data: { orgId, buyerId, name: 'c', status: 'ACTIVE', keywords: [] } })).id;
  });
});

beforeEach(async () => {
  notify.mockClear();
  mock.businesses.clear();
  mock.addBusiness({ bizId: BIZ, apiKey: KEY, title: 'Acme' });
  mock.requests.length = 0;
  mock.failures.length = 0;
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.whopConnection.deleteMany({ where: { orgId } });
    await tx.whopConnection.create({ data: { orgId, userId: buyerId, bizId: BIZ, label: 'Acme Ads', environment: 'SANDBOX', apiKeyEnc: encryptToken(KEY), apiKeyLast4: KEY.slice(-4), apiVersionDate: '2026-09-29' } });
  });
});

afterAll(async () => {
  await mock.close();
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.whopConnection.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('dispatchWhopEvent', () => {
  it('reports the event the way ClickFlare does, and marks the row sent', async () => {
    const id = await makeEvent();
    const { clickId } = await row(id);
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'sent' });

    const sent = mock.businesses.get(BIZ)!.events;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toEqual({
      account_id: BIZ,
      event_name: 'submit_application', // our `Search` (the ad click) is Whop's money event
      event_id: clickId,
      event_time: new Date(NOW.getTime() - 60_000).toISOString(),
      action_source: 'website',
      url: context.landing, // Whop's landing URL with its own parameters, never our page URL or cloak token
      context: {
        ad_campaign_id: 'adcamp_ARRzXWlc8gt',
        ad_set_id: 'adgrp_adGTsobtDlzz',
        ad_id: 'ad_I2YRNtEkImoX5qB',
        fbclid: 'IwAR0x',
        fbc: `fb.1.${NOW.getTime() - 120_000}.IwAR0x`, // the ad-CLICK time, as Facebook requires
        fbp: 'fb.1.1790000000000.1234567890',
        ip_address: '203.0.113.9',
        user_agent: 'UA-test',
        utm_source: 'fb',
        utm_medium: 'paid_social',
      },
      user: { external_id: clickId },
    });
    expect(JSON.stringify(sent[0]!.input)).not.toContain('secrettoken');
    const after = await row(id);
    expect(after).toMatchObject({ status: 'sent', attempts: 1, providerRef: `${BIZ}:${clickId}`, providerResponse: 'ok' });
    expect(after.sentAt).toBeInstanceOf(Date);
    // The key went out as the bearer token and nowhere else.
    expect(mock.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(after, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(KEY);
  });

  it('names each funnel stage the way ClickFlare maps it', async () => {
    const ids = await Promise.all([makeEvent({ eventName: 'ViewContent' }), makeEvent({ eventName: 'AddToCart' }), makeEvent({ eventName: 'Search' })]);
    for (const id of ids) await dispatchWhopEvent({ conversionEventId: id }, deps());
    expect(mock.businesses.get(BIZ)!.events.map((e) => e.input.event_name).sort()).toEqual(['add_to_cart', 'submit_application', 'view_content']);
  });

  it('is a no-op for an event already sent, and for one that does not exist', async () => {
    const id = await makeEvent({ status: 'sent' });
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'skipped' });
    expect(await dispatchWhopEvent({ conversionEventId: randomUUID() }, deps())).toEqual({ status: 'missing' });
    expect(mock.requests).toHaveLength(0);
  });

  it('cannot double count: sending the same event twice leaves Whop with one copy', async () => {
    const id = await makeEvent();
    await dispatchWhopEvent({ conversionEventId: id }, deps());
    // Simulate a crash between Whop's answer and our update: the job runs again on a pending row.
    await withSystem((tx) => tx.conversionEvent.update({ where: { id }, data: { status: 'pending' } }));
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'sent' });
    expect(mock.businesses.get(BIZ)!.events).toHaveLength(1);
  });

  it('refuses a Facebook row that reached this queue by mistake, without calling Whop', async () => {
    const id = await makeEvent({ provider: 'facebook', providerContext: null });
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'failed', providerResponse: 'not a Whop event' });
    expect(mock.requests).toHaveLength(0);
  });

  it('skips while Whop Ads is off, without calling Whop', async () => {
    const id = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps({ enabled: () => false }))).toEqual({ status: 'skipped' });
    expect(await row(id)).toMatchObject({ status: 'skipped', providerResponse: 'Whop Ads is off' });
    expect(mock.requests).toHaveLength(0);
  });

  it('never sends an event older than Whop accepts (28 days): it can only fail', async () => {
    const id = await makeEvent({ eventTime: new Date(NOW.getTime() - 28 * 86_400_000) });
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'failed', providerResponse: expect.stringContaining('28 days') });
    expect(mock.requests).toHaveLength(0);
  });

  it('fails an event with no business or no live connection, without calling Whop', async () => {
    const noBiz = await makeEvent({ providerContext: { landing: context.landing } });
    expect(await dispatchWhopEvent({ conversionEventId: noBiz }, deps())).toEqual({ status: 'failed' });
    await withSystem((tx) => tx.whopConnection.updateMany({ where: { orgId }, data: { status: 'BROKEN' } }));
    const noConn = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: noConn }, deps())).toEqual({ status: 'failed' });
    expect(await row(noConn)).toMatchObject({ providerResponse: 'no usable Whop connection' });
    expect(mock.requests).toHaveLength(0);
  });

  it('prefers the campaign buyer\'s own connection over a colleague\'s', async () => {
    await withSystem((tx) =>
      tx.whopConnection.create({ data: { orgId, userId: otherUserId, bizId: BIZ, label: 'Colleague', environment: 'SANDBOX', apiKeyEnc: encryptToken('colleague-key'), apiKeyLast4: 'ykey', apiVersionDate: '2026-09-29' } }),
    );
    const used: string[] = [];
    const id = await makeEvent();
    await dispatchWhopEvent({ conversionEventId: id }, deps({ apiFor: (conn) => { used.push(conn.userId); return deps().apiFor(conn); } }));
    expect(used).toEqual([buyerId]);
  });
});

describe('dispatchWhopEvent: Whop refuses', () => {
  it('a rejected key is terminal: the connection is flipped to BROKEN once and its owner is told once', async () => {
    mock.failures.push({ status: 401, body: { error: { type: 'unauthorized', message: 'The API key is missing or invalid.' } } });
    const first = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: first }, deps())).toEqual({ status: 'failed' });
    expect(await row(first)).toMatchObject({ status: 'failed', providerResponse: expect.stringContaining('connection broken') });
    expect(await connection()).toMatchObject({ status: 'BROKEN', lastError: expect.stringContaining('rejected') });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ orgId, userId: buyerId, type: 'whop_connection_broken' });

    // Every later event skips the call: no key to use, and no second alert.
    const requestsBefore = mock.requests.length;
    const second = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: second }, deps())).toEqual({ status: 'failed' });
    expect(mock.requests.length).toBe(requestsBefore);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a missing permission names itself and leaves the connection alone', async () => {
    mock.businesses.get(BIZ)!.permissions = ['ad_campaign:basic:read'];
    const id = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'failed', providerResponse: expect.stringContaining('event:create') });
    expect(await connection()).toMatchObject({ status: 'ACTIVE' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a refused payload is terminal and recorded on the row', async () => {
    mock.failures.push({ status: 400, body: { error: { type: 'bad_request', message: 'event_time is more than 28 days in the past' } } });
    const id = await makeEvent();
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 1, providerResponse: expect.stringContaining('validation status=400') });
  });

  it('an outage is transient: attempts are counted, the row stays pending, and the job is retried', async () => {
    mock.failures.push({ status: 503 }, { status: 503 }); // the client's own one retry is used up too
    const id = await makeEvent();
    await expect(dispatchWhopEvent({ conversionEventId: id }, deps())).rejects.toBeInstanceOf(WhopApiError);
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, providerResponse: expect.stringContaining('server status=503') });
    expect(await connection()).toMatchObject({ status: 'ACTIVE' }); // an outage never breaks a connection
    // BullMQ's next attempt succeeds and overwrites the stale failure text.
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'sent' });
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2, providerResponse: 'ok' });
  });

  it('a rate limit is transient too', async () => {
    mock.failures.push({ status: 429, body: { error: { type: 'rate_limit_exceeded', message: 'Try again in 1 seconds.' } }, headers: { 'retry-after': '1' } });
    const id = await makeEvent();
    // One 429 is absorbed by the client's own retry, so the job succeeds.
    expect(await dispatchWhopEvent({ conversionEventId: id }, deps())).toEqual({ status: 'sent' });
  });
});

describe('failExhaustedWhopEvent', () => {
  it('settles a pending Whop row BullMQ gave up on, so it never sits pending forever', async () => {
    const id = await makeEvent();
    await failExhaustedWhopEvent(id, 'Could not reach Whop.');
    expect(await row(id)).toMatchObject({ status: 'failed', providerResponse: 'retries exhausted: Could not reach Whop.' });
  });

  it('leaves a row that was sent in the meantime, and a Facebook row, alone', async () => {
    const sent = await makeEvent({ status: 'sent', providerResponse: 'ok' });
    const fb = await makeEvent({ provider: 'facebook', providerContext: null });
    await failExhaustedWhopEvent(sent, 'x');
    await failExhaustedWhopEvent(fb, 'x');
    expect(await row(sent)).toMatchObject({ status: 'sent', providerResponse: 'ok' });
    expect(await row(fb)).toMatchObject({ status: 'pending' });
  });
});
