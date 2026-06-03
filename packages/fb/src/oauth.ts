import { env } from '@knn/config';
import { type FbAppKind, fbAppCreds } from './app-creds.js';
import { graphRequest } from './graph.js';

/** Permissions requested at connect time (spec §5.2.1). */
export const FB_SCOPES = [
  'ads_management',
  'ads_read',
  'pages_show_list',
  // Required (with pages_show_list) for /act_<id>/promote_pages to return the FULL set of pages an ad
  // account can advertise — without it FB only returns pages already wired for ads, so the wizard's
  // page picker under-reports. NOTE: when a Facebook Login for Business config is used (FB_*_CONFIG_ID),
  // scopes come from that saved config — add `pages_manage_ads` to it in the Meta dashboard too.
  'pages_manage_ads',
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

/**
 * Build the OAuth dialog URL. Two flows:
 * - Facebook Login for Business (when a `configId` is set): permissions come from
 *   the saved login configuration, so we pass `config_id` (and force a `code`
 *   response) instead of a `scope` list. This is the modern path for ads access.
 * - Classic Facebook Login (no `configId`): request permissions via `scope`.
 */
/** Pure URL builder (no env) — kept separate so the scope-vs-config branch is unit-testable. */
export function buildAuthUrlWith(state: string, appId: string, configId: string): string {
  const url = new URL(`https://www.facebook.com/${env.FB_API_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  // The redirect URI is shared by both apps — add this same callback to each app in Meta.
  url.searchParams.set('redirect_uri', env.FB_OAUTH_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (configId) {
    url.searchParams.set('config_id', configId);
    url.searchParams.set('override_default_response_type', 'true');
  } else {
    url.searchParams.set('scope', FB_SCOPES.join(','));
  }
  return url.toString();
}

export function buildAuthUrl(state: string, appKind: FbAppKind = 'DATA'): string {
  const { appId, configId } = fbAppCreds(appKind);
  return buildAuthUrlWith(state, appId, configId);
}

export async function exchangeCodeForToken(
  code: string,
  appKind: FbAppKind = 'DATA',
): Promise<{ accessToken: string; expiresInSec: number }> {
  const { appId, appSecret } = fbAppCreds(appKind);
  const r = await graphRequest<TokenResponse>({
    path: '/oauth/access_token',
    params: {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: env.FB_OAUTH_REDIRECT_URI,
      code,
    },
  });
  return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 0 };
}

/** Trade a short-lived token for a long-lived one (~60 days). DATA app only in practice. */
export async function exchangeForLongLivedToken(
  shortToken: string,
  appKind: FbAppKind = 'DATA',
): Promise<{ accessToken: string; expiresInSec: number }> {
  const { appId, appSecret } = fbAppCreds(appKind);
  const r = await graphRequest<TokenResponse>({
    path: '/oauth/access_token',
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  });
  return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 60 * 24 * 3_600 };
}

export async function getMe(
  accessToken: string,
  appKind: FbAppKind = 'DATA',
): Promise<{ id: string; name: string }> {
  return graphRequest<{ id: string; name: string }>({
    path: '/me',
    params: { fields: 'id,name' },
    accessToken,
    appKind,
  });
}
