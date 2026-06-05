import { verifyCloakToken } from './cloak-token';

/**
 * The cloak gate — supplies the AFS monetization params for a money-page request.
 *
 * The money page (`articles.*`) is the CLEAN, Google-facing monetized site: Google's AdSense / RSOC
 * crawler MUST be able to load it and see the ad unit, or Google never approves/serves ads on it
 * (→ the unit never fills → $0 revenue). So this page ALWAYS renders its unit. The cloaking — who is
 * sent to the money page vs the white (safe) page — is enforced UPSTREAM at the `go.*` redirect
 * Worker (`CLOAK_VERIFY_MODE` kaid verification), which is the correct layer and is unaffected here.
 *
 * Params are sourced from an opaque signed token when present (`?t=`, minted by the Worker so the 302
 * `Location` leaks no plaintext AFS params), otherwise from the plaintext query params (Google's
 * crawler, direct hits, or a pre-token Worker). `CLOAK_TOKEN_SECRET` is server-only (never
 * `NEXT_PUBLIC_*`); this helper runs only in server components, so neither the secret nor the
 * verification ever reaches the browser.
 *
 * ⚠️ History: an earlier `CLOAK_GATE_MODE=enforce` rendered the unit ONLY for a valid token — which
 * also hid it from Google's crawler (a tokenless request), so ads never served and revenue was $0.
 * The money page must always show the unit (Google's anti-cloaking policy also requires the crawler
 * see the same content as users); direct article access is acceptable — these slugs are in the
 * sitemap / Google-indexed regardless. The token now only secures param passing, never gates render.
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
  /** The raw signed token, forwarded article → /search so the results page gets the same params. */
  token?: string;
}

export interface CloakGate {
  /** Always true: the money page always renders its unit (cloaking is upstream at the `go.*` Worker). */
  monetize: boolean;
  /** How the params were sourced — useful for a one-line server log. */
  via: 'token' | 'plaintext';
  params: CloakParams;
}

function str(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Resolve the monetization context for a money-page request. Always monetizes; the only question is
 * whether the AFS params come from a valid signed token or the plaintext query.
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

  // No valid token → plaintext params (Google's crawler, a direct hit, or a pre-token Worker). The
  // channel arrives as `ch` on the article page and `cid` on /search. Read `cid` FIRST: Google's
  // results unit appends its own `ch=1` click-telemetry param to the /search URL, so reading `ch`
  // there would grab Google's value, not ours. `cid` is absent on the article page, so it correctly
  // falls through to `ch`.
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
