/**
 * Maintenance: regenerate the article of every campaign in a status (default ACTIVE) with the CURRENT prompt and
 * compliance policy (D42), in place. Each article keeps its id and slug (running ads and attribution are untouched);
 * its title, body, related-search terms and embedding are refreshed through the same `regenerateArticleContent` the
 * API route uses, so market resolution, the compliance rewrite and the audit trail behave exactly as in production.
 *
 * Before anything is overwritten, every article's current title / raw / compliant body / terms are written to a JSON
 * backup file, and `--restore <file>` puts them back (the embedding is not restored; the topic is the same, so reuse
 * similarity is effectively unchanged).
 *
 * Run INSIDE the api container (it needs the OpenAI key and the database):
 *
 *   pnpm --filter @knn/api exec tsx scripts/regenerate-articles.ts --dry-run
 *   pnpm --filter @knn/api exec tsx scripts/regenerate-articles.ts [--status ACTIVE] [--limit N] [--slug <slug>]
 *   pnpm --filter @knn/api exec tsx scripts/regenerate-articles.ts --restore /tmp/article-backup-<stamp>.json
 *
 * One OpenAI call for the article + one for the compliance rewrite + one embedding per article (about 1 cent).
 * Articles are processed one at a time; a failure on one is reported and the rest continue (exit code 1 at the end).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { withSystem } from '@knn/db';
import { CAMPAIGN_STATUS, ROLES, USER_STATUS } from '@knn/shared';
import type { AuthContext } from '../src/middleware/authenticate.js';
import { regenerateArticleContent } from '../src/modules/articles/articles.service.js';

interface Backup {
  id: string;
  slug: string;
  title: string;
  rawContent: string;
  compliantContent: string;
  relatedSearchTerms: string[];
  campaignId: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

async function restore(file: string): Promise<void> {
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Backup[];
  for (const r of rows) {
    await withSystem((tx) =>
      tx.article.update({
        where: { id: r.id },
        data: { title: r.title, rawContent: r.rawContent, compliantContent: r.compliantContent, relatedSearchTerms: r.relatedSearchTerms },
      }),
    );
    console.log(`restored ${r.slug}`);
  }
  console.log(`restored ${rows.length} article(s) from ${file}`);
}

async function main(): Promise<void> {
  const restoreFile = arg('--restore');
  if (restoreFile) return restore(restoreFile);

  const status = (arg('--status') ?? CAMPAIGN_STATUS.ACTIVE) as string;
  const dryRun = has('--dry-run');
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
  const onlySlug = arg('--slug');

  const actor = await withSystem((tx) =>
    tx.user.findFirst({ where: { role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
  );
  if (!actor) throw new Error('No active SUPER_ADMIN user to attribute the audit trail to');

  const campaigns = await withSystem((tx) =>
    tx.campaign.findMany({
      where: { status: status as never, articleId: { not: null } },
      select: { id: true, name: true, orgId: true, articleId: true },
      orderBy: { createdAt: 'asc' },
    }),
  );
  const articles = await withSystem((tx) =>
    tx.article.findMany({
      where: { id: { in: campaigns.map((c) => c.articleId!) } },
      select: { id: true, slug: true, title: true, rawContent: true, compliantContent: true, relatedSearchTerms: true },
    }),
  );
  const byId = new Map(articles.map((a) => [a.id, a]));

  // One campaign per article (articles can be shared by reuse; regenerating once refreshes it for all of them).
  const seen = new Set<string>();
  const todo = campaigns.filter((c) => {
    if (seen.has(c.articleId!)) return false;
    seen.add(c.articleId!);
    return !onlySlug || byId.get(c.articleId!)?.slug === onlySlug;
  }).slice(0, limit);

  console.log(`${todo.length} article(s) to regenerate (campaign status ${status})${dryRun ? ' — DRY RUN, nothing will change' : ''}`);
  for (const c of todo) {
    const a = byId.get(c.articleId!)!;
    console.log(`  ${a.slug}  [${words(a.compliantContent)} words]  "${a.title}"  ← ${c.name.slice(0, 40)}`);
  }
  if (dryRun || todo.length === 0) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `/tmp/article-backup-${stamp}.json`;
  const backup: Backup[] = todo.map((c) => {
    const a = byId.get(c.articleId!)!;
    return { id: a.id, slug: a.slug, title: a.title, rawContent: a.rawContent, compliantContent: a.compliantContent, relatedSearchTerms: a.relatedSearchTerms, campaignId: c.id };
  });
  writeFileSync(backupFile, JSON.stringify(backup));
  console.log(`backup written: ${backupFile}`);

  let failed = 0;
  for (const c of todo) {
    const before = byId.get(c.articleId!)!;
    const auth: AuthContext = { userId: actor.id, orgId: c.orgId, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE };
    try {
      const out = await regenerateArticleContent(auth, c.id);
      const after = await withSystem((tx) => tx.article.findUnique({ where: { id: out.id }, select: { title: true, compliantContent: true } }));
      console.log(`OK  ${out.slug}  ${words(before.compliantContent)} → ${words(after?.compliantContent ?? '')} words  "${before.title}" → "${after?.title}"  (market ${out.market})`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${before.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`done: ${todo.length - failed} regenerated, ${failed} failed. Backup: ${backupFile}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
