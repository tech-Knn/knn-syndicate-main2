import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The flags are read once when @knn/config loads, so set them before any import runs.
const { realFetch } = vi.hoisted(() => {
  process.env.WHOP_ADS_ENABLED = 'true';
  process.env.WHOP_ALLOW_SANDBOX = 'false';
  return { realFetch: globalThis.fetch };
});

import { env } from '@knn/config';
import { prisma, withSystem, withTenant } from '@knn/db';
import { decryptToken } from '@knn/fb';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type MockWhop, startMockWhop } from '@knn/whop/testing';
import { buildApp } from '../../app.js';
import { hashPassword } from '../../lib/password.js';

const suffix = Date.now().toString(36);
const PW = 'whop-pw-123456';
const BIZ = 'biz_TESTAAA111';
const BIZ_OTHER = 'biz_TESTBBB222';
const KEY_A1 = 'whop_test_key_buyer_a1_3456';
const KEY_A1_NEW = 'whop_test_key_buyer_a1_rotated_9999';
const emails = {
  a1: `whop-a1-${suffix}@a.com`,
  a2: `whop-a2-${suffix}@a.com`,
  adminA: `whop-admin-a-${suffix}@a.com`,
  b1: `whop-b1-${suffix}@b.com`,
  superU: `whop-super-${suffix}@a.com`,
};

let app: FastifyInstance;
let mock: MockWhop;
let orgAId = '';
let orgBId = '';
const tokens = {} as Record<keyof typeof emails, string>;

const h = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: h(token), ...(payload === undefined ? {} : { payload: payload as object }) });
const connectPayload = (over: Record<string, unknown> = {}) => ({ bizId: BIZ, apiKey: KEY_A1, ...over });
const BASE = '/api/ad-providers/whop';

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return res.json<{ accessToken: string }>().accessToken;
}

beforeAll(async () => {
  mock = await startMockWhop();
  // Send the real client's calls to Whop's hosts to the local mock; everything else passes through.
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input).replace(/^https:\/\/(sandbox-)?api\.whop\.com\/api\/v1/, mock.baseUrl);
    return realFetch(url, init);
  });
  app = await buildApp();
  await app.ready();
  const pw = await hashPassword(PW);
  await withSystem(async (tx) => {
    orgAId = (await tx.organization.create({ data: { name: 'Whop A', slug: `whop-a-${suffix}`, whopEnabled: true } })).id;
    orgBId = (await tx.organization.create({ data: { name: 'Whop B', slug: `whop-b-${suffix}`, whopEnabled: false } })).id;
    const mk = (orgId: string, email: string, name: string, role: (typeof ROLES)[keyof typeof ROLES]) =>
      tx.user.create({ data: { orgId, email, name, passwordHash: pw, role, status: USER_STATUS.ACTIVE } });
    await mk(orgAId, emails.a1, 'Buyer A1', ROLES.MEDIA_BUYER);
    await mk(orgAId, emails.a2, 'Buyer A2', ROLES.MEDIA_BUYER);
    await mk(orgAId, emails.adminA, 'Admin A', ROLES.COMPANY_ADMIN);
    await mk(orgBId, emails.b1, 'Buyer B1', ROLES.MEDIA_BUYER);
    await mk(orgAId, emails.superU, 'Super', ROLES.SUPER_ADMIN);
  });
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) tokens[k] = await login(emails[k]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await withSystem(async (tx) => {
    await tx.auditLog.deleteMany({ where: { orgId: { in: [orgAId, orgBId] } } });
    await tx.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  });
  await mock.close();
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mock.businesses.clear();
  mock.requests.length = 0;
  mock.failures.length = 0;
  mock.addBusiness({ bizId: BIZ, apiKey: KEY_A1, title: 'Acme Ads' });
  mock.addBusiness({ bizId: BIZ_OTHER, apiKey: 'whop_test_key_other', title: 'Other Co' });
  await withSystem(async (tx) => {
    await tx.whopConnection.deleteMany({ where: { orgId: { in: [orgAId, orgBId] } } });
    await tx.organization.update({ where: { id: orgAId }, data: { whopEnabled: true } });
  });
});

