import type { MetadataRoute } from 'next';

/**
 * Allow crawling of content (article) pages — RSOC related-search terms only
 * appear after Google crawls the page. Keep the /search results pages out of the
 * index (they're query-driven, noindex).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/search' },
  };
}
