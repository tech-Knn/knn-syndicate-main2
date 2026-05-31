'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, EmptyState, Spinner, useConfirm, useToast } from '@/components/ui';
import { ApiError, facebook } from '@/lib/api';
import { type FbAccount, type FbPage, type FbPixel, type FbProfile, type FbProfileWithOwner, type LaunchAccessResult } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from './facebook.module.css';

interface PageBanner {
  tone: 'success' | 'error';
  text: string;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Milliseconds from now until `iso` (negative = already expired). null when unknown. */
function msToExpiry(iso?: string): number | null {
  if (!iso) return null;
  return new Date(iso).getTime() - Date.now();
}

/** Adaptive relative time — minutes (<90m), hours (<48h), else days. Handles the
 *  short-lived LAUNCH token (≈1–2h) AND the long-lived DATA token (≈60d). */
function relExpiry(ms: number): string {
  const abs = Math.abs(ms);
  const unit =
    abs < 90 * 60_000
      ? `${Math.max(1, Math.round(abs / 60_000))} min`
      : abs < 48 * 3_600_000
        ? `${Math.round(abs / 3_600_000)} hr`
        : `${Math.round(abs / 86_400_000)} days`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Token expiry rendered as a Badge: danger when expired, warning when ≤7 days out. */
function TokenExpiry({ iso }: { iso?: string }): React.ReactNode {
  const ms = msToExpiry(iso);
  if (ms === null) return <span className={styles.metaValue}>—</span>;
  const rel = relExpiry(ms);
  if (ms < 0) {
    return (
      <Badge tone="danger" dot>
        Expired {rel}
      </Badge>
    );
  }
  if (ms <= 7 * 86_400_000) {
    return (
      <Badge tone="warning" dot>
        Expires {rel}
      </Badge>
    );
  }
  return <span className={styles.metaValue}>Expires {rel}</span>;
}

/**
 * Facebook `account_status` codes (the raw numeric code is stored as a string).
 * Grouped into a tone + readable label for the accounts table.
 */
const ACCOUNT_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  '1': { label: 'Active', tone: 'success' },
  '201': { label: 'Active', tone: 'success' },
  '2': { label: 'Disabled', tone: 'danger' },
  '101': { label: 'Closed', tone: 'danger' },
  '202': { label: 'Closed', tone: 'danger' },
  '3': { label: 'Unsettled', tone: 'warning' },
  '7': { label: 'Pending review', tone: 'warning' },
  '8': { label: 'Pending settlement', tone: 'warning' },
  '9': { label: 'Grace period', tone: 'warning' },
  '100': { label: 'Pending closure', tone: 'warning' },
};

/** Ad-account status rendered as a Badge derived from the FB `account_status` code. */
function AccountStatus({ status }: { status: string }): React.ReactNode {
  const meta = ACCOUNT_STATUS[status];
  if (!meta) return <Badge tone="neutral">Unknown</Badge>;
  return (
    <Badge tone={meta.tone} dot={meta.tone !== 'success'}>
      {meta.label}
    </Badge>
  );
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
  setBanner: (b: PageBanner | null) => void;
  onReconnect: () => void;
}): React.ReactNode {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<FbAccount[] | null>(null);
  const [pages, setPages] = useState<FbPage[] | null>(null);
  const [drillError, setDrillError] = useState(false);
  const [pixels, setPixels] = useState<Record<string, FbPixel[] | 'loading' | 'error'>>({});
  const [expandedAcc, setExpandedAcc] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [access, setAccess] = useState<LaunchAccessResult | 'loading' | null>(null);
  const broken = profile.status === 'CONNECTION_BROKEN';
  const expiryMs = msToExpiry(profile.tokenExpiresAt);
  const expired = expiryMs !== null && expiryMs < 0;
  const isLaunch = profile.appKind === 'LAUNCH';
  const canCheckAccess = isLaunch && !broken && !expired && !owner;

  const checkAccess = useCallback(async () => {
    setAccess('loading');
    try {
      setAccess(await facebook.launchAccess(profile.id));
    } catch {
      setAccess(null);
    }
  }, [profile.id]);

  // Auto-verify a launch app's asset coverage on mount, so the buyer sees right away
  // whether a clone/relaunch will work (no surprise "different account" error later).
  useEffect(() => {
    if (canCheckAccess) void checkAccess();
  }, [canCheckAccess, checkAccess]);
  // Super-admin oversight rows carry an `owner`; only the owner can re-authorize,
  // so the Reconnect control dead-ends here — surface guidance instead.
  const isOversight = !!owner;

  const loadDrill = useCallback(async () => {
    setAccounts(null);
    setPages(null);
    setDrillError(false);
    try {
      const [acc, pg] = await Promise.all([facebook.profileAccounts(profile.id), facebook.profilePages(profile.id)]);
      setAccounts(acc);
      setPages(pg);
    } catch {
      setAccounts([]);
      setPages([]);
      setDrillError(true);
    }
  }, [profile.id]);

  const toggleOpen = (): void => {
    setOpen((o) => {
      if (!o && accounts === null) void loadDrill();
      return !o;
    });
  };

  const loadPixels = useCallback((a: FbAccount): void => {
    setPixels((p) => ({ ...p, [a.id]: 'loading' }));
    void facebook
      .pixels(a.id)
      .then((list) => setPixels((p) => ({ ...p, [a.id]: list })))
      .catch(() => setPixels((p) => ({ ...p, [a.id]: 'error' })));
  }, []);

  const togglePixels = (a: FbAccount): void => {
    setExpandedAcc((prev) => {
      const next = new Set(prev);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
    if (!pixels[a.id]) loadPixels(a);
  };

  const resync = async (): Promise<void> => {
    setSyncing(true);
    setBanner(null);
    try {
      const r = await facebook.syncProfile(profile.id);
      toast.success(`Synced ${r.adAccounts} ad account(s), ${r.pages} page(s), ${r.pixels} pixel(s).`);
      if (open) await loadDrill();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Sync failed.');
      if (err instanceof ApiError && err.status === 409) onChanged();
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    const ok = await confirm({
      title: `Disconnect “${profile.name}”?`,
      body: 'Its synced ad accounts and pages will be removed. Campaigns already launched are not affected.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    setDisconnecting(true);
    try {
      await facebook.disconnectProfile(profile.id);
      toast.success(`Disconnected “${profile.name}”.`);
      onChanged();
    } catch {
      toast.error('Could not disconnect.');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Card className={styles.account}>
      <div className={styles.accountTop}>
        <div className={styles.accountId}>
          <div className={styles.heroIcon} style={{ width: 40, height: 40, fontSize: '1.2rem' }} aria-hidden>
            f
          </div>
          <div>
            <div className={styles.accountName}>
              {profile.name}{' '}
              {profile.appKind === 'LAUNCH' ? <Badge tone="warning">Launch app · short-lived</Badge> : null}
            </div>
            <div className={styles.accountSub}>
              {owner ? `${owner.email} · ${owner.org}` : `id ${profile.fbUserId}`}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          {/* A LAUNCH connection owns no ad accounts/pages (the main connection does), so the
              assets drill-down + re-sync don't apply — its only action is reconnecting the token. */}
          {!isLaunch && (
            <Button variant="ghost" onClick={toggleOpen} aria-expanded={open}>
              {open ? 'Hide assets' : `Assets (${profile.adAccountCount}/${profile.pageCount})`}
            </Button>
          )}
          {isLaunch ? (
            isOversight ? (
              <span className={styles.ownerNote}>Owner reconnects before launching</span>
            ) : (
              <Button onClick={onReconnect}>{expired ? 'Reconnect to publish' : 'Refresh token'}</Button>
            )
          ) : broken || expired ? (
            isOversight ? (
              <span className={styles.ownerNote}>Owner must reconnect</span>
            ) : (
              <Button onClick={onReconnect}>Reconnect</Button>
            )
          ) : (
            <Button variant="secondary" onClick={() => void resync()} loading={syncing}>
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
            ) : expired ? (
              <Badge tone="danger" dot>
                Token expired
              </Badge>
            ) : (
              <Badge tone="success" dot>
                Connected
              </Badge>
            )}
          </span>
        </div>
        {!isLaunch && (
          <>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Ad accounts</span>
              <span className={styles.metaValue}>{profile.adAccountCount}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Pages</span>
              <span className={styles.metaValue}>{profile.pageCount}</span>
            </div>
          </>
        )}
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Token expires</span>
          <span className={styles.metaValue}>
            <TokenExpiry iso={profile.tokenExpiresAt} />
          </span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Connected</span>
          <span className={styles.metaValue}>{fmtDate(profile.connectedAt)}</span>
        </div>
      </div>

      {/* Launch-app asset coverage: does this short-lived token see everything the main
          connection synced? Green ✓ = clone/relaunch will work; gaps = re-grant first. */}
      {canCheckAccess && (
        <div className={styles.accessRow}>
          {access === 'loading' || access === null ? (
            <span className={styles.metaValue}>Checking asset access…</span>
          ) : access.status === 'ok' ? (
            <Badge tone="success" dot>
              Covers all {access.total} of your assets — ready to launch
            </Badge>
          ) : access.status === 'no_assets' ? (
            <span className={styles.metaValue}>Connect your main profile first (no synced assets to cover yet).</span>
          ) : access.status === 'expired' || access.status === 'broken' ? (
            <Badge tone="warning" dot>
              Token expired — reconnect to publish
            </Badge>
          ) : (
            <div className={styles.accessGaps}>
              <Badge tone="danger" dot>
                Missing access to {access.missing.length} of {access.total} assets
              </Badge>
              <span className={styles.accessGapList}>
                {access.missing.map((m) => `${m.type}: ${m.name}`).join(' · ')}
              </span>
              <span className={styles.accessHint}>
                Reconnect the launch app and grant these — otherwise launching a campaign that uses them will fail.
              </span>
            </div>
          )}
          {access !== 'loading' && (
            <button type="button" className={styles.accessRecheck} onClick={() => void checkAccess()}>
              Re-check
            </button>
          )}
        </div>
      )}

      {profile.scopes.length > 0 && (
        <div className={styles.metaItem} style={{ marginTop: 'var(--space-3)' }}>
          <span className={styles.metaLabel}>Permissions granted</span>
          <div className={styles.scopes}>
            {profile.scopes.map((s) => (
              <span key={s} className={styles.scope}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {(broken || expired) && (
        <div className={styles.profileBanner}>
          <Banner
            tone="error"
            title={broken ? 'Connection lost' : 'Access token expired'}
            action={
              isOversight ? (
                <span className={styles.ownerNote}>Owner must reconnect</span>
              ) : (
                <Button onClick={onReconnect}>Reconnect</Button>
              )
            }
          >
            {isOversight
              ? broken
                ? `${profile.lastError ?? 'Facebook revoked this connection.'} Only ${owner?.email ?? 'the owner'} can re-authorize it.`
                : `This token has expired. Only ${owner?.email ?? 'the owner'} can re-authorize this profile with Facebook.`
              : broken
                ? (profile.lastError ?? 'Facebook revoked this connection. Reconnect to resume syncing.')
                : 'Reconnect to re-authorize with Facebook and resume syncing this profile.'}
          </Banner>
        </div>
      )}

      {open && (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Ad accounts</h3>
            <span className={styles.count}>{accounts?.length ?? 0}</span>
          </div>
          {accounts === null ? (
            <div className={styles.loadingRow}>
              <Spinner />
            </div>
          ) : drillError ? (
            <div className={styles.profileBanner}>
              <Banner
                tone="error"
                title="Couldn’t load assets"
                action={
                  <Button variant="secondary" onClick={() => void loadDrill()}>
                    Retry
                  </Button>
                }
              >
                We couldn’t fetch this profile’s ad accounts and pages. Check the connection and try again.
              </Banner>
            </div>
          ) : (
            <>
              <div className={styles.list}>
                <div className={`${styles.row} ${styles.accountRow} ${styles.rowHead}`}>
                  <span>Name</span>
                  <span>Account ID</span>
                  <span>Currency</span>
                  <span>Status</span>
                  <span />
                </div>
                {accounts.length > 0 ? (
                  accounts.map((a) => {
                    const px = pixels[a.id];
                    const isOpen = expandedAcc.has(a.id);
                    return (
                      <div key={a.id} className={`${styles.row} ${styles.accountRow}`}>
                        <span className={styles.cellName}>{a.name}</span>
                        <span className={styles.cellMono}>{a.fbAccountId}</span>
                        <span>
                          {a.currency} · {a.timezone}
                        </span>
                        <span>
                          <AccountStatus status={a.status} />
                        </span>
                        <button
                          type="button"
                          className={styles.expandBtn}
                          onClick={() => togglePixels(a)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? `Hide pixels for ${a.name}` : `Show pixels for ${a.name}`}
                        >
                          {isOpen ? 'Hide pixels' : 'Pixels'}
                        </button>
                        {isOpen && (
                          <div className={styles.pixels}>
                            {px === 'loading' || px === undefined ? (
                              <Spinner />
                            ) : px === 'error' ? (
                              <span className={styles.pixelError}>
                                Couldn’t load pixels.{' '}
                                <button type="button" className={styles.retryLink} onClick={() => loadPixels(a)}>
                                  Retry
                                </button>
                              </span>
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
                  <>
                    <div className={`${styles.row} ${styles.pageRow} ${styles.rowHead}`}>
                      <span>Name</span>
                      <span>Page ID</span>
                      <span>Instagram</span>
                    </div>
                    {pages.map((p) => (
                      <div key={p.id} className={`${styles.row} ${styles.pageRow}`}>
                        <span className={styles.cellName}>{p.name}</span>
                        <span className={styles.cellMono}>{p.fbPageId}</span>
                        <span>
                          {p.instagramId ? (
                            <Badge tone="brand">IG linked</Badge>
                          ) : (
                            <span className={styles.metaValue}>—</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className={styles.empty}>No pages found for this profile.</div>
                )}
              </div>
            </>
          )}
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
  const [banner, setBanner] = useState<PageBanner | null>(null);
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

  const connect = useCallback(async (app: 'data' | 'launch' = 'data') => {
    setConnecting(true);
    setBanner(null);
    try {
      const { url } = await facebook.authUrl(app);
      window.location.href = url;
    } catch (err) {
      setBanner({
        tone: 'error',
        text:
          err instanceof ApiError && err.status === 503
            ? app === 'launch'
              ? 'The Facebook launch app is not configured on this environment yet.'
              : 'Facebook is not configured on this environment yet.'
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
        <div className={styles.connectActions}>
          <Button onClick={() => void connect('data')} loading={connecting}>
            {connecting ? 'Redirecting…' : 'Connect a profile'}
          </Button>
          {/* The short-lived LAUNCH app (used only to publish ads past the FB security
              checkpoint). Reconnect it right before launching — its token is short-lived. */}
          <Button variant="secondary" onClick={() => void connect('launch')} loading={connecting}>
            Connect launch app
          </Button>
        </div>
      </div>

      {banner && (
        <div className={styles.pageBanner}>
          <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </Banner>
        </div>
      )}

      {/* Two-connection explainer — buyers need to know WHY there are two + WHEN to use each. */}
      <Card className={styles.explainer}>
        <h3 className={styles.explainerTitle}>How connecting Facebook works here</h3>
        <p className={styles.explainerLead}>
          Facebook blocks ad publishing from our servers on a long-lived login token, so we split it into
          two connections. Connect both once, then just <strong>refresh the launch app right before you launch</strong>.
        </p>
        <div className={styles.explainerGrid}>
          <div className={styles.explainerCol}>
            <Badge tone="success">Main connection</Badge>
            <p>
              Long-lived (~60 days). Syncs your ad accounts, Pages &amp; pixels and tracks results &amp; conversions.
              Connect it once — we keep it refreshed for you.
            </p>
          </div>
          <div className={styles.explainerCol}>
            <Badge tone="warning">Launch app · short-lived</Badge>
            <p>
              Used <em>only</em> to publish ads (it clears Facebook&rsquo;s security check). Its token lasts ~1–2 hours,
              so click <strong>Connect launch app</strong> just before launching — and grant it the <strong>same</strong>{' '}
              ad accounts, Pages &amp; pixels as your main connection, or publishing will fail.
            </p>
          </div>
        </div>
      </Card>

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
            <div className={styles.heroIcon} aria-hidden>
              f
            </div>
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
            <ProfileBlock
              key={p.id}
              profile={p}
              onChanged={refresh}
              setBanner={setBanner}
              onReconnect={() => void connect(p.appKind === 'LAUNCH' ? 'launch' : 'data')}
            />
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
            <Card>
              <EmptyState title="No profiles connected anywhere yet" description="Once any user connects a Facebook profile, it will appear here for platform oversight." />
            </Card>
          ) : (
            allProfiles.map((p) => (
              <ProfileBlock
                key={p.id}
                profile={p}
                owner={{ email: p.ownerEmail, org: p.orgName }}
                onChanged={refresh}
                setBanner={setBanner}
                // Oversight rows surface "Owner must reconnect" inline and never invoke this.
                onReconnect={() => {}}
              />
            ))
          )}
        </section>
      )}
    </div>
  );
}