describe('access gate', () => {
  it('reports whether Whop Ads is on for the caller', async () => {
    expect((await inject('GET', `${BASE}/status`, tokens.a1)).json()).toEqual({ enabled: true, allowSandbox: false });
    expect((await inject('GET', `${BASE}/status`, tokens.b1)).json()).toEqual({ enabled: false, allowSandbox: false });
    expect((await inject('GET', `${BASE}/status`, tokens.superU)).json()).toEqual({ enabled: true, allowSandbox: true });
    expect((await app.inject({ method: 'GET', url: `${BASE}/status` })).statusCode).toBe(401);
  });

  it('answers 404 to every Whop route when the company switch is off', async () => {
    expect((await inject('GET', `${BASE}/connections`, tokens.b1)).statusCode).toBe(404);
    expect((await inject('POST', `${BASE}/connections`, tokens.b1, connectPayload())).statusCode).toBe(404);
    expect(mock.requests).toHaveLength(0); // nothing reached Whop
  });

  it('follows the super-admin switch: off hides it, on shows it', async () => {
    const off = await inject('PATCH', `/api/admin/organizations/${orgAId}/whop`, tokens.superU, { whopEnabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json<{ organization: { whopEnabled: boolean } }>().organization.whopEnabled).toBe(false);
    expect((await inject('GET', `${BASE}/status`, tokens.a1)).json()).toMatchObject({ enabled: false });
    expect((await inject('GET', `${BASE}/connections`, tokens.a1)).statusCode).toBe(404);

    const on = await inject('PATCH', `/api/admin/organizations/${orgAId}/whop`, tokens.superU, { whopEnabled: true });
    expect(on.json<{ organization: { whopEnabled: boolean } }>().organization.whopEnabled).toBe(true);
    expect((await inject('GET', `${BASE}/status`, tokens.a1)).json()).toMatchObject({ enabled: true });

    const audit = await withSystem((tx) => tx.auditLog.findMany({ where: { orgId: orgAId, action: 'org.whop.updated' }, orderBy: { createdAt: 'asc' } }));
    expect(audit.map((a) => (a.details as { whopEnabled: boolean }).whopEnabled)).toEqual([false, true]);

    const list = await inject('GET', '/api/admin/organizations', tokens.superU);
    expect(list.json<{ organizations: { id: string; whopEnabled: boolean }[] }>().organizations.find((o) => o.id === orgAId)?.whopEnabled).toBe(true);
  });

  it('only a super admin can flip the switch', async () => {
    expect((await inject('PATCH', `/api/admin/organizations/${orgAId}/whop`, tokens.adminA, { whopEnabled: false })).statusCode).toBe(403);
    expect((await inject('PATCH', `/api/admin/organizations/${orgAId}/whop`, tokens.a1, { whopEnabled: false })).statusCode).toBe(403);
    expect((await inject('PATCH', `/api/admin/organizations/${orgAId}/whop`, tokens.superU, { whopEnabled: 'yes' })).statusCode).toBe(400);
  });
});

describe('connect', () => {
  it('verifies the key, stores it encrypted, and returns the live checklist without the key', async () => {
    const res = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    expect(res.statusCode).toBe(201);
    const conn = res.json<{ connection: Record<string, unknown> & { id: string; checklist: { canDraft: boolean; canLaunch: boolean; items: { key: string; status: string }[] } } }>().connection;
    expect(conn).toMatchObject({ bizId: BIZ, environment: 'PRODUCTION', label: 'Acme Ads', apiKeyLast4: '3456', status: 'ACTIVE', reportingCurrency: 'usd' });
    expect(conn.checklist).toMatchObject({ canDraft: true, canLaunch: true });
    expect(conn.checklist.items.map((i) => [i.key, i.status])).toContainEqual(['payment', 'ok']);
    expect(conn.pages).toEqual([expect.objectContaining({ id: 'sacc_MockPage1', platform: 'facebook', name: 'Mock Page', error: null })]);

    // The key is nowhere in the response.
    expect(res.body).not.toContain(KEY_A1);
    expect(res.body).not.toContain('apiKeyEnc');

    // Stored encrypted, and round-trips.
    const row = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: conn.id } }));
    expect(row.apiKeyEnc).not.toContain(KEY_A1);
    expect(decryptToken(row.apiKeyEnc)).toBe(KEY_A1);
    expect(row).toMatchObject({ apiKeyLast4: '3456', apiVersionDate: env.WHOP_API_VERSION_DATE });

    // Whop was called with the pinned version and the key, as the user who owns the connection.
    const sent = mock.requests.find((r) => r.path === '/ad_campaigns')!;
    expect(sent.headers.authorization).toBe(`Bearer ${KEY_A1}`);
    expect(sent.headers['api-version-date']).toBe(env.WHOP_API_VERSION_DATE);
    expect(sent.query.account_id).toBe(BIZ);

    // Audited, without the key.
    const audit = await withSystem((tx) => tx.auditLog.findFirstOrThrow({ where: { orgId: orgAId, action: 'whop.connected' } }));
    expect(JSON.stringify(audit.details)).not.toContain(KEY_A1);
    expect(audit.details).toMatchObject({ bizId: BIZ, environment: 'PRODUCTION', canLaunch: true });
  });

  it('refuses a key Whop rejects, with its reason, and stores nothing', async () => {
    const res = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ apiKey: 'not-a-real-key-123' }));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; details: { checklist: { canDraft: boolean } } }>()).toMatchObject({ error: expect.stringContaining('rejected'), details: { checklist: { canDraft: false } } });
    expect(await withSystem((tx) => tx.whopConnection.count({ where: { orgId: orgAId } }))).toBe(0);
  });

  it("refuses a key that belongs to a different business", async () => {
    const res = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ apiKey: 'whop_test_key_other' }));
    expect(res.statusCode).toBe(400);
    expect(await withSystem((tx) => tx.whopConnection.count({ where: { orgId: orgAId } }))).toBe(0);
  });

  it('validates the business id and key shape before calling Whop', async () => {
    expect((await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ bizId: 'acme' }))).statusCode).toBe(400);
    expect((await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ apiKey: 'short' }))).statusCode).toBe(400);
    expect(mock.requests).toHaveLength(0);
  });

  it('says Whop is unreachable instead of blaming the key', async () => {
    mock.failures.push(...Array.from({ length: 6 }, () => ({ status: 503 })));
    const res = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toContain('Try again in a minute');
    expect(await withSystem((tx) => tx.whopConnection.count({ where: { orgId: orgAId } }))).toBe(0);
  }, 20_000);

  it('reconnecting the same business replaces the key and keeps one row', async () => {
    const first = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    const id = first.json<{ connection: { id: string } }>().connection.id;
    mock.businesses.get(BIZ)!.apiKey = KEY_A1_NEW;
    const second = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ apiKey: KEY_A1_NEW }));
    expect(second.json<{ connection: { id: string; apiKeyLast4: string } }>().connection).toMatchObject({ id, apiKeyLast4: '9999' });
    expect(await withSystem((tx) => tx.whopConnection.count({ where: { userId: { not: undefined }, orgId: orgAId } }))).toBe(1);
    const row = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id } }));
    expect(decryptToken(row.apiKeyEnc)).toBe(KEY_A1_NEW);
  });

  it('keeps the sandbox for super admins unless WHOP_ALLOW_SANDBOX is on', async () => {
    const buyer = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload({ environment: 'SANDBOX' }));
    expect(buyer.statusCode).toBe(403);
    const sup = await inject('POST', `${BASE}/connections`, tokens.superU, connectPayload({ environment: 'SANDBOX' }));
    expect(sup.statusCode).toBe(201);
    expect(sup.json<{ connection: { environment: string } }>().connection.environment).toBe('SANDBOX');
  });

  it('connects a key with limited permissions as a draft-only connection and names what is missing', async () => {
    mock.addBusiness({ bizId: BIZ, apiKey: KEY_A1, permissions: ['ad_campaign:basic:read'] });
    const res = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    expect(res.statusCode).toBe(201);
    const { checklist } = res.json<{ connection: { checklist: { canDraft: boolean; canLaunch: boolean; items: { key: string; status: string; detail: string }[] } } }>().connection;
    expect(checklist).toMatchObject({ canDraft: true, canLaunch: false });
    const perms = checklist.items.find((i) => i.key === 'permissions')!;
    expect(perms.status).toBe('todo');
    expect(perms.detail).toContain('social_account:read');
  });
});

