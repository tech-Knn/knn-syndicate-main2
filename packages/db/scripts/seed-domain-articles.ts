/**
 * Seed AI-generated articles ON a specific domain (host) so the RSOC `/search` "Web results"
 * have real organic results to show — and "number of ads ≤ number of search results" holds
 * with the 5/5 caps. Unlike `gen:demo-articles` (standalone articles, no domain link), this
 * WIRES each article to the host through a content campaign + offer, so `listArticlesForHost`
 * surfaces it. Generates via the real OpenAI pipeline (`generateArticleOpenAI`) — needs
 * OPENAI_API_KEY. Idempotent per (org, query): re-runs skip topics already seeded.
 *
 *   HOST=articles.10linesabout.com COUNT=5 OPENAI_API_KEY=sk-... \
 *     pnpm --filter @knn/db exec tsx scripts/seed-domain-articles.ts
 */
import { randomBytes } from 'node:crypto';
import { generateArticleOpenAI } from '@knn/ai';
import { env } from '@knn/config';
import { withSystem } from '../src/index.js';

const HOST = process.env.HOST ?? 'articles.10linesabout.com';
const COUNT = Math.max(1, Math.min(Number(process.env.COUNT ?? '5'), 10));

// High-commercial-intent topics (distinct from the existing demo articles) — classic RSOC verticals.
const TOPICS: { query: string; keywords: string[] }[] = [
  { query: 'Medicare Advantage plans for seniors in 2026', keywords: ['medicare advantage', 'senior health insurance', 'medicare enrollment'] },
  { query: 'Affordable dental implants: costs and financing options', keywords: ['dental implants cost', 'affordable dental implants', 'tooth replacement'] },
  { query: 'Auto insurance quotes: how to compare and save in 2026', keywords: ['auto insurance quotes', 'cheap car insurance', 'compare car insurance'] },
  { query: 'No-medical-exam life insurance for seniors', keywords: ['final expense insurance', 'burial insurance', 'senior life insurance'] },
  { query: 'Home solar panels: cost, savings, and incentives in 2026', keywords: ['solar panel cost', 'home solar savings', 'solar incentives'] },
  { query: 'Personal loans: best rates and how to qualify', keywords: ['personal loan rates', 'best personal loans', 'debt consolidation'] },
  { query: 'Walk-in tubs: cost, safety features, and installation', keywords: ['walk-in tub cost', 'walk-in bathtub', 'senior bathroom safety'] },
];

function slugify(title: string): string {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'article';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

async function main(): Promise<void> {
  const domain = await withSystem((tx) =>
    tx.domain.findUnique({ where: { host: HOST }, select: { id: true, ownerOrgId: true } }),
  );
  if (!domain) throw new Error(`Domain ${HOST} not found — register it in the Domains UI first`);

  // Use the org that already routes offers to this host (consistent with the existing articles);
  // fall back to the domain's owner org, then the platform org.
  const existingOffer = await withSystem((tx) =>
    tx.offer.findFirst({ where: { domainId: domain.id }, select: { orgId: true } }),
  );
  let orgId = existingOffer?.orgId ?? domain.ownerOrgId ?? null;
  if (!orgId) {
    const platform = await withSystem((tx) =>
      tx.organization.findFirst({ where: { isPlatform: true }, select: { id: true } }),
    );
    orgId = platform?.id ?? null;
  }
  if (!orgId) throw new Error(`Could not resolve an org for ${HOST}`);

  const buyer =
    (await withSystem((tx) => tx.user.findFirst({ where: { orgId, role: 'MEDIA_BUYER' }, select: { id: true } }))) ??
    (await withSystem((tx) => tx.user.findFirst({ where: { orgId }, select: { id: true } })));
  if (!buyer) throw new Error(`No user found in org ${orgId} to own the content campaigns`);

  console.log(`Seeding up to ${COUNT} article(s) on ${HOST} (org ${orgId})`);
  let seeded = 0;
  for (const topic of TOPICS) {
    if (seeded >= COUNT) break;
    // Idempotent: skip a topic already seeded for this org.
    const dupe = await withSystem((tx) =>
      tx.article.findFirst({ where: { orgId: orgId!, query: topic.query }, select: { id: true } }),
    );
    if (dupe) {
      console.log(`SKIP (exists)\t${topic.query}`);
      continue;
    }
    try {
      const generated = await generateArticleOpenAI({ keywords: topic.keywords, query: topic.query });
      const slug = slugify(generated.title);
      await withSystem(async (tx) => {
        const article = await tx.article.create({
          data: {
            orgId: orgId!,
            slug,
            title: generated.title,
            keywords: topic.keywords,
            relatedSearchTerms: generated.relatedSearchTerms,
            query: topic.query,
            rawContent: generated.content,
            compliantContent: generated.content,
            status: 'READY',
            model: env.OPENAI_ARTICLE_MODEL,
          },
        });
        // A content campaign carrying the article + a PAID offer routing it to this host — this
        // is what makes listArticlesForHost (and the /search Web results) surface the article.
        const campaign = await tx.campaign.create({
          data: {
            orgId: orgId!,
            buyerId: buyer.id,
            name: `Content — ${topic.query.slice(0, 48)}`,
            keywords: topic.keywords,
            status: 'DRAFT',
            articleId: article.id,
          },
        });
        await tx.offer.create({
          data: { orgId: orgId!, campaignId: campaign.id, domainId: domain.id, weightPct: 100, kind: 'PAID' },
        });
      });
      seeded += 1;
      console.log(`RESULT\t${slug}\t${generated.title}`);
    } catch (err) {
      console.error(`FAILED\t${topic.query}\t${(err as Error).message}`);
    }
  }
  console.log(`Done — seeded ${seeded} new article(s) on ${HOST}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
