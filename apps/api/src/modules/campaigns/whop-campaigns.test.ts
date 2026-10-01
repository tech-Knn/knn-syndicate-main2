import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The flag is read once when @knn/config loads, so set it before any import runs.
vi.hoisted(() => {
  process.env.WHOP_ADS_ENABLED = 'true';
});

import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { buildApp } from '../../app.js';
import { hashPassword } from '../../lib/password.js';

const suffix = Date.now().toString(36);
const PW = 'whop-draft-pw-123';
const emails = { buyer: `wc-buyer-${suffix}@a.com`, other: `wc-other-${suffix}@a.com` };
const BIZ = 'biz_DRAFTTEST01';
const BIZ_OTHER = 'biz_DRAFTOTHER2';
const PAGE = 'sacc_DraftPage01';
const PAGE_OTHER = 'sacc_DraftPageB2';

let app: FastifyInstance;
let orgId = '';
let buyerId = '';
let connectionId = '';
let otherConnectionId = '';
let uploadId = '';
let afsId = '';
let domainId = '';
let fbAdAccountId = '';
let fbPageId = '';
let fbPixelId = '';
const tokens = {} as Record<keyof typeof emails, string>;

const h = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: h(token), ...(payload === undefined ? {} : { payload: payload as object }) });

const adSet = (over: Record<string, unknown> = {}) => ({
  name: 'US 35-65',
  dailyBudgetCents: 2500,
  countries: ['US'],
  ageMin: 35,
  ageMax: 65,
  ads: [{ name: 'Ad A', headline: 'Compare SUV deals', primaryText: 'See what you qualify for.', uploadId }],
  ...over,
});
const whopDraft = (over: Record<string, unknown> = {}) => ({
  name: `Whop Draft ${Math.random().toString(36).slice(2, 7)}`,
  adProvider: 'WHOP',
  objective: 'OUTCOME_LEADS',
  keywords: ['senior suv deals'],
  racValue: 'senior suv deals',
  whopConnectionId: connectionId,
  whopPageId: PAGE,
  adSets: [adSet()],
  ...over,
});

