import { env } from '@knn/config';

/**
 * Which Facebook app a token/call belongs to:
 * - `DATA`   — the main app (FB_APP_*). Long-lived (~60d) per-user token. Used for ALL
 *   reads/sync/insights/CAPI + the daily token refresh.
 * - `LAUNCH` — an optional SECOND app (FB_LAUNCH_*). Short-lived token. Used ONLY to
 *   create/modify ads, because the DATA app's long-lived token trips Facebook's
 *   `31/3858385` ad-publish security checkpoint while a fresh short-lived token from a
 *   separate app does not. Falls back to the DATA app when FB_LAUNCH_* is unset.
 *
 * This is a temporary split (`#two-app`) until the checkpoint is solved at the
 * account/IP level; it's intentionally additive so single-app installs are unaffected.
 */
export type FbAppKind = 'DATA' | 'LAUNCH';

export interface FbAppCreds {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (may be '' → classic scope flow). */
  configId: string;
}

/** True when a distinct LAUNCH app is configured (separate id + secret from the DATA app). */
export function hasLaunchApp(): boolean {
  return Boolean(env.FB_LAUNCH_APP_ID && env.FB_LAUNCH_APP_SECRET);
}

/**
 * Resolve the app credentials for a given role. `LAUNCH` returns the launch app's creds
 * when configured, otherwise transparently falls back to the DATA app — so a call tagged
 * `LAUNCH` on a single-app install just uses the only app there is.
 */
export function fbAppCreds(kind: FbAppKind = 'DATA'): FbAppCreds {
  if (kind === 'LAUNCH' && hasLaunchApp()) {
    return {
      appId: env.FB_LAUNCH_APP_ID,
      appSecret: env.FB_LAUNCH_APP_SECRET,
      configId: env.FB_LAUNCH_CONFIG_ID || env.FB_LOGIN_CONFIG_ID,
    };
  }
  return { appId: env.FB_APP_ID, appSecret: env.FB_APP_SECRET, configId: env.FB_LOGIN_CONFIG_ID };
}
