import type { FastifyInstance } from 'fastify';
import { handleRouteError } from '../../lib/http.js';
import { getPublicArticleBySlug, listArticleSlugsForHost, listArticlesForHost } from './articles.service.js';

/**
 * Public (unauthenticated) article reads for the article frontend. Mounted at
 * `/api/public/articles`. Serves only READY articles by their public slug, and
 * only the compliance-rewritten content.
 */
export async function publicArticleRoutes(app: FastifyInstance): Promise<void> {
  // Organic "Web results" for the RSOC results page: the READY articles routed to a
  // given host (so the AFS ads supplement REAL results — Google policy). Host-scoped
  // (tenant-safe). Short public cache — results change slowly, and the article SSR also
  // caches the fetch — so this never sits on the money page's critical path.
  app.get<{ Querystring: { host?: string; limit?: string } }>('/', async (req, reply) => {
    const host = req.query.host;
    if (!host) return reply.code(400).send({ error: 'Missing host' });
    try {
      const articles = await listArticlesForHost(host, Number(req.query.limit) || 6);
      reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=600');
      return reply.send({ articles });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Per-host sitemap data: all READY article slugs (+ lastmod) routed to the host. Static
  // route, so it's matched before `/:slug`. Backs the article app's /sitemap.xml.
  app.get<{ Querystring: { host?: string } }>('/sitemap', async (req, reply) => {
    const host = req.query.host;
    if (!host) return reply.code(400).send({ error: 'Missing host' });
    try {
      const urls = await listArticleSlugsForHost(host);
      reply.header('cache-control', 'public, max-age=600, stale-while-revalidate=600');
      return reply.send({ urls });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { slug: string } }>('/:slug', async (req, reply) => {
    try {
      const article = await getPublicArticleBySlug(req.params.slug);
      if (!article) return reply.code(404).send({ error: 'Article not found' });
      return reply.send({ article });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
