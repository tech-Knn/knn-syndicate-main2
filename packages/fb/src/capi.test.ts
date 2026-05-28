import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendConversionEvent } from './capi.js';
import { FbRateLimiter } from './rate-limiter.js';

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendConversionEvent', () => {
  it('POSTs the event to /{pixelId}/events with the bearer token and data payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ events_received: 1, fbtrace_id: 'tr1' }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await sendConversionEvent(
      {
        pixelId: 'px_123',
        accessToken: 'tok_abc',
        event: {
          event_name: 'Search',
          event_time: 1779950000,
          event_id: 'txid-1',
          action_source: 'website',
          user_data: { fbc: 'fb.1.1779950000000.abc', client_ip_address: '1.2.3.4', client_user_agent: 'UA' },
          custom_data: { value: 0.05, currency: 'USD' },
        },
      },
      new FbRateLimiter(),
    );

    expect(out.events_received).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/px_123/events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
    const body = String(init.body);
    expect(body).toContain('data=');
    expect(decodeURIComponent(body)).toContain('"event_name":"Search"');
    expect(decodeURIComponent(body)).toContain('"event_id":"txid-1"');
  });

  it('includes test_event_code when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ events_received: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendConversionEvent(
      { pixelId: 'px_1', accessToken: 't', event: { event_name: 'Lead', event_time: 1, user_data: {} }, testEventCode: 'TEST123' },
      new FbRateLimiter(),
    );
    const body = decodeURIComponent(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toContain('test_event_code=TEST123');
  });

  it('throws (classified) on a non-OK response so the worker can retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ error: { message: 'bad', code: 100 } }, 400)));
    await expect(
      sendConversionEvent({ pixelId: 'px_1', accessToken: 't', event: { event_name: 'Search', event_time: 1, user_data: {} } }, new FbRateLimiter()),
    ).rejects.toThrow();
  });
});
