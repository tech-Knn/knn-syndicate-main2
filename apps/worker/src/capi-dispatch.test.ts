import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { type CapiResult, type SendConversionParams, FbConnectionBrokenError, encryptToken } from '@knn/fb';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type CapiDispatchDeps, dispatchConversion } from './capi-dispatch.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let campaignId = '';

async function makeEvent(overrides: Record<string, unknown> = {}): Promise<string> {
  const ev = await withSystem((tx) =>
    tx.conversionEvent.create({
      data: {
        orgId,
        campaignId,
        adId: randomUUID(),
        clickId: `tx-${randomUUID()}`,
        fbclid: 'FBCL_1',
        pixelFbId: 'PX_777',
        eventName: 'Search',
        valueMinor: 5,
        currency: 'USD',
        clientIp: '9.9.9.9',
        clientUa: 'UA-test',
        eventSourceUrl: 'https://articles.x/search?q=foo',
        eventTime: new Date(1779950000000),
        status: 'pending',
        ...overrides,
      },
      select: { id: true },
    }),
  );
  return ev.id;
}

async function setConnStatus(status: 'ACTIVE' | 'CONNECTION_BROKEN'): Promise<void> {
  await withSystem((tx) => tx.fbConnection.updateMany({ where: { userId: buyerId }, data: { status } }));
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Capi Co', slug: `capi-${suffix}` } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `capi-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    const conn = await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: 'fb', accessTokenEnc: encryptToken('tok-xyz'), tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
    // The CAPI token is resolved via the campaign's ad account → its connection.
    const acct = await tx.fbAdAccount.create({ data: { orgId, connectionId: conn.id, fbAccountId: 'act_capi', name: 'A', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } });
    campaignId = (await tx.campaign.create({ data: { orgId, buyerId, name: 'c', status: 'ACTIVE', keywords: [], adAccountId: acct.id } })).id;
  });
});

beforeEach(async () => {
  await setConnStatus('ACTIVE');
  await withSystem((tx) => tx.conversionEvent.deleteMany({ where: { orgId } }));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('dispatchConversion', () => {
  it('builds the CAPI event with the resolved pixel + buyer token and marks it sent', async () => {
    const id = await makeEvent();
    const send = vi.fn(async (_p: SendConversionParams): Promise<CapiResult> => ({ events_received: 1 }));
    const deps: CapiDispatchDeps = { send };

    const res = await dispatchConversion({ conversionEventId: id }, deps);
    expect(res.status).toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]![0];
    expect(arg.pixelId).toBe('PX_777');
    expect(arg.accessToken).toBe('tok-xyz'); // decrypted from the stored connection
    expect(arg.event.event_name).toBe('Search');
    expect(arg.event.event_id).toBe((await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id }, select: { clickId: true } })))!.clickId);
    expect(arg.event.event_time).toBe(Math.floor(1779950000000 / 1000));
    expect(arg.event.user_data.fbc).toBe('fb.1.1779950000000.FBCL_1');
    expect(arg.event.user_data.client_ip_address).toBe('9.9.9.9');
    expect(arg.event.custom_data).toEqual({ value: 0.05, currency: 'USD' });

    const ev = await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id } }));
    expect(ev).toMatchObject({ status: 'sent', attempts: 1 });
    expect(ev!.sentAt).toBeTruthy();
  });

  it('marks failed (no retry) when the buyer connection is broken', async () => {
    await setConnStatus('CONNECTION_BROKEN');
    const id = await makeEvent();
    const send = vi.fn();
    const res = await dispatchConversion({ conversionEventId: id }, { send: send as unknown as CapiDispatchDeps['send'] });
    expect(res.status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect((await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id } })))!.status).toBe('failed');
  });

  it('marks failed (terminal) on a broken-connection error from CAPI', async () => {
    const id = await makeEvent();
    const send = vi.fn(async () => {
      throw new FbConnectionBrokenError('token dead', { code: 190 });
    });
    const res = await dispatchConversion({ conversionEventId: id }, { send: send as unknown as CapiDispatchDeps['send'] });
    expect(res.status).toBe('failed');
    expect((await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id } })))!.status).toBe('failed');
  });

  it('rethrows a transient error so BullMQ retries (status stays pending)', async () => {
    const id = await makeEvent();
    const send = vi.fn(async () => {
      throw new Error('network blip');
    });
    await expect(dispatchConversion({ conversionEventId: id }, { send: send as unknown as CapiDispatchDeps['send'] })).rejects.toThrow('network blip');
    expect((await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id } })))!.status).toBe('pending');
  });

  it('is a no-op for an already-sent event', async () => {
    const id = await makeEvent({ status: 'sent' });
    const send = vi.fn();
    const res = await dispatchConversion({ conversionEventId: id }, { send: send as unknown as CapiDispatchDeps['send'] });
    expect(res.status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
});