describe('ownership and isolation', () => {
  it('a user sees only their own connections; a super-admin sees all with owners', async () => {
    const created = await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    const id = created.json<{ connection: { id: string } }>().connection.id;

    expect((await inject('GET', `${BASE}/connections`, tokens.a2)).json<{ connections: unknown[] }>().connections).toHaveLength(0);
    expect((await inject('GET', `${BASE}/connections/${id}`, tokens.a2)).statusCode).toBe(404);
    expect((await inject('POST', `${BASE}/connections/${id}/check`, tokens.a2)).statusCode).toBe(404);
    expect((await inject('DELETE', `${BASE}/connections/${id}`, tokens.a2)).statusCode).toBe(404);
    // A company admin is not an oversight role here: the key belongs to its owner.
    expect((await inject('GET', `${BASE}/connections/${id}`, tokens.adminA)).statusCode).toBe(404);

    const all = await inject('GET', `${BASE}/connections/all`, tokens.superU);
    expect(all.statusCode).toBe(200);
    expect(all.json<{ connections: { id: string; ownerEmail: string; orgName: string }[] }>().connections).toEqual([expect.objectContaining({ id, ownerEmail: emails.a1, orgName: 'Whop A' })]);
    expect((await inject('GET', `${BASE}/connections/all`, tokens.a1)).statusCode).toBe(403);
    expect((await inject('GET', `${BASE}/connections/${id}`, tokens.superU)).statusCode).toBe(200);
  });

  it("row-level security hides one company's connections from another", async () => {
    await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload());
    const seenByB = await withTenant(orgBId, (tx) => tx.whopConnection.count());
    const seenByA = await withTenant(orgAId, (tx) => tx.whopConnection.count());
    expect({ seenByA, seenByB }).toEqual({ seenByA: 1, seenByB: 0 });
    expect(await withTenant(orgBId, (tx) => tx.whopSocialAccount.count())).toBe(0);
  });
});

