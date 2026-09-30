/**
 * Whop scope token — a signed hint from the redirect Worker to the page a go-link lands on, saying WHICH
 * Whop business's pixel that page should carry (D33). Whop checks an ad's destination by loading the URL,
 * following redirects and reading the final page for its pixel; so the page our link ends on when nobody
 * proves they are a real ad click (the white site, or the plain article in normal funnel mode) carries it.
 *
 * Why signed: the page must never render a pixel for a business id anyone can put in a URL. An unsigned
 * `?_ws=biz_…` would let a stranger make our pages report page views into somebody else's Whop account.
 * It carries no expiry on purpose: the value is stable per business, so a cached page stays correct.
 *
 * Format: `base64url(bizId).base64url(HMAC-SHA256("whop-scope/v1:" + base64url(bizId), secret))`.
 * Web Crypto only, so the SAME code runs on Cloudflare Workers (sign and verify) and in the Next article
 * server (verify). ⚠️ This file is duplicated verbatim at `apps/white/src/whop-scope.ts` and
 * `apps/article/app/_afs/whop-scope.ts`: keep the three identical (`whop-scope.test.ts` guards it).
 */

/** The query parameter that carries the token. Not one of Whop's or Meta's reserved names. */
export const WHOP_SCOPE_PARAM = '_ws';

const BIZ_ID_RE = /^biz_[A-Za-z0-9]{6,40}$/;
const CONTEXT = 'whop-scope/v1:';
const MAX_TOKEN_LENGTH = 200;

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToText(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
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

/** Mint the token for a Whop business id. Throws for anything that is not a `biz_` id. */
export async function signWhopScope(bizId: string, secret: string): Promise<string> {
  if (!BIZ_ID_RE.test(bizId)) throw new Error('Not a Whop business id');
  const body = bytesToB64url(new TextEncoder().encode(bizId));
  return `${body}.${await hmacB64url(CONTEXT + body, secret)}`;
}

/** The business id a valid token names, or null (no token, no secret, wrong signature, malformed). */
export async function verifyWhopScope(token: string | null | undefined, secret: string | undefined): Promise<string | null> {
  if (!token || !secret || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = await hmacB64url(CONTEXT + body, secret);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const bizId = b64urlToText(body);
    return BIZ_ID_RE.test(bizId) ? bizId : null;
  } catch {
    return null;
  }
}
