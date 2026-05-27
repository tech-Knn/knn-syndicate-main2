'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { ApiError, facebook } from '@/lib/api';
import {
  type ConnectionStatus,
  type FbAccount,
  type FbPage,
  type FbPixel,
} from '@/lib/types';
import styles from './facebook.module.css';

interface Banner {
  tone: 'success' | 'error';
  text: string;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function relExpiry(iso?: string): string {
  if (!iso) return '—';
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'in 1 day';
  if (days === 0) return 'today';
  return `${Math.abs(days)} days ago`;
}

export default function FacebookPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [accounts, setAccounts] = useState<FbAccount[] | null>(null);
  const [pages, setPages] = useState<FbPage[] | null>(null);
  const [pixels, setPixels] = useState<Record<string, FbPixel[] | 'loading'>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadEntities = useCallback(async () => {
    const [acc, pg] = await Promise.all([facebook.accounts(), facebook.pages()]);
    setAccounts(acc);
    setPages(pg);
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await facebook.status();
      setStatus(s);
      if (s.connected) await loadEntities();
      else {
        setAccounts(null);
        setPages(null);
      }
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [loadEntities]);

  useEffect(() => {
    // Surface the OAuth callback result, then strip the query so a refresh is clean.
    const params = new URLSearchParams(window.location.search);
    if (params.get('fb_connected')) {
      setBanner({ tone: 'success', text: 'Facebook connected. Your accounts are syncing.' });
    } else if (params.get('fb_error')) {
      setBanner({ tone: 'error', text: `Connection failed (${params.get('fb_error')}). Try again.` });
    }
    if (params.has('fb_connected') || params.has('fb_error')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    void loadStatus();
  }, [loadStatus]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setBanner(null);
    try {
      const { url } = await facebook.authUrl();
      window.location.href = url;
    } catch (err) {
      setBanner({
        tone: 'error',
        text:
          err instanceof ApiError && err.status === 503
            ? 'Facebook is not configured on this environment yet.'
            : 'Could not start the Facebook connection.',
      });
      setConnecting(false);
    }
  }, []);

  const resync = useCallback(async () => {
    setSyncing(true);
    setBanner(null);
    try {
      const r = await facebook.sync();
      await loadEntities();
      setBanner({
        tone: 'success',
        text: `Synced ${r.adAccounts} ad account(s), ${r.pages} page(s), ${r.pixels} pixel(s).`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Sync failed.',
      });
      if (err instanceof ApiError && err.status === 409) await loadStatus();
    } finally {
      setSyncing(false);
    }
  }, [loadEntities, loadStatus]);

  const disconnect = useCallback(async () => {
    if (!window.confirm('Disconnect this Facebook account? Synced accounts will be removed.')) return;
    setDisconnecting(true);
    try {
      await facebook.disconnect();
      setExpanded(new Set());
      setPixels({});
      setBanner({ tone: 'success', text: 'Facebook disconnected.' });
      await loadStatus();
    } catch {
      setBanner({ tone: 'error', text: 'Could not disconnect.' });
    } finally {
      setDisconnecting(false);
    }
  }, [loadStatus]);

  const toggleAccount = useCallback(
    (account: FbAccount) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(account.id)) next.delete(account.id);
        else next.add(account.id);
        return next;
      });
      if (!pixels[account.id]) {
        setPixels((p) => ({ ...p, [account.id]: 'loading' }));
        void facebook
          .pixels(account.id)
          .then((list) => setPixels((p) => ({ ...p, [account.id]: list })))
          .catch(() => setPixels((p) => ({ ...p, [account.id]: [] })));
      }
    },
    [pixels],
  );

  const broken = status?.status === 'CONNECTION_BROKEN';

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Facebook</h1>
          <p className={styles.subtitle}>
            Connect a Facebook account to sync ad accounts, pages, and pixels for launching campaigns.
          </p>
        </div>
      </div>

      {banner && (
        <div
          className={`${styles.banner} ${banner.tone === 'success' ? styles.bannerSuccess : styles.bannerError}`}
        >
          {banner.text}
        </div>
      )}

      {loading ? (
        <Card className={styles.loadingRow}>
          <Spinner />
        </Card>
      ) : !status?.connected ? (
        <Card className={styles.hero}>
          <div className={styles.heroIcon}>f</div>
          <h2 className={styles.heroTitle}>Connect your Facebook account</h2>
          <p className={styles.heroText}>
            You&rsquo;ll be redirected to Facebook to authorize ad management. Use a Facebook account
            that has access to your ad accounts.
          </p>
          <div className={styles.heroActions}>
            <Button onClick={() => void connect()} loading={connecting}>
              {connecting ? 'Redirecting…' : 'Connect Facebook'}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {broken && status?.lastError && (
            <div className={`${styles.banner} ${styles.bannerError}`}>
              Connection lost: {status.lastError}
            </div>
          )}

          <Card className={styles.account}>
            <div className={styles.accountTop}>
              <div className={styles.accountId}>
                <div className={styles.heroIcon} style={{ width: 40, height: 40, fontSize: '1.2rem' }}>
                  f
                </div>
                <div>
                  <div className={styles.accountName}>Facebook account</div>
                  <div className={styles.accountSub}>id {status.fbUserId}</div>
                </div>
              </div>
              <div className={styles.actions}>
                {broken ? (
                  <Button onClick={() => void connect()} loading={connecting}>
                    Reconnect
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => void resync()} loading={syncing}>
                    {syncing ? 'Syncing…' : 'Re-sync'}
                  </Button>
                )}
                <Button variant="danger" onClick={() => void disconnect()} loading={disconnecting}>
                  Disconnect
                </Button>
              </div>
            </div>

            <div className={styles.meta}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Status</span>
                <span className={styles.metaValue}>
                  {broken ? (
                    <Badge tone="danger" dot>
                      Reconnect needed
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      Connected
                    </Badge>
                  )}
                </span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Token expires</span>
                <span className={styles.metaValue}>{relExpiry(status.tokenExpiresAt)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Connected</span>
                <span className={styles.metaValue}>{fmtDate(status.connectedAt)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Scopes</span>
                <span className={styles.scopes}>
                  {(status.scopes ?? []).map((s) => (
                    <span key={s} className={styles.scope}>
                      {s}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </Card>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Ad accounts</h3>
              <span className={styles.count}>{accounts?.length ?? 0}</span>
            </div>
            <Card className={styles.list}>
              <div className={`${styles.row} ${styles.rowHead}`}>
                <span>Name</span>
                <span>Account ID</span>
                <span>Currency</span>
                <span />
              </div>
              {accounts && accounts.length > 0 ? (
                accounts.map((a) => {
                  const px = pixels[a.id];
                  const isOpen = expanded.has(a.id);
                  return (
                    <div key={a.id} className={styles.row}>
                      <span className={styles.cellName}>{a.name}</span>
                      <span className={styles.cellMono}>{a.fbAccountId}</span>
                      <span>
                        {a.currency} · {a.timezone}
                      </span>
                      <button className={styles.expandBtn} onClick={() => toggleAccount(a)}>
                        {isOpen ? 'Hide pixels' : 'Pixels'}
                      </button>
                      {isOpen && (
                        <div className={styles.pixels}>
                          {px === 'loading' || px === undefined ? (
                            <Spinner />
                          ) : px.length > 0 ? (
                            px.map((p) => (
                              <span key={p.id} className={styles.pixel}>
                                {p.name}
                                <span className={styles.pixelId}>{p.fbPixelId}</span>
                              </span>
                            ))
                          ) : (
                            <span className={styles.empty}>No pixels on this account.</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className={styles.empty}>No ad accounts found for this connection.</div>
              )}
            </Card>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Pages</h3>
              <span className={styles.count}>{pages?.length ?? 0}</span>
            </div>
            <Card className={styles.list}>
              {pages && pages.length > 0 ? (
                pages.map((p) => (
                  <div key={p.id} className={styles.row}>
                    <span className={styles.cellName}>{p.name}</span>
                    <span className={styles.cellMono}>{p.fbPageId}</span>
                    <span>{p.instagramId ? 'IG linked' : '—'}</span>
                    <span />
                  </div>
                ))
              ) : (
                <div className={styles.empty}>No pages found for this connection.</div>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
