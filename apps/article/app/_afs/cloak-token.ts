/**
 * Cloak token — a short-lived signed blob that proves a click came from the redirect, and carries
 * the monetization params (rc/ch/rac/styleId/txid) so they never appear in the 302 Location.
 *
 * Format: `base64url(payloadJson).base64url(HMAC-SHA256(base64url(payloadJson), secret))`.
 * Uses Web Crypto (`crypto.subtle`) so the SAME code runs on the Cloudflare Worker (mint) and here
 * on the Next article server (verify). ⚠️ This file is duplicated verbatim from
 * `apps/redirect/src/cloak-token.ts` — keep the two identical (round-trip tests guard both).
 *
 * Server-only: imported solely by server components / the gate helper, so the secret + verify never
 * reach the browser bundle. The client only ever forwards the opaque token string.
 */

export interface CloakPayload {
  /** The AFS params the article needs (referrerAdCreative, channel, rac, styleId, txid, offerId). */
  p: Record<string, string>;
  /** Expiry, epoch ms. A real ad click lands immediately; a scanner replaying later is rejected. */
  exp: number;
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time string compare (avoid leaking the HMAC via early-exit timing). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacB64url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

/** Mint a signed token for the given payload. */
export async function signCloakToken(payload: CloakPayload, secret: string): Promise<string> {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacB64url(body, secret);
  return `${body}.${sig}`;
}

/** Verify a token: returns the payload if the HMAC matches and it hasn't expired, else null. */
export async function verifyCloakToken(token: string, secret: string, nowMs: number): Promise<CloakPayload | null> {
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = await hmacB64url(body, secret);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  let payload: CloakPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as CloakPayload;
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || nowMs > payload.exp) return null;
  if (!payload.p || typeof payload.p !== 'object') return null;
  return payload;
}
