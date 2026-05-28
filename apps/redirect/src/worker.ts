import { Hono } from 'hono';
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
}

const key = (id: string): string => `redirect:${id}`;
const DEFAULT_FALLBACK = 'https://articles.10linesabout.com/';

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

  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const decision = resolveRedirect(config, query, { txid: mintTxid() });

  // On a funnel-bound (paid + active) click, log txid → {redirectId, fbclid} to KV so
  // the later conversion beacon can resolve the ad's pixel + the buyer's token and the
  // fbclid for attribution. Fire-and-forget (waitUntil) — never blocks the 302.
  if (decision.paid && config.active) {
    // Include the chosen offer (Phase E) so revenue/conversions attribute per-offer.
    const record = JSON.stringify({
      redirectId: c.req.param('id'),
      fbclid: query.fbclid,
      offerId: decision.offerId,
      ts: Date.now(),
    });
    c.executionCtx.waitUntil(c.env.REDIRECTS.put(`click:${decision.txid}`, record, { expirationTtl: 604_800 }));
  }

  // Cache-Control: never cache the 302 (the txid + split must vary per click).
  c.header('Cache-Control', 'no-store');
  return c.redirect(decision.location, 302);
});

export default worker;
