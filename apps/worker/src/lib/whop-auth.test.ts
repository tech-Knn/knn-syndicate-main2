import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type WhopErrorKind, WhopApiError } from '@knn/whop';

vi.mock('./notify.js', () => ({ sendNotification: vi.fn() }));

import { sendNotification } from './notify.js';
import { PassBudget, TRANSPORT_FAILURES_BEFORE_STOP, handleWhopReadFailure, markWhopConnectionBroken, nextTransportFailures, resolveWhopConnection, rotate } from './whop-auth.js';

const suffix = Date.now().toString(36);
const BIZ = `biz_AUTH${suffix}`.slice(0, 24);
const notify = vi.mocked(sendNotification);

let orgA = '';
let orgB = '';
let buyerA = '';
let buyerB = '';

const makeConn = (orgId: string, userId: string, o: { bizId?: string; status?: 'ACTIVE' | 'BROKEN'; key?: string; env?: 'PRODUCTION' | 'SANDBOX'; connectedAt?: Date } = {}) =>
  withSystem((tx) =>
    tx.whopConnection.create({
      data: {
        orgId,
        userId,
        bizId: o.bizId ?? BIZ,
        environment: o.env ?? 'PRODUCTION',
        apiKeyEnc: o.key ?? `enc-${Math.random()}`,
        apiKeyLast4: '1234',
        apiVersionDate: '2026-09-29',
        status: o.status ?? 'ACTIVE',
        ...(o.connectedAt ? { connectedAt: o.connectedAt } : {}),
      },
    }),
  );
const reload = (id: string) => withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id } }));
const whopError = (kind: WhopErrorKind, status = 500, message = `whop ${kind}`) => new WhopApiError(kind, message, { status });

