import { describe, expect, it } from 'vitest';
import { fbAppCreds, hasLaunchApp, hasVerifyApp } from './app-creds.js';

// The test env configures only the DATA app (FB_APP_*); FB_LAUNCH_*/FB_VERIFY_* are unset. So the
// LAUNCH and VERIFY roles must transparently fall back to the DATA app — proving single-app installs
// are unaffected by the optional extra apps.
describe('fbAppCreds / hasLaunchApp / hasVerifyApp', () => {
  it('reports no launch app when FB_LAUNCH_* is unset', () => {
    expect(hasLaunchApp()).toBe(false);
  });

  it('reports no verify app when FB_VERIFY_* is unset', () => {
    expect(hasVerifyApp()).toBe(false);
  });

  it('DATA returns the main app creds', () => {
    const data = fbAppCreds('DATA');
    expect(data).toEqual(fbAppCreds()); // default kind is DATA
    expect(typeof data.appId).toBe('string');
    expect(typeof data.appSecret).toBe('string');
  });

  it('LAUNCH falls back to the DATA app creds when no launch app is configured', () => {
    expect(fbAppCreds('LAUNCH')).toEqual(fbAppCreds('DATA'));
  });

  it('VERIFY falls back to the DATA app creds when no verify app is configured', () => {
    expect(fbAppCreds('VERIFY')).toEqual(fbAppCreds('DATA'));
  });
});
