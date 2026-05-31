import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAssetAccess } from './launch.js';

/** Stub Graph so a node id-GET succeeds when `visible(url)` is true, else returns a 400 error. */
function stubGraph(visible: (url: string) => boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const headers = { 'content-type': 'application/json' };
      return visible(url)
        ? new Response(JSON.stringify({ id: 'x' }), { status: 200, headers })
        : new Response(JSON.stringify({ error: { message: 'no permission / unsupported get', code: 100 } }), { status: 400, headers });
    }) as unknown as typeof fetch,
  );
}

describe('checkAssetAccess', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('flags only the assets this token cannot see', async () => {
    // Everything visible except pixel PXBAD (the launch app wasn't granted it).
    stubGraph((url) => !url.includes('/PXBAD'));
    const res = await checkAssetAccess('tok', { accountIds: ['123'], pageIds: ['PG1'], pixelIds: ['PXOK', 'PXBAD'] }, 'LAUNCH');
    expect(res.missingAccountIds).toEqual([]);
    expect(res.missingPageIds).toEqual([]);
    expect(res.missingPixelIds).toEqual(['PXBAD']);
    expect(res.ok).toBe(false);
  });

  it('ok=true when the token can see every asset', async () => {
    stubGraph(() => true);
    const res = await checkAssetAccess('tok', { accountIds: ['123'], pageIds: ['PG1'], pixelIds: ['PX'] });
    expect(res).toMatchObject({ missingAccountIds: [], missingPageIds: [], missingPixelIds: [], ok: true });
  });

  it('flags a missing ad account among several', async () => {
    stubGraph((url) => !url.includes('act_999'));
    const res = await checkAssetAccess('tok', { accountIds: ['123', '999'], pixelIds: ['PX'] }, 'LAUNCH');
    expect(res.missingAccountIds).toEqual(['999']);
    expect(res.ok).toBe(false);
  });
});