beforeAll(async () => {
  await withSystem(async (tx) => {
    orgA = (await tx.organization.create({ data: { name: 'Auth A', slug: `auth-a-${suffix}`, whopEnabled: true } })).id;
    orgB = (await tx.organization.create({ data: { name: 'Auth B', slug: `auth-b-${suffix}`, whopEnabled: true } })).id;
    buyerA = (await tx.user.create({ data: { orgId: orgA, email: `auth-a-${suffix}@a.com`, name: 'A', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    buyerB = (await tx.user.create({ data: { orgId: orgB, email: `auth-b-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.whopConnection.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
    await tx.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  notify.mockClear();
  await withSystem((tx) => tx.whopConnection.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }));
});

describe('resolveWhopConnection', () => {
  it('finds the connection a campaign was launched with', async () => {
    const conn = await makeConn(orgA, buyerA);
    const found = await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: conn.id, whopBizId: BIZ });
    expect(found?.id).toBe(conn.id);
  });

  it('never returns another company\'s connection, whatever id the campaign stores', async () => {
    const theirs = await makeConn(orgB, buyerB);
    expect(await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: theirs.id, whopBizId: BIZ })).toBeNull();
    // ...and falls back to the campaign's OWN company's connection to the same business when there is one.
    const mine = await makeConn(orgA, buyerA);
    expect((await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: theirs.id, whopBizId: BIZ }))?.id).toBe(mine.id);
  });

  it('falls back to the buyer\'s connection to the same business when the stored row is gone, preferring a working one', async () => {
    const gone = '00000000-0000-4000-8000-000000000000';
    await makeConn(orgA, buyerA, { env: 'PRODUCTION', status: 'BROKEN', connectedAt: new Date('2026-09-30T10:00:00Z') }); // newer but broken
    const working = await makeConn(orgA, buyerA, { env: 'SANDBOX', status: 'ACTIVE', connectedAt: new Date('2026-09-29T10:00:00Z') });
    expect((await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: gone, whopBizId: BIZ }))?.id).toBe(working.id);

    // With nothing working, the newest one still answers (its status tells the caller to skip it).
    await withSystem((tx) => tx.whopConnection.update({ where: { id: working.id }, data: { status: 'BROKEN' } }));
    expect((await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: gone, whopBizId: BIZ }))?.status).toBe('BROKEN');
  });

  it('does not borrow another buyer\'s connection to the same business', async () => {
    await makeConn(orgA, buyerA); // the same business, connected by someone at another company
    const b = await makeConn(orgB, buyerB);
    expect(await resolveWhopConnection({ orgId: orgB, buyerId: buyerB, whopConnectionId: null, whopBizId: BIZ })).toMatchObject({ id: b.id });
    // A colleague of buyer B who never connected it gets nothing: a campaign runs on its own buyer's key, not a teammate's.
    const other = await withSystem((tx) => tx.user.create({ data: { orgId: orgB, email: `auth-c-${suffix}@a.com`, name: 'C', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } }));
    expect(await resolveWhopConnection({ orgId: orgB, buyerId: other.id, whopConnectionId: null, whopBizId: BIZ })).toBeNull();
    await withSystem((tx) => tx.user.delete({ where: { id: other.id } }));
  });

  it('is null with no stored id and no business to go by, or no connection at all', async () => {
    expect(await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: null, whopBizId: null })).toBeNull();
    expect(await resolveWhopConnection({ orgId: orgA, buyerId: buyerA, whopConnectionId: null, whopBizId: BIZ })).toBeNull();
  });
});

describe('markWhopConnectionBroken', () => {
  it('breaks an active connection and tells its owner, once', async () => {
    const conn = await makeConn(orgA, buyerA);
    await markWhopConnectionBroken(conn, 'Whop rejected the API key. Reconnect with a working key.');
    await markWhopConnectionBroken(conn, 'Whop rejected the API key. Reconnect with a working key.'); // a second job failing at the same moment
    const after = await reload(conn.id);
    expect(after.status).toBe('BROKEN');
    expect(after.lastError).toMatch(/rejected/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'whop_connection_broken', orgId: orgA, userId: buyerA }));
  });

  it('does nothing when the key that failed is no longer the connection\'s key (the buyer reconnected meanwhile)', async () => {
    const conn = await makeConn(orgA, buyerA, { key: 'old-key' });
    await withSystem((tx) => tx.whopConnection.update({ where: { id: conn.id }, data: { apiKeyEnc: 'new-key' } })); // reconnected with a new key, same row
    await markWhopConnectionBroken(conn, 'Whop rejected the API key. Reconnect with a working key.'); // the OLD key's late 401
    expect((await reload(conn.id)).status).toBe('ACTIVE');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('handleWhopReadFailure', () => {
  it('breaks the connection on a rejected key and on a key that may not read the ads: "fatal"', async () => {
    const rejected = await makeConn(orgA, buyerA, { env: 'PRODUCTION' });
    expect(await handleWhopReadFailure(rejected, whopError('auth', 401))).toBe('fatal');
    expect((await reload(rejected.id)).status).toBe('BROKEN');

    const forbidden = await makeConn(orgA, buyerA, { env: 'SANDBOX' });
    expect(await handleWhopReadFailure(forbidden, whopError('permission', 403, 'needs ad_campaign:basic:read'))).toBe('fatal');
    const after = await reload(forbidden.id);
    expect(after.status).toBe('BROKEN');
    expect(after.lastError).toContain('needs ad_campaign:basic:read'); // the owner is told which permission to give
  });

  it('calls an outage "transport" and leaves the connection alone: it is nobody\'s fault', async () => {
    const conn = await makeConn(orgA, buyerA);
    for (const kind of ['network', 'timeout', 'server'] as const) {
      expect(await handleWhopReadFailure(conn, whopError(kind))).toBe('transport');
    }
    expect((await reload(conn.id)).status).toBe('ACTIVE');
    expect(notify).not.toHaveBeenCalled();
  });

  it('calls a rate limit "limited", not "transport": Whop is up and answering, it is just limiting this key', async () => {
    const conn = await makeConn(orgA, buyerA);
    expect(await handleWhopReadFailure(conn, whopError('rate_limited', 429))).toBe('limited');
    expect((await reload(conn.id)).status).toBe('ACTIVE');
    expect(notify).not.toHaveBeenCalled();
  });

  it('calls a refusal of one request, or an error that is not Whop\'s, "other"', async () => {
    const conn = await makeConn(orgA, buyerA);
    expect(await handleWhopReadFailure(conn, whopError('validation', 400))).toBe('other');
    expect(await handleWhopReadFailure(conn, whopError('not_found', 404))).toBe('other');
    expect(await handleWhopReadFailure(conn, new Error('disk full'))).toBe('other');
    expect((await reload(conn.id)).status).toBe('ACTIVE');
  });
});

describe('PassBudget', () => {
  it('runs out once the time allowed has passed, by the clock it is given', () => {
    let now = 1_000;
    const budget = new PassBudget(5_000, () => now);
    expect(budget.expired()).toBe(false);
    now = 6_000;
    expect(budget.expired()).toBe(false); // exactly at the deadline is still inside it
    now = 6_001;
    expect(budget.expired()).toBe(true);
  });

  it('gives up on a run of failing businesses after a fixed, small number', () => {
    expect(TRANSPORT_FAILURES_BEFORE_STOP).toBeGreaterThanOrEqual(2);
    expect(TRANSPORT_FAILURES_BEFORE_STOP).toBeLessThanOrEqual(5);
  });
});

describe('nextTransportFailures', () => {
  it('counts only consecutive transport failures: anything Whop answered resets the run, and skipping says nothing', () => {
    let n = 0;
    n = nextTransportFailures(n, 'transport');
    n = nextTransportFailures(n, 'transport');
    expect(n).toBe(2);
    expect(nextTransportFailures(n, 'skipped')).toBe(2); // a key we could not even use: no evidence either way
    expect(nextTransportFailures(n, 'answered')).toBe(0); // a rejected key, a rate limit, a success: Whop is up
    expect(nextTransportFailures(0, 'transport')).toBe(1);
  });
});

describe('rotate', () => {
  it('starts anywhere in the list and keeps the cyclic order, so a stopped pass does not starve the same tail every time', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(rotate(list, 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(rotate(list, 0.26)).toEqual(['b', 'c', 'd', 'a']);
    expect(rotate(list, 0.5)).toEqual(['c', 'd', 'a', 'b']);
    expect(rotate(list, 0.999)).toEqual(['d', 'a', 'b', 'c']);
    // Every business is first for some start, which is what gives each its turn over time.
    expect(new Set([0, 0.25, 0.5, 0.75].map((f) => rotate(list, f)[0])).size).toBe(4);
  });

  it('copes with an empty list and with numbers outside [0, 1)', () => {
    expect(rotate([], 0.5)).toEqual([]);
    expect(rotate(['a', 'b'], 1)).toEqual(['b', 'a']);
    expect(rotate(['a', 'b'], -3)).toEqual(['a', 'b']);
  });

  it('does not touch the list it is given', () => {
    const list = ['a', 'b', 'c'];
    rotate(list, 0.7);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
