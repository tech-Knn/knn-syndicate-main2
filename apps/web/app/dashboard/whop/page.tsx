'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WHOP_DASHBOARDS,
  WHOP_OPTIONAL_PERMISSIONS,
  WHOP_REQUIRED_PERMISSIONS,
  type WhopChecklistAction,
  type WhopChecklistItem,
  type WhopChecklistStatus,
  type WhopEnvironment,
} from '@knn/shared';
import { Badge, Banner, Button, Card, EmptyState, Segmented, Skeleton, TextField, useConfirm, useToast } from '@/components/ui';
import { ApiError, whop } from '@/lib/api';
import type { WhopConnection, WhopConnectionWithOwner, WhopPixelCheck, WhopStatus } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from './whop.module.css';

/**
 * Whop Ads (D32). Whop owns the Meta ad account; the user connects their Whop business with its ID and an
 * API key, and this page shows, per connection, what Whop still needs before ads can launch. Each
 * line is one plain sentence with one button to fix it. The three steps only the Whop account owner can
 * do (sign the agreement, add a payment method, approve Meta access) link out to Whop.
 */

const STATUS: Record<WhopChecklistStatus, { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Done' },
  todo: { tone: 'warning', label: 'To do' },
  warn: { tone: 'warning', label: 'Check' },
  error: { tone: 'danger', label: 'Problem' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86_400)} d ago`;
}

const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

// ── connect form ────────────────────────────────────────────────────────────────────────────────

interface Prefill {
  bizId: string;
  environment: WhopEnvironment;
  nonce: number;
}

function ConnectForm({ status, prefill, onConnected }: { status: WhopStatus; prefill: Prefill | null; onConnected: (c: WhopConnection) => void }) {
  const toast = useToast();
  const [bizId, setBizId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [environment, setEnvironment] = useState<WhopEnvironment>('PRODUCTION');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // "Reconnect" on a broken connection fills in the business and puts the cursor on the key.
  useEffect(() => {
    if (!prefill) return;
    setBizId(prefill.bizId);
    setEnvironment(prefill.environment);
    setApiKey('');
    setError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('whop-api-key')?.focus();
  }, [prefill]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const conn = await whop.connect({ bizId: bizId.trim(), apiKey: apiKey.trim(), environment });
      setApiKey('');
      toast.success(conn.checklist?.canLaunch ? 'Connected. Every Whop step is done.' : 'Connected. Finish the remaining steps below.');
      onConnected(conn);
    } catch (err) {
      setError(errorText(err, 'Could not connect. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const dash = WHOP_DASHBOARDS[environment];
  return (
    <Card className={styles.connectCard}>
      <div ref={formRef}>
        <h2 className={styles.h2}>Connect a Whop business</h2>
        <p className={styles.lede}>
          Enter the business ID and an API key from the Whop business you run ads from. We check the key right away and show what is still needed.
        </p>
        <form onSubmit={(e) => void submit(e)} className={styles.form} noValidate>
          <TextField
            label="Business ID"
            placeholder="biz_xxxxxxxxxxxxxx"
            value={bizId}
            onChange={(e) => setBizId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            hint="The part of your Whop dashboard address that starts with biz_"
            requiredMark
          />
          <TextField
            id="whop-api-key"
            label="API key"
            type={showKey ? 'text' : 'password'}
            placeholder="Paste the full key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            hint="Stored encrypted. We only ever show its last four characters."
            requiredMark
            trailing={
              <button type="button" className={styles.linkBtn} onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            }
          />
          {status.allowSandbox && (
            <div className={styles.envPick}>
              <span className={styles.envLabel}>Whop environment</span>
              <Segmented
                ariaLabel="Whop environment"
                value={environment}
                onChange={setEnvironment}
                options={[
                  { label: 'Production', value: 'PRODUCTION' },
                  { label: 'Sandbox (test, no real money)', value: 'SANDBOX' },
                ]}
              />
            </div>
          )}
          {error && (
            <Banner tone="error" title="Could not connect">
              {error}
            </Banner>
          )}
          <div className={styles.formActions}>
            <Button type="submit" loading={busy} disabled={!bizId.trim() || !apiKey.trim()}>
              Connect
            </Button>
          </div>
        </form>

        <details className={styles.help}>
          <summary>Where do I find these?</summary>
          <ol>
            <li>
              Open your business in Whop. The address bar shows <code>/dashboard/biz_…</code>. That is the business ID.
            </li>
            <li>
              Go to{' '}
              <a href={`${dash}/dashboard/developer`} target="_blank" rel="noreferrer">
                Developer → Account API Keys ↗
              </a>{' '}
              and choose <strong>Create</strong>. Tick the permissions below, then copy the key. Whop may show it only once.
            </li>
            <li>Paste both here.</li>
          </ol>
          <PermissionList />
        </details>
      </div>
    </Card>
  );
}

function PermissionList() {
  const toast = useToast();
  const copy = async (): Promise<void> => {
    const text = WHOP_REQUIRED_PERMISSIONS.map((p) => p.action).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Permission list copied.');
    } catch {
      toast.error('Could not copy. Select the list and copy it by hand.');
    }
  };
  return (
    <div className={styles.perms}>
      <div className={styles.permsHead}>
        <strong>Permissions to tick</strong>
        <button type="button" className={styles.linkBtn} onClick={() => void copy()}>
          Copy list
        </button>
      </div>
      <ul className={styles.permList}>
        {WHOP_REQUIRED_PERMISSIONS.map((p) => (
          <li key={p.action}>
            <code>{p.action}</code> <span>{p.purpose}</span>
          </li>
        ))}
      </ul>
      <p className={styles.permNote}>Optional:</p>
      <ul className={styles.permList}>
        {WHOP_OPTIONAL_PERMISSIONS.map((p) => (
          <li key={p.action}>
            <code>{p.action}</code> <span>{p.purpose}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── one connection ──────────────────────────────────────────────────────────────────────────────

function ChecklistRow({ item, busy, onAction }: { item: WhopChecklistItem; busy: string | null; onAction: (a: WhopChecklistAction) => void }) {
  const s = STATUS[item.status];
  return (
    <li className={styles.row}>
      <span className={styles.rowBadge}>
        <Badge tone={s.tone} dot>
          {s.label}
        </Badge>
      </span>
      <div className={styles.rowMain}>
        <div className={styles.rowLabel}>{item.label}</div>
        {item.detail && <div className={styles.rowDetail}>{item.detail}</div>}
      </div>
      {item.actions && item.actions.length > 0 && (
        <div className={styles.rowActions}>
          {item.actions.map((a) =>
            a.kind === 'open_whop' ? (
              <a key={a.label} href={a.url} target="_blank" rel="noreferrer" className={styles.openLink}>
                {a.label} ↗
              </a>
            ) : (
              <Button key={a.label} variant="secondary" loading={busy === a.kind} disabled={busy !== null && busy !== a.kind} onClick={() => onAction(a)}>
                {a.label}
              </Button>
            ),
          )}
        </div>
      )}
    </li>
  );
}

function ConnectionCard({
  conn,
  onChange,
  onRemoved,
  onReconnect,
}: {
  conn: WhopConnection;
  onChange: (c: WhopConnection) => void;
  onRemoved: (id: string) => void;
  onReconnect: (c: WhopConnection) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [pixelUrl, setPixelUrl] = useState('');
  const [pixel, setPixel] = useState<WhopPixelCheck | null>(null);
  const [pixelBusy, setPixelBusy] = useState(false);

  const guarded = async (kind: string, fn: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(errorText(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  const check = (): Promise<void> =>
    guarded(
      'recheck',
      async () => {
        const next = await whop.check(conn.id);
        onChange(next);
        toast.success(next.checklist?.canLaunch ? 'Every Whop step is done.' : 'Checked with Whop.');
      },
      'Could not check with Whop.',
    );

  const onAction = (a: WhopChecklistAction): void => {
    if (a.kind === 'recheck') void check();
    else if (a.kind === 'connect_meta') {
      void guarded(
        'connect_meta',
        async () => {
          const { authorizeUrl } = await whop.metaConnect(conn.id, `${window.location.origin}/dashboard/whop?connection=${conn.id}`);
          window.location.href = authorizeUrl;
        },
        'Could not start the Meta sign-in.',
      );
    } else if (a.kind === 'create_page') {
      void (async () => {
        const ok = await confirm({
          title: 'Create a Whop-managed Facebook page?',
          body: 'Whop creates a Facebook page for this business, using the logo, banner and description set on the business in Whop. Set those first if you have not.',
          confirmLabel: 'Create page',
        });
        if (!ok) return;
        await guarded(
          'create_page',
          async () => {
            onChange(await whop.createPage(conn.id));
            toast.success('Page created.');
          },
          'Could not create the page.',
        );
      })();
    } else if (a.kind === 'refresh_page') {
      const page = conn.pages.find((p) => p.error);
      if (!page) return void check();
      void guarded(
        'refresh_page',
        async () => {
          onChange(await whop.refreshPage(conn.id, page.id));
          toast.success('Page refreshed.');
        },
        'Could not refresh the page.',
      );
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${conn.label ?? conn.bizId}?`,
      body: 'We delete the stored API key. Campaigns already running on Whop keep running there, and you can pause them in Whop. You can connect again any time.',
      confirmLabel: 'Remove connection',
      tone: 'danger',
    });
    if (!ok) return;
    await guarded(
      'remove',
      async () => {
        await whop.disconnect(conn.id);
        toast.success('Connection removed.');
        onRemoved(conn.id);
      },
      'Could not remove the connection.',
    );
  };

  const runPixelCheck = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPixelBusy(true);
    setPixel(null);
    try {
      setPixel(await whop.pixelCheck(conn.id, pixelUrl.trim() || undefined));
    } catch (err) {
      toast.error(errorText(err, 'Could not check the pixel.'));
    } finally {
      setPixelBusy(false);
    }
  };

  const items = conn.checklist?.items ?? [];
  const remaining = items.filter((i) => i.status === 'todo' || i.status === 'error').length;
  const unchecked = items.filter((i) => i.status === 'unknown').length;
  const progress = [
    remaining > 0 ? `${remaining} step${remaining === 1 ? '' : 's'} left before Whop can launch ads.` : '',
    unchecked > 0 ? `${unchecked} could not be checked yet.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Card className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle}>{conn.label ?? conn.bizId}</h3>
          <div className={styles.cardMeta}>
            <code>{conn.bizId}</code> · key ending <code>{conn.apiKeyLast4}</code> · checked {timeAgo(conn.lastCheckedAt)}
          </div>
        </div>
        <div className={styles.badges}>
          {conn.environment === 'SANDBOX' && <Badge tone="brand">Sandbox</Badge>}
          <Badge tone={conn.status === 'ACTIVE' ? 'success' : 'danger'} dot>
            {conn.status === 'ACTIVE' ? 'Connected' : 'Needs attention'}
          </Badge>
        </div>
      </div>

      {conn.status === 'BROKEN' ? (
        <Banner
          tone="error"
          title="Whop is not accepting this connection"
          action={
            <Button variant="secondary" onClick={() => onReconnect(conn)}>
              Reconnect with a new key
            </Button>
          }
        >
          {conn.lastError ?? 'The key no longer works.'}
        </Banner>
      ) : conn.checklist?.canLaunch ? (
        <Banner tone="success" title="Setup complete">
          Whop has everything it needs to launch ads for this business.
        </Banner>
      ) : conn.checklist?.canDraft ? (
        <Banner tone="info" title="Key connected">
          {progress || 'Finish the checks below before ads can launch.'}
        </Banner>
      ) : null}

      <ul className={styles.checklist} role="list" aria-label={`Setup checklist for ${conn.label ?? conn.bizId}`}>
        {items.map((item) => (
          <ChecklistRow key={item.key} item={item} busy={busy} onAction={onAction} />
        ))}
      </ul>

      <form className={styles.pixelForm} onSubmit={(e) => void runPixelCheck(e)}>
        <label htmlFor={`px-${conn.id}`} className={styles.pixelLabel}>
          Check the Whop pixel on a page
        </label>
        <div className={styles.pixelRow}>
          <input
            id={`px-${conn.id}`}
            className={styles.pixelInput}
            placeholder="https://your-article-page.example/a/your-slug (optional)"
            value={pixelUrl}
            onChange={(e) => setPixelUrl(e.target.value)}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="secondary" loading={pixelBusy}>
            Check
          </Button>
        </div>
        {pixel && (
          <p className={styles.pixelResult} role="status">
            {pixel.nativeTracking
              ? 'This page is hosted on Whop, so no snippet is needed.'
              : pixel.installed
                ? `Pixel found${pixel.lastSeenDays === null ? '' : pixel.lastSeenDays === 0 ? ', seen today' : `, last seen ${pixel.lastSeenDays} day${pixel.lastSeenDays === 1 ? '' : 's'} ago`}.`
                : 'Whop has not seen its pixel yet.'}
            {pixel.reachable === false && ' Whop could not load that page.'}
            {Object.keys(pixel.lastFiredDays).length > 0 && ` Events: ${Object.entries(pixel.lastFiredDays).map(([k, d]) => `${k} (${d === 0 ? 'today' : `${d} d ago`})`).join(', ')}.`}
          </p>
        )}
      </form>

      <div className={styles.footer}>
        <Button variant="secondary" loading={busy === 'recheck'} disabled={busy !== null && busy !== 'recheck'} onClick={() => void check()}>
          Check again
        </Button>
        <Button variant="ghost" loading={busy === 'remove'} disabled={busy !== null && busy !== 'remove'} onClick={() => void remove()}>
          Remove connection
        </Button>
      </div>
    </Card>
  );
}

// ── page ────────────────────────────────────────────────────────────────────────────────────────

export default function WhopPage() {
  const { user } = useAuth();
  const toast = useToast();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [status, setStatus] = useState<WhopStatus | null>(null);
  const [connections, setConnections] = useState<WhopConnection[] | null>(null);
  const [all, setAll] = useState<WhopConnectionWithOwner[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await whop.status();
      setStatus(s);
      if (!s.enabled) return;
      setConnections(await whop.connections());
      if (isSuper) setAll(await whop.allConnections());
    } catch (err) {
      setLoadError(errorText(err, 'Could not load your Whop connections.'));
    }
  }, [isSuper]);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from Whop's Meta sign-in: `?connection=<id>` (and `social_account_error` on failure).
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current || !connections) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('connection');
    const failed = params.get('social_account_error');
    if (!id && !failed) return;
    handledReturn.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (failed) toast.error(`Meta sign-in did not finish: ${failed}`);
    else if (id) {
      void whop
        .check(id)
        .then((next) => {
          setConnections((prev) => prev?.map((c) => (c.id === next.id ? next : c)) ?? prev);
          toast.success('Back from Meta. Checked your page.');
        })
        .catch((err) => toast.error(errorText(err, 'Could not re-check after the Meta sign-in.')));
    }
  }, [connections, toast]);

  const upsert = (c: WhopConnection): void => {
    setConnections((prev) => (prev?.some((x) => x.id === c.id) ? prev.map((x) => (x.id === c.id ? c : x)) : [...(prev ?? []), c]));
    if (isSuper) void whop.allConnections().then(setAll).catch(() => undefined);
  };
  const remove = (id: string): void => {
    setConnections((prev) => prev?.filter((c) => c.id !== id) ?? prev);
    if (isSuper) void whop.allConnections().then(setAll).catch(() => undefined);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className="eyebrow">Ad provider</span>
          <h1 className={`serif ${styles.h1}`}>Whop Ads</h1>
          <p className={styles.lede}>
            Run Meta ads through Whop's ad accounts. Connect your Whop business with its ID and an API key, and this page checks everything Whop needs before ads can launch.
          </p>
        </div>
      </header>

      {loadError && <Banner tone="error">{loadError}</Banner>}

      {status === null && !loadError ? (
        <Skeleton className={styles.skeleton} />
      ) : status && !status.enabled ? (
        <EmptyState title="Whop Ads is not turned on for your company" description="Ask a platform admin to enable it, then come back here to connect your Whop business." />
      ) : status && connections ? (
        <>
          {connections.length === 0 && <ConnectForm status={status} prefill={prefill} onConnected={upsert} />}
          {connections.map((c) => (
            <ConnectionCard
              key={c.id}
              conn={c}
              onChange={upsert}
              onRemoved={remove}
              onReconnect={(x) => setPrefill({ bizId: x.bizId, environment: x.environment, nonce: Date.now() })}
            />
          ))}
          {connections.length > 0 && <ConnectForm status={status} prefill={prefill} onConnected={upsert} />}

          {isSuper && all && (
            <Card className={styles.card}>
              <h2 className={styles.h2}>All connections</h2>
              <p className={styles.lede}>Every Whop business connected on the platform, for oversight. Keys are never shown.</p>
              {all.length === 0 ? (
                <p className={styles.muted}>Nobody has connected a Whop business yet.</p>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Owner</th>
                        <th scope="col">Company</th>
                        <th scope="col">Business</th>
                        <th scope="col">Status</th>
                        <th scope="col">Setup complete</th>
                        <th scope="col">Checked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {all.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.ownerName}
                            <div className={styles.muted}>{c.ownerEmail}</div>
                          </td>
                          <td>{c.orgName}</td>
                          <td>
                            {c.label ?? c.bizId}
                            <div className={styles.muted}>
                              <code>{c.bizId}</code> {c.environment === 'SANDBOX' ? '· sandbox' : ''}
                            </div>
                          </td>
                          <td>
                            <Badge tone={c.status === 'ACTIVE' ? 'success' : 'danger'} dot>
                              {c.status === 'ACTIVE' ? 'Connected' : 'Needs attention'}
                            </Badge>
                          </td>
                          <td>{c.checklist?.canLaunch ? 'Yes' : 'Not yet'}</td>
                          <td>{timeAgo(c.lastCheckedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
