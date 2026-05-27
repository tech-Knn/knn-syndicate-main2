/**
 * Seed one READY demo article (into the platform org) so the article frontend +
 * AFS slot can be exercised before the live article-generation pipeline is wired.
 * Idempotent on slug. Safe to run on staging; not part of the default `db:seed`.
 *
 *   tsx packages/db/scripts/seed-demo-article.ts
 */
import { withSystem } from '../src/index.js';

const SLUG = 'medicare-advantage-2026';
const TITLE = 'Understanding Medicare Advantage Plans in 2026';
const COMPLIANT = [
  'Medicare Advantage plans bundle hospital and medical coverage into a single plan offered by private insurers approved by Medicare, and many add extras such as dental, vision, and prescription drug coverage.',
  'Because benefits, costs, and provider networks vary widely between insurers and regions, it helps to compare several plans side by side before deciding which one fits your needs and budget.',
  'Enrollment windows are the main times to join or switch a plan, so reviewing your options each year is worthwhile as premiums and coverage can change.',
  'Speaking with a licensed advisor or using an official comparison tool can clarify the trade-offs between premiums, out-of-pocket limits, and the providers available near you.',
].join('\n\n');

async function main(): Promise<void> {
  await withSystem(async (tx) => {
    const org = await tx.organization.findUnique({ where: { slug: 'knn-platform' }, select: { id: true } });
    if (!org) throw new Error('platform org (knn-platform) not found — run db:seed first');

    const existing = await tx.article.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (existing) {
      console.log(`Demo article already present (slug=${SLUG}).`);
      return;
    }
    await tx.article.create({
      data: {
        orgId: org.id,
        slug: SLUG,
        title: TITLE,
        keywords: ['medicare advantage', 'medicare plans 2026'],
        query: 'medicare advantage 2026',
        rawContent: 'Raw draft (pre-compliance) omitted for the demo.',
        compliantContent: COMPLIANT,
        status: 'READY',
      },
    });
    console.log(`Seeded demo article: /a/${SLUG}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
