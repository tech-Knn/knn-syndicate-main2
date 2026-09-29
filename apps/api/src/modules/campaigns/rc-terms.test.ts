import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS, currentBusinessDay, rcBlockedMessage } from '@knn/shared';
import { buildApp } from '../../app.js';
import { hashPassword } from '../../lib/password.js';
import type { RedirectConfigPayload } from '../../lib/kv-sync.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { submitCampaign } from './campaigns.service.js';
import { updateGoogleSignals } from './google-signals.service.js';
import { learnRcTerms, listBlockedRcTerms } from './rc-terms.service.js';

/**
 * D28 — rc words that make Google hide the keyword block: the seeded list, who can read/manage it,
 * enforcement on a NEW rc (Sent to Google panel + submit), and the learning run on real tables.
 * The table is global, so every term this suite creates is a unique synthetic word, deleted after.
 */

const suffix = Date.now().toString(36);
const PW = 'rc-pw-123';
const buyerEmail = `rc-b-${suffix}@a.com`;
const superEmail = `rc-s-${suffix}@a.com`;
const W = `zqx${suffix}`; // synthetic trigger word for the learner
const MANUAL = `zqm${suffix.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!)}x`; // letters only (plural folding applies)

let app: FastifyInstance;
let orgId = '';
let buyerId = '';
let liveId = '';
let adId = '';
const learningCampaignIds: string[] = [];

const buyer = (): AuthContext => ({ userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });
type Entries = { redirectId: string; config: RedirectConfigPayload }[];
const noEdge = () => ({ writeRedirectConfigs: vi.fn(async (_e: Entries): Promise<void> => undefined) });