describe('checking a connection', () => {
  let id = '';
  beforeEach(async () => {
    id = (await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload())).json<{ connection: { id: string } }>().connection.id;
  });

  it('re-reads Whop and saves the new checklist', async () => {
    mock.businesses.get(BIZ)!.agreement = 'pending_signature';
    mock.businesses.get(BIZ)!.payment = null;
    const res = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
    const conn = res.json<{ connection: { status: string; checklist: { canLaunch: boolean; items: { key: string; status: string }[] } } }>().connection;
    expect(conn.status).toBe('ACTIVE');
    expect(conn.checklist.canLaunch).toBe(false);
    expect(conn.checklist.items.filter((i) => i.status === 'todo').map((i) => i.key)).toEqual(['agreement', 'payment']);
    const saved = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id } }));
    expect((saved.checks as { canLaunch: boolean }).canLaunch).toBe(false);
  });

  it('marks the connection BROKEN once when Whop rejects the key, alerts once, and recovers when fixed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const good = mock.businesses.get(BIZ)!;
      mock.businesses.delete(BIZ); // the key is revoked on Whop
      const broken = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
      expect(broken.json<{ connection: { status: string; lastError: string } }>().connection).toMatchObject({ status: 'BROKEN', lastError: expect.stringContaining('rejected') });
      const alerts = () => log.mock.calls.filter((c) => String(c[0]).includes('[notify:whop_connection_broken]')).length;
      expect(alerts()).toBe(1);

      await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1); // still broken: no second alert
      expect(alerts()).toBe(1);

      mock.businesses.set(BIZ, good); // the user re-creates the key
      const fixed = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
      expect(fixed.json<{ connection: { status: string; lastError: string | null } }>().connection).toMatchObject({ status: 'ACTIVE', lastError: null });
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the status when Whop is down (an outage is not a broken key)', async () => {
    mock.failures.push(...Array.from({ length: 6 }, () => ({ status: 503 })));
    const res = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
    const conn = res.json<{ connection: { status: string; checklist: { items: { key: string; status: string }[] } } }>().connection;
    expect(conn.status).toBe('ACTIVE');
    expect(conn.checklist.items[0]).toMatchObject({ key: 'credentials', status: 'unknown' });
  }, 20_000);

  it('disconnect deletes the connection, its pages and its key, and is audited', async () => {
    const res = await inject('DELETE', `${BASE}/connections/${id}`, tokens.a1);
    expect(res.statusCode).toBe(204);
    expect((await inject('GET', `${BASE}/connections/${id}`, tokens.a1)).statusCode).toBe(404);
    expect(await withSystem((tx) => tx.whopSocialAccount.count({ where: { connectionId: id } }))).toBe(0);
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { orgId: orgAId, action: 'whop.disconnected', entityId: id } }));
    expect(audit).not.toBeNull();
  });
});

