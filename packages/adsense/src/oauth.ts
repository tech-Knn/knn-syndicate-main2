import { env } from '@knn/config';
import { AdsenseRequestError } from './errors.js';

/**
 * Google OAuth 2.0 for the platform's AdSense connection (mirrors `@knn/fb/oauth.ts`).
 * AdSense is a single PLATFORM account (the funnel's approved domain), so there's one
 * connection a SUPER_ADMIN connects — not per-buyer. We request offline access so Google
 * returns a refresh token (access tokens last ~1h); the worker refreshes on demand.
 *
 * Read-only scope — we only pull reports + list channels, never write to AdSense.
 * Pure library: keys come from `@knn/config`; persistence/crypto are the caller's.
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/adsense.readonly',
  'openid',
  'email',
] as const;

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

/** Build the Google consent URL. `access_type=offline` + `prompt=consent` → a refresh token. */
export function buildGoogleAuthUrl(state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope: string;
  email?: string;
}

export interface GoogleOAuthDeps {
  fetch: typeof fetch;
  tokenUrl: string;
}
// Resolve `fetch` lazily (per call) so tests can `vi.stubGlobal('fetch', …)`.
const defaultDeps: GoogleOAuthDeps = {
  fetch: (input, init) => fetch(input, init),
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

async function tokenRequest(
  body: Record<string, string>,
  deps: GoogleOAuthDeps,
): Promise<GoogleTokenResponse> {
  const res = await deps.fetch(deps.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new AdsenseRequestError(`Google token exchange failed (${res.status}): ${t.slice(0, 200)}`, res.status);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/** Best-effort email from the id_token (payload only — not a signature check; cosmetic). */
function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string };
    return typeof json.email === 'string' ? json.email : undefined;
  } catch {
    return undefined;
  }
}

export async function exchangeGoogleCode(code: string, deps: GoogleOAuthDeps = defaultDeps): Promise<GoogleTokens> {
  const r = await tokenRequest(
    {
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    },
    deps,
  );
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresInSec: r.expires_in ?? 3600,
    scope: r.scope ?? '',
    email: emailFromIdToken(r.id_token),
  };
}

export async function refreshGoogleToken(
  refreshToken: string,
  deps: GoogleOAuthDeps = defaultDeps,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const r = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
    deps,
  );
  return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 3600 };
}
