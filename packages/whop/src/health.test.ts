import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { whopApi } from './api.js';
import { WhopClient } from './client.js';
import { runWhopHealthCheck } from './health.js';
import { type MockWhop, startMockWhop } from './testing/mock-whop.js';

let mock: MockWhop;
beforeAll(async () => {
  mock = await startMockWhop();
});
afterAll(() => mock.close());
afterEach(() => {
  mock.businesses.clear();
  mock.failures.length = 0;
});

const check = async (apiKey: string, bizId: string, baseUrl = mock.baseUrl) =>
  runWhopHealthCheck(whopApi(new WhopClient({ apiKey, baseUrl, limiter: false, maxRetries: 0 })), { bizId, environment: 'SANDBOX', now: () => new Date('2026-09-30T10:00:00Z') });
const item = (h: Awaited<ReturnType<typeof check>>, key: string) => h.checklist.items.find((i) => i.key === key)!;

describe('runWhopHealthCheck', () => {
  it('a fully set up business is ready to launch', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', title: 'Acme Ads' });
    const h = await check('k1', 'biz_AAAAAA');
    expect(h.checklist.items.map((i) => [i.key, i.status])).toEqual([
      ['credentials', 'ok'],
      ['permissions', 'ok'],
      ['agreement', 'ok'],
      ['payment', 'ok'],
      ['currency', 'ok'],
      ['page', 'ok'],
      ['pixel', 'ok'],
    ]);
    expect(h.checklist).toMatchObject({ canDraft: true, canLaunch: true, checkedAt: '2026-09-30T10:00:00.000Z' });
    expect(h.keyStatus).toBe('ok');
    expect(item(h, 'credentials').detail).toContain('Acme Ads');
    expect(item(h, 'payment').detail).toBe('Pays with Visa ending 4242.');
    expect(item(h, 'page').detail).toContain('Mock Page');
    expect(h.accountTitle).toBe('Acme Ads');
    expect(h.pages).toHaveLength(1);
  });

  it('reports a rejected key and stops there', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1' });
    const h = await check('wrong-key', 'biz_AAAAAA');
    expect(h.checklist.items).toHaveLength(1);
    expect(h.checklist.items[0]).toMatchObject({ key: 'credentials', status: 'error', detail: expect.stringContaining('rejected') });
    expect(h.checklist).toMatchObject({ canDraft: false, canLaunch: false });
    expect(h.keyStatus).toBe('rejected');
  });

  it('flags a key that belongs to a different business', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', title: 'Acme' });
    mock.addBusiness({ bizId: 'biz_BBBBBB', apiKey: 'k2', title: 'Other Co' });
    const h = await check('k2', 'biz_AAAAAA'); // k2's own business is B, asking about A → refused
    expect(item(h, 'credentials')).toMatchObject({ status: 'error' });
    expect(h.checklist.canDraft).toBe(false);
    expect(h.keyStatus).toBe('no_access');
  });

  it('catches an ID mismatch via /accounts/me when the key may read it', async () => {
    // The mock scopes by account_id, so emulate a key that can read the asked-for account but whose own account differs.
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', title: 'Acme' });
    const client = new WhopClient({ apiKey: 'k1', baseUrl: mock.baseUrl, limiter: false, maxRetries: 0 });
    const api = whopApi(client);
    const h = await runWhopHealthCheck({ ...api, accountMe: async () => ({ id: 'biz_ZZZZZZ', title: 'Zed Inc' }) }, { bizId: 'biz_AAAAAA', environment: 'PRODUCTION' });
    expect(item(h, 'credentials').detail).toContain('biz_ZZZZZZ');
    expect(item(h, 'credentials').detail).toContain('Zed Inc');
    expect(h.checklist.canDraft).toBe(false);
    expect(h.keyStatus).toBe('wrong_business');
  });

  it('names exactly the permissions a limited key is missing', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', permissions: ['ad_campaign:basic:read'] });
    const h = await check('k1', 'biz_AAAAAA');
    expect(item(h, 'credentials').status).toBe('ok'); // can read campaigns
    expect(item(h, 'permissions')).toMatchObject({ status: 'todo', detail: expect.stringContaining('social_account:read') });
    expect(item(h, 'permissions').detail).toContain('ad_campaign:create');
    expect(item(h, 'permissions').detail).toContain('company:basic:read');
    expect(item(h, 'agreement').status).toBe('unknown');
    expect(item(h, 'page').status).toBe('unknown');
    expect(h.checklist).toMatchObject({ canDraft: true, canLaunch: false });
  });

  it('asks the owner to sign the agreement and add a payment method', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', agreement: 'pending_signature', payment: null });
    const h = await check('k1', 'biz_AAAAAA');
    expect(item(h, 'agreement')).toMatchObject({ status: 'todo' });
    expect(item(h, 'agreement').actions?.[0]).toMatchObject({ kind: 'open_whop', url: 'https://sandbox.whop.com/dashboard/biz_AAAAAA' });
    expect(item(h, 'payment')).toMatchObject({ status: 'todo', detail: expect.stringContaining('Launching needs it') });
    expect(h.checklist).toMatchObject({ canDraft: true, canLaunch: false });
  });

  it('offers to connect Meta or create a page when there is none', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', pages: [] });
    const page = item(await check('k1', 'biz_AAAAAA'), 'page');
    expect(page.status).toBe('todo');
    expect(page.actions?.map((a) => a.kind)).toEqual(['connect_meta', 'create_page']);
  });

  it('warns when the page has a Meta-side problem and offers a refresh', async () => {
    mock.addBusiness({
      bizId: 'biz_AAAAAA',
      apiKey: 'k1',
      pages: [{ id: 'sacc_P1', platform: 'facebook', name: 'My Page', username: null, external_id: '1', url: null, verified: true, error: 'Page share to the ad account failed.' }],
    });
    const page = item(await check('k1', 'biz_AAAAAA'), 'page');
    expect(page).toMatchObject({ status: 'warn', detail: expect.stringContaining('share to the ad account failed') });
    expect(page.actions?.map((a) => a.kind)).toEqual(['refresh_page', 'connect_meta']);
  });

  it('treats an unseen pixel as a launch blocker, not a draft blocker', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', pixel: { installed: false, last_seen_days: null, last_fired_days: {}, firing_data_ok: true } });
    const h = await check('k1', 'biz_AAAAAA');
    expect(item(h, 'pixel')).toMatchObject({ status: 'todo' });
    expect(h.checklist).toMatchObject({ canDraft: true, canLaunch: false });
  });

  it('describes how recently the pixel fired', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', pixel: { installed: true, last_seen_days: 3, last_fired_days: {}, firing_data_ok: true } });
    expect(item(await check('k1', 'biz_AAAAAA'), 'pixel').detail).toBe('Last seen 3 days ago.');
  });

  it('warns about a non-USD reporting currency without blocking', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', currency: 'eur' });
    const h = await check('k1', 'biz_AAAAAA');
    expect(item(h, 'currency')).toMatchObject({ status: 'warn', detail: expect.stringContaining('EUR') });
    expect(h.checklist.canLaunch).toBe(true);
    expect(h.reportingCurrency).toBe('eur');
  });

  it('shows a balance payment method by name', async () => {
    mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k1', payment: { primary: { type: 'platform_balance', id: 'ldgr_1', title: 'Acme Ads' }, backup: null } });
    expect(item(await check('k1', 'biz_AAAAAA'), 'payment').detail).toBe('Pays with Whop balance (Acme Ads).');
  });

  it('says Whop is unreachable instead of blaming the user', async () => {
    const h = await check('k1', 'biz_AAAAAA', 'http://127.0.0.1:1/api/v1');
    expect(item(h, 'credentials')).toMatchObject({ status: 'unknown', detail: expect.stringContaining('did not answer') });
    expect(h.checklist.canDraft).toBe(false);
    expect(h.keyStatus).toBe('unreachable');
  });
});