describe('Facebook pages and pixel', () => {
  let id = '';
  beforeEach(async () => {
    id = (await inject('POST', `${BASE}/connections`, tokens.a1, connectPayload())).json<{ connection: { id: string } }>().connection.id;
  });

  it('lists the pages live and saves them', async () => {
    mock.businesses.get(BIZ)!.pages.push({ id: 'sacc_Second', platform: 'facebook', name: 'Aardvark Page', username: null, external_id: '2', url: null, verified: false, error: null });
    const res = await inject('GET', `${BASE}/connections/${id}/pages`, tokens.a1);
    expect(res.json<{ pages: { id: string }[] }>().pages.map((p) => p.id)).toEqual(['sacc_Second', 'sacc_MockPage1']); // sorted by name
    expect(await withSystem((tx) => tx.whopSocialAccount.count({ where: { connectionId: id } }))).toBe(2);
  });

  it('starts Whop\'s Meta sign-in and only returns to our own dashboard', async () => {
    const ok = await inject('POST', `${BASE}/connections/${id}/pages/meta-connect`, tokens.a1, { redirectUrl: `${env.WEB_DOMAIN}/dashboard/whop?connection=${id}` });
    expect(ok.json()).toEqual({ authorizeUrl: mock.authorizeUrl });
    const call = mock.requests.find((r) => r.path === '/social_accounts/connect')!;
    expect(call.body).toMatchObject({ account_id: BIZ, platform: 'meta_business', scopes: ['advertise'], redirect_url: `${env.WEB_DOMAIN}/dashboard/whop?connection=${id}` });

    const foreign = await inject('POST', `${BASE}/connections/${id}/pages/meta-connect`, tokens.a1, { redirectUrl: 'https://evil.example/steal' });
    expect(foreign.statusCode).toBe(400);
  });

  it('creates a Whop-managed page when there is none, then shows it', async () => {
    mock.businesses.get(BIZ)!.pages.length = 0;
    const before = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
    expect(before.json<{ connection: { checklist: { items: { key: string; status: string }[] } } }>().connection.checklist.items.find((i) => i.key === 'page')?.status).toBe('todo');
    const res = await inject('POST', `${BASE}/connections/${id}/pages/create`, tokens.a1);
    const conn = res.json<{ connection: { pages: { name: string }[]; checklist: { items: { key: string; status: string }[] } } }>().connection;
    expect(conn.pages).toHaveLength(1);
    expect(conn.checklist.items.find((i) => i.key === 'page')?.status).toBe('ok');
    const create = mock.requests.find((r) => r.method === 'POST' && r.path === '/social_accounts')!;
    expect(create.headers['idempotency-key']).toBeTruthy();
  });

  it('refreshes a page that has a Meta-side error', async () => {
    mock.businesses.get(BIZ)!.pages[0]!.error = 'Sharing the page failed.';
    const warned = await inject('POST', `${BASE}/connections/${id}/check`, tokens.a1);
    expect(warned.json<{ connection: { checklist: { items: { key: string; status: string }[] } } }>().connection.checklist.items.find((i) => i.key === 'page')?.status).toBe('warn');
    const res = await inject('POST', `${BASE}/connections/${id}/pages/sacc_MockPage1/refresh`, tokens.a1);
    expect(res.json<{ connection: { checklist: { items: { key: string; status: string }[] } } }>().connection.checklist.items.find((i) => i.key === 'page')?.status).toBe('ok');
    expect((await inject('POST', `${BASE}/connections/${id}/pages/sacc_NotMine/refresh`, tokens.a1)).statusCode).toBe(404);
  });

  it('checks the pixel for the business, or for one URL', async () => {
    mock.businesses.get(BIZ)!.pixelByUrl = { 'https://a.example/a/x': { installed: true, last_seen_days: 2, last_fired_days: { view_content: 2 }, firing_data_ok: true, reachable: true, url: 'https://a.example/a/x' } };
    const res = await inject('POST', `${BASE}/connections/${id}/pixel-check`, tokens.a1, { url: 'https://a.example/a/x' });
    expect(res.json()).toEqual({ pixel: { installed: true, lastSeenDays: 2, lastFiredDays: { view_content: 2 }, nativeTracking: false, reachable: true, url: 'https://a.example/a/x' } });
    expect(mock.requests.filter((r) => r.path === '/events/validate_pixel').at(-1)!.body).toMatchObject({ account_id: BIZ, url: 'https://a.example/a/x' });
    expect((await inject('POST', `${BASE}/connections/${id}/pixel-check`, tokens.a1, { url: 'not a url' })).statusCode).toBe(400);
  });

  it('turns a missing permission into a message that names it (and does not break the connection)', async () => {
    mock.businesses.get(BIZ)!.permissions = ['ad_campaign:basic:read', 'social_account:read'];
    const res = await inject('POST', `${BASE}/connections/${id}/pages/create`, tokens.a1);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('social_account:create');
    expect((await inject('GET', `${BASE}/connections/${id}`, tokens.a1)).json<{ connection: { status: string } }>().connection.status).toBe('ACTIVE');
  });

  it('marks the connection broken when Whop starts rejecting the key during an action', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      mock.businesses.delete(BIZ);
      const res = await inject('POST', `${BASE}/connections/${id}/pixel-check`, tokens.a1, {});
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain('Reconnect');
      expect((await inject('GET', `${BASE}/connections/${id}`, tokens.a1)).json<{ connection: { status: string } }>().connection.status).toBe('BROKEN');
    } finally {
      log.mockRestore();
    }
  });
});
