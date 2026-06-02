import { verifyCloakToken } from './cloak-token';

/**
 * The cloak gate — decides whether a money-page request may render the AFS unit, and supplies the
 * monetization params. It closes two holes:
 *   1. Direct article access — `/a/{slug}` (slugs are in the sitemap) rendering ads to anyone.
 *   2. The 302 `Location` leaking the monetized URL — the Worker now sends an opaque `?t=<token>`.
 *
 * Rollout is observe-first (set by `CLOAK_GATE_MODE`, default `observe`):
 *   - A valid signed token (`?t=`) → its params (a real, FB-originated click). Always monetizes.
 *   - observe + no/invalid token → fall back to the plaintext query params (legacy / pre-token
 *     Worker). Identical to today's behavior → ZERO revenue change while we confirm tokens flow.
 *   - enforce + no/invalid token → do NOT monetize (clean page). Closes #1 and any guessed-param hit.
 *
 * `CLOAK_TOKEN_SECRET` is server-only (never `NEXT_PUBLIC_*`); this helper runs only in server
 * components, so neither the secret nor the verification ever reaches the browser.
 */

export interface CloakParams {
  /** referrerAdCreative — Google requires it for source-controlled (our FB ad) traffic. */
  rc?: string;
  /** The campaign/offer AdSense channel (per-offer attribution). Canonical name across both pages. */
  ch?: string;
  rac?: string;
  styleId?: string;
  /** Redirect click id — threads conversion attribution through to /search. */
  txid?: string;
  /** The raw signed token, forwarded article → /search so the results page is gated too. */
  token?: string;
}

export interface CloakGate {
  /** Render the monetized unit? observe → always true; enforce → only with a valid token. */
  monetize: boolean;
  /** How this decision was reached — useful for a one-line server log during the rollout. */
  via: 'token' | 'plaintext' | 'blocked';
  params: CloakParams;
}

function str(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function gateMode(): 'observe' | 'enforce' {
  return process.env.CLOAK_GATE_MODE === 'enforce' ? 'enforce' : 'observe';
}

/**
 * Resolve the monetization context for a money-page request.
 * @param sp the request searchParams
 * @param nowMs current time (epoch ms) for token-expiry checks
 */
export async function resolveCloakGate(
  sp: Record<string, string | string[] | undefined>,
  nowMs: number,
): Promise<CloakGate> {
  const token = str(sp.t);
  const secret = process.env.CLOAK_TOKEN_SECRET;

  if (token && secret) {
    const payload = await verifyCloakToken(token, secret, nowMs);
    if (payload) {
      const p = payload.p;
      return {
        monetize: true,
        via: 'token',
        params: {
          rc: p.rc || undefined,
          ch: p.ch || undefined,
          rac: p.rac || undefined,
          styleId: p.styleId || undefined,
          txid: p.txid || undefined,
          token, // forward the same token on to /search
        },
      };
    }
  }

  // No valid token.
  if (gateMode() === 'enforce') {
    return { monetize: false, via: 'blocked', params: {} };
  }

  // OBSERVE: fall back to the plaintext params (today's behavior — zero revenue change). The channel
  // arrives as `ch` on the article page and `cid` on /search. Read `cid` FIRST: Google appends its
  // own `ch=1` click-telemetry param to the /search URL, so reading `ch` there would grab Google's
  // value, not ours. `cid` is absent on the article page, so it correctly falls through to `ch`.
  return {
    monetize: true,
    via: 'plaintext',
    params: {
      rc: str(sp.rc) || undefined,
      ch: str(sp.cid) || str(sp.ch) || undefined,
      rac: str(sp.rac) || undefined,
      styleId: str(sp.styleId) || undefined,
      txid: str(sp.txid) || undefined,
      token: undefined,
    },
  };
}
