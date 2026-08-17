import { randomBytes } from 'node:crypto';
import {
  AiNotConfiguredError,
  complianceRewriteOpenAI as defaultComplianceRewrite,
  embedText as defaultEmbedText,
  generateArticleOpenAI as defaultGenerateArticle,
} from '@knn/ai';
import { env, isProd } from '@knn/config';
import { type Prisma, type TxClient, withSystem, withTenant } from '@knn/db';
import { ARTICLE_SIMILARITY_THRESHOLD, EMBEDDING_DIMENSIONS, ROLES } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/** Injectable AI calls (defaults = the real @knn/ai clients); tests pass mocks. */
export interface ArticleAiDeps {
  
  embedText: (text: string) => Promise<number[]>;
  generateArticle: (input: {
    keywords: string[];
    query?: string;
  }) => Promise<{ title: string; content: string; relatedSearchTerms?: string[] }>;
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
  /** Campaign keywords — fallback related-search `terms` when no AI terms exist. */
  keywords: string[];
  /** AI-generated high-CPC related-search queries — the CSA `terms` (preferred). */
  relatedSearchTerms: string[];
  /**
   * The AFS custom-channel string (`ch`) of the article's most-recently-launched
   * campaign. Bulletproof fallback for `/search` when the cookie bridge AND URL
   * token both miss (incognito, cross-context nav) — Referer-based lookup uses
   * this so Google AFS never receives channel=1 for our own campaigns.
   */
  channel: string | null;
  /** The campaign's referrerAdCreative — same-purpose fallback for the /search page. */
  referrerAdCreative: string | null;
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
      select: {
        id: true,
        slug: true,
        title: true,
        compliantContent: true,
        query: true,
        keywords: true,
        relatedSearchTerms: true,
        status: true,
      },
    });
    if (!article || article.status !== 'READY') return null;
    // Pick the article's active campaign (most-recently-launched with a channel assigned)
    // to expose its channel/RAC — the /search page uses these as a Referer-based fallback
    // when the primary cookie/URL bridge has been stripped by the browser or Google's iframe.
    // One article CAN back multiple campaigns (article reuse via cosine similarity), so we pick
    // the newest LIVE/ACTIVE assignment; any valid channel from THIS org's campaigns is strictly
    // better than Google's default "1" fallback for the ad request.
    const activeCampaign = await tx.campaign.findFirst({
      where: {
        articleId: article.id,
        channelId: { not: null },
        status: { in: ['ACTIVE', 'LAUNCHING', 'BATCHED', 'PAUSED'] },
      },
      orderBy: { updatedAt: 'desc' },
      select: { racValue: true, channelId: true },
    });
    // No `@relation` on Campaign.channelId → resolve the AFS channel string in a
    // second lookup by internal id.
    const channel = activeCampaign?.channelId
      ? await tx.channel.findUnique({
          where: { id: activeCampaign.channelId },
          select: { channelId: true },
        })
      : null;
    return {
      slug: article.slug,
      title: article.title,
      compliantContent: article.compliantContent,
      query: article.query,
      keywords: Array.isArray(article.keywords) ? (article.keywords as string[]) : [],
      relatedSearchTerms: article.relatedSearchTerms,
      channel: channel?.channelId ?? null,
      referrerAdCreative: activeCampaign?.racValue ?? null,
    };
  });
}

/** Normalize a host: lowercase, strip scheme/path/port (mirrors domains.service). */
function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}