interface Created {
  id: string;
  adProvider: string;
  whopConnectionId: string | null;
  whopPageId: string | null;
  whopBizId: string | null;
  adAccountId: string | null;
  pageId: string | null;
  adSets: { pixelId: string | null; ads: { redirectId: string }[] }[];
}
async function create(payload: Record<string, unknown>, token = tokens.buyer): Promise<Created> {
  const res = await call('POST', '/api/campaigns', token, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ campaign: Created }>().campaign;
}
const getRow = (id: string) => withSystem((tx) => tx.campaign.findUniqueOrThrow({ where: { id }, include: { adSets: { include: { ads: true } } } }));

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const pw = await hashPassword(PW);
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'Whop Draft Co', slug: `whop-draft-${suffix}`, whopEnabled: true } })).id;
    const mk = (email: string, name: string) => tx.user.create({ data: { orgId, email, name, passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    buyerId = (await mk(emails.buyer, 'Buyer')).id;
    const other = await mk(emails.other, 'Other');
    const conn = (bizId: string, userId: string) =>
      tx.whopConnection.create({ data: { orgId, userId, bizId, label: bizId, apiKeyEnc: 'enc', apiKeyLast4: '1234', apiVersionDate: env.WHOP_API_VERSION_DATE, status: 'ACTIVE' } });
    connectionId = (await conn(BIZ, buyerId)).id;
    otherConnectionId = (await conn(BIZ_OTHER, other.id)).id;
    await tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: PAGE, platform: 'facebook', name: 'Draft Page' } });
    await tx.whopSocialAccount.create({ data: { orgId, connectionId: otherConnectionId, whopId: PAGE_OTHER, platform: 'facebook', name: 'Other Page' } });
    uploadId = (await tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'c.png', mimeType: 'image/png', sizeBytes: 4, storageKey: `wc-${suffix}.png` } })).id;
    // A LIVE domain + AFS account so a campaign can carry a PAID offer (required to submit).
    afsId = (await tx.googleConnection.create({ data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-wc-${suffix}`, adsenseAdClient: `adc-wc-${suffix}`, afsPubId: `pp-wc-${suffix}`, label: 'AFS', status: 'ACTIVE' } })).id;
    domainId = (await tx.domain.create({ data: { host: `wc-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `wc-${suffix}` } })).id;
    // Facebook assets for the "a Whop draft carries none of these" checks.
    const fbConn = await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: 'fb-wc', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
    fbAdAccountId = (await tx.fbAdAccount.create({ data: { orgId, connectionId: fbConn.id, fbAccountId: 'act_wc', name: 'M', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } })).id;
    fbPageId = (await tx.fbPage.create({ data: { orgId, connectionId: fbConn.id, fbPageId: 'pg_wc', name: 'P' } })).id;
    fbPixelId = (await tx.fbPixel.create({ data: { orgId, adAccountId: fbAdAccountId, fbPixelId: 'px_wc', name: 'X' } })).id;
  });
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emails[k], password: PW } });
    tokens[k] = res.json<{ accessToken: string }>().accessToken;
  }
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('Whop drafts', () => {
  it('creates a Whop draft: the business is frozen on it, and it carries no Facebook asset and no pixel', async () => {
    const c = await create(whopDraft({ adSets: [adSet({ pixelId: fbPixelId })], adAccountId: fbAdAccountId, pageId: fbPageId }));
    expect(c).toMatchObject({ adProvider: 'WHOP', whopConnectionId: connectionId, whopPageId: PAGE, whopBizId: BIZ, adAccountId: null, pageId: null });
    expect(c.adSets[0]!.pixelId).toBeNull(); // Whop owns the pixel
    expect(new Set(c.adSets[0]!.ads.map((a) => a.redirectId)).size).toBe(1); // each ad still gets its own go-link (D9)
  });

  it('a Facebook draft carries no Whop id, even if one is sent', async () => {
    const c = await create({ name: 'FB Draft', adProvider: 'FACEBOOK', adAccountId: fbAdAccountId, pageId: fbPageId, whopConnectionId: connectionId, whopPageId: PAGE, adSets: [adSet({ pixelId: fbPixelId })] });
    expect(c).toMatchObject({ adProvider: 'FACEBOOK', adAccountId: fbAdAccountId, pageId: fbPageId, whopConnectionId: null, whopPageId: null, whopBizId: null });
    expect(c.adSets[0]!.pixelId).toBe(fbPixelId); // and the Facebook path is unchanged
  });

  it('defaults to Facebook: every existing client keeps working untouched', async () => {
    const c = await create({ name: 'Plain' });
    expect(c.adProvider).toBe('FACEBOOK');
  });

  it('refuses another buyer\'s Whop business, a page that is not on the business, and a business that does not exist', async () => {
    expect((await call('POST', '/api/campaigns', tokens.buyer, whopDraft({ whopConnectionId: otherConnectionId, whopPageId: PAGE_OTHER }))).statusCode).toBe(400);
    expect((await call('POST', '/api/campaigns', tokens.buyer, whopDraft({ whopPageId: PAGE_OTHER }))).statusCode).toBe(400);
    expect((await call('POST', '/api/campaigns', tokens.buyer, whopDraft({ whopConnectionId: '00000000-0000-4000-8000-000000000000' }))).statusCode).toBe(400);
    expect((await call('POST', '/api/campaigns', tokens.buyer, whopDraft({ whopPageId: 'not a page' }))).statusCode).toBe(400);
  });

  it('refuses an Instagram account as the page: only a Facebook page can host the ads', async () => {
    const INSTA = 'sacc_DraftInsta01';
    await withSystem((tx) => tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: INSTA, platform: 'instagram', name: 'Draft Insta' } }));
    try {
      const res = await call('POST', '/api/campaigns', tokens.buyer, whopDraft({ whopPageId: INSTA }));
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/not a Facebook page/i);
    } finally {
      await withSystem((tx) => tx.whopSocialAccount.deleteMany({ where: { connectionId, whopId: INSTA } }));
    }
  });

  it('refuses a Whop draft while Whop Ads is off for the company', async () => {
    await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: false } }));
    try {
      const res = await call('POST', '/api/campaigns', tokens.buyer, whopDraft());
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/isn't switched on/);
      // Facebook is not affected by the Whop switch.
      expect((await call('POST', '/api/campaigns', tokens.buyer, { name: 'still fine' })).statusCode).toBe(201);
    } finally {
      await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: true } }));
    }
  });

  it('switching a draft from Whop to Facebook (and back) clears the other provider\'s choices', async () => {
    const c = await create(whopDraft());
    const toFb = await call('PATCH', `/api/campaigns/${c.id}`, tokens.buyer, { name: 'Switched', adProvider: 'FACEBOOK', adAccountId: fbAdAccountId, pageId: fbPageId, whopConnectionId: connectionId, whopPageId: PAGE, adSets: [adSet({ pixelId: fbPixelId })] });
    expect(toFb.statusCode, toFb.body).toBe(200);
    expect(await getRow(c.id)).toMatchObject({ adProvider: 'FACEBOOK', adAccountId: fbAdAccountId, pageId: fbPageId, whopConnectionId: null, whopPageId: null, whopBizId: null });

    const back = await call('PATCH', `/api/campaigns/${c.id}`, tokens.buyer, whopDraft({ name: 'Back', adAccountId: fbAdAccountId, pageId: fbPageId }));
    expect(back.statusCode, back.body).toBe(200);
    const row = await getRow(c.id);
    expect(row).toMatchObject({ adProvider: 'WHOP', adAccountId: null, pageId: null, whopConnectionId: connectionId, whopPageId: PAGE, whopBizId: BIZ });
    expect(row.adSets[0]!.pixelId).toBeNull();
  });
});

