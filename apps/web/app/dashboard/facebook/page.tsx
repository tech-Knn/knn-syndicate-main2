'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { ApiError, facebook } from '@/lib/api';
import { type FbAccount, type FbPage, type FbPixel, type FbProfile, type FbProfileWithOwner } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from './facebook.module.css';

interface Banner {
  tone: 'success' | 'error';
  text: string;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function relExpiry(iso?: string): string {
  if (!iso) return '—';
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'in 1 day';
  if (days === 0) return 'today';
  return `${Math.abs(days)} days ago`;
}

/** One connected profile: name + status + assets, expandable to its accounts & pages. */
function ProfileBlock({
  profile,
  owner,
  onChanged,
  setBanner,
  onReconnect,
}: {
  profile: FbProfile | FbProfileWithOwner;
  owner?: { email: string; org: string };
  onChanged: () => void;
  setBanner: (b: Banner | null) => void;
  onReconnect: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<FbAccount[] | null>(null);
  const [pages, setPages] = useState<FbPage[] | null>(null);
  const [pixels, setPixels] = useState<Record<string, FbPixel[] | 'loading'>>({});
  const [expandedAcc, setExpandedAcc] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const broken = profile.status === 'CONNECTION_BROKEN';

  const loadDrill = useCallback(async () => {
    setAccounts(null);
    setPages(null);
    try {
      const [acc, pg] = await Promise.all([facebook.profileAccounts(profile.id), facebook.profilePages(profile.id)]);
      setAccounts(acc);
      setPages(pg);
    } catch {
      setAccounts([]);
      setPages([]);
    }
  }, [profile.id]);

  const toggleOpen = (): void => {
    setOpen((o) => {
      if (!o && accounts === null) void loadDrill();
      return !o;
    });
  };

  const togglePixels = (a: FbAccount): void => {
    setExpandedAcc((prev) => {
      const next = new Set(prev);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
    if (!pixels[a.id]) {
      setPixels((p) => ({ ...p, [a.id]: 'loading' }));
      void facebook
        .pixels(a.id)
        .then((list) => setPixels((p) => ({ ...p, [a.id]: list })))
        .catch(() => setPixels((p) => ({ ...p, [a.id]: [] })));
    }
  };

  const resync = async (): Promise<void> => {
    setSyncing(true);
    setBanner(null);
    try {
      const r = await facebook.syncProfile(profile.id);
      setBanner({ tone: 'success', text: `Synced ${r.adAccounts} ad account(s), ${r.pages} page(s), ${r.pixels} pixel(s).` });
      if (open) await loadDrill();
      onChanged();
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof ApiError ? err.message : 'Sync failed.' });
      if (err instanceof ApiError && err.status === 409) onChanged();
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!window.confirm(`Disconnect “${profile.name}”? Its synced accounts/pages will be removed.`)) return;
    setDisconnecting(true);
    try {
      await facebook.disconnectProfile(profile.id);
      setBanner({ tone: 'success', text: `Disconnected “${profile.name}”.` });
      onChanged();
    } catch {
      setBanner({ tone: 'error', text: 'Could not disconnect.' });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Card className={styles.account}>
      <div className={styles.accountTop}>
        <div className={styles.accountId}>
          <div className={styles.heroIcon} style={{ width: 40, height: 40, fontSize: '1.2rem' }}>
            f
          </div>
          <div>
            <div className={styles.accountName}>{profile.name}</div>
            <div className={styles.accountSub}>
              {owner ? `${owner.email} · ${owner.org}` : `id ${profile.fbUserId}`}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={toggleOpen}>
            {open ? 'Hide assets' : `Assets (${profile.adAccountCount}/${profile.pageCount})`}
          </Button>
          {broken ? (
            <Button onClick={onReconnect}>Reconnect</Button>
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
          <span className={styles.metaLabel}>Ad accounts</span>
          <span className={styles.metaValue}>{profile.adAccountCount}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Pages</span>
          <span className={styles.metaValue}>{profile.pageCount}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Token expires</span>
          <span className={styles.metaValue}>{relExpiry(profile.tokenExpiresAt)}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Connected</span>
          <span className={styles.metaValue}>{fmtDate(profile.connectedAt)}</span>
        </div>
      </div>

      {broken && profile.lastError && (
        <div className={`${styles.banner} ${styles.bannerError}`}>Connection lost: {profile.lastError}</div>
      )}

      {open && (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Ad accounts</h3>
            <span className={styles.count}>{accounts?.length ?? 0}</span>
          </div>
          <div className={styles.list}>
            <div className={`${styles.row} ${styles.rowHead}`}>
              <span>Name</span>
              <span>Account ID</span>
              <span>Currency</span>
              <span />
            </div>
            {accounts === null ? (
              <div className={styles.loadingRow}>
                <Spinner />
              </div>
            ) : accounts.length > 0 ? (
              accounts.map((a) => {
                const px = pixels[a.id];
                const isOpen = expandedAcc.has(a.id);
                return (
                  <div key={a.id} className={styles.row}>
                    <span className={styles.cellName}>{a.name}</span>
                    <span className={styles.cellMono}>{a.fbAccountId}</span>
                    <span>
                      {a.currency} · {a.timezone}
                    </span>
                    <button className={styles.expandBtn} onClick={() => togglePixels(a)}>
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
              <div className={styles.empty}>No ad accounts found for this profile.</div>
            )}
          </div>

          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Pages</h3>
            <span className={styles.count}>{pages?.length ?? 0}</span>
          </div>
          <div className={styles.list}>
            {pages === null ? (
              <div className={styles.loadingRow}>
                <Spinner />
              </div>
            ) : pages.length > 0 ? (
              pages.map((p) => (
                <div key={p.id} className={styles.row}>
                  <span className={styles.cellName}>{p.name}</span>
                  <span className={styles.cellMono}>{p.fbPageId}</span>
                  <span>{p.instagramId ? 'IG linked' : '—'}</span>
                  <span />
                </div>
              ))
            ) : (
              <div className={styles.empty}>No pages found for this profile.</div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export default function FacebookPage() {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [profiles, setProfiles] = useState<FbProfile[] | null>(null);
  const [allProfiles, setAllProfiles] = useState<FbProfileWithOwner[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProfiles(await facebook.profiles());
    } catch {
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    if (!isSuper) return;
    try {
      setAllProfiles(await facebook.allProfiles());
    } catch {
      setAllProfiles([]);
    }
  }, [isSuper]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fb_connected')) setBanner({ tone: 'success', text: 'Facebook profile connected. Its accounts are syncing.' });
    else if (params.get('fb_error')) setBanner({ tone: 'error', text: `Connection failed (${params.get('fb_error')}). Try again.` });
    if (params.has('fb_connected') || params.has('fb_error')) window.history.replaceState({}, '', window.location.pathname);
    void load();
    void loadAll();
  }, [load, loadAll]);

  const refresh = useCallback(() => {
    void load();
    void loadAll();
  }, [load, loadAll]);

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

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Facebook</h1>
          <p className={styles.subtitle}>
            {isSuper
              ? 'Connect your own Facebook profiles and oversee every profile connected across the platform.'
              : 'Connect one or more Facebook profiles to sync ad accounts, pages, and pixels for launching campaigns.'}
          </p>
        </div>
        <Button onClick={() => void connect()} loading={connecting}>
          {connecting ? 'Redirecting…' : 'Connect a profile'}
        </Button>
      </div>

      {banner && (
        <div className={`${styles.banner} ${banner.tone === 'success' ? styles.bannerSuccess : styles.bannerError}`}>
          {banner.text}
        </div>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Your profiles</h3>
          <span className={styles.count}>{profiles?.length ?? 0}</span>
        </div>
        {loading ? (
          <Card className={styles.loadingRow}>
            <Spinner />
          </Card>
        ) : !profiles || profiles.length === 0 ? (
          <Card className={styles.hero}>
            <div className={styles.heroIcon}>f</div>
            <h2 className={styles.heroTitle}>Connect your first Facebook profile</h2>
            <p className={styles.heroText}>
              You&rsquo;ll be redirected to Facebook to authorize ad management. You can connect several
              profiles — each keeps its own ad accounts, pages, and pixels.
            </p>
            <div className={styles.heroActions}>
              <Button onClick={() => void connect()} loading={connecting}>
                {connecting ? 'Redirecting…' : 'Connect Facebook'}
              </Button>
            </div>
          </Card>
        ) : (
          profiles.map((p) => (
            <ProfileBlock key={p.id} profile={p} onChanged={refresh} setBanner={setBanner} onReconnect={() => void connect()} />
          ))
        )}
      </section>

      {isSuper && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>All connected profiles (platform)</h3>
            <span className={styles.count}>{allProfiles?.length ?? 0}</span>
          </div>
          <p className={styles.subtitle}>Every Facebook profile connected by any user, across all companies. You can re-sync or disconnect any for support.</p>
          {allProfiles === null ? (
            <Card className={styles.loadingRow}>
              <Spinner />
            </Card>
          ) : allProfiles.length === 0 ? (
            <Card className={styles.hero}>
              <p className={styles.heroText}>No profiles connected anywhere yet.</p>
            </Card>
          ) : (
            allProfiles.map((p) => (
              <ProfileBlock
                key={p.id}
                profile={p}
                owner={{ email: p.ownerEmail, org: p.orgName }}
                onChanged={refresh}
                setBanner={setBanner}
                onReconnect={() => setBanner({ tone: 'error', text: 'Only the profile owner can reconnect it (they re-authorize with Facebook).' })}
              />
            ))
          )}
        </section>
      )}
    </div>
  );
}
