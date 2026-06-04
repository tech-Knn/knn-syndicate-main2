import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FbConnectionStatus, prisma, withSystem } from '@knn/db';
import { encryptToken } from '@knn/fb';
import { ROLES, USER_STATUS } from '@knn/shared';
import { resolveCampaignReadAuth } from './fb-read-auth.js';

const suffix = Date.now().toString(36);
let orgId = '';
let userId = '';

async function mkConn(appKind: string, status: FbConnectionStatus): Promise<string> {
  const c = await withSystem((tx) =>
    tx.fbConnection.create({
      data: {
        orgId,
        userId,
        fbUserId: `fb-${appKind}-${Math.random().toString(36).slice(2)}`,
        appKind,
        accessTokenEnc: encryptToken(`tok-${appKind}`),
        tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
        status,
      },
    }),
  );
  return c.id;
}

async function mkAcct(connectionId: string, fbAccountId: string, currency = 'USD'): Promise<string> {
  const a = await withSystem((tx) =>
    tx.fbAdAccount.create({
      data: { orgId, connectionId, fbAccountId, name: 'Acc', currency, timezone: 'Asia/Kolkata', status: '1' },
    }),
  );
  return a.id;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'RA Co', slug: `ra-${suffix}` } });
    orgId = org.id;
    const user = await tx.user.create({
      data: { orgId, email: `ra-${suffix}@a.com`, name: 'U', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    userId = user.id;
  });
});

beforeEach(async () => {
  await withSystem((tx) => tx.fbConnection.deleteMany({ where: { userId } })); // cascades ad accounts
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await prisma.$disconnect();
});

describe('resolveCampaignReadAuth', () => {
  it('resolves token + appKind + currency from the pinned ad-account row', async () => {
    const conn = await mkConn('DATA', FbConnectionStatus.ACTIVE);
    const acctId = await mkAcct(conn, 'act_100', 'EUR');

    const auth = await resolveCampaignReadAuth({ fbAccountId: null, adAccountId: acctId });
    expect(auth?.fbAccountId).toBe('act_100');
    expect(auth?.appKind).toBe('DATA');
    expect(auth?.currency).toBe('EUR');
    expect(auth?.token).toBe('tok-DATA'); // decrypted
  });

  it('uses the stable campaign.fbAccountId even when the pinned row is gone (orphan fix #3)', async () => {
    // The disconnect deleted the original ad-account row (adAccountId now dangling/null), but the
    // campaign carries the stable Meta id and a current healthy connection owns that account.
    const conn = await mkConn('VERIFY', FbConnectionStatus.ACTIVE);
    await mkAcct(conn, 'act_orphan');

    const auth = await resolveCampaignReadAuth({ fbAccountId: 'act_orphan', adAccountId: null });
    expect(auth?.fbAccountId).toBe('act_orphan');
    expect(auth?.appKind).toBe('VERIFY');
    expect(auth?.token).toBe('tok-VERIFY');
  });

  it('prefers a LIVE connection over a broken one for the same Meta account', async () => {
    const oldConn = await mkConn('DATA', FbConnectionStatus.CONNECTION_BROKEN);
    await mkAcct(oldConn, 'act_200');
    const newConn = await mkConn('VERIFY', FbConnectionStatus.ACTIVE);
    await mkAcct(newConn, 'act_200');

    const auth = await resolveCampaignReadAuth({ fbAccountId: 'act_200', adAccountId: null });
    expect(auth?.appKind).toBe('VERIFY'); // the live connection, not the broken one
    expect(auth?.token).toBe('tok-VERIFY');
  });

  it('returns null when no healthy connection owns the account', async () => {
    const conn = await mkConn('DATA', FbConnectionStatus.CONNECTION_BROKEN);
    await mkAcct(conn, 'act_300');
    expect(await resolveCampaignReadAuth({ fbAccountId: 'act_300', adAccountId: null })).toBeNull();
  });

  it('returns null with neither a stable id nor a pinned row', async () => {
    expect(await resolveCampaignReadAuth({ fbAccountId: null, adAccountId: null })).toBeNull();
  });
});