describe('submitting a Whop campaign', () => {
  it('lists what is missing in Whop\'s terms, never Facebook\'s', async () => {
    const c = await create({ name: 'Bare Whop', adProvider: 'WHOP', whopConnectionId: connectionId });
    const res = await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer);
    expect(res.statusCode).toBe(422);
    const issues = res.json<{ details: string[] }>().details;
    expect(issues).toContain('Select the Facebook page your Whop ads run under.');
    expect(issues.join(' ')).not.toMatch(/ad account|pixel|\$2/i);
  });

  it('refuses manual placements with none picked, in Whop\'s words (the wizard says the same thing)', async () => {
    const c = await create(whopDraft({ adSets: [adSet({ placementMode: 'manual', placements: [] })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: c.id, domainId, weightPct: 100, kind: 'PAID' } }));
    const res = await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ details: string[] }>().details).toContain('Pick at least one placement.');
    // ...and a Whop-mappable choice is fine.
    const ok = await create(whopDraft({ adSets: [adSet({ placementMode: 'manual', placements: ['facebook_feed', 'instagram_stream'] })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: ok.id, domainId, weightPct: 100, kind: 'PAID' } }));
    expect((await call('POST', `/api/campaigns/${ok.id}/submit`, tokens.buyer)).statusCode).toBe(200);
  });

  it('submits a complete Whop campaign, with no Facebook asset and no $2 floor (Whop\'s own floor is $5.00)', async () => {
    const c = await create(whopDraft({ budgetMode: 'AD_SET', adSets: [adSet({ dailyBudgetCents: 500 })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: c.id, domainId, weightPct: 100, kind: 'PAID' } }));
    const res = await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ campaign: { status: string } }>().campaign.status).toBe('PENDING_APPROVAL');
  });

  it('refuses a Whop budget under $5.00 and a narrowed age on a special ad category, in Whop\'s words (they left campaigns stuck at launch)', async () => {
    const low = await create(whopDraft({ budgetMode: 'AD_SET', adSets: [adSet({ dailyBudgetCents: 300 })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: low.id, domainId, weightPct: 100, kind: 'PAID' } }));
    const r1 = await call('POST', `/api/campaigns/${low.id}/submit`, tokens.buyer);
    expect(r1.statusCode).toBe(422);
    expect(r1.json<{ details: string[] }>().details).toContain("Whop's minimum daily budget is $5.00: raise the budget.");

    const narrowed = await create(whopDraft({ specialAdCategories: ['EMPLOYMENT'], adSets: [adSet({ ageMin: 20, ageMax: 65 })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: narrowed.id, domainId, weightPct: 100, kind: 'PAID' } }));
    const r2 = await call('POST', `/api/campaigns/${narrowed.id}/submit`, tokens.buyer);
    expect(r2.statusCode).toBe(422);
    expect(r2.json<{ details: string[] }>().details).toContain('Whop does not let a special ad category campaign narrow the age range: set 18 to 65.');

    const fine = await create(whopDraft({ specialAdCategories: ['EMPLOYMENT'], adSets: [adSet({ ageMin: 18, ageMax: 65 })] }));
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: fine.id, domainId, weightPct: 100, kind: 'PAID' } }));
    expect((await call('POST', `/api/campaigns/${fine.id}/submit`, tokens.buyer)).statusCode).toBe(200);
  });

  it('does not require the connection\'s launch checklist: a missing payment method is Whop\'s to say at launch', async () => {
    const c = await create(whopDraft());
    await withSystem(async (tx) => {
      await tx.offer.create({ data: { orgId, campaignId: c.id, domainId, weightPct: 100, kind: 'PAID' } });
      await tx.whopConnection.update({ where: { id: connectionId }, data: { checks: { canDraft: true, canLaunch: false, items: [] } } });
    });
    expect((await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer)).statusCode).toBe(200);
    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { checks: undefined } }));
  });

  it('refuses when its Whop connection is broken, gone, or Whop Ads is off', async () => {
    const c = await create(whopDraft());
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: c.id, domainId, weightPct: 100, kind: 'PAID' } }));
    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'BROKEN' } }));
    const broken = await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer);
    expect(broken.statusCode).toBe(422);
    expect(broken.json<{ details: string[] }>().details.join(' ')).toMatch(/needs attention/);
    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE' } }));

    await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: false } }));
    const off = await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer);
    expect(off.statusCode).toBe(422);
    expect(off.json<{ details: string[] }>().details.join(' ')).toMatch(/isn't switched on/);
    await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: true } }));

    expect((await call('POST', `/api/campaigns/${c.id}/submit`, tokens.buyer)).statusCode).toBe(200);
  });
});

