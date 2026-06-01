import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock only the validated env so we can flip the webhook URL; @knn/shared (the pure formatter) stays real.
const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: { NOTIFY_WEBHOOK_URL: '' } }));
vi.mock('@knn/config', () => ({ env: fakeEnv }));

const { notify } = await import('./notify.js');

const input = { orgId: 'o1', userId: 'u1', type: 'fb_connection_broken', title: 'Reconnect Facebook', body: 'Token revoked.' };

afterEach(() => {
  vi.unstubAllGlobals();
  fakeEnv.NOTIFY_WEBHOOK_URL = '';
});

describe('notify sink', () => {
  it('is console-only (no webhook POST) when NOTIFY_WEBHOOK_URL is unset — self-dormant', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await notify(input);
    expect(f).not.toHaveBeenCalled();
  });

  it('POSTs a Slack-compatible payload when the webhook is configured', async () => {
    fakeEnv.NOTIFY_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', f);
    await notify(input);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/services/x');
    const body = JSON.parse(opts.body as string) as { text: string };
    expect(body.text).toContain('fb_connection_broken');
    expect(body.text).toContain('Reconnect Facebook');
  });

  it('never throws when the webhook POST fails (a notify failure must not break the caller)', async () => {
    fakeEnv.NOTIFY_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(notify(input)).resolves.toBeUndefined();
  });
});
