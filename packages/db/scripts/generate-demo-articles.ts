/**
 * Generate N demo articles through the REAL app pipeline (OpenAI `generateArticleOpenAI`)
 * and store them as READY articles in the platform org, so the article frontend renders
 * them at /a/<slug> with the AI-produced high-CPC related-search `terms`. Real OpenAI calls
 * — needs OPENAI_API_KEY in the env. Not part of `db:seed`.
 *
 *   OPENAI_API_KEY=sk-... tsx packages/db/scripts/generate-demo-articles.ts
 */
import { randomBytes } from 'node:crypto';
import { generateArticleOpenAI } from '@knn/ai';
import { env } from '@knn/config';
import { withSystem } from '../src/index.js';

const TOPICS: { query: string; keywords: string[] }[] = [
  { query: 'Medicare Advantage plans for seniors in 2026', keywords: ['medicare advantage', 'senior health insurance', 'medicare enrollment'] },
  { query: 'Affordable dental implants for seniors: costs and options', keywords: ['dental implants cost', 'senior dental care', 'tooth replacement'] },
  { query: 'Walk-in tubs: cost, safety features, and installation', keywords: ['walk-in tub cost', 'senior bathroom safety', 'walk-in bathtub installation'] },
  { query: 'No-medical-exam life insurance for seniors', keywords: ['final expense insurance', 'burial insurance', 'senior life insurance'] },
  { query: 'Best SUV lease and finance deals in 2026', keywords: ['suv deals', 'auto financing', 'low apr suv'] },
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
  const org = await withSystem((tx) =>
    tx.organization.findFirst({ where: { isPlatform: true }, select: { id: true } }),
  );
  if (!org) throw new Error('platform org not found — run db:seed first');

  for (const topic of TOPICS) {
    try {
      const generated = await generateArticleOpenAI({ keywords: topic.keywords, query: topic.query });
      const slug = slugify(generated.title);
      await withSystem((tx) =>
        tx.article.create({
          data: {
            orgId: org.id,
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
        }),
      );
      console.log(`RESULT\t${slug}\t${generated.title}\tterms=${JSON.stringify(generated.relatedSearchTerms)}`);
    } catch (err) {
      console.error(`FAILED\t${topic.query}\t${(err as Error).message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
