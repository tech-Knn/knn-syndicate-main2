'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, useConfirm, useToast } from '@/components/ui';
import { ApiError, admin, type RedirectDomain } from '@/lib/api';

/**
 * Super-admin Redirect Domains panel. The redirect domain is the `go.*` host the edge
 * Worker serves; the DEFAULT one is what new ad creatives link to. This manages which
 * domain ads point at, with a reachability check, plus an explainer of how it fits the funnel.
 */
export function RedirectDomainsPanel(): React.ReactElement {
  const confirm = useConfirm();
  const toast = useToast();
  const [domains, setDomains] = useState<RedirectDomain[] | null>(null);
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // id or 'add'
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    void admin
      .redirectDomains()
      .then(setDomains)
      .catch(() => {
        setDomains([]);
        toast.error('Could not load redirect domains.');
      });
  }, [toast]);
  useEffect(() => load(), [load]);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      load();
      if (okMsg) setNote({ tone: 'ok', text: okMsg });
    } catch (err) {
      setNote({ tone: 'err', text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!host.trim()) return;
    await run('add', async () => {
      await admin.addRedirectDomain(host.trim(), label.trim() || undefined);
      setHost('');
      setLabel('');
    }, 'Domain added. Set it as default + verify it points at the redirect Worker.');
  };

  const hasDefault = domains?.some((d) => d.isDefault) ?? false;

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h2 className="serif" style={{ margin: 0, fontSize: '1.25rem' }}>Redirect domains</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.88rem', margin: '0.35rem 0 0' }}>
            The <code>go.*</code> host the edge redirect Worker serves. The <strong>default</strong> is the
            link baked into every new ad&rsquo;s creative.
          </p>
        </div>

        {note && (
          <Banner tone={note.tone === 'ok' ? 'success' : 'error'} onDismiss={() => setNote(null)}>
            {note.text}
          </Banner>
        )}

        {!hasDefault && domains && domains.length > 0 && (
          <Banner tone="warning">
            No default set — new ads fall back to the <code>REDIRECT_DOMAIN</code> env value. Pick a default below.
          </Banner>
        )}

        {/* List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {domains === null ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Loading…</p>
          ) : domains.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
              No redirect domains yet. Add the <code>go.*</code> host your Cloudflare Worker serves.
            </p>
          ) : (
            domains.map((d) => (
              <div
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  padding: '0.7rem 0.9rem',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: d.isDefault ? 'rgba(217,81,44,0.06)' : 'transparent',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--cream)' }}>{d.host}</span>
                    {d.isDefault && <Badge tone="brand">Default</Badge>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                    {d.label ? `${d.label} · ` : ''}
                    {d.lastCheck ? `check: ${d.lastCheck}` : 'not verified yet'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                  {!d.isDefault && (
                    <Button variant="ghost" onClick={() => void run(d.id, () => admin.setDefaultRedirectDomain(d.id), 'Default updated — future launches use it.')} loading={busy === d.id}>
                      Set default
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => void run(`v-${d.id}`, () => admin.verifyRedirectDomain(d.id))} loading={busy === `v-${d.id}`}>
                    Verify
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void (async () => {
                        const ok = await confirm({
                          title: `Remove ${d.host}?`,
                          body: "New ads won't be able to use it.",
                          confirmLabel: 'Remove domain',
                          tone: 'danger',
                        });
                        if (ok) await run(`d-${d.id}`, () => admin.deleteRedirectDomain(d.id));
                      })();
                    }}
                    loading={busy === `d-${d.id}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Add */}
        <form onSubmit={(e) => void add(e)} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 16rem' }}>
            <label htmlFor="rd-host" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Host</label>
            <input
              id="rd-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="go.example.com"
              style={{ width: '100%', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--cream)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ flex: '0 1 12rem' }}>
            <label htmlFor="rd-label" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Label (optional)</label>
            <input
              id="rd-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Primary edge"
              style={{ width: '100%', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--cream)' }}
            />
          </div>
          <Button type="submit" loading={busy === 'add'} disabled={!host.trim()}>Add domain</Button>
        </form>

        {/* How it works */}
        <details style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.88rem', color: 'var(--cream)' }}>How redirect domains work</summary>
          <div style={{ color: 'var(--muted)', fontSize: '0.83rem', lineHeight: 1.6, marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ margin: 0 }}>
              Every ad&rsquo;s destination is <code>https://&lt;default redirect domain&gt;/go/&lt;per-ad id&gt;</code>. When someone
              clicks the ad, the edge Worker on that domain detects ad traffic (fbclid) and 302-redirects to the
              campaign&rsquo;s monetized article with the AFS channel + RAC + a click id; organic/bot traffic gets a
              clean redirect with no monetization params.
            </p>
            <p style={{ margin: 0 }}>
              <strong>The host must point at the Worker.</strong> Adding it here only sets which domain new creatives
              link to — you still need its DNS on Cloudflare with the redirect Worker routed to it. Use <em>Verify</em> to
              confirm the Worker answers (<code>/health/live</code>). Changing the default only affects <em>future</em>
              launches; live ads keep the link baked into their creative until relaunched.
            </p>
            <p style={{ margin: 0 }}>
              Keep this on a <em>separate</em> domain from the article sites so AFS stays clean. If none is marked
              default, launches fall back to the <code>REDIRECT_DOMAIN</code> env value.
            </p>
          </div>
        </details>
      </div>
    </Card>
  );
}
