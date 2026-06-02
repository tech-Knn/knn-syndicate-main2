import { type Context, Hono } from 'hono';

/**
 * The WHITE site — a clean, legitimate-looking content publication. It is the cloaker funnel's
 * fallback (organic / bot / FB-reviewer traffic lands here) and the FB ad display link. It serves the
 * SAME articles as the money domains, but as plain editorial content with **no AFS / ad code and no
 * Google/FB IDs**, on a separately-hosted Cloudflare account so it's unlinkable from the money infra.
 *
 * Deliberately its OWN Worker with a DISTINCT theme — reusing the money article app would give the two
 * identical templates (a content/template fingerprint link). Article TEXT is pulled from our public API
 * server-side (invisible to external scanners). Keep it lean: no @knn/shared, no money-side imports.
 */

interface Env {
  /** Public API base the article content is fetched from (server-side). */
  API_BASE: string;
}

interface PublicArticle {
  slug: string;
  title: string;
  compliantContent: string;
}
interface ArticleSummary {
  slug: string;
  title: string;
  snippet: string;
}

/** A few hand-set brand names for the known white hosts; otherwise title-case the domain label. */
const BRANDS: Record<string, string> = {
  'readoranow.com': 'Readora',
  'livedailyperch.com': 'The Daily Perch',
  'brightleafreads.com': 'Brightleaf Reads',
};
function brandFor(host: string): string {
  const h = host.replace(/^www\./, '').toLowerCase();
  if (BRANDS[h]) return BRANDS[h];
  const label = h.split('.')[0] ?? h;
  return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The request host. Prefers the Host header (set on real custom-domain requests); falls back to the
 *  URL hostname. Both resolve to the white domain in production; locally it's just the dev host. */
function hostOf(c: Context): string {
  const h = c.req.header('host');
  if (h) return h.replace(/:\d+$/, '').toLowerCase();
  try {
    return new URL(c.req.url).hostname.toLowerCase();
  } catch {
    return 'readoranow.com';
  }
}

const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;
function esc(s: string): string {
  return s.replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;').replace(QUOT, '&quot;');
}

/** Minimal, SAFE markdown → HTML: escape first, then apply a small, fixed set of block + inline rules.
 *  No raw HTML or link URLs from the content are ever emitted (link text only) — XSS-safe by construction. */
function renderMarkdown(md: string): string {
  const inline = (t: string): string =>
    esc(t)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text only (never an attacker URL)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((i) => `<li>${inline(i)}</li>`).join('');
      out.push(`<${list.type}>${items}</${list.type}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = h[1]!.length + 1; // # → h2 (the page <h1> is the title)
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (ul) {
      flushPara();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list!.items.push(ul[1]!);
    } else if (ol) {
      flushPara();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list!.items.push(ol[1]!);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

const CSS = `
:root{--ink:#22201c;--muted:#6f6a61;--line:#e7e2d8;--bg:#faf8f3;--accent:#7a5b3a;--card:#fff}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 Georgia,"Times New Roman",serif}
a{color:var(--accent)}img{max-width:100%}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
header.site{border-bottom:1px solid var(--line);background:var(--card)}
header.site .wrap{display:flex;align-items:baseline;justify-content:space-between;padding:18px 20px}
.brand{font-size:24px;font-weight:700;letter-spacing:.3px;text-decoration:none;color:var(--ink);font-family:Georgia,serif}
nav a{margin-left:18px;font:14px/1 system-ui,sans-serif;color:var(--muted);text-decoration:none}
nav a:hover{color:var(--accent)}
main{padding:34px 0 10px}
h1{font-size:34px;line-height:1.2;margin:.2em 0 .4em}
h2{font-size:24px;margin:1.5em 0 .4em}h3{font-size:20px;margin:1.3em 0 .3em}
.lead{font-size:19px;color:#3c382f}
.kicker{font:13px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;color:var(--accent)}
.card{display:block;padding:18px 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.card h3{margin:.1em 0 .25em;font-size:21px;color:var(--ink)}
.card p{margin:0;color:var(--muted);font-size:16px}
.muted{color:var(--muted)}
footer.site{margin-top:40px;border-top:1px solid var(--line);background:var(--card)}
footer.site .wrap{padding:26px 20px;font:14px/1.6 system-ui,sans-serif;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between}
footer.site a{color:var(--muted);text-decoration:none}footer.site a:hover{color:var(--accent)}
`;

function page(host: string, title: string, inner: string): string {
  const brand = brandFor(host);
  const year = '2026';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(brand)}</title>
<meta name="description" content="${esc(brand)} — independent writing on the things worth a closer look.">
<style>${CSS}</style></head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="/">${esc(brand)}</a>
  <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
</div></header>
<main><div class="wrap">${inner}</div></main>
<footer class="site"><div class="wrap">
  <span>© ${year} ${esc(brand)}. All rights reserved.</span>
  <span><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/contact">Contact</a></span>
</div></footer>
</body></html>`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const LEGAL: Record<string, { title: string; body: (brand: string) => string }> = {
  about: {
    title: 'About',
    body: (b) =>
      `<p class="lead">${esc(b)} is an independent publication of explainers, guides, and longer reads — written to be genuinely useful and easy to follow.</p>
<p>We cover everyday topics across home, money, tech, travel and lifestyle, with a simple goal: clear writing that respects your time. New pieces are added regularly.</p>
<p>Have a suggestion or a correction? We'd love to hear from you — see the <a href="/contact">contact page</a>.</p>`,
  },
  contact: {
    title: 'Contact',
    body: (b) =>
      `<p class="lead">Thanks for reading ${esc(b)}.</p>
<p>For questions, feedback, or corrections, reach the editors at <a href="/contact">our contact form</a> or by email at the address listed with the domain registrar. We read everything and reply when we can.</p>`,
  },
  privacy: {
    title: 'Privacy',
    body: (b) =>
      `<p class="lead">Your privacy matters to ${esc(b)}.</p>
<p>This site serves editorial content. We do not sell your personal information. Standard server logs (such as IP address and user-agent) may be recorded for security and to keep the site reliable, and are retained only as long as needed.</p>
<p>We use only the cookies necessary for the site to function. If that ever changes, this page will be updated first.</p>`,
  },
  terms: {
    title: 'Terms',
    body: (b) =>
      `<p class="lead">Terms of use for ${esc(b)}.</p>
<p>The content here is provided for general information only and is offered "as is" without warranties. It is not professional advice; always confirm important details independently before acting on them.</p>
<p>All content is the property of its respective owners. Please don't republish without permission.</p>`,
  },
};

export const white = new Hono<{ Bindings: Env }>();

white.get('/health/live', (c) => c.json({ status: 'ok' }));

white.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /\n'));

// Homepage — a clean magazine index of recent articles (so the domain root looks like a real site).
white.get('/', async (c) => {
  const host = hostOf(c);
  const brand = brandFor(host);
  const data = await fetchJson<{ articles: ArticleSummary[] }>(`${c.env.API_BASE}/api/public/articles/recent?limit=18`);
  const items = (data?.articles ?? [])
    .map(
      (a) =>
        `<a class="card" href="/a/${encodeURIComponent(a.slug)}"><h3>${esc(a.title)}</h3><p>${esc(a.snippet)}</p></a>`,
    )
    .join('');
  const inner = `
<p class="kicker">${esc(brand)}</p>
<h1>Reads worth your time</h1>
<p class="lead">Clear, practical writing on the things people actually want explained.</p>
<div class="list">${items || '<p class="muted">New articles are on the way.</p>'}</div>`;
  c.header('cache-control', 'public, max-age=300');
  return c.html(page(host, 'Home', inner));
});

// Article — the SAME content as the money page, rendered clean (no ads, no Google IDs).
white.get('/a/:slug', async (c) => {
  const host = hostOf(c);
  const slug = c.req.param('slug');
  const data = await fetchJson<{ article: PublicArticle }>(`${c.env.API_BASE}/api/public/articles/${encodeURIComponent(slug)}`);
  if (!data?.article) {
    c.status(404);
    return c.html(page(host, 'Not found', `<h1>Page not found</h1><p class="muted">That article doesn't exist or has moved. <a href="/">Back to the homepage</a>.</p>`));
  }
  const a = data.article;
  const inner = `<article><h1>${esc(a.title)}</h1>${renderMarkdown(a.compliantContent)}</article>
<p class="muted" style="margin-top:28px"><a href="/">← More from ${esc(brandFor(host))}</a></p>`;
  c.header('cache-control', 'public, max-age=300');
  return c.html(page(host, a.title, inner));
});

// Legal / about / contact — simple, real pages so the site reads as legitimate to reviewers.
white.get('/:legal{about|contact|privacy|terms}', (c) => {
  const host = hostOf(c);
  const key = c.req.param('legal');
  const def = LEGAL[key]!;
  return c.html(page(host, def.title, `<h1>${esc(def.title)}</h1>${def.body(brandFor(host))}`));
});

white.notFound((c) => {
  const host = hostOf(c);
  c.status(404);
  return c.html(page(host, 'Not found', `<h1>Page not found</h1><p class="muted"><a href="/">Back to the homepage</a>.</p>`));
});

export default white;
