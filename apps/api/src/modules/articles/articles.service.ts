import { randomBytes } from 'node:crypto';
import {
  AiNotConfiguredError,
  complianceRewrite as defaultComplianceRewrite,
  embedText as defaultEmbedText,
  generateArticle as defaultGenerateArticle,
} from '@knn/ai';
import { env } from '@knn/config';
import { type Prisma, type TxClient, withSystem, withTenant } from '@knn/db';
import { ARTICLE_SIMILARITY_THRESHOLD, EMBEDDING_DIMENSIONS, ROLES } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/** Injectable AI calls (defaults = the real @knn/ai clients); tests pass mocks. */
export interface ArticleAiDeps {
  embedText: (text: string) => Promise<number[]>;
  generateArticle: (input: { keywords: string[]; query?: string }) => Promise<{ title: string; content: string }>;
  complianceRewrite: (input: { content: string; compliancePrompt: string }) => Promise<string>;
}
const defaultAiDeps: ArticleAiDeps = {
  embedText: defaultEmbedText,
  generateArticle: defaultGenerateArticle,
  complianceRewrite: defaultComplianceRewrite,
};

export interface ArticleResult {
  id: string;
  slug: string;
  title: string;
  status: string;
  /** True when an existing similar article (cosine ≥ threshold) was attached. */
  reused: boolean;
}

export interface PublicArticle {
  slug: string;
  title: string;
  compliantContent: string;
  query: string | null;
  /** Campaign keywords — usable as publisher-provided related-search `terms` (D16). */
  keywords: string[];
}

/**
 * Fetch a READY article by its public slug for the article frontend. Uses
 * `withSystem` (RLS-bypassing) because the article site is public and has no
 * tenant context — the slug is a globally-unique public identifier. Only the
 * compliance-rewritten content is exposed (never the raw draft).
 */
export async function getPublicArticleBySlug(slug: string): Promise<PublicArticle | null> {
  return withSystem(async (tx) => {
    const article = await tx.article.findUnique({
      where: { slug },
      select: { slug: true, title: true, compliantContent: true, query: true, keywords: true, status: true },
    });
    if (!article || article.status !== 'READY') return null;
    return {
      slug: article.slug,
      title: article.title,
      compliantContent: article.compliantContent,
      query: article.query,
      keywords: Array.isArray(article.keywords) ? (article.keywords as string[]) : [],
    };
  });
}

/** URL-safe slug from the title + a short random suffix to guarantee uniqueness. */
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

/** pgvector text literal `[f1,f2,…]`, with finite-number validation (no injection). */
function toVectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError(500, `Embedding has wrong length: ${vec.length}`);
  }
  for (const n of vec) {
    if (!Number.isFinite(n)) throw new AppError(500, 'Embedding contains a non-finite value');
  }
  return `[${vec.join(',')}]`;
}

interface SimilarRow {
  id: string;
  slug: string;
  title: string;
  similarity: number;
}

/**
 * Nearest READY article by cosine similarity (pgvector `<=>` is cosine distance,
 * so similarity = 1 - distance). Runs inside the tenant txn, so RLS limits it to
 * the current org — reuse never crosses tenants. Returns null below the threshold.
 */
async function findSimilarArticle(tx: TxClient, vectorLiteral: string): Promise<SimilarRow | null> {
  const rows = await tx.$queryRawUnsafe<SimilarRow[]>(
    `SELECT id, slug, title, 1 - (embedding <=> $1::vector) AS similarity
     FROM articles
     WHERE embedding IS NOT NULL AND status = 'READY'
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    vectorLiteral,
  );
  const top = rows[0];
  return top && Number(top.similarity) >= ARTICLE_SIMILARITY_THRESHOLD ? top : null;
}

async function getCompliancePrompt(tx: TxClient): Promise<string> {
  const setting = await tx.platformSetting.findUnique({ where: { key: 'compliance_prompt' } });
  return setting?.value ?? '';
}

/**
 * Resolve a campaign's article (D6: one per campaign). Embeds the campaign's
 * keywords/angle, **reuses** an existing org article when cosine ≥ threshold
 * (D16), otherwise **generates** via Claude → compliance rewrite (storing both
 * the raw and compliant versions) → stores the embedding → attaches to the
 * campaign. Idempotent: returns the already-attached article if present.
 */
export async function generateArticleForCampaign(
  auth: AuthContext,
  campaignId: string,
  deps: ArticleAiDeps = defaultAiDeps,
): Promise<ArticleResult> {
  // 1. Authz + load (respects buyer self-scope / admin org-scope).
  const campaign = await runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) {
      throw new AppError(404, 'Campaign not found');
    }
    return c;
  });

  const keywords = Array.isArray(campaign.keywords) ? (campaign.keywords as string[]) : [];
  if (keywords.length === 0) {
    throw new AppError(422, 'Campaign has no keywords to generate an article from');
  }

  // 2. Engine work scoped to the campaign's org (within-org reuse only).
  try {
    return await withTenant(campaign.orgId, async (tx) => {
      if (campaign.articleId) {
        const existing = await tx.article.findUnique({
          where: { id: campaign.articleId },
          select: { id: true, slug: true, title: true, status: true },
        });
        if (existing) return { ...existing, reused: true };
      }

      const topic = (campaign.query ? `${campaign.query}. ` : '') + keywords.join(', ');

      // Embedding is best-effort: if OpenAI isn't configured we skip reuse and
      // still generate (Claude). Other embedding errors propagate.
      let vector: number[] | null = null;
      try {
        vector = await deps.embedText(topic);
      } catch (err) {
        if (!(err instanceof AiNotConfiguredError)) throw err;
      }

      if (vector) {
        const similar = await findSimilarArticle(tx, toVectorLiteral(vector));
        if (similar) {
          await tx.campaign.update({ where: { id: campaignId }, data: { articleId: similar.id } });
          await writeAudit(tx, {
            orgId: campaign.orgId,
            actorId: auth.userId,
            action: 'article.reused',
            entityType: 'article',
            entityId: similar.id,
            details: { campaignId },
          });
          return { id: similar.id, slug: similar.slug, title: similar.title, status: 'READY', reused: true };
        }
      }

      const compliancePrompt = await getCompliancePrompt(tx);
      const generated = await deps.generateArticle({ keywords, query: campaign.query ?? undefined });
      const compliant = await deps.complianceRewrite({ content: generated.content, compliancePrompt });
      const slug = slugify(generated.title);

      const created = await tx.article.create({
        data: {
          orgId: campaign.orgId,
          slug,
          title: generated.title,
          keywords: keywords as Prisma.InputJsonValue,
          query: campaign.query ?? null,
          rawContent: generated.content,
          compliantContent: compliant,
          status: 'READY',
          model: env.ANTHROPIC_MODEL,
        },
        select: { id: true, slug: true, title: true, status: true },
      });

      if (vector) {
        await tx.$executeRawUnsafe(
          'UPDATE articles SET embedding = $1::vector WHERE id = $2::uuid',
          toVectorLiteral(vector),
          created.id,
        );
      }
      await tx.campaign.update({ where: { id: campaignId }, data: { articleId: created.id } });
      await writeAudit(tx, {
        orgId: campaign.orgId,
        actorId: auth.userId,
        action: 'article.generated',
        entityType: 'article',
        entityId: created.id,
        details: { campaignId, hasEmbedding: vector !== null },
      });
      return { ...created, reused: false };
    });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new AppError(503, 'AI generation is not configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY)');
    }
    throw err;
  }
}
