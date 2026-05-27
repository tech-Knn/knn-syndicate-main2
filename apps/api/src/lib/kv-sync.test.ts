import { afterEach, describe, expect, it, vi } from 'vitest';

const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: {
    CLOUDFLARE_ACCOUNT_ID: 'acct-123',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    CF_KV_NAMESPACE_ID: 'ns-456',
  },
}));
vi.mock('@knn/config', () => ({ env: fakeEnv }));

const { writeRedirectConfigs, deleteRedirectConfig, isKvConfigured, KvNotConfiguredError } = await import('./kv-sync.js');

afterEach(() => {
  vi.unstubAllGlobals();
  fakeEnv.CLOUDFLARE_API_TOKEN = 'cf-token';
});

const cfg = { campaignId: 'c1', active: true, articleUrl: 'https://articles.x/a/s', channel: 'ch-1' };

describe('kv-sync', () => {
  it('isKvConfigured reflects the env', () => {
    expect(isKvConfigured()).toBe(true);
    fakeEnv.CLOUDFLARE_API_TOKEN = '';
    expect(isKvConfigured()).toBe(false);
  });

  it('bulk-writes redirect configs to the namespace bulk endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await writeRedirectConfigs([{ redirectId: 'rid-1', config: cfg }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/storage/kv/namespaces/ns-456/bulk');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as { key: string; value: string }[];
    expect(body[0]?.key).toBe('redirect:rid-1');
    expect(JSON.parse(body[0]!.value)).toMatchObject({ campaignId: 'c1', channel: 'ch-1' });
  });

  it('is a no-op for an empty list (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await writeRedirectConfigs([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates a 404 on delete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(deleteRedirectConfig('gone')).resolves.toBeUndefined();
  });

  it('throws KvNotConfiguredError when unconfigured', async () => {
    fakeEnv.CLOUDFLARE_API_TOKEN = '';
    await expect(writeRedirectConfigs([{ redirectId: 'r', config: cfg }])).rejects.toBeInstanceOf(KvNotConfiguredError);
  });
});
