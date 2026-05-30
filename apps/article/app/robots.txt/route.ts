import { headers } from 'next/headers';

/**
 * Per-host robots.txt. One article app serves many websites, so the `Sitemap:` line must point
 * at the REQUEST host's own sitemap. Allow crawling of content (article) pages — the RSOC
 * related-search terms refine after Google crawls the page — and keep the query-driven /search
 * results pages out of the index. Replaces the static `robots.ts` (which couldn't emit a
 * per-host sitemap URL).
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const host = (await headers()).get('host') ?? '';
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /search'];
  if (host) lines.push(`Sitemap: https://${host}/sitemap.xml`);
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
