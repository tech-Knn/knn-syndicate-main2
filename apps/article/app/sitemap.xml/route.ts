import { headers } from 'next/headers';

/**
 * Per-host sitemap. One article app serves many websites, so the sitemap is built from the
 * REQUEST host: it lists that host's READY articles (`https://{host}/a/{slug}`) so Google
 * discovers + crawls new articles quickly. The content-page related-search unit refines from
 * crawled content — publisher `terms` already fill it immediately, so this keeps fresh URLs
 * from sitting un-crawled. Dynamic (per-host); the article list is fetched with a short cache.
 */
export const dynamic = 'force-dynamic';

const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

interface SitemapUrl {
  slug: string;
  lastmod: string;
}

/** Minimal XML-text escape for the <loc> value (slugs/hosts are already URL-safe; defensive). */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<Response> {
  const host = (await headers()).get('host') ?? '';
  let urls: SitemapUrl[] = [];
  if (host) {
    try {
      const res = await fetch(`${API_BASE}/api/public/articles/sitemap?host=${encodeURIComponent(host)}`, {
        next: { revalidate: 600 },
      });
      if (res.ok) urls = ((await res.json()) as { urls?: SitemapUrl[] }).urls ?? [];
    } catch {
      // Serve an empty (valid) sitemap rather than erroring the route.
    }
  }
  const origin = `https://${host}`;
  const entries = urls
    .map((u) => `  <url><loc>${xml(`${origin}/a/${u.slug}`)}</loc><lastmod>${u.lastmod}</lastmod></url>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}