async function login(email: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return { authorization: `Bearer ${res.json<{ accessToken: string }>().accessToken}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'RC Co', slug: `rc-${suffix}` } })).id;
    const passwordHash = await hashPassword(PW);
    buyerId = (await tx.user.create({ data: { orgId, email: buyerEmail, name: 'B', passwordHash, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    await tx.user.create({ data: { orgId, email: superEmail, name: 'S', passwordHash, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } });
    // A launched campaign whose EXISTING rc already contains a blocked word (predates the list).
    const live = await tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: 'RC live',
        status: 'PAUSED',
        keywords: [],
        racValue: 'Hospital jobs near you',
        adSets: { create: [{ orgId, name: 's', ads: { create: [{ orgId, name: 'A', headline: 'h', primaryText: 'p', redirectId: `rc-a-${suffix}` }] } }] },
      },
      include: { adSets: { include: { ads: true } } },
    });
    liveId = live.id;
    adId = live.adSets[0]!.ads[0]!.id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    // Every synthetic term this suite can create starts with "zq" (also catches a failed run's leftovers).
    await tx.rcBlockedTerm.deleteMany({ where: { term: { startsWith: 'zq' } } });
    await tx.adStatsDaily.deleteMany({ where: { orgId } });
    await tx.campaignRevenueDaily.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.user.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('the block list (D28)', () => {
  it('ships with the words verified on live pages', async () => {
    const terms = await listBlockedRcTerms();
    expect(terms).toEqual(
      expect.arrayContaining([
        'job', 'career', 'hiring', 'vacancy', 'free', 'work from home',
        'opportunity', 'recruitment', 'employment', 'opening', 'salary', 'staff required',
      ]),
    );
  });

  it('any signed-in user can read it; anonymous cannot', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/campaigns/rc-blocked-terms', headers: await login(buyerEmail) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ terms: string[] }>().terms).toContain('free');
    expect((await app.inject({ method: 'GET', url: '/api/campaigns/rc-blocked-terms' })).statusCode).toBe(401);
  });

  it('only super-admins manage it: add (normalized) → duplicate 409 → allow → block again', async () => {
    const buyerHeaders = await login(buyerEmail);
    expect((await app.inject({ method: 'GET', url: '/api/admin/rc-terms', headers: buyerHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/rc-terms', headers: buyerHeaders, payload: { term: MANUAL } })).statusCode).toBe(403);

    const s = await login(superEmail);
    const add = await app.inject({ method: 'POST', url: '/api/admin/rc-terms', headers: s, payload: { term: `  ${MANUAL.toUpperCase()}S `, note: 'test' } });
    expect(add.statusCode).toBe(201);
    const row = add.json<{ term: { id: string; term: string; source: string; status: string } }>().term;
    expect(row).toMatchObject({ term: MANUAL, source: 'MANUAL', status: 'BLOCKED' });
    expect(await listBlockedRcTerms()).toContain(MANUAL);

    expect((await app.inject({ method: 'POST', url: '/api/admin/rc-terms', headers: s, payload: { term: MANUAL } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/admin/rc-terms', headers: s, payload: { term: '  ' } })).statusCode).toBe(400);

    const allow = await app.inject({ method: 'PATCH', url: `/api/admin/rc-terms/${row.id}`, headers: s, payload: { status: 'ALLOWED' } });
    expect(allow.json<{ term: { status: string } }>().term.status).toBe('ALLOWED');
    expect(await listBlockedRcTerms()).not.toContain(MANUAL);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/rc-terms/${row.id}`, headers: s, payload: { status: 'MAYBE' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/rc-terms/${randomUUID()}`, headers: s, payload: { status: 'BLOCKED' } })).statusCode).toBe(404);
    // Re-adding an ALLOWED term blocks it again.
    const again = await app.inject({ method: 'POST', url: '/api/admin/rc-terms', headers: s, payload: { term: MANUAL } });
    expect(again.json<{ term: { status: string } }>().term.status).toBe('BLOCKED');

    const list = await app.inject({ method: 'GET', url: '/api/admin/rc-terms', headers: s });
    expect(list.json<{ terms: { term: string; note: string | null }[] }>().terms.find((t) => t.term === 'free')?.note).toContain('Live test');
  });
});

describe('enforcement on a NEW rc (D28)', () => {
  it('the Sent to Google panel rejects a new campaign-default or per-ad rc with a blocked word', async () => {
    const err = await updateGoogleSignals(buyer(), liveId, { racValue: 'Hospital Jobs in Delhi' }, noEdge()).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, details: { blockedWords: ['job'] } });
    expect((err as Error).message).toBe(rcBlockedMessage(['job']));

    await expect(updateGoogleSignals(buyer(), liveId, { ads: [{ adId, racValue: 'Free training for nurses' }] }, noEdge())).rejects.toMatchObject({
      statusCode: 400,
      details: { blockedWords: ['free'] },
    });
    const row = await withSystem((tx) => tx.campaign.findUnique({ where: { id: liveId }, select: { racValue: true } }));
    expect(row?.racValue).toBe('Hospital jobs near you'); // nothing saved
  });

  it('an EXISTING rc is left alone: other edits still save, and clean new text is accepted', async () => {
    const v = await updateGoogleSignals(buyer(), liveId, { terms: ['nursing course fees'] }, noEdge());
    expect(v.customTerms).toEqual(['nursing course fees']);
    const v2 = await updateGoogleSignals(buyer(), liveId, { racValue: 'Hospital jobs near you', ads: [{ adId, racValue: 'Nursing course fees in India' }] }, noEdge());
    expect(v2.ads[0]!.effectiveRac).toBe('Nursing course fees in India'); // re-sending the unchanged default is fine
  });

  it('submit lists the blocked-word issue for a draft whose rc uses one', async () => {
    const draft = await withSystem((tx) =>
      tx.campaign.create({ data: { orgId, buyerId, name: 'RC draft', status: 'DRAFT', keywords: ['x'], racValue: 'Free flat on rent' } }),
    );
    const err = await submitCampaign(buyer(), draft.id).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect((err as { details: string[] }).details).toContain(rcBlockedMessage(['free']));

    await withSystem((tx) => tx.campaign.update({ where: { id: draft.id }, data: { racValue: 'Flat on rent' } }));
    const clean = await submitCampaign(buyer(), draft.id).catch((e: unknown) => e);
    expect((clean as { details: string[] }).details.some((d) => d.includes('keyword block'))).toBe(false);
  });
});

describe('learning run on real tables (D28)', () => {
  beforeAll(async () => {
    const day = currentBusinessDay();
    const make = async (rc: string, visits: number, keywordClicks: number): Promise<void> => {
      await withSystem(async (tx) => {
        const c = await tx.campaign.create({
          data: {
            orgId,
            buyerId,
            name: `L ${rc}`,
            status: 'ACTIVE',
            keywords: [],
            racValue: rc,
            adSets: { create: [{ orgId, name: 's', ads: { create: [{ orgId, name: 'a', headline: 'h', primaryText: 'p', redirectId: `rc-l-${randomUUID()}` }] } }] },
          },
          include: { adSets: { include: { ads: true } } },
        });
        learningCampaignIds.push(c.id);
        await tx.adStatsDaily.create({ data: { orgId, adId: c.adSets[0]!.ads[0]!.id, campaignId: c.id, day, clicks: visits } });
        await tx.campaignRevenueDaily.create({ data: { orgId, campaignId: c.id, channelRef: randomUUID(), day, afsRequests: keywordClicks } });
      });
    };
    for (const [rc, v, k] of [
      ['Flat on rent', 400, 200],
      ['Used cars under budget', 500, 250],
      ['Automatic gas stove price', 300, 150],
      ['Laptop deals for students', 300, 140],
      ['Personal loan interest rates', 600, 300],
      [`Carpenter ${W}`, 300, 1],
      [`Hospital ${W}`, 250, 0],
      [`Packing ${W}`, 200, 2],
    ] as const) {
      await make(rc, v, k);
    }
  });

  it('adds the shared trigger word as LEARNED + BLOCKED with its evidence — once', async () => {
    const run = await learnRcTerms({ campaignIds: learningCampaignIds });
    expect(run.eligibleCampaigns).toBe(8);
    expect(run.added.map((a) => a.term)).toEqual([W]);
    const row = await withSystem((tx) => tx.rcBlockedTerm.findUnique({ where: { term: W } }));
    expect(row).toMatchObject({ source: 'LEARNED', status: 'BLOCKED', suppressedCampaigns: 3, campaignsUsing: 3 });
    expect(row?.note).toContain('3 of 3 campaigns');
    expect(await listBlockedRcTerms()).toContain(W);

    const again = await learnRcTerms({ campaignIds: learningCampaignIds });
    expect(again.added).toEqual([]); // already known
  });

  it('an ALLOWED word is never re-learned, and learned words are enforced like seeds', async () => {
    await expect(updateGoogleSignals(buyer(), liveId, { racValue: `Carpenter ${W} guide` }, noEdge())).rejects.toMatchObject({ statusCode: 400 });
    await withSystem((tx) => tx.rcBlockedTerm.update({ where: { term: W }, data: { status: 'ALLOWED' } }));
    expect((await learnRcTerms({ campaignIds: learningCampaignIds })).added).toEqual([]);
    const v = await updateGoogleSignals(buyer(), liveId, { racValue: `Carpenter ${W} guide` }, noEdge());
    expect(v.racValue).toBe(`Carpenter ${W} guide`);
  });
});
