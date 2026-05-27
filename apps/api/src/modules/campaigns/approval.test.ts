import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

const suffix = Date.now().toString(36);
const PW = 'approval-pw-123';
const slugA = `appr-a-${suffix}`;
const slugB = `appr-b-${suffix}`;
const adminAEmail = `appr-admin-a-${suffix}@a.com`;
const buyerAEmail = `appr-buyer-a-${suffix}@a.com`;
const adminBEmail = `appr-admin-b-${suffix}@a.com`;
const superEmail = `appr-super-${suffix}@a.com`;

let app: FastifyInstance;
let orgAId = '';
let orgBId = '';
let adAccountId = '';
let pageId = '';
let pixelId = '';
let uploadId = '';

async function bearer(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return res.json<{ accessToken: string }>().accessToken;
}
function h(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Create a complete, submittable draft as the buyer; return its id. */
async function buildSubmittable(token: string, name: string): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/campaigns', headers: h(token), payload: { name } });
  const id = created.json<{ campaign: { id: string } }>().campaign.id;
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/campaigns/${id}`,
    headers: h(token),
    payload: {
      name,
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
          ads: [{ name: 'Ad A', headline: 'Save on Health', primaryText: 'Compare plans now.', uploadId }],
        },
      ],
    },
  });
  if (res.statusCode !== 200) throw new Error(`build failed: ${res.statusCode} ${res.body}`);
  return id;
}

async function submit(token: string, id: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/submit`, headers: h(token) });
  return res.json<{ campaign: { status: string } }>().campaign.status;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const orgA = await tx.organization.create({ data: { name: 'Appr A', slug: slugA } });
    orgAId = orgA.id;
    const orgB = await tx.organization.create({ data: { name: 'Appr B', slug: slugB } });
    orgBId = orgB.id;
    const pw = await hashPassword(PW);
    await tx.user.create({ data: { orgId: orgAId, email: adminAEmail, name: 'Admin A', passwordHash: pw, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } });
    await tx.user.create({ data: { orgId: orgBId, email: adminBEmail, name: 'Admin B', passwordHash: pw, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } });
    await tx.user.create({ data: { orgId: orgAId, email: superEmail, name: 'Super', passwordHash: pw, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } });
    const buyer = await tx.user.create({ data: { orgId: orgAId, email: buyerAEmail, name: 'Buyer A', passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    const conn = await tx.fbConnection.create({
      data: { orgId: orgAId, userId: buyer.id, fbUserId: 'fb-a', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) },
    });
    const acc = await tx.fbAdAccount.create({ data: { orgId: orgAId, connectionId: conn.id, fbAccountId: 'act_a', name: 'Main', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } });
    adAccountId = acc.id;
    pageId = (await tx.fbPage.create({ data: { orgId: orgAId, connectionId: conn.id, fbPageId: 'pg_a', name: 'Page' } })).id;
    pixelId = (await tx.fbPixel.create({ data: { orgId: orgAId, adAccountId: acc.id, fbPixelId: 'px_a', name: 'Pixel' } })).id;
  });
  // Upload one creative as the buyer (reused by every ad).
  const boundary = '----knnapprtest';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const token = await bearer(buyerAEmail);
  const up = await app.inject({ method: 'POST', url: '/api/uploads', headers: { ...h(token), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  uploadId = up.json<{ upload: { id: string } }>().upload.id;
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.auditLog.deleteMany({ where: { orgId: { in: [orgAId, orgBId] } } });
    await tx.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('campaign approval system', () => {
  const ids = {} as { c1: string; c2: string; c3: string; c4: string };

  it('requires auth for the review queue', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/pending' });
    expect(res.statusCode).toBe(401);
  });

  it('forbids a buyer from the review queue', async () => {
    const token = await bearer(buyerAEmail);
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/pending', headers: h(token) });
    expect(res.statusCode).toBe(403);
  });

  it('submitting (manual mode) lands in PENDING_APPROVAL and shows in the queue', async () => {
    const buyer = await bearer(buyerAEmail);
    ids.c1 = await buildSubmittable(buyer, 'Campaign One');
    expect(await submit(buyer, ids.c1)).toBe('PENDING_APPROVAL');

    const admin = await bearer(adminAEmail);
    const queue = await app.inject({ method: 'GET', url: '/api/campaigns/pending', headers: h(admin) });
    expect(queue.statusCode).toBe(200);
    expect(queue.json<{ campaigns: { id: string }[] }>().campaigns.map((c) => c.id)).toContain(ids.c1);
  });

  it('forbids a buyer from approving', async () => {
    const buyer = await bearer(buyerAEmail);
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c1}/approve`, headers: h(buyer) });
    expect(res.statusCode).toBe(403);
  });

  it('an admin approves a pending campaign (records the reviewer)', async () => {
    const admin = await bearer(adminAEmail);
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c1}/approve`, headers: h(admin) });
    expect(res.statusCode).toBe(200);
    const c = res.json<{ campaign: { status: string; reviewedById: string | null; reviewedAt: string | null } }>().campaign;
    expect(c.status).toBe('APPROVED');
    expect(c.reviewedById).toBeTruthy();
    expect(c.reviewedAt).toBeTruthy();
  });

  it('rejects re-approving a non-pending campaign (illegal transition → 409)', async () => {
    const admin = await bearer(adminAEmail);
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c1}/approve`, headers: h(admin) });
    expect(res.statusCode).toBe(409);
  });

  it('requires a reason to reject (400) then rejects with one', async () => {
    const buyer = await bearer(buyerAEmail);
    ids.c2 = await buildSubmittable(buyer, 'Campaign Two');
    await submit(buyer, ids.c2);

    const admin = await bearer(adminAEmail);
    const noReason = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c2}/reject`, headers: h(admin), payload: {} });
    expect(noReason.statusCode).toBe(400);

    const rejected = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c2}/reject`, headers: h(admin), payload: { reason: 'Landing page off-policy' } });
    expect(rejected.statusCode).toBe(200);
    const c = rejected.json<{ campaign: { status: string; rejectionReason: string } }>().campaign;
    expect(c.status).toBe('REJECTED');
    expect(c.rejectionReason).toBe('Landing page off-policy');
  });

  it('lets the buyer reopen a rejected campaign back to an editable draft', async () => {
    const buyer = await bearer(buyerAEmail);
    const reopened = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c2}/reopen`, headers: h(buyer) });
    expect(reopened.statusCode).toBe(200);
    const c = reopened.json<{ campaign: { status: string; rejectionReason: string | null } }>().campaign;
    expect(c.status).toBe('DRAFT');
    expect(c.rejectionReason).toBeNull();
    // It's editable again now that it's a draft.
    const edit = await app.inject({ method: 'PATCH', url: `/api/campaigns/${ids.c2}`, headers: h(buyer), payload: { name: 'Campaign Two (revised)' } });
    expect(edit.statusCode).toBe(200);
  });

  it("isolates another org's admin from this org's campaigns", async () => {
    const buyer = await bearer(buyerAEmail);
    ids.c3 = await buildSubmittable(buyer, 'Campaign Three');
    await submit(buyer, ids.c3);

    const adminB = await bearer(adminBEmail);
    const queue = await app.inject({ method: 'GET', url: '/api/campaigns/pending', headers: h(adminB) });
    expect(queue.json<{ campaigns: { id: string }[] }>().campaigns.map((c) => c.id)).not.toContain(ids.c3);
    const approve = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c3}/approve`, headers: h(adminB) });
    expect(approve.statusCode).toBe(404);
  });

  it('a super-admin can approve across orgs', async () => {
    const su = await bearer(superEmail);
    const res = await app.inject({ method: 'POST', url: `/api/campaigns/${ids.c3}/approve`, headers: h(su) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ campaign: { status: string } }>().campaign.status).toBe('APPROVED');
  });

  it('a company-admin cannot toggle another org, but can toggle their own', async () => {
    const adminA = await bearer(adminAEmail);
    const cross = await app.inject({ method: 'PATCH', url: `/api/admin/organizations/${orgBId}/auto-approve`, headers: h(adminA), payload: { autoApprove: true } });
    expect(cross.statusCode).toBe(403);

    const own = await app.inject({ method: 'PATCH', url: `/api/admin/organizations/${orgAId}/auto-approve`, headers: h(adminA), payload: { autoApprove: true } });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ organization: { autoApprove: boolean } }>().organization.autoApprove).toBe(true);
  });

  it('a company-admin cannot toggle another org auto-launch, but can toggle their own', async () => {
    const adminA = await bearer(adminAEmail);
    const cross = await app.inject({ method: 'PATCH', url: `/api/admin/organizations/${orgBId}/auto-launch`, headers: h(adminA), payload: { autoLaunch: true } });
    expect(cross.statusCode).toBe(403);

    const own = await app.inject({ method: 'PATCH', url: `/api/admin/organizations/${orgAId}/auto-launch`, headers: h(adminA), payload: { autoLaunch: true } });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ organization: { autoLaunch: boolean } }>().organization.autoLaunch).toBe(true);

    // The settings endpoint reflects both modes.
    const settings = await app.inject({ method: 'GET', url: '/api/admin/organization', headers: h(adminA) });
    expect(settings.json<{ organization: { autoLaunch: boolean } }>().organization.autoLaunch).toBe(true);
  });

  it('auto-approve mode skips review (DRAFT → APPROVED on submit)', async () => {
    const buyer = await bearer(buyerAEmail);
    ids.c4 = await buildSubmittable(buyer, 'Campaign Four');
    expect(await submit(buyer, ids.c4)).toBe('APPROVED');
  });

  it('writes an audit trail for every review action', async () => {
    const logs = await withSystem((tx) =>
      tx.auditLog.findMany({ where: { entityId: { in: [ids.c1, ids.c2, ids.c3, ids.c4, orgAId] } } }),
    );
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('campaign.submitted'); // c1/c2/c3 manual submit
    expect(actions).toContain('campaign.approved'); // c1 (admin) + c3 (super)
    expect(actions).toContain('campaign.rejected'); // c2
    expect(actions).toContain('campaign.auto_approved'); // c4
    expect(actions).toContain('org.auto_approve.enabled'); // toggle
    expect(actions).toContain('org.auto_launch.enabled'); // auto-launch toggle

    // The reject entry carries the reason in its details.
    const reject = logs.find((l) => l.action === 'campaign.rejected');
    expect((reject?.details as { reason?: string } | null)?.reason).toBe('Landing page off-policy');
  });
});
