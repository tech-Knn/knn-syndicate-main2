import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAssetAccess, fetchFbVideoThumbnail, uploadFbAdVideo } from './launch.js';

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

describe('uploadFbAdVideo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads to /advideos as multipart form-data and returns the FB video id', async () => {
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init: { method?: string; body?: unknown }) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: 'vid-123' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    );
    const id = await uploadFbAdVideo('123', 'tok', { bytes: Buffer.from([0, 1, 2, 3]), filename: 'clip.mp4', mimeType: 'video/mp4' }, 'LAUNCH');
    expect(id).toBe('vid-123');
    expect(calls).toHaveLength(1);
    // The image-path bug was posting video to /adimages; a video MUST go to /advideos.
    expect(calls[0]!.url).toContain('/act_123/advideos');
    expect(calls[0]!.url).not.toContain('/adimages');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((calls[0]!.init.body as FormData).get('source')).toBeInstanceOf(Blob);
  });

  it('throws if Facebook returns no video id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    );
    await expect(
      uploadFbAdVideo('123', 'tok', { bytes: Buffer.from([1]), filename: 'c.mp4', mimeType: 'video/mp4' }),
    ).rejects.toThrow('no id');
  });
});

describe('fetchFbVideoThumbnail', () => {
  afterEach(() => vi.unstubAllGlobals());

  const thumbResponse = (data: { uri?: string; is_preferred?: boolean }[]) =>
    new Response(JSON.stringify({ thumbnails: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('returns the preferred thumbnail uri (else the first available)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => thumbResponse([{ uri: 'https://t/a.jpg' }, { uri: 'https://t/pref.jpg', is_preferred: true }])) as unknown as typeof fetch,
    );
    const uri = await fetchFbVideoThumbnail('vid-1', 'tok', 'DATA', { sleep: async () => {} });
    expect(uri).toBe('https://t/pref.jpg');
  });

  it('polls until the async-generated thumbnail is ready', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return thumbResponse(n < 3 ? [] : [{ uri: 'https://t/ready.jpg' }]);
      }) as unknown as typeof fetch,
    );
    const sleep = vi.fn(async () => {});
    const uri = await fetchFbVideoThumbnail('vid-1', 'tok', 'DATA', { attempts: 5, sleep });
    expect(uri).toBe('https://t/ready.jpg');
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns null when no thumbnail appears within the attempt budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => thumbResponse([])) as unknown as typeof fetch);
    const uri = await fetchFbVideoThumbnail('vid-1', 'tok', 'DATA', { attempts: 3, sleep: async () => {} });
    expect(uri).toBeNull();
  });
});
