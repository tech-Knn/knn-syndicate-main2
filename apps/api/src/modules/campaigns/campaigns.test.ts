import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

const suffix = Date.now().toString(36);
const slug = `camp-co-${suffix}`;
const buyerEmail = `camp-buyer-${suffix}@a.com`;
const buyerBEmail = `camp-buyer-b-${suffix}@a.com`;
const PW = 'buyer-pw-123';

let app: FastifyInstance;
let orgId = '';
let adAccountId = '';
let pageId = '';
let pixelId = '';

async function bearer(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return res.json<{ accessToken: string }>().accessToken;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Camp Co', slug } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: {
        orgId,
        email: buyerEmail,
        name: 'Camp Buyer',
        passwordHash: await hashPassword(PW),
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.ACTIVE,
      },
    });
    await tx.user.create({
      data: {
        orgId,
        email: buyerBEmail,
        name: 'Camp Buyer B',
        passwordHash: await hashPassword(PW),
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.ACTIVE,
      },
    });
    // FB assets the buyer "owns" (their connection's), so campaigns can reference them.
    const conn = await tx.fbConnection.create({
      data: {
        orgId,
        userId: buyer.id,
        fbUserId: 'fb-1',
        accessTokenEnc: 'enc',
        tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
      },
    });
    const acc = await tx.fbAdAccount.create({
      data: { orgId, connectionId: conn.id, fbAccountId: 'act_1', name: 'Main', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' },
    });
    adAccountId = acc.id;
    const page = await tx.fbPage.create({ data: { orgId, connectionId: conn.id, fbPageId: 'pg_1', name: 'Page' } });
    pageId = page.id;
    const pixel = await tx.fbPixel.create({ data: { orgId, adAccountId: acc.id, fbPixelId: 'px_1', name: 'Pixel' } });
    pixelId = pixel.id;
  });
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

/** A tiny PNG (signature only) — storeUpload validates mime + size, not pixels. */
function pngMultipart(): { body: Buffer; contentType: string } {
  const boundary = '----knncampaigntest';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="creative.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('campaigns + uploads', () => {
  let token = '';
  let draftId = '';
  let uploadId = '';

  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(res.statusCode).toBe(401);
  });

  it('uploads a creative (validated multipart)', async () => {
    token = await bearer(buyerEmail);
    const { body, contentType } = pngMultipart();
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...authHeaders(token), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const upload = res.json<{ upload: { id: string; kind: string } }>().upload;
    expect(upload.kind).toBe('IMAGE');
    uploadId = upload.id;
  });

  it('rejects an unsupported upload type', async () => {
    const boundary = '----knnbad';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
  });

  it('creates a draft campaign', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authHeaders(token),
      payload: { name: 'Summer Offer' },
    });
    expect(res.statusCode).toBe(201);
    const campaign = res.json<{ campaign: { id: string; status: string; objective: string } }>().campaign;
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.objective).toBe('OUTCOME_SALES');
    draftId = campaign.id;
  });

  it('lists the buyer\'s campaigns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns', headers: authHeaders(token) });
    const ids = res.json<{ campaigns: { id: string }[] }>().campaigns.map((c) => c.id);
    expect(ids).toContain(draftId);
  });

  it('rejects an ad account the buyer does not own', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${draftId}`,
      headers: authHeaders(token),
      payload: { name: 'Summer Offer', adAccountId: '99999999-9999-9999-9999-999999999999' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks submitting an incomplete campaign (422 + issues)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/submit`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: string; details: string[] }>();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('updates the draft into a complete, submittable campaign', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${draftId}`,
      headers: authHeaders(token),
      payload: {
        name: 'Summer Offer',
        keywords: ['health insurance', 'medicare'],
        racValue: 'health insurance',
        adAccountId,
        pageId,
        adSets: [
          {
            name: 'US - 25-54',
            dailyBudgetCents: 5000,
            countries: ['US'],
            ageMin: 25,
            ageMax: 54,
            pixelId,
            ads: [
              { name: 'Ad A', headline: 'Save on Health', primaryText: 'Compare plans now.', uploadId },
              { name: 'Ad B', headline: 'Best Rates 2026', primaryText: 'See your options.', uploadId },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const campaign = res.json<{ campaign: { adSets: { ads: { redirectId: string }[] }[] } }>().campaign;
    expect(campaign.adSets).toHaveLength(1);
    expect(campaign.adSets[0]?.ads).toHaveLength(2);
    // Each ad got a unique redirect id (D9).
    const redirectIds = campaign.adSets[0]?.ads.map((a) => a.redirectId) ?? [];
    expect(new Set(redirectIds).size).toBe(2);
  });

  it('submits the completed campaign (DRAFT -> PENDING_APPROVAL)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/submit`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ campaign: { status: string } }>().campaign.status).toBe('PENDING_APPROVAL');
  });

  it('refuses to edit a non-draft campaign', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${draftId}`,
      headers: authHeaders(token),
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('hides one buyer\'s campaign from another buyer in the same org', async () => {
    const tokenB = await bearer(buyerBEmail);
    const res = await app.inject({ method: 'GET', url: `/api/campaigns/${draftId}`, headers: authHeaders(tokenB) });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/campaigns', headers: authHeaders(tokenB) });
    expect(list.json<{ campaigns: { id: string }[] }>().campaigns).toHaveLength(0);
  });
});
