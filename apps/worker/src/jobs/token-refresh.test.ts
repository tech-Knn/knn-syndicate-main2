import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FbConnectionStatus, prisma, withSystem } from '@knn/db';
import { encryptToken } from '@knn/fb';
import { refreshFbTokens } from './token-refresh.js';

const suffix = Date.now().toString(36);
const slug = `tr-co-${suffix}`;
const DAY_MS = 24 * 60 * 60 * 1_000;
const T0 = Date.UTC(2026, 4, 27, 12, 0, 0); // fixed clock for deterministic windows
const now = (): number => T0;

let orgId = '';
let seq = 0;

function fetchToken(expiresInSec: number): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ access_token: `fresh-${seq}`, expires_in: expiresInSec }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

function fetchBrokenToken(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { code: 190, error_subcode: 460, message: 'expired' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

/** Create a user + FbConnection whose token expires `daysToExpiry` days after T0. */
async function makeConnection(daysToExpiry: number): Promise<{ userId: string; connId: string }> {
  seq += 1;
  return withSystem(async (tx) => {
    const user = await tx.user.create({
      data: { orgId, email: `tr-${suffix}-${seq}@a.com`, name: `TR ${seq}`, passwordHash: 'x' },
    });
    const conn = await tx.fbConnection.create({
      data: {
        orgId,
        userId: user.id,
        fbUserId: `fb-${seq}`,
        accessTokenEnc: encryptToken(`stored-token-${seq}`),
        tokenExpiresAt: new Date(T0 + daysToExpiry * DAY_MS),
      },
    });
    return { userId: user.id, connId: conn.id };
  });
}

function readConn(connId: string) {
  return withSystem((tx) => tx.fbConnection.findUnique({ where: { id: connId } }));
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'TR Co', slug } });
    orgId = org.id;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await prisma.$disconnect();
});

describe('refreshFbTokens (D13)', () => {
  it('leaves a healthy, far-from-expiry token untouched', async () => {
    vi.stubGlobal('fetch', fetchToken(60 * DAY_MS / 1000));
    const { connId } = await makeConnection(40);
    await refreshFbTokens({ now });
    const conn = await readConn(connId);
    expect(conn?.status).toBe(FbConnectionStatus.ACTIVE);
    expect(conn?.tokenExpiresAt.getTime()).toBe(T0 + 40 * DAY_MS); // unchanged
  });

  it('extends a token that is inside the refresh window', async () => {
    vi.stubGlobal('fetch', fetchToken((60 * DAY_MS) / 1000));
    const { connId } = await makeConnection(3);
    const summary = await refreshFbTokens({ now });
    const conn = await readConn(connId);
    expect(conn?.status).toBe(FbConnectionStatus.ACTIVE);
    expect(conn?.tokenExpiresAt.getTime()).toBe(T0 + 60 * DAY_MS); // pushed out
    expect(summary.refreshed).toBeGreaterThanOrEqual(1);
  });

  it('degrades an already-expired connection to CONNECTION_BROKEN + notifies', async () => {
    vi.stubGlobal('fetch', fetchToken((60 * DAY_MS) / 1000));
    const { userId, connId } = await makeConnection(-1);
    const notify = vi.fn();
    await refreshFbTokens({ now, notify });
    const conn = await readConn(connId);
    expect(conn?.status).toBe(FbConnectionStatus.CONNECTION_BROKEN);
    expect(conn?.lastError).toBeTruthy();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId, type: 'fb_connection_broken' }),
    );
  });

  it('degrades when Facebook rejects the refresh with an expired-token error (190)', async () => {
    vi.stubGlobal('fetch', fetchBrokenToken());
    const { connId } = await makeConnection(2);
    const notify = vi.fn();
    await refreshFbTokens({ now, notify });
    const conn = await readConn(connId);
    expect(conn?.status).toBe(FbConnectionStatus.CONNECTION_BROKEN);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fb_connection_broken' }),
    );
  });

  it('nudges a proactive re-auth when the refreshed token is still near expiry', async () => {
    vi.stubGlobal('fetch', fetchToken((2 * DAY_MS) / 1000)); // FB only gives 2 more days
    const { userId } = await makeConnection(3);
    const notify = vi.fn();
    await refreshFbTokens({ now, notify });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId, type: 'fb_reauth_soon' }),
    );
  });
});
