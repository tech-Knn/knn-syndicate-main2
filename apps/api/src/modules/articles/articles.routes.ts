import type { FastifyInstance } from 'fastify';
import { handleRouteError } from '../../lib/http.js';
import { getPublicArticleBySlug } from './articles.service.js';

/**
 * Public (unauthenticated) article reads for the article frontend. Mounted at
 * `/api/public/articles`. Serves only READY articles by their public slug, and
 * only the compliance-rewritten content.
 */
export async function publicArticleRoutes(app: FastifyInstance): Promise<void> {
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
