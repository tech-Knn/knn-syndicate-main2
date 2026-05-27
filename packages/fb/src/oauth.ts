import { env } from '@knn/config';
import { graphRequest } from './graph.js';

/** Permissions requested at connect time (spec §5.2.1). */
export const FB_SCOPES = [
  'ads_management',
  'ads_read',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
] as const;

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export function isFbConfigured(): boolean {
  return Boolean(env.FB_APP_ID && env.FB_APP_SECRET && env.FB_OAUTH_REDIRECT_URI);
}

export function buildAuthUrl(state: string): string {
  const url = new URL(`https://www.facebook.com/${env.FB_API_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', env.FB_APP_ID);
  url.searchParams.set('redirect_uri', env.FB_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', FB_SCOPES.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

export async function exchangeCodeForToken(
  code: string,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const r = await graphRequest<TokenResponse>({
    path: '/oauth/access_token',
    params: {
      client_id: env.FB_APP_ID,
      client_secret: env.FB_APP_SECRET,
      redirect_uri: env.FB_OAUTH_REDIRECT_URI,
      code,
    },
  });
  return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 0 };
}

/** Trade a short-lived token for a long-lived one (~60 days). */
export async function exchangeForLongLivedToken(
  shortToken: string,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const r = await graphRequest<TokenResponse>({
    path: '/oauth/access_token',
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.FB_APP_ID,
      client_secret: env.FB_APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 60 * 24 * 3_600 };
}

export async function getMe(accessToken: string): Promise<{ id: string; name: string }> {
  return graphRequest<{ id: string; name: string }>({
    path: '/me',
    params: { fields: 'id,name' },
    accessToken,
  });
}
