import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAdAccounts, fetchPixels } from './sync.js';

function res(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync pagination', () => {
  it('follows paging.next and merges every page, carrying the after cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        res({
          data: [{ account_id: 'act_1', account_status: 1 }],
          paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/vX/me/adaccounts?after=CUR1' },
        }),
      )
      .mockResolvedValueOnce(
        res({
          data: [{ account_id: 'act_2', account_status: 1 }],
          // no `next` → stop here
          paging: { cursors: { after: 'CUR2' } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await fetchAdAccounts('tok');
    expect(accounts.map((a) => a.fbAccountId)).toEqual(['act_1', 'act_2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The 2nd request advanced to the next page using the cursor from page 1.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('after=CUR1');
  });

  it('stops after a single page when there is no next cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ data: [{ id: 'px_1', name: 'Pixel' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const pixels = await fetchPixels('123', 'tok');
    expect(pixels).toEqual([{ fbPixelId: 'px_1', name: 'Pixel' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
