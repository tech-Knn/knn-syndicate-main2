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
  it('resolves token + appKind + currency for a healthy connection', async () => {
    const conn = await mkConn('DATA', FbConnectionStatus.ACTIVE);
    const acctId = await mkAcct(conn, 'act_100', 'EUR');

    const auth = await resolveCampaignReadAuth(acctId);
    expect(auth?.fbAccountId).toBe('act_100');
    expect(auth?.appKind).toBe('DATA');
    expect(auth?.currency).toBe('EUR');
    expect(auth?.token).toBe('tok-DATA'); // decrypted
  });

  it('resolves via the STABLE fbAccountId to the CURRENT healthy connection when the pinned row is on a broken/old one (#3)', async () => {
    // The campaign was launched against an old connection (now broken); the buyer later reconnected
    // under a different app — same Meta ad account, a NEW healthy connection row.
    const oldConn = await mkConn('DATA', FbConnectionStatus.CONNECTION_BROKEN);
    const pinned = await mkAcct(oldConn, 'act_200'); // the internal id the campaign still stores
    const newConn = await mkConn('VERIFY', FbConnectionStatus.ACTIVE);
    await mkAcct(newConn, 'act_200'); // same Meta account under the live connection

    const auth = await resolveCampaignReadAuth(pinned);
    expect(auth?.fbAccountId).toBe('act_200');
    expect(auth?.appKind).toBe('VERIFY'); // the LIVE connection, not the broken pinned one
    expect(auth?.token).toBe('tok-VERIFY');
  });

  it('returns null when no healthy connection owns the account', async () => {
    const conn = await mkConn('DATA', FbConnectionStatus.CONNECTION_BROKEN);
    const acctId = await mkAcct(conn, 'act_300');
    expect(await resolveCampaignReadAuth(acctId)).toBeNull();
  });

  it('returns null for a null ad account', async () => {
    expect(await resolveCampaignReadAuth(null)).toBeNull();
  });
});
