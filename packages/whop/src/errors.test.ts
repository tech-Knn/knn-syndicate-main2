import { describe, expect, it } from 'vitest';
import { WhopApiError, isWhopError, parseWhopErrorBody, retryAfterMs, whopErrorKind } from './errors.js';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('whopErrorKind', () => {
  it('maps status codes to kinds', () => {
    expect(whopErrorKind(401)).toBe('auth');
    expect(whopErrorKind(402)).toBe('payment_required');
    expect(whopErrorKind(403)).toBe('permission');
    expect(whopErrorKind(404)).toBe('not_found');
    expect(whopErrorKind(409)).toBe('conflict');
    expect(whopErrorKind(429)).toBe('rate_limited');
    expect(whopErrorKind(500)).toBe('server');
    expect(whopErrorKind(503)).toBe('server');
    expect(whopErrorKind(400)).toBe('validation');
    expect(whopErrorKind(422)).toBe('validation');
  });
});

describe('parseWhopErrorBody', () => {
  it('reads the standard { error: { type, message } } shape', () => {
    expect(parseWhopErrorBody('{"error":{"type":"rate_limit_exceeded","message":"Try again in 12 seconds."}}')).toMatchObject({
      type: 'rate_limit_exceeded',
      message: 'Try again in 12 seconds.',
    });
  });
  it('reads the code + message variant and a deposit url', () => {
    const p = parseWhopErrorBody('{"error":{"code":"invalid_request","message":"Missing required parameter: company_id"},"deposit_url":"https://whop.com/deposit"}');
    expect(p).toMatchObject({ code: 'invalid_request', message: 'Missing required parameter: company_id', depositUrl: 'https://whop.com/deposit' });
  });
  it('never throws on junk', () => {
    expect(parseWhopErrorBody('')).toEqual({});
    expect(parseWhopErrorBody('<html>Bad gateway</html>')).toEqual({});
    expect(parseWhopErrorBody('null')).toEqual({});
  });
});

describe('retryAfterMs', () => {
  it('prefers the Retry-After header (seconds)', () => {
    expect(retryAfterMs(headers({ 'retry-after': '7' }), 'Try again in 12 seconds.')).toBe(7000);
  });
  it('reads an HTTP date header', () => {
    expect(retryAfterMs(headers({ 'retry-after': new Date(10_000 + 5000).toUTCString() }), undefined, () => 10_000)).toBeGreaterThanOrEqual(4000);
  });
  it('falls back to the sentence in the message', () => {
    expect(retryAfterMs(headers({}), 'Try again in 12 seconds.')).toBe(12_000);
    expect(retryAfterMs(headers({}), 'Try again in 2 minutes.')).toBe(120_000);
    expect(retryAfterMs(headers({}), 'Slow down')).toBeUndefined();
  });
});

describe('WhopApiError', () => {
  it('carries the kind and is recognisable', () => {
    const e = new WhopApiError('auth', 'nope', { status: 401, method: 'GET', path: '/x' });
    expect(isWhopError(e)).toBe(true);
    expect(isWhopError(new Error('x'))).toBe(false);
    expect(e).toMatchObject({ kind: 'auth', status: 401, method: 'GET', path: '/x' });
  });
});
