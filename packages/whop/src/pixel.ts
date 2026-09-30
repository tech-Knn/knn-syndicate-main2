import { WHOP_BIZ_ID_RE } from '@knn/shared';

/**
 * The Whop pixel (https://docs.whop.com/developer/ads/pixel): the snippet every page of a funnel carries so
 * Whop can see visitors, and the thing Whop's ad check looks for in a destination's HTML before an ad may
 * be created. It loads from, and reports to, `WHOP_PIXEL_ORIGIN`: allow that origin in any
 * Content-Security-Policy of a page that carries it.
 */
export const WHOP_PIXEL_ORIGIN = 'https://t.whop.tw';

/**
 * Whop's loader, byte for byte as published. Whop's checker finds the pixel by matching it in page
 * source, so never reformat, rename or "tidy" it. `pixel.test.ts` pins its hash.
 */
export const WHOP_PIXEL_LOADER =
  `!function(w,d,s,u,n,a,b){if(w[n])return;a=w[n]={q:[],t:+new Date,s:[],o:u,track:function(){a.q.push([+new Date].concat([].slice.call(arguments)))},setScope:function(){a.s=[].slice.call(arguments).filter(function(x){return typeof x==="string"});a.q.push([+new Date,"setScope"].concat(a.s))},scope:function(){var c=[].slice.call(arguments);return{track:function(){a.q.push([+new Date].concat([].slice.call(arguments)).concat([{__scope:c}]))}}}};b=d.createElement(s);b.async=1;b.src=u+"/s.js";d.getElementsByTagName(s)[0].parentNode.insertBefore(b,d.getElementsByTagName(s)[0])}(window,document,"script","https://t.whop.tw","whop");`;

/** A page may report to several Whop businesses; more than a handful means something is wrong. */
const MAX_SCOPES = 10;

/** Validate, trim and de-duplicate business ids. Throws on anything that is not a `biz_` id, because these end up inside a page. */
export function normalizeWhopScopes(bizIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of bizIds) {
    const id = String(raw).trim();
    if (!WHOP_BIZ_ID_RE.test(id)) throw new Error(`Not a Whop business id: ${JSON.stringify(id).slice(0, 60)}`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error('The Whop pixel needs at least one business id.');
  if (out.length > MAX_SCOPES) throw new Error(`The Whop pixel takes at most ${MAX_SCOPES} business ids.`);
  return out;
}

/**
 * The pixel's JavaScript for these businesses: the loader, the scope, and the page view. `whop.track("page")`
 * is part of Whop's own snippet: it is the ordinary page view, not a conversion.
 */
export function whopPixelJs(bizIds: readonly string[]): string {
  const scopes = normalizeWhopScopes(bizIds).map((id) => JSON.stringify(id)).join(',');
  return `${WHOP_PIXEL_LOADER}\nwhop.setScope(${scopes});\nwhop.track("page");`;
}

/** The snippet as a ready-to-paste `<script>` tag. Pass the page's CSP nonce when it uses one. */
export function whopPixelTag(bizIds: readonly string[], opts: { nonce?: string } = {}): string {
  if (opts.nonce !== undefined && !/^[A-Za-z0-9+/=_-]{8,128}$/.test(opts.nonce)) throw new Error('Invalid CSP nonce.');
  const attr = opts.nonce ? ` nonce="${opts.nonce}"` : '';
  return `<script${attr}>\n${whopPixelJs(bizIds)}\n</script>`;
}
