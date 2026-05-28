import { describe, expect, it } from 'vitest';
import {
  buildGoogleAuthUrl,
  discoverChannels,
  discoverChannelsInRanges,
  exchangeGoogleCode,
  listCustomChannels,
  parseChannelRanges,
  refreshGoogleToken,
  toCustomChannel,
} from './index.js';

/** A fetch stub that returns a sequence of JSON bodies and records the requests. */
function stubFetch(responses: unknown[]): { fetch: typeof fetch; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  let i = 0;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function idToken(payload: object): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `h.${b64}.s`;
}

describe('Google OAuth', () => {
  it('builds a consent URL with offline access + the read-only AdSense scope', () => {
    const url = new URL(buildGoogleAuthUrl('state-xyz'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('scope')).toContain('adsense.readonly');
  });

  it('exchanges a code for tokens (authorization_code) and decodes the email', async () => {
    const { fetch, calls } = stubFetch([
      { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: 'adsense.readonly', id_token: idToken({ email: 'pub@knn.co' }) },
    ]);
    const tokens = await exchangeGoogleCode('the-code', { fetch, tokenUrl: 'https://oauth2.googleapis.com/token' });
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.expiresInSec).toBe(3599);
    expect(tokens.email).toBe('pub@knn.co');
    expect(calls[0]!.body).toContain('grant_type=authorization_code');
    expect(calls[0]!.body).toContain('the-code');
  });

  it('refreshes an access token (refresh_token grant)', async () => {
    const { fetch, calls } = stubFetch([{ access_token: 'at-2', expires_in: 3600 }]);
    const r = await refreshGoogleToken('rt-1', { fetch, tokenUrl: 'https://oauth2.googleapis.com/token' });
    expect(r.accessToken).toBe('at-2');
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
  });
});

describe('AdSense Management listing', () => {
  it('extracts the numeric channel id from a resource name', () => {
    const ch = toCustomChannel({ name: 'accounts/pub-9/adclients/ca-pub-9/customchannels/1234567890', displayName: 'auto-us' });
    expect(ch.channelId).toBe('1234567890');
    expect(ch.displayName).toBe('auto-us');
  });

  it('lists custom channels with pagination', async () => {
    const { fetch } = stubFetch([
      { customChannels: [{ name: 'accounts/p/adclients/c/customchannels/1', displayName: 'a' }], nextPageToken: 'tok' },
      { customChannels: [{ name: 'accounts/p/adclients/c/customchannels/2', displayName: 'b' }] },
    ]);
    const channels = await listCustomChannels('at', 'accounts/p/adclients/c', { fetch, baseUrl: 'https://adsense.googleapis.com/v2' });
    expect(channels.map((c) => c.channelId)).toEqual(['1', '2']);
  });

  it('parses channel-range specs (normalizes reversed; single ids)', () => {
    expect(parseChannelRanges('03700-05000, 00500')).toEqual([
      { start: 3700, end: 5000 },
      { start: 500, end: 500 },
    ]);
    expect(parseChannelRanges('5000-3700')).toEqual([{ start: 3700, end: 5000 }]);
  });

  it('discoverChannelsInRanges filters to the ranges and early-stops past the max', async () => {
    const page = (ids: string[], next?: string) => ({
      customChannels: ids.map((id) => ({ name: `accounts/p/adclients/c/customchannels/${id}`, displayName: id })),
      ...(next ? { nextPageToken: next } : {}),
    });
    const { fetch, calls } = stubFetch([
      page(['0498', '0499', '0500', '0501', '0502', '0503'], 'p2'),
      page(['0600']), // page 2 — must NOT be fetched (we overshot 501 on page 1)
    ]);
    const chs = await discoverChannelsInRanges('at', 'accounts/p/adclients/c', [{ start: 500, end: 501 }], {
      fetch,
      baseUrl: 'https://adsense.googleapis.com/v2',
    });
    expect(chs.map((c) => c.channelId)).toEqual(['0500', '0501']);
    expect(calls.length).toBe(1); // stopped after seeing 0502 (> max end), no page 2
  });

  it('discoverChannels filters to AFS ad clients when afsOnly is set', async () => {
    const { fetch, calls } = stubFetch([
      { adClients: [{ name: 'accounts/p/adclients/afs', productCode: 'AFS' }, { name: 'accounts/p/adclients/afc', productCode: 'AFC' }] },
      { customChannels: [{ name: 'accounts/p/adclients/afs/customchannels/99' }] },
    ]);
    const channels = await discoverChannels('at', 'accounts/p', { afsOnly: true }, { fetch, baseUrl: 'https://adsense.googleapis.com/v2' });
    expect(channels.map((c) => c.channelId)).toEqual(['99']);
    // only the AFS ad client's channels were fetched (1 adclients call + 1 customchannels call)
    expect(calls.some((c) => c.url.includes('/adclients/afc/customchannels'))).toBe(false);
  });
});
