/**
 * The Whop pixel for ONE business, as a ready-to-insert `<script>` tag (D33). Used by the white Worker and
 * the article server, which render it only when a request carries a valid signed scope (whop-scope.ts).
 *
 * ⚠️ Neither of those apps may import a workspace package, so this is a deliberate copy of the canonical
 * `@knn/whop` `pixel.ts`; `packages/whop/src/pixel.test.ts` fails if the loader here ever differs from it
 * (Whop finds the pixel by matching its loader in page source, so it must stay byte for byte).
 * Duplicated verbatim at `apps/white/src/whop-pixel.ts` and `apps/article/app/_afs/whop-pixel.ts`.
 */

const BIZ_ID_RE = /^biz_[A-Za-z0-9]{6,40}$/;

/** Whop's loader, exactly as published at docs.whop.com/developer/ads/pixel. */
export const WHOP_PIXEL_LOADER =
  `!function(w,d,s,u,n,a,b){if(w[n])return;a=w[n]={q:[],t:+new Date,s:[],o:u,track:function(){a.q.push([+new Date].concat([].slice.call(arguments)))},setScope:function(){a.s=[].slice.call(arguments).filter(function(x){return typeof x==="string"});a.q.push([+new Date,"setScope"].concat(a.s))},scope:function(){var c=[].slice.call(arguments);return{track:function(){a.q.push([+new Date].concat([].slice.call(arguments)).concat([{__scope:c}]))}}}};b=d.createElement(s);b.async=1;b.src=u+"/s.js";d.getElementsByTagName(s)[0].parentNode.insertBefore(b,d.getElementsByTagName(s)[0])}(window,document,"script","https://t.whop.tw","whop");`;

/** The pixel's JavaScript for one business: the loader, the scope, and the ordinary page view. Throws for a non-business id. */
export function whopPixelJs(bizId: string): string {
  if (!BIZ_ID_RE.test(bizId)) throw new Error('Not a Whop business id');
  return `${WHOP_PIXEL_LOADER}\nwhop.setScope(${JSON.stringify(bizId)});\nwhop.track("page");`;
}

/** The same as a ready-to-insert `<script>` tag. */
export function whopPixelTag(bizId: string): string {
  return `<script>\n${whopPixelJs(bizId)}\n</script>`;
}
