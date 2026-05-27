import { describe, expect, it } from 'vitest';
import { FB_SCOPES, buildAuthUrl } from './oauth.js';

describe('buildAuthUrl', () => {
  it('uses scope-based classic Facebook Login when no config id is set', () => {
    const url = new URL(buildAuthUrl('state-123', ''));
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBe(FB_SCOPES.join(','));
    expect(url.searchParams.get('config_id')).toBeNull();
  });

  it('uses the Facebook Login for Business config flow when a config id is set', () => {
    const url = new URL(buildAuthUrl('state-123', '1234567890'));
    expect(url.searchParams.get('config_id')).toBe('1234567890');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Permissions come from the configuration, not a scope list.
    expect(url.searchParams.get('scope')).toBeNull();
  });
});