describe('cloning a Whop campaign', () => {
  it('keeps the business and the page while they are healthy, with fresh go-links and no Whop objects', async () => {
    const src = await create(whopDraft({ name: 'Clone Me' }));
    await withSystem((tx) => tx.campaign.update({ where: { id: src.id }, data: { whopCampaignId: `adcamp_CloneSrc${suffix}`.slice(0, 30) } }));
    const res = await call('POST', `/api/campaigns/${src.id}/clone`, tokens.buyer);
    expect(res.statusCode, res.body).toBe(201);
    const clone = res.json<{ campaign: Created & { name: string } }>().campaign;
    expect(clone.name).toBe('Clone Me (copy)');
    expect(clone).toMatchObject({ adProvider: 'WHOP', whopConnectionId: connectionId, whopPageId: PAGE, whopBizId: BIZ });
    const row = await getRow(clone.id);
    expect(row.whopCampaignId).toBeNull(); // a clone is a fresh draft: nothing of the source's Whop tree
    expect(row.adSets[0]!.whopAdGroupId).toBeNull();
    expect(row.adSets[0]!.ads[0]!.whopAdId).toBeNull();
    const srcRow = await getRow(src.id);
    expect(row.adSets[0]!.ads[0]!.redirectId).not.toBe(srcRow.adSets[0]!.ads[0]!.redirectId);
  });

  it('drops the page when the business no longer has it, and the business when its connection is broken', async () => {
    const src = await create(whopDraft({ name: 'Clone Drop' }));
    await withSystem((tx) => tx.whopSocialAccount.deleteMany({ where: { connectionId, whopId: PAGE } }));
    const noPage = (await call('POST', `/api/campaigns/${src.id}/clone`, tokens.buyer)).json<{ campaign: Created }>().campaign;
    expect(noPage).toMatchObject({ whopConnectionId: connectionId, whopPageId: null });
    await withSystem((tx) => tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: PAGE, platform: 'facebook', name: 'Draft Page' } }));

    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'BROKEN' } }));
    const broken = (await call('POST', `/api/campaigns/${src.id}/clone`, tokens.buyer)).json<{ campaign: Created }>().campaign;
    expect(broken).toMatchObject({ adProvider: 'WHOP', whopConnectionId: null, whopPageId: null, whopBizId: null });
    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE' } }));
  });
});

describe('the API tells the provider', () => {
  it('returns the provider and Whop fields on every campaign read', async () => {
    const c = await create(whopDraft());
    const one = (await call('GET', `/api/campaigns/${c.id}`, tokens.buyer)).json<{ campaign: Created }>().campaign;
    expect(one).toMatchObject({ adProvider: 'WHOP', whopConnectionId: connectionId, whopPageId: PAGE });
    // The names a reviewer sees (resolved server-side, like a Facebook campaign's ad account and page).
    expect(one).toMatchObject({ whopBusiness: { bizId: BIZ, label: BIZ }, whopPage: { whopId: PAGE, name: 'Draft Page' }, adAccount: null, page: null });
    const list = (await call('GET', '/api/campaigns', tokens.buyer)).json<{ campaigns: Created[] }>().campaigns;
    expect(list.find((x) => x.id === c.id)?.adProvider).toBe('WHOP');
    expect(list.filter((x) => x.adProvider === 'FACEBOOK').length).toBeGreaterThan(0);
  });
});
