import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { listArticlesForHost } from './articles.service.js';

/**
 * `listArticlesForHost` backs the organic "Web results" on the RSOC results page — the
 * host's own READY articles, so the AFS ads supplement REAL results (Google policy). It
 * must be HOST-SCOPED (tenant-safe: never leak another site's titles) and resolve each
 * offer's article (the per-offer variant, else its campaign's default). Real Postgres.
 */
const suffix = Date.now().toString(36);
let orgId = '';
const host = `wr-${suffix}.example.com`;
const otherHost = `wr-other-${suffix}.example.com`;

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'WR Co', slug: `wr-${suffix}` } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: { orgId, email: `wr-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    const afs = await tx.googleConnection.create({
      data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${suffix}`, adsenseAdClient: `adc-${suffix}`, afsPubId: `pub-${suffix}`, label: 'AFS', status: 'ACTIVE' },
    });
    const domain = await tx.domain.create({ data: { host, afsAccountId: afs.id, status: 'LIVE', verifyToken: `v-${suffix}` } });
    const domain2 = await tx.domain.create({ data: { host: otherHost, afsAccountId: afs.id, status: 'LIVE', verifyToken: `v2-${suffix}` } });
    const ch = async (n: number, domainId: string) =>
      (await tx.channel.create({ data: { channelId: `wr-ch${n}-${suffix}`, domainId, status: 'ASSIGNED' } })).id;
    const [c1, c2, c3, c4] = [await ch(1, domain.id), await ch(2, domain.id), await ch(3, domain2.id), await ch(4, domain.id)];

    // A: campaign DEFAULT article on `host`, READY, markdown body (snippet must strip it).
    const artA = await tx.article.create({
      data: { orgId, slug: `wr-a-${suffix}`, title: 'Medicare Advantage Plans 2026', rawContent: 'raw', compliantContent: '## Heading\n\n**Medicare** Advantage plans bundle hospital and medical coverage into a single plan offered by private insurers.' },
    });
    // B: per-OFFER VARIANT article on `host`, READY (campaign has no default).
    const artB = await tx.article.create({ data: { orgId, slug: `wr-b-${suffix}`, title: 'Best Health Insurance Quotes', rawContent: 'raw', compliantContent: 'Compare top health insurance quotes from leading providers.' } });
    // C: only on the OTHER host → must NOT appear for `host`.
    const artC = await tx.article.create({ data: { orgId, slug: `wr-c-${suffix}`, title: 'Auto Insurance Deals', rawContent: 'raw', compliantContent: 'Find auto insurance deals.' } });
    // D: routed to `host` but still GENERATING → excluded (only READY content is a real result).
    const artD = await tx.article.create({ data: { orgId, slug: `wr-d-${suffix}`, title: 'Draft', rawContent: 'raw', compliantContent: 'draft', status: 'GENERATING' } });

    const camp = async (name: string, articleId: string | null) =>
      (await tx.campaign.create({ data: { orgId, buyerId: buyer.id, name: `${name}-${suffix}`, status: 'ACTIVE', keywords: ['x'], articleId } })).id;
    const campA = await camp('A', artA.id);
    const campB = await camp('B', null); // no default; the offer carries the variant
    const campC = await camp('C', artC.id);
    const campD = await camp('D', artD.id);

    await tx.offer.create({ data: { orgId, campaignId: campA, domainId: domain.id, weightPct: 100, kind: 'PAID', channelRef: c1 } });
    await tx.offer.create({ data: { orgId, campaignId: campB, domainId: domain.id, articleId: artB.id, weightPct: 100, kind: 'PAID', channelRef: c2 } });
    await tx.offer.create({ data: { orgId, campaignId: campC, domainId: domain2.id, weightPct: 100, kind: 'PAID', channelRef: c3 } });
    await tx.offer.create({ data: { orgId, campaignId: campD, domainId: domain.id, weightPct: 100, kind: 'PAID', channelRef: c4 } });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } }); // cascades offers
    await tx.article.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `wr-ch` } } });
    await tx.domain.deleteMany({ where: { host: { in: [host, otherHost] } } });
    await tx.googleConnection.deleteMany({ where: { afsPubId: `pub-${suffix}` } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('listArticlesForHost (organic /search web results)', () => {
  it("returns the host's READY articles — campaign default AND per-offer variant", async () => {
    const slugs = (await listArticlesForHost(host, 6)).map((r) => r.slug);
    expect(slugs).toContain(`wr-a-${suffix}`); // campaign's default article
    expect(slugs).toContain(`wr-b-${suffix}`); // per-offer variant article
  });

  it('excludes other hosts (tenant/host isolation) and non-READY articles', async () => {
    const slugs = (await listArticlesForHost(host, 6)).map((r) => r.slug);
    expect(slugs).not.toContain(`wr-c-${suffix}`); // routed only to the OTHER host
    expect(slugs).not.toContain(`wr-d-${suffix}`); // still GENERATING, not a real result
  });

  it('strips markdown to a plain-text snippet', async () => {
    const a = (await listArticlesForHost(host, 6)).find((r) => r.slug === `wr-a-${suffix}`);
    expect(a?.title).toBe('Medicare Advantage Plans 2026');
    expect(a?.snippet).not.toMatch(/[#*`]/);
    expect(a?.snippet).toContain('Medicare Advantage plans bundle');
  });

  it('is host-scoped — the other host returns only its own article', async () => {
    const slugs = (await listArticlesForHost(otherHost, 6)).map((r) => r.slug);
    expect(slugs).toContain(`wr-c-${suffix}`);
    expect(slugs).not.toContain(`wr-a-${suffix}`);
  });

  it('normalizes the host (scheme / port / path stripped) and caps results', async () => {
    // A messy host still resolves (normalization worked → non-empty), and `limit` caps it.
    const results = await listArticlesForHost(`https://${host}:443/anything`, 1);
    expect(results).toHaveLength(1);
    expect([`wr-a-${suffix}`, `wr-b-${suffix}`]).toContain(results[0]?.slug);
  });

  it('returns [] for an unknown host', async () => {
    expect(await listArticlesForHost(`no-such-${suffix}.example.com`, 6)).toEqual([]);
  });
});
