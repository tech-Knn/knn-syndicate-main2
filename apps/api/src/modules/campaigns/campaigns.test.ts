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
let afsId = '';
let domainId = '';

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
    // A LIVE domain + AFS account so a campaign can carry a PAID offer (required to submit).
    afsId = (await tx.googleConnection.create({ data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${slug}`, adsenseAdClient: `adc-${slug}`, afsPubId: `pp-${slug}`, label: 'AFS', status: 'ACTIVE' } })).id;
    domainId = (await tx.domain.create({ data: { host: `camp-${slug}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `v-${slug}` } })).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.launcherPreset.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
  });
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
    // A campaign needs ≥1 PAID offer (a website to route to) to be submittable.
    await withSystem((tx) => tx.offer.create({ data: { orgId, campaignId: draftId, domainId, weightPct: 100, kind: 'PAID' } }));
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

  it('clones a campaign into a fresh draft — new redirect ids, copied offers', async () => {
    // Source = the submitted campaign; capture its ad redirect ids to prove the clone's differ.
    const src = (
      await (await app.inject({ method: 'GET', url: `/api/campaigns/${draftId}`, headers: authHeaders(token) })).json<{
        campaign: { adSets: { ads: { redirectId: string }[] }[] };
      }>()
    ).campaign;
    const srcRedirects = new Set(src.adSets.flatMap((s) => s.ads.map((a) => a.redirectId)));

    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${draftId}/clone`, headers: authHeaders(token) });
    expect(res.statusCode).toBe(201);
    const clone = res.json<{ campaign: { id: string; name: string; status: string; adSets: { ads: { redirectId: string }[] }[] } }>().campaign;
    expect(clone.status).toBe('DRAFT'); // a fresh editable draft, no FB/channel state
    expect(clone.name).toBe('Summer Offer (copy)');
    expect(clone.adSets).toHaveLength(1);
    expect(clone.adSets[0]?.ads).toHaveLength(2);
    // Each ad got a BRAND-NEW redirect id — none reused from the source (D9: ids are per-ad).
    const cloneRedirects = clone.adSets[0]!.ads.map((a) => a.redirectId);
    expect(new Set(cloneRedirects).size).toBe(2);
    expect(cloneRedirects.every((id) => !srcRedirects.has(id))).toBe(true);
    // Offers were copied (1 PAID offer on the same domain).
    const cloneOffers = await withSystem((tx) => tx.offer.findMany({ where: { campaignId: clone.id } }));
    expect(cloneOffers).toHaveLength(1);
    expect(cloneOffers[0]?.kind).toBe('PAID');
    expect(cloneOffers[0]?.domainId).toBe(domainId);
  });

  it('clone drops an ad account / pixel whose Facebook connection is broken (#2 — independence)', async () => {
    const t = await bearer(buyerEmail);
    // A source campaign bound to assets of a BROKEN connection (e.g. the token expired after launch).
    const campaignId = await withSystem(async (tx) => {
      const buyer = await tx.user.findFirstOrThrow({ where: { email: buyerEmail } });
      const broken = await tx.fbConnection.create({
        data: {
          orgId,
          userId: buyer.id,
          fbUserId: 'fb-broken',
          accessTokenEnc: 'enc',
          tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
          status: 'CONNECTION_BROKEN',
        },
      });
      const brokenAcc = await tx.fbAdAccount.create({
        data: { orgId, connectionId: broken.id, fbAccountId: 'act_broken', name: 'Broken', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' },
      });
      const brokenPixel = await tx.fbPixel.create({ data: { orgId, adAccountId: brokenAcc.id, fbPixelId: 'px_broken', name: 'BrokenPixel' } });
      const camp = await tx.campaign.create({
        data: {
          orgId,
          buyerId: buyer.id,
          name: 'Broken-conn source',
          status: 'DRAFT',
          keywords: [],
          adAccountId: brokenAcc.id,
          adSets: {
            create: [
              {
                orgId,
                name: 'set',
                pixelId: brokenPixel.id,
                ads: { create: [{ orgId, name: 'ad', headline: 'H', primaryText: 'P', redirectId: `rb-${slug}` }] },
              },
            ],
          },
        },
      });
      return camp.id;
    });

    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/clone`, headers: authHeaders(t) });
    expect(res.statusCode).toBe(201);
    const cloneId = res.json<{ campaign: { id: string } }>().campaign.id;

    // The clone is a clean, independent draft: the dead account + pixel refs are dropped (the buyer
    // re-selects a live ad account in the wizard), not carried over as broken dependencies.
    const cloned = await withSystem((tx) =>
      tx.campaign.findUnique({ where: { id: cloneId }, select: { adAccountId: true, adSets: { select: { pixelId: true } } } }),
    );
    expect(cloned?.adAccountId).toBeNull();
    expect(cloned?.adSets[0]?.pixelId).toBeNull();
  });

  it("won't clone another buyer's campaign (404)", async () => {
    const tokenB = await bearer(buyerBEmail);
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${draftId}/clone`, headers: authHeaders(tokenB) });
    expect(res.statusCode).toBe(404);
  });

  it('saves a campaign as a preset, applies it to a new draft, lists + deletes it', async () => {
    const saveRes = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/save-preset`,
      headers: authHeaders(token),
      payload: { name: 'Health template' },
    });
    expect(saveRes.statusCode).toBe(201);
    const presetId = saveRes.json<{ preset: { id: string; name: string } }>().preset.id;

    const listRes = await app.inject({ method: 'GET', url: '/api/campaigns/presets', headers: authHeaders(token) });
    expect(listRes.json<{ presets: { id: string }[] }>().presets.map((p) => p.id)).toContain(presetId);

    // Apply → a fresh DRAFT with the same ad-set/ad structure + offers.
    const applyRes = await app.inject({ method: 'POST', url: `/api/campaigns/presets/${presetId}/apply`, headers: authHeaders(token) });
    expect(applyRes.statusCode).toBe(201);
    const created = applyRes.json<{ campaign: { id: string; status: string; adSets: { ads: unknown[] }[] } }>().campaign;
    expect(created.status).toBe('DRAFT');
    expect(created.adSets).toHaveLength(1);
    expect(created.adSets[0]?.ads).toHaveLength(2);
    const createdOffers = await withSystem((tx) => tx.offer.findMany({ where: { campaignId: created.id } }));
    expect(createdOffers).toHaveLength(1);

    const delRes = await app.inject({ method: 'DELETE', url: `/api/campaigns/presets/${presetId}`, headers: authHeaders(token) });
    expect(delRes.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/campaigns/presets', headers: authHeaders(token) });
    expect(after.json<{ presets: { id: string }[] }>().presets.map((p) => p.id)).not.toContain(presetId);
  });

  it("hides one buyer's preset from another buyer (404 on apply)", async () => {
    const saveRes = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/save-preset`,
      headers: authHeaders(token),
      payload: { name: 'Private template' },
    });
    const presetId = saveRes.json<{ preset: { id: string } }>().preset.id;
    const tokenB = await bearer(buyerBEmail);
    const listB = await app.inject({ method: 'GET', url: '/api/campaigns/presets', headers: authHeaders(tokenB) });
    expect(listB.json<{ presets: { id: string }[] }>().presets.map((p) => p.id)).not.toContain(presetId);
    const applyB = await app.inject({ method: 'POST', url: `/api/campaigns/presets/${presetId}/apply`, headers: authHeaders(tokenB) });
    expect(applyB.statusCode).toBe(404);
  });

  it('bulk-clones a campaign into N fresh drafts with distinct names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/bulk-clone`,
      headers: authHeaders(token),
      payload: { count: 3 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ count: number; ids: string[] }>();
    expect(body.count).toBe(3);
    expect(body.ids).toHaveLength(3);
    const drafts = await withSystem((tx) =>
      tx.campaign.findMany({ where: { id: { in: body.ids } }, select: { name: true, status: true } }),
    );
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.status === 'DRAFT')).toBe(true);
    expect(new Set(drafts.map((d) => d.name)).size).toBe(3); // "… (copy 1/2/3)"
  });

  it('clamps the bulk-clone count to at least 1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${draftId}/bulk-clone`,
      headers: authHeaders(token),
      payload: { count: 0 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ count: number }>().count).toBe(1);
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

  it('pausing a campaign whose stored FB token is undecryptable fails cleanly (409, not a raw 500)', async () => {
    // Regression: a rotated TOKEN_ENCRYPTION_KEY / corrupt ciphertext must surface as an
    // actionable "reconnect" 409 — never a raw ERR_CRYPTO_INVALID_AUTH_TAG 500 that leaks
    // internals. The fixture's FbConnection stores a non-decryptable accessTokenEnc ('enc'),
    // so an ACTIVE campaign pointing at it exercises exactly that path.
    const active = await withSystem(async (tx) => {
      const buyer = await tx.user.findUniqueOrThrow({ where: { email: buyerEmail } });
      return tx.campaign.create({
        data: {
          orgId,
          buyerId: buyer.id,
          name: 'Live (bad token)',
          status: 'ACTIVE',
          keywords: ['x'],
          adAccountId,
          pageId,
          fbCampaignId: 'fb_test_active',
        },
        select: { id: true },
      });
    });
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${active.id}/pause`, headers: authHeaders(token) });
    expect(res.statusCode).toBe(409);
    const { error } = res.json<{ error: string }>();
    expect(error).toMatch(/reconnect/i);
    expect(error).not.toMatch(/ERR_CRYPTO|auth(entication)? tag/i);
  });
});
