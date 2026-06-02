import { describe, expect, it } from 'vitest';
import { fbAppCreds } from './app-creds.js';
import { FB_SCOPES, buildAuthUrl, buildAuthUrlWith } from './oauth.js';

describe('buildAuthUrlWith', () => {
  it('uses scope-based classic Facebook Login when no config id is set', () => {
    const url = new URL(buildAuthUrlWith('state-123', 'app-1', ''));
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBe(FB_SCOPES.join(','));
    expect(url.searchParams.get('config_id')).toBeNull();
  });

  it('uses the Facebook Login for Business config flow when a config id is set', () => {
    const url = new URL(buildAuthUrlWith('state-123', 'app-1', '1234567890'));
    expect(url.searchParams.get('config_id')).toBe('1234567890');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Permissions come from the configuration, not a scope list.
    expect(url.searchParams.get('scope')).toBeNull();
  });
});

describe('buildAuthUrl (app-kind aware)', () => {
  it('builds a dialog URL with the DATA app client id', () => {
    const url = new URL(buildAuthUrl('s', 'DATA'));
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(fbAppCreds('DATA').appId);
    expect(url.searchParams.get('state')).toBe('s');
  });

  it("falls back to the DATA app's client id for LAUNCH when no launch app is configured", () => {
    // In the test env FB_LAUNCH_APP_ID is unset, so LAUNCH resolves to the DATA creds.
    expect(new URL(buildAuthUrl('s', 'LAUNCH')).searchParams.get('client_id')).toBe(fbAppCreds('DATA').appId);
  });

  it("falls back to the DATA app's client id for VERIFY when no verify app is configured", () => {
    // In the test env FB_VERIFY_APP_ID is unset, so VERIFY resolves to the DATA creds.
    expect(new URL(buildAuthUrl('s', 'VERIFY')).searchParams.get('client_id')).toBe(fbAppCreds('DATA').appId);
  });
});
