import { afterEach, describe, expect, it, vi } from 'vitest';
import { FbAccountRestrictedError, FbConnectionBrokenError, FbRateLimitError, classifyFbError } from './errors.js';
import { graphRequest } from './graph.js';
import { getMe } from './oauth.js';
import { fetchAdAccounts } from './sync.js';

function fetchReturning(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers }),
    ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('graph client', () => {
  it('GET /me returns parsed JSON', async () => {
    vi.stubGlobal('fetch', fetchReturning({ id: '123', name: 'Test User' }));
    await expect(getMe('tok')).resolves.toEqual({ id: '123', name: 'Test User' });
  });

  it('classifies err 190 / subcode 460 as a broken connection', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ error: { code: 190, error_subcode: 460, message: 'expired' } }, { status: 400 }),
    );
    await expect(getMe('tok')).rejects.toBeInstanceOf(FbConnectionBrokenError);
  });

  it('classifies err 368 ("authenticate your account") as an account-restricted error', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        { error: { code: 368, message: 'The action attempted has been deemed abusive or is otherwise disallowed' } },
        { status: 400 },
      ),
    );
    await expect(getMe('tok')).rejects.toBeInstanceOf(FbAccountRestrictedError);
  });

  it('classifies the account-restricted subcode 1487390 as account-restricted, not a rate limit', () => {
    const err = classifyFbError({ code: 1, error_subcode: 1487390, message: 'restricted' }, 400);
    expect(err).toBeInstanceOf(FbAccountRestrictedError);
  });

  it('classifies err 31 / subcode 3858385 ("pending action") as account-restricted', () => {
    // The exact live signature of the "authenticate your account in Ads Manager" checkpoint.
    const err = classifyFbError({ code: 31, error_subcode: 3858385, message: 'This request requires the user to take a pending action' }, 400);
    expect(err).toBeInstanceOf(FbAccountRestrictedError);
    expect(err.code).toBe(31);
    expect(err.subcode).toBe(3858385);
  });

  it('keeps a token break (190) as a broken connection, not account-restricted', () => {
    expect(classifyFbError({ code: 190, error_subcode: 459, message: 'checkpoint' }, 400)).toBeInstanceOf(
      FbConnectionBrokenError,
    );
  });

  it('extracts the checkpoint URL from error_data when present', () => {
    const fromObj = classifyFbError({ code: 368, message: 'blocked', error_data: { url: 'https://www.facebook.com/checkpoint/123' } }, 400);
    expect(fromObj.checkpointUrl).toBe('https://www.facebook.com/checkpoint/123');
    const fromStr = classifyFbError({ code: 368, message: 'blocked', error_data: 'https://www.facebook.com/checkpoint/abc' }, 400);
    expect(fromStr.checkpointUrl).toBe('https://www.facebook.com/checkpoint/abc');
  });

  it('classifies BUC throttle (80004) as a rate limit with retryAfterMs from the header', async () => {
    const header = JSON.stringify({ 'biz-1': [{ estimated_time_to_regain_access: 2 }] });
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        { error: { code: 80004, message: 'rate limited' } },
        { status: 400, headers: { 'x-business-use-case-usage': header } },
      ),
    );
    await expect(graphRequest({ path: '/me', accessToken: 'tok' })).rejects.toMatchObject({
      name: 'FbRateLimitError',
      retryAfterMs: 2 * 60_000,
    });
    // sanity: it is the typed error
    vi.stubGlobal(
      'fetch',
      fetchReturning({ error: { code: 80004 } }, { status: 400 }),
    );
    await expect(graphRequest({ path: '/me', accessToken: 'tok' })).rejects.toBeInstanceOf(
      FbRateLimitError,
    );
  });

  it('maps /me/adaccounts to AdAccountDTO', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        data: [
          {
            account_id: 'act_1',
            name: 'Main',
            currency: 'USD',
            timezone_name: 'Asia/Kolkata',
            account_status: 1,
            business: { id: 'bm_1' },
          },
        ],
      }),
    );
    await expect(fetchAdAccounts('tok')).resolves.toEqual([
      { fbAccountId: 'act_1', name: 'Main', currency: 'USD', timezone: 'Asia/Kolkata', status: '1', businessId: 'bm_1' },
    ]);
  });
});
