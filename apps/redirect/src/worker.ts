import { Hono } from 'hono';
import { signCloakToken } from './cloak-token.js';
import { type RedirectConfig, resolveRedirect } from './resolve.js';

/**
 * Edge redirect engine — Hono on Cloudflare Workers (D3, refined to edge after
 * Phase-7 research: a single origin can't hit <50ms for a global FB audience;
 * Workers serve from 300+ PoPs at ~8–25ms). Per-ad configs live in Workers KV
 * (`redirect:{redirectId}`), write-through-synced from the origin (Postgres =
 * source of truth) on launch/update — so the hot path is a single KV read
 * (1–5ms) + the pure `resolveRedirect`, with no origin round-trip.
 *
 * Run/deploy with wrangler (see wrangler.toml). The decision logic is shared with
 * the unit tests in resolve.test.ts.
 */

/** Minimal Workers-KV surface we use (avoids @cloudflare/workers-types in the
 *  Node typecheck; wrangler injects the real binding at deploy). */
interface Kv {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  REDIRECTS: Kv;
  /** Generic fallback when a redirect id is unknown (never 404 a paid click). */
  ARTICLE_FALLBACK?: string;
  /** Cloak ad-id verification mode: 'observe' (default — route unchanged, only measure) | 'enforce'. */
  CLOAK_VERIFY_MODE?: string;
  /** Where to beacon each cloak decision (money/white + verify outcome). Empty → telemetry off. */
  CLOAK_TELEMETRY_URL?: string;
  /** Shared HMAC secret for the cloak token. Set → money 302s carry an opaque `?t=` instead of
   *  plaintext AFS params (closes the Location leak). Unset → legacy plaintext params (current). */
  CLOAK_TOKEN_SECRET?: string;
}

const key = (id: string): string => `redirect:${id}`;
const DEFAULT_FALLBACK = 'https://articles.10linesabout.com/';
/** Cloak-token lifetime: long enough for a reading session + a later related-search click on the
 *  article, short enough that a captured token can't be replayed hours later. */
const CLOAK_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Attribution click id (txid). Uses the Web Crypto global present on Workers + Node 19+. */
function mintTxid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `tx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export const worker = new Hono<{ Bindings: Env }>();

worker.get('/health/live', (c) => c.json({ status: 'ok' }));

worker.get('/go/:id', async (c) => {
  const fallback = c.env.ARTICLE_FALLBACK ?? DEFAULT_FALLBACK;
  const raw = await c.env.REDIRECTS.get(key(c.req.param('id')), 'text');
  if (!raw) return c.redirect(fallback, 302);

  let config: RedirectConfig;
  try {
    config = JSON.parse(raw) as RedirectConfig;
  } catch {
    return c.redirect(fallback, 302);
  }

  // Cloak ad-id verification mode is global (one switch to flip): default OBSERVE = route exactly as
  // today, only measure. Set CLOAK_VERIFY_MODE=enforce (and redeploy) once the stats prove it's safe.
  config.verifyMode = c.env.CLOAK_VERIFY_MODE === 'enforce' ? 'enforce' : 'observe';

  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const decision = resolveRedirect(config, query, { txid: mintTxid() });

  // Beacon the decision (money/white + the would-be-enforce ad-id outcome) so the money-vs-white
  // split + macro-hit rate are visible BEFORE enforcing. Fire-and-forget; never blocks the 302.
  if (c.env.CLOAK_TELEMETRY_URL && config.campaignId) {
    const t = `${c.env.CLOAK_TELEMETRY_URL}?cid=${encodeURIComponent(config.campaignId)}&route=${decision.verify.route}&v=${decision.verify.outcome}`;
    c.executionCtx.waitUntil(fetch(t, { method: 'POST' }).then(() => undefined).catch(() => undefined));
  }

  // On a funnel-bound (paid + active) click, log txid → {redirectId, fbclid, ts, fbp} to
  // KV so the later conversion beacon can resolve the ad's pixel + the buyer's token, the
  // fbclid for attribution, the CLICK timestamp (feeds `fbc`'s middle field — must be the
  // FB-ad-click time, not the conversion time, or Facebook rejects the match), and a
  // synthesized `fbp` browser id (pure-S2S: no in-browser Meta pixel to set `_fbp`, so we
  // mint one here and reuse it across every funnel event for this click — Facebook accepts
  // the value regardless of whether it came from a cookie or the server, only the format
  // and stability-per-visitor matter for EMQ). Fire-and-forget (waitUntil) — never blocks
  // the 302.
  if (decision.paid && config.active) {
    const clickTimeMs = Date.now();
    // `fb.<subdomainIndex>.<creationTime>.<random>` — subdomainIndex=1 like real _fbp cookies
    // on a 2-part apex; `random` is a 10-digit integer.
    const rand10 = Math.floor(1_000_000_000 + Math.random() * 9_000_000_000).toString();
    const fbp = `fb.1.${clickTimeMs}.${rand10}`;
    // Include the chosen offer (Phase E) so revenue/conversions attribute per-offer.
    const record = JSON.stringify({
      redirectId: c.req.param('id'),
      fbclid: query.fbclid,
      offerId: decision.offerId,
      ts: clickTimeMs,
      fbp,
    });
    c.executionCtx.waitUntil(c.env.REDIRECTS.put(`click:${decision.txid}`, record, { expirationTtl: 604_800 }));
  }

  // Mint a signed cloak token so the money 302's `Location` carries NO plaintext AFS params — a
  // header scanner sees only the slug + an opaque `?t=`. The article decodes it (and, once flipped
  // to enforce, renders ads ONLY with a valid token, closing direct-article-access too). Done only
  // for the money route when a secret is configured; otherwise the legacy plaintext URL is used.
  // Failure to mint never blocks the click — fall back to the plaintext Location.
  let location = decision.location;
  if (decision.verify.route === 'money' && c.env.CLOAK_TOKEN_SECRET) {
    try {
      const u = new URL(decision.location);
      const p: Record<string, string> = {};
      for (const [k, v] of u.searchParams) p[k] = v;
      const token = await signCloakToken({ p, exp: Date.now() + CLOAK_TOKEN_TTL_MS }, c.env.CLOAK_TOKEN_SECRET);
      // Carry the AFS channel as `cid` OUTSIDE the token. Google's related-search unit strips `t`
      // (it's in ignoredPageParams) when building the /search URL and appends its own `ch=1`
      // click-telemetry param — so /search reads `1` as the channel. `cid` is not in
      // ignoredPageParams, so it survives the hop; cloak-gate already reads `cid` before `ch`.
      const chan = u.searchParams.get('ch');
      location = `${u.origin}${u.pathname}?t=${encodeURIComponent(token)}${chan ? `&cid=${encodeURIComponent(chan)}` : ''}`;
    } catch {
      location = decision.location;
    }
  }

  // Cache-Control: never cache the 302 (the txid + split must vary per click).
  c.header('Cache-Control', 'no-store');
  return c.redirect(location, 302);
});

export default worker;
