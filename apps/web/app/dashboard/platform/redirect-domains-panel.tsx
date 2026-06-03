'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, useConfirm, useToast } from '@/components/ui';
import { ApiError, admin, type RedirectDomain } from '@/lib/api';
import type { FunnelMode, OrgRow } from '@/lib/types';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.7rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--cream)',
};

/**
 * Super-admin Redirect Domains panel. Each `go.*` host belongs to a funnel-mode pool (NORMAL vs
 * CLOAKER) and is either shared or company-exclusive; launch rotates least-loaded across the eligible,
 * active, healthy ones. Manages mode/owner/active + a reachability check, with an explainer.
 */
export function RedirectDomainsPanel(): React.ReactElement {
  const confirm = useConfirm();
  const toast = useToast();
  const [domains, setDomains] = useState<RedirectDomain[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<FunnelMode>('CLOAKER');
  const [ownerOrgId, setOwnerOrgId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    void admin.redirectDomains().then(setDomains).catch(() => {
      setDomains([]);
      toast.error('Could not load redirect domains.');
    });
    void admin.organizations().then((o) => setOrgs(o.filter((x) => !x.isPlatform))).catch(() => undefined);
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
        await admin.addRedirectDomain(host.trim(), label.trim() || undefined, { mode, ownerOrgId: ownerOrgId || null });
        setHost('');
        setLabel('');
      },
      'Domain added. Point its DNS at the redirect Worker, then Verify.',
    );
  };

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h2 className="serif" style={{ margin: 0, fontSize: '1.25rem' }}>Redirect domains</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.88rem', margin: '0.35rem 0 0' }}>
            The <code>go.*</code> hosts the edge Worker serves. Launch <strong>rotates</strong> across the pool that
            matches each buyer&rsquo;s funnel mode (and their company, if a domain is company-exclusive).
          </p>
        </div>

        {note && (
          <Banner tone={note.tone === 'ok' ? 'success' : 'error'} onDismiss={() => setNote(null)}>{note.text}</Banner>
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
                  opacity: d.isActive ? 1 : 0.55,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--cream)' }}>{d.host}</span>
                    <Badge tone={d.mode === 'CLOAKER' ? 'brand' : 'neutral'}>{d.mode === 'CLOAKER' ? 'Cloaker' : 'Normal'}</Badge>
                    <Badge tone={d.healthy ? 'success' : 'danger'}>{d.healthy ? 'healthy' : 'down'}</Badge>
                    {d.isDefault && <Badge tone="warning">Default</Badge>}
                    {!d.isActive && <Badge tone="neutral">retired</Badge>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                    {d.ownerOrgName ? `${d.ownerOrgName} only · ` : 'shared pool · '}
                    {d.label ? `${d.label} · ` : ''}
                    {d.lastCheck ? `check: ${d.lastCheck}` : 'not verified yet'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <select
                    aria-label="Mode"
                    value={d.mode}
                    disabled={busy === `m-${d.id}`}
                    onChange={(e) => void run(`m-${d.id}`, () => admin.updateRedirectDomain(d.id, { mode: e.target.value as FunnelMode }))}
                    style={{ ...inputStyle, width: 'auto', padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}
                  >
                    <option value="NORMAL">Normal pool</option>
                    <option value="CLOAKER">Cloaker pool</option>
                  </select>
                  <select
                    aria-label="Owner"
                    value={d.ownerOrgId ?? ''}
                    disabled={busy === `o-${d.id}`}
                    onChange={(e) => void run(`o-${d.id}`, () => admin.updateRedirectDomain(d.id, { ownerOrgId: e.target.value || null }))}
                    style={{ ...inputStyle, width: 'auto', padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}
                  >
                    <option value="">Shared pool</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name} only</option>
                    ))}
                  </select>
                  <Button variant="ghost" onClick={() => void run(`a-${d.id}`, () => admin.updateRedirectDomain(d.id, { isActive: !d.isActive }))} loading={busy === `a-${d.id}`}>
                    {d.isActive ? 'Retire' : 'Activate'}
                  </Button>
                  {!d.isDefault && (
                    <Button variant="ghost" onClick={() => void run(d.id, () => admin.setDefaultRedirectDomain(d.id), 'Default updated (the launch fallback).')} loading={busy === d.id}>
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
                        const ok = await confirm({ title: `Remove ${d.host}?`, body: "New ads won't be able to use it.", confirmLabel: 'Remove domain', tone: 'danger' });
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
          <div style={{ flex: '1 1 14rem' }}>
            <label htmlFor="rd-host" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Host</label>
            <input id="rd-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="go.example.com" style={{ ...inputStyle, fontFamily: 'monospace' }} />
          </div>
          <div style={{ flex: '0 1 10rem' }}>
            <label htmlFor="rd-label" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Label</label>
            <input id="rd-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" style={inputStyle} />
          </div>
          <div style={{ flex: '0 1 9rem' }}>
            <label htmlFor="rd-mode" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Pool</label>
            <select id="rd-mode" value={mode} onChange={(e) => setMode(e.target.value as FunnelMode)} style={inputStyle}>
              <option value="CLOAKER">Cloaker</option>
              <option value="NORMAL">Normal</option>
            </select>
          </div>
          <div style={{ flex: '0 1 11rem' }}>
            <label htmlFor="rd-owner" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Owner</label>
            <select id="rd-owner" value={ownerOrgId} onChange={(e) => setOwnerOrgId(e.target.value)} style={inputStyle}>
              <option value="">Shared</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <Button type="submit" loading={busy === 'add'} disabled={!host.trim()}>Add domain</Button>
        </form>

        {/* How it works */}
        <details style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.88rem', color: 'var(--cream)' }}>How redirect domains work + DNS setup</summary>
          <div style={{ color: 'var(--muted)', fontSize: '0.83rem', lineHeight: 1.6, marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ margin: 0 }}>
              Each ad&rsquo;s destination is <code>https://&lt;rotated go.* host&gt;/go/&lt;per-ad id&gt;</code>. Launch picks the
              least-loaded host from the pool matching the buyer&rsquo;s mode (and company, for an exclusive domain), so a
              flagged host has minimal blast radius. <strong>Cloaker</strong> and <strong>Normal</strong> pools are kept
              separate so a flagged cloaker host never takes down normal buyers.
            </p>
            <p style={{ margin: 0 }}>
              <strong>DNS setup:</strong> add the domain to Cloudflare → in the redirect Worker (<code>apps/redirect</code>),
              add it as a custom domain (<code>wrangler.toml</code> route) → <code>wrangler deploy</code>. Then click
              <em> Verify</em> here to confirm the Worker answers <code>/health/live</code>. <em>Retire</em> a flagged host
              (stops new launches) without deleting its history; the marked <em>default</em> is the fallback when a
              buyer&rsquo;s pool is empty.
            </p>
          </div>
        </details>
      </div>
    </Card>
  );
}
