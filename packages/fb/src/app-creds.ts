import { env } from '@knn/config';

/**
 * Which Facebook app a token/call belongs to:
 * - `DATA`   — the main app (FB_APP_*). Long-lived (~60d) per-user token. Used for ALL
 *   reads/sync/insights/CAPI + the daily token refresh.
 * - `LAUNCH` — an optional SECOND app (FB_LAUNCH_*). Short-lived token. Used ONLY to
 *   create/modify ads, because the DATA app's long-lived token trips Facebook's
 *   `31/3858385` ad-publish security checkpoint while a fresh short-lived token from a
 *   separate app does not. Falls back to the DATA app when FB_LAUNCH_* is unset.
 * - `VERIFY` — an optional THIRD app (FB_VERIFY_*) with **Advanced Access** approved. Behaves
 *   like DATA (long-lived token, syncs assets) AND publishes ads directly with its own
 *   `ads_management` token — so a single connection does sync + launch with no LAUNCH detour.
 *   Used to verify the post-App-Review path (any user, not just Testers, can connect). Falls
 *   back to the DATA app when FB_VERIFY_* is unset.
 *
 * The DATA/LAUNCH split is a temporary measure (`#two-app`) until the checkpoint is solved at
 * the account/IP level; VERIFY is the candidate end-state. All of this is intentionally additive
 * so single-app installs are unaffected.
 */
export type FbAppKind = 'DATA' | 'LAUNCH' | 'VERIFY';

export interface FbAppCreds {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (may be '' → classic scope flow). */
  configId: string;
  /** Graph API version for THIS app's OAuth dialog + token exchange (entry == exit). */
  apiVersion: string;
}

/** True when a distinct LAUNCH app is configured (separate id + secret from the DATA app). */
export function hasLaunchApp(): boolean {
  return Boolean(env.FB_LAUNCH_APP_ID && env.FB_LAUNCH_APP_SECRET);
}

/** True when the Advanced-Access VERIFY app is configured (separate id + secret). */
export function hasVerifyApp(): boolean {
  return Boolean(env.FB_VERIFY_APP_ID && env.FB_VERIFY_APP_SECRET);
}

/**
 * Resolve the app credentials for a given role. `LAUNCH`/`VERIFY` return their app's creds when
 * configured, otherwise transparently fall back to the DATA app — so a call tagged for an
 * unconfigured app just uses the only app there is. `VERIFY` has no Login-config fallback: when
 * FB_VERIFY_CONFIG_ID is unset, OAuth uses an explicit scope list (configId '').
 */
export function fbAppCreds(kind: FbAppKind = 'DATA'): FbAppCreds {
  if (kind === 'LAUNCH' && hasLaunchApp()) {
    return {
      appId: env.FB_LAUNCH_APP_ID,
      appSecret: env.FB_LAUNCH_APP_SECRET,
      configId: env.FB_LAUNCH_CONFIG_ID || env.FB_LOGIN_CONFIG_ID,
      apiVersion: env.FB_API_VERSION,
    };
  }
  if (kind === 'VERIFY' && hasVerifyApp()) {
    return {
      appId: env.FB_VERIFY_APP_ID,
      appSecret: env.FB_VERIFY_APP_SECRET,
      // VERIFY is an "App type: Business" app, which Facebook FORCES through Login for Business —
      // the dialog renders at /dialog/oauth/business/ even when we request the plain scope flow.
      // That flow REQUIRES a Login Configuration (config_id); without one, FB runs a business login
      // with no configuration and the issued code can't be exchanged (code 100 / subcode 36008).
      // So VERIFY must send its config_id. (The earlier config_id failure was the app's empty
      // App Domains, since fixed — so config_id + App Domains is the combination that should work.)
      configId: env.FB_VERIFY_CONFIG_ID,
      // Business-app login runs at a newer Graph version; mint AND redeem the code at the same one.
      apiVersion: env.FB_VERIFY_API_VERSION,
    };
  }
  return {
    appId: env.FB_APP_ID,
    appSecret: env.FB_APP_SECRET,
    configId: env.FB_LOGIN_CONFIG_ID,
    apiVersion: env.FB_API_VERSION,
  };
}
