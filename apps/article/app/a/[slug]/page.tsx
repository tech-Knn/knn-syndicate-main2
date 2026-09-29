import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { articleBlocks, articleTeaser, resolvePublisherTerms } from '@knn/shared';
import { resolveCloakGate } from '../../_afs/cloak-gate';
import { resolveSiteConfig } from '../../_afs/site-config';
import { SiteFooter } from '../../_components/site-footer';
import { LanderBeacon } from '../../funnel-beacons';
import { RelatedSearchUnit } from './related-search-unit';
import styles from './article.module.css';

// Server-side base for the public article API. articles.<domain> is a different
// origin than the API (app.<domain>), so this is an absolute URL.
const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

interface PublicArticle {
  slug: string;
  title: string;
  compliantContent: string;
  query: string | null;
  keywords: string[];
  relatedSearchTerms: string[];
  /** Article's active-campaign AFS channel (server-side fallback when the visitor
   *  arrives without a signed cloak token — direct/organic/test URLs). Prevents
   *  the RSOC unit from firing untagged and later serving the AFS default `ch=1`. */
  channel: string | null;
  /** Same-purpose fallback for referrerAdCreative (required for paid traffic). */
  referrerAdCreative: string | null;
}

async function fetchArticle(slug: string): Promise<PublicArticle | null> {
  try {
    const res = await fetch(`${API_BASE}/api/public/articles/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { article: PublicArticle };
    return data.article;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await fetchArticle(slug);
  if (!article) return { title: 'Article not found' };
  const description = articleTeaser(article.compliantContent, 30, 160);
  // Canonical points at this article's own URL on the request host (one article ↔ one
  // canonical), which keeps the editorial page from looking like duplicate/thin content
  // to crawlers. Derived from the request Host (same origin serving the page); omitted if
  // the host is unavailable so we never emit a wrong canonical.
  let canonicalUrl: string | undefined;
  try {
    const host = (await headers()).get('host');
    if (host) canonicalUrl = `https://${host}/a/${encodeURIComponent(slug)}`;
  } catch {
    /* host unavailable → omit canonical */
  }
  return {
    title: article.title,
    description,
    ...(canonicalUrl ? { alternates: { canonical: canonicalUrl } } : {}),
    openGraph: {
      title: article.title,
      description,
      type: 'article',
      ...(canonicalUrl ? { url: canonicalUrl } : {}),
    },
  };
}

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const [article, site] = await Promise.all([fetchArticle(slug), resolveSiteConfig()]);
  if (!article) notFound();

  const blocks = articleBlocks(article.compliantContent);
  // Deterministic lead/body de-dup: the FULL first paragraph is the lead (above the AFS
  // unit), rendered verbatim from the body's first block — so the exact same block is
  // dropped from the body. The opening paragraph thus appears once, never duplicated nor
  // truncated. (The short `articleTeaser` is the meta-description summary only.)
  const leadBlock = blocks[0]?.type === 'p' ? blocks[0] : null;
  const lead = leadBlock?.text ?? '';
  const bodyBlocks = leadBlock ? blocks.slice(1) : blocks;
  // Cloak gate: a real FB click arrives with an opaque signed token (`?t=`) instead of plaintext AFS
  // params (the Worker stopped leaking them in the 302 Location). Decode it for the params; the money
  // page ALWAYS renders its unit (Google's crawler must see it to serve ads — see cloak-gate.ts), so
  // this only chooses the param source: token if valid, else the plaintext query.
  const gate = await resolveCloakGate(sp, Date.now());
  // `rc` (referrerAdCreative) stays TOKEN-ONLY on purpose. It literally means "referrer ad
  // creative" — sending it on organic/Googlebot visits looks like paid-traffic misrepresentation
  // and (empirically 2026-08-17→08-20) caused Google to degrade RSOC serving on affected articles.
  // Real paid clicks always carry a token, so paid traffic keeps its rc; organic doesn't.
  const referrerAdCreative = gate.params.rc;
  const txid = gate.params.txid;
  // The offer's AFS channel. Priority:
  //   1. Signed cloak-gate token (real FB paid click) — authoritative
  //   2. Article's active-campaign channel from the API (fallback for direct/organic visits so
  //      the /search chip click still tags the AFS ad request with a real channel).
  // "1" is Google's own default when no channel is set; treat it as absent so the DB fallback
  // can substitute a real channel instead of clobbering our attribution with Google's fallback.
  // Channel-in-pageOptions was verified accepted by this pubId on 2026-08-12 (`?withchannel=07793`
  // returned 5 chips), unlike rc — so restoring channel-only fallback is safe.
  const isValidChannel = (v: string | undefined): v is string => Boolean(v) && v !== '1';
  const channel = isValidChannel(gate.params.ch) ? gate.params.ch : article.channel ?? undefined;
  // Publisher-provided related-search terms (D27) — via the SAME resolver the dashboard's "Sent to
  // Google" panel uses, so what buyers see is exactly what is sent:
  //   · the buyer's custom terms from the SIGNED token (set live in the dashboard) → sent as entered;
  //   · else an unsigned plaintext `?terms=` (anyone can craft a URL) → treated like AI terms: cleaned;
  //   · else the article's AI related searches → campaign keywords, through the RSOC term cleaner.
  const signedCustom = gate.params.termsSigned && gate.params.terms ? gate.params.terms.split(',') : [];
  const unsignedTerms = !gate.params.termsSigned && gate.params.terms ? gate.params.terms.split(',') : [];
  const { terms: termList } = resolvePublisherTerms({
    custom: signedCustom,
    articleTerms: unsignedTerms.length ? unsignedTerms : article.relatedSearchTerms,
    keywords: article.keywords,
    query: article.query,
  });
  const terms = termList.length ? termList.join(',') : undefined;

  return (
    <div className={styles.page}>
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>

      {/* No top masthead/brand/byline on the money-page: open straight into the headline →
          lead → RSOC unit so the visitor's focus lands on the unit (matches the live RSOC
          funnels; reduces bounce). Legitimacy chrome lives in the footer + legal pages. */}
      <main id="main-content" className={styles.main}>
        {/* Paid visitors fire the `lander` (ViewContent) funnel event on view. */}
        <LanderBeacon clickId={txid} />
        {/* Server-side AFS channel cookie set. Runs during HTML parse — BEFORE React hydrates
            and BEFORE Google's RSOC iframe navigates the user to /search on chip click. The
            client useEffect in RelatedSearchUnit also sets this cookie (as a backup) but was
            observed racing with fast chip clicks in production, leaving /search without the
            channel → AdSense requests fired untagged → $0 attributed revenue for the campaign
            even when the account overall earned. Uses SameSite=None; Secure so the cookie
            survives the cross-context navigation from Google's RSOC iframe → /search — verified
            2026-08-12 that SameSite=Lax was being dropped in Chrome (incognito confirmed) when
            the chip click originates inside Google's cross-origin iframe. */}
        {(channel || referrerAdCreative) && (
          <script
            dangerouslySetInnerHTML={{
              __html: [
                channel ? `document.cookie="_rsoc_ch=${encodeURIComponent(channel)}; path=/; max-age=1800; SameSite=None; Secure";` : '',
                txid ? `document.cookie="_rsoc_txid=${encodeURIComponent(txid)}; path=/; max-age=1800; SameSite=None; Secure";` : '',
                referrerAdCreative ? `document.cookie="_rsoc_rc=${encodeURIComponent(referrerAdCreative)}; path=/; max-age=1800; SameSite=None; Secure";` : '',
              ].join(''),
            }}
          />
        )}
        <article className={styles.article}>
          <h1 className={styles.title}>{article.title}</h1>
          {lead && <p className={styles.lead}>{lead}</p>}

          {/* RSOC related-search unit (content-targeted). Clicks → /search results page. Always
              rendered (when the host has an AFS account): Google's crawler must see it to serve ads,
              and the money-vs-white cloaking is enforced upstream at the go.* Worker. The signed
              token (when present) is forwarded to /search so its params travel without plaintext. */}
          {gate.monetize && (
            <>
              <RelatedSearchUnit
                referrerAdCreative={referrerAdCreative}
                terms={terms}
                txid={txid}
                channel={channel}
                site={site}
              />
              {/* Tap/click the article title (h1) or any h2/h3 in the body → smooth-scroll to the
                  NEAREST chip strip that sits at or below the tapped heading. Falls back to the
                  nearest strip above only when the user is already past the last strip. This avoids
                  the disorienting back-jump that a naïve "always scroll to #relatedsearches1" would
                  cause when the user is reading deeper in the article. Reduces dead clicks flagged
                  by Clarity — the h1 title in particular concentrates the most dead clicks (users
                  tap the headline expecting interaction). Scoped to `<article>` so headings
                  elsewhere on the page (footer etc.) don't trigger it. */}
              <script
                dangerouslySetInnerHTML={{
                  __html:
                    "(function(){document.addEventListener('click',function(e){" +
                    "var el=e.target;if(!(el instanceof HTMLElement))return;" +
                    "var h=el.closest('h1, h2, h3');if(!h||!h.closest('article'))return;" +
                    "var hy=h.getBoundingClientRect().top;" +
                    "var t1=document.getElementById('relatedsearches1');" +
                    "var t2=document.getElementById('relatedsearches2');" +
                    "var arr=[];if(t1)arr.push(t1);if(t2)arr.push(t2);" +
                    "if(!arr.length)return;" +
                    "var target=null,bestTop=Infinity,i,ty;" +
                    "for(i=0;i<arr.length;i++){ty=arr[i].getBoundingClientRect().top;" +
                    "if(ty>=hy&&ty<bestTop){target=arr[i];bestTop=ty;}}" +
                    "if(!target){var bestAbove=-Infinity;" +
                    "for(i=0;i<arr.length;i++){ty=arr[i].getBoundingClientRect().top;" +
                    "if(ty>bestAbove){target=arr[i];bestAbove=ty;}}}" +
                    "if(!target)return;" +
                    "target.scrollIntoView({behavior:'smooth',block:'start'});" +
                    "},{passive:true});})();",
                }}
              />
            </>
          )}

          {/* One related-search unit per page (D26) — the one above, in <RelatedSearchUnit />. */}
          <div className={styles.body}>
            {bodyBlocks.map((block, i) => {
              if (block.type === 'h2') return <h2 key={i}>{block.text}</h2>;
              if (block.type === 'h3') return <h3 key={i}>{block.text}</h3>;
              if (block.type === 'ul')
                return (
                  <ul key={i}>
                    {block.items.map((it, j) => (
                      <li key={j}>{it}</li>
                    ))}
                  </ul>
                );
              if (block.type === 'ol')
                return (
                  <ol key={i}>
                    {block.items.map((it, j) => (
                      <li key={j}>{it}</li>
                    ))}
                  </ol>
                );
              return <p key={i}>{block.text}</p>;
            })}
          </div>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}
