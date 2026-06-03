'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, useConfirm, useToast } from '@/components/ui';
import { ApiError, admin, type WhiteDomain } from '@/lib/api';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.7rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--cream)',
};

/**
 * Super-admin White Domains panel. The white pool is the CLEAN, separately-hosted content sites used
 * as the cloaker funnel's fallback (organic/reviewer traffic) + the FB ad display link. A flat pool —
 * launch rotates least-loaded across the active + healthy ones. They must live on infrastructure
 * unlinkable from the money domains (separate Cloudflare account, registrar, IP).
 */
export function WhiteDomainsPanel(): React.ReactElement {
  const confirm = useConfirm();
  const toast = useToast();
  const [domains, setDomains] = useState<WhiteDomain[] | null>(null);
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    void admin.whiteDomains().then(setDomains).catch(() => {
      setDomains([]);
      toast.error('Could not load white domains.');
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
    await run(
      'add',
      async () => {
        await admin.addWhiteDomain(host.trim(), label.trim() || undefined);
        setHost('');
        setLabel('');
      },
      'White domain added. Point its DNS at the white-site Worker, then Verify.',
    );
  };

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h2 className="serif" style={{ margin: 0, fontSize: '1.25rem' }}>White domains</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.88rem', margin: '0.35rem 0 0' }}>
            The clean content sites a cloaker campaign uses for its <strong>fallback</strong> page + FB{' '}
            <strong>display link</strong>. Launch rotates across the active, healthy ones.
          </p>
        </div>

        {note && (
          <Banner tone={note.tone === 'ok' ? 'success' : 'error'} onDismiss={() => setNote(null)}>{note.text}</Banner>
        )}

        {domains && domains.filter((d) => d.isActive && d.healthy).length === 0 && (
          <Banner tone="warning">
            No active, healthy white domains — cloaker launches will fall back to the buyer&rsquo;s own display/fallback. Add at least one.
          </Banner>
        )}

        {/* List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {domains === null ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Loading…</p>
          ) : domains.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>No white domains yet.</p>
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
                  opacity: d.isActive ? 1 : 0.55,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--cream)' }}>{d.host}</span>
                    <Badge tone={d.healthy ? 'success' : 'danger'}>{d.healthy ? 'healthy' : 'down'}</Badge>
                    {!d.isActive && <Badge tone="neutral">retired</Badge>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                    {d.label ? `${d.label} · ` : ''}
                    {d.lastCheck ? `check: ${d.lastCheck}` : 'not verified yet'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => void run(`a-${d.id}`, () => admin.updateWhiteDomain(d.id, { isActive: !d.isActive }))} loading={busy === `a-${d.id}`}>
                    {d.isActive ? 'Retire' : 'Activate'}
                  </Button>
                  <Button variant="ghost" onClick={() => void run(`v-${d.id}`, () => admin.verifyWhiteDomain(d.id))} loading={busy === `v-${d.id}`}>
                    Verify
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void (async () => {
                        const ok = await confirm({ title: `Remove ${d.host}?`, body: 'Cloaker launches will stop rotating onto it.', confirmLabel: 'Remove domain', tone: 'danger' });
                        if (ok) await run(`d-${d.id}`, () => admin.deleteWhiteDomain(d.id));
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
            <label htmlFor="wd-host" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Host</label>
            <input id="wd-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="readoranow.com" style={{ ...inputStyle, fontFamily: 'monospace' }} />
          </div>
          <div style={{ flex: '0 1 12rem' }}>
            <label htmlFor="wd-label" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Label (optional)</label>
            <input id="wd-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Readora" style={inputStyle} />
          </div>
          <Button type="submit" loading={busy === 'add'} disabled={!host.trim()}>Add domain</Button>
        </form>

        {/* How it works */}
        <details style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.88rem', color: 'var(--cream)' }}>How white domains work + the separation rule</summary>
          <div style={{ color: 'var(--muted)', fontSize: '0.83rem', lineHeight: 1.6, marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ margin: 0 }}>
              A cloaker campaign&rsquo;s launch auto-assigns one of these as its FB display link and its fallback page. A
              real ad click reaches the money article; organic / bot / FB-reviewer traffic lands on the white site —
              clean content, no ads. The buyer never sets either.
            </p>
            <p style={{ margin: 0 }}>
              <strong>⚠️ Separation is the whole point.</strong> These must be UNLINKABLE from the money domains: a{' '}
              <em>separate Cloudflare account</em> (so the nameserver pair differs), a different registrar, WHOIS privacy,
              and zero shared Google/Analytics/pixel IDs. They&rsquo;re served by the white-site Worker (<code>apps/white</code>).
              Point each domain&rsquo;s DNS there, then <em>Verify</em> (the white site answers a 200 homepage).
            </p>
          </div>
        </details>
      </div>
    </Card>
  );
}