/** Strip markdown to a plain-text snippet (~160 chars) for a SERP-style result line. */
function toSnippet(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/^#{1,6}\s+/gm, ' ') // headings
    .replace(/[*_`>#]+/g, ' ') // residual md punctuation
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

export interface PublicArticleSummary {
  slug: string;
  title: string;
  /** Plain-text snippet (article opening) for the organic result line. */
  snippet: string;
}

/**
 * Organic "Web results" for the RSOC results page (`/search`): the READY articles
 * actually routed to THIS host (via its offers — the offer's article variant, else its
 * campaign's article). Two reasons this is host-scoped, not global:
 *  1. Compliance — the AFS ads must SUPPLEMENT real search results (Google Search-ads
 *     policy), so the results page needs genuine, on-topic content links.
 *  2. Tenant isolation — only content actually published on this host appears (never
 *     another org's article titles leaking onto someone else's domain).
 * `withSystem` (the article site is public, no tenant ctx); newest first; capped.
 */
export async function listArticlesForHost(rawHost: string, limit = 6): Promise<PublicArticleSummary[]> {
  const host = normalizeHost(rawHost);
  if (!host) return [];
  const take = Math.min(Math.max(limit, 1), 10);
  return withSystem(async (tx) => {
    const domain = await tx.domain.findUnique({ where: { host }, select: { id: true } });
    if (!domain) return [];
    // Articles reachable on this host = each offer's variant article, else its campaign's.
    const offers = await tx.offer.findMany({
      where: { domainId: domain.id },
      select: { articleId: true, campaign: { select: { articleId: true } } },
    });
    const ids = [
      ...new Set(
        offers.flatMap((o) => [o.articleId, o.campaign?.articleId]).filter((x): x is string => Boolean(x)),
      ),
    ];
    if (ids.length === 0) return [];
    const articles = await tx.article.findMany({
      where: { id: { in: ids }, status: 'READY' },
      select: { slug: true, title: true, compliantContent: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return articles.map((a) => ({ slug: a.slug, title: a.title, snippet: toSnippet(a.compliantContent) }));
  });
}

/**
 * Recent READY articles platform-wide (NOT host-scoped) — backs the WHITE site's homepage. The
 * white domains aren't registered money `Domain`s, so `listArticlesForHost` returns [] for them; the
 * white site is a generic clean publication that simply lists recent content. Public + `withSystem`;
 * exposes only the already-public slug/title/snippet, hard-capped so it can't enumerate everything.
 */
export async function listRecentArticles(limit = 18): Promise<PublicArticleSummary[]> {
  const take = Math.min(Math.max(limit, 1), 24);
  return withSystem(async (tx) => {
    const articles = await tx.article.findMany({
      where: { status: 'READY' },
      select: { slug: true, title: true, compliantContent: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return articles.map((a) => ({ slug: a.slug, title: a.title, snippet: toSnippet(a.compliantContent) }));
  });
}

export interface ArticleSitemapEntry {
  slug: string;
  /** Last-modified date (YYYY-MM-DD) for the sitemap <lastmod>. */
  lastmod: string;
}

/**
 * All READY article slugs routed to a host (via its offers), for the per-host sitemap.
 * Same host-scoping as listArticlesForHost (tenant-safe) but UNCAPPED + lightweight (slug +
 * updatedAt only). A sitemap is how we proactively surface new article URLs to Google so it
 * crawls them sooner — the content-page related-search unit refines from crawled content
 * (publisher `terms` already fill it immediately, so this avoids a thin unit on fresh URLs).
 */
export async function listArticleSlugsForHost(rawHost: string): Promise<ArticleSitemapEntry[]> {
  const host = normalizeHost(rawHost);
  if (!host) return [];
  return withSystem(async (tx) => {
    const domain = await tx.domain.findUnique({ where: { host }, select: { id: true } });
    if (!domain) return [];
    const offers = await tx.offer.findMany({
      where: { domainId: domain.id },
      select: { articleId: true, campaign: { select: { articleId: true } } },
    });
    const ids = [
      ...new Set(
        offers.flatMap((o) => [o.articleId, o.campaign?.articleId]).filter((x): x is string => Boolean(x)),
      ),
    ];
    if (ids.length === 0) return [];
    const articles = await tx.article.findMany({
      where: { id: { in: ids }, status: 'READY' },
      select: { slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });
    return articles.map((a) => ({ slug: a.slug, lastmod: a.updatedAt.toISOString().slice(0, 10) }));
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
 * Fail-closed compliance gate (audit Blocker B2). In PRODUCTION, refuse to generate a landing page
 * when no compliance policy is configured — a non-compliant page reaching live Google AFS risks
 * suspension of the shared AdSense account the whole platform's revenue depends on. A super-admin
 * sets `compliance_prompt` once, globally (Platform → Settings). No-op outside production (so local /
 * staging test flows aren't blocked) and when a prompt is set. Pure + exported for unit testing.
 */
export function assertComplianceConfigured(compliancePrompt: string, prod: boolean): void {
  if (prod && !compliancePrompt.trim()) {
    throw new AppError(
      422,
      'Article generation is blocked: no compliance policy is configured. A platform super-admin must set the compliance prompt (Platform → Settings) before campaigns can generate landing pages for live ads.',
    );
  }
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

  const orgId = campaign.orgId;
  // CRITICAL: the AI calls (embed / generate / compliance) take many seconds — they
  // must run OUTSIDE any DB transaction, or Prisma's 5s interactive-txn timeout kills
  // it ("transaction already closed"). Each DB step below is its own short txn.
  try {
    // Idempotent: already attached → done (a quick read).
    if (campaign.articleId) {
      const existing = await withTenant(orgId, (tx) =>
        tx.article.findUnique({ where: { id: campaign.articleId! }, select: { id: true, slug: true, title: true, status: true } }),
      );
      if (existing) return { ...existing, reused: true };
    }

    const topic = (campaign.query ? `${campaign.query}. ` : '') + keywords.join(', ');

    // Embedding is best-effort (network, no txn): if OpenAI isn't configured we skip
    // reuse and still generate. Other embedding errors propagate.
    let vector: number[] | null = null;
    try {
      vector = await deps.embedText(topic);
    } catch (err) {
      if (!(err instanceof AiNotConfiguredError)) throw err;
    }

    // Reuse an existing similar article (short txn for the vector query only).
    if (vector) {
      const vectorLiteral = toVectorLiteral(vector);
      const similar = await withTenant(orgId, (tx) => findSimilarArticle(tx, vectorLiteral));
      if (similar) {
        await withTenant(orgId, async (tx) => {
          await tx.campaign.update({ where: { id: campaignId }, data: { articleId: similar.id } });
          await writeAudit(tx, { orgId, actorId: auth.userId, action: 'article.reused', entityType: 'article', entityId: similar.id, details: { campaignId } });
        });
        return { id: similar.id, slug: similar.slug, title: similar.title, status: 'READY', reused: true };
      }
    }

    // Generate (network, no txn). compliance_prompt is a global setting (quick read).
    const compliancePrompt = await withSystem((tx) => getCompliancePrompt(tx));
    // B2 (fail-closed compliance): in PRODUCTION never serve an AI page to live Google AFS without a
    // compliance policy configured — a non-compliant landing page risks suspension of the shared
    // AdSense account the WHOLE platform's revenue depends on.
    assertComplianceConfigured(compliancePrompt, isProd);
    const generated = await deps.generateArticle({ keywords, query: campaign.query ?? undefined });
    // Only spend a second model call when an admin has actually set compliance rules.
    const compliant = compliancePrompt.trim()
      ? await deps.complianceRewrite({ content: generated.content, compliancePrompt })
      : generated.content;
    const slug = slugify(generated.title);

    // Persist (short txn — pure DB writes, no network).
    return await withTenant(orgId, async (tx) => {
      const created = await tx.article.create({
        data: {
          orgId,
          slug,
          title: generated.title,
          keywords: keywords as Prisma.InputJsonValue,
          relatedSearchTerms: generated.relatedSearchTerms ?? [],
          query: campaign.query ?? null,
          rawContent: generated.content,
          compliantContent: compliant,
          status: 'READY',
          model: env.OPENAI_ARTICLE_MODEL,
        },
        select: { id: true, slug: true, title: true, status: true },
      });
      if (vector) {
        await tx.$executeRawUnsafe('UPDATE articles SET embedding = $1::vector WHERE id = $2::uuid', toVectorLiteral(vector), created.id);
      }
      await tx.campaign.update({ where: { id: campaignId }, data: { articleId: created.id } });
      await writeAudit(tx, { orgId, actorId: auth.userId, action: 'article.generated', entityType: 'article', entityId: created.id, details: { campaignId, hasEmbedding: vector !== null } });
      return { ...created, reused: false };
    });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new AppError(503, 'AI generation is not configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY)');
    }
    throw err;
  }
}
