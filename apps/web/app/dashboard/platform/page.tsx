'use client';

import { type FormEvent, Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type PlatformSettings, addBusinessDays, currentBusinessDay } from '@knn/shared';
import { Badge, Banner, Button, Card, EmptyState, Skeleton, useConfirm, useToast } from '@/components/ui';
import { adsense, admin } from '@/lib/api';
import { type AdsenseRevenuePreview, type AfsAccountRow } from '@/lib/types';
import { useAuth } from '../../providers';
import { RedirectDomainsPanel } from './redirect-domains-panel';
import styles from '../admin.module.css';

export default function PlatformPage() {
  const { user } = useAuth();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [afsAccounts, setAfsAccounts] = useState<AfsAccountRow[] | null>(null);
  const [catSyncing, setCatSyncing] = useState<string | null>(null);
  const [adsNote, setAdsNote] = useState<string | null>(null);

  // Live AFS revenue preview (per account) + on-demand attribution pull.
  const [revOpen, setRevOpen] = useState<string | null>(null);
  const [revData, setRevData] = useState<Record<string, AdsenseRevenuePreview | 'loading' | 'error'>>({});
  const [pulling, setPulling] = useState(false);

  const previewRevenue = useCallback((accountId: string): void => {
    if (revOpen === accountId) {
      setRevOpen(null);
      return;
    }
    setRevOpen(accountId);
    setRevData((d) => ({ ...d, [accountId]: 'loading' }));
    const until = currentBusinessDay();
    const since = addBusinessDays(until, -6); // last 7 IST days
    void adsense
      .report(accountId, since, until)
      .then((r) => setRevData((d) => ({ ...d, [accountId]: r })))
      .catch(() => setRevData((d) => ({ ...d, [accountId]: 'error' })));
  }, [revOpen]);

  const pullRevenueNow = async (): Promise<void> => {
    setPulling(true);
    setAdsNote('Pulling FB + AdSense and re-allocating revenue… (refresh dashboards in ~1 min)');
    try {
      await adsense.runAttribution();
      setAdsNote('Attribution run queued — revenue will appear in campaign dashboards shortly.');
    } catch {
      setAdsNote('Could not queue the attribution run — check the worker is up.');
    } finally {
      setPulling(false);
    }
  };

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const loadAfsAccounts = useCallback(() => {
    void adsense.accounts().then(setAfsAccounts).catch(() => setAfsAccounts([]));
  }, []);

  // Surface the OAuth return (?adsense=connected / ?adsense_error=…).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('adsense') === 'connected') setAdsNote('AdSense account connected. Use “Sync catalog” to pull its channels.');
    else if (p.get('adsense_error')) setAdsNote(`AdSense connect failed: ${p.get('adsense_error')}`);
  }, []);

  const connectAdsense = async (): Promise<void> => {
    try {
      const { url } = await adsense.authUrl();
      window.location.href = url;
    } catch {
      setAdsNote('Google / AdSense is not configured on the server yet.');
    }
  };

  const syncCatalog = async (id: string): Promise<void> => {
    setCatSyncing(id);
    setAdsNote('Syncing the account’s channels from AdSense… (large accounts take a moment)');
    try {
      const r = await adsense.syncCatalog(id);
      setAdsNote(`Synced ${r.synced.toLocaleString()} channels from AdSense into the catalog.`);
      loadAfsAccounts();
    } catch {
      setAdsNote('Catalog sync failed — confirm AFS access is granted for this account, then retry.');
    } finally {
      setCatSyncing(null);
    }
  };

  const disconnectAfs = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: 'Disconnect this AdSense account?',
      body: 'It stops syncing and pulling revenue. Imported channels stay in the pool; reconnect any time to resume.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await adsense.disconnectAccount(id);
      toast.success('AdSense account disconnected.');
    } catch {
      toast.error('Could not disconnect the account — try again.');
    }
    loadAfsAccounts();
  };

  useEffect(() => {
    loadAfsAccounts();
    void admin.settings().then(setSettings).catch(() => setSettings({ compliancePrompt: '', articleDomain: '', redirectDomain: '' }));
  }, [loadAfsAccounts]);

  const saveSettings = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    setSavedAt(false);
    try {
      const updated = await admin.updateSettings(settings);
      setSettings(updated);
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Setup</h1>
          <p className={styles.sub}>AdSense accounts, redirect domains, and platform settings. Companies, Domains, Channels &amp; Articles are in the left nav.</p>
        </div>
      </div>

      {/* AdSense accounts (multi-account) */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>AdSense accounts</span>
          <div className={styles.actions}>
            {afsAccounts && afsAccounts.length > 0 && (
              <Button variant="ghost" loading={pulling} onClick={() => void pullRevenueNow()} title="Pull FB + AdSense now and re-allocate revenue into the dashboards">
                Pull revenue now
              </Button>
            )}
            <Button onClick={() => void connectAdsense()}>Connect AdSense account</Button>
          </div>
        </div>
        {adsNote && (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Banner tone="info" onDismiss={() => setAdsNote(null)}>{adsNote}</Banner>
          </div>
        )}
        {!afsAccounts ? (
          <div role="status">
            <span className="srOnly">Loading AdSense accounts…</span>
            <Skeleton className={styles.rowSkel} />
          </div>
        ) : afsAccounts.length === 0 ? (
          <EmptyState
            icon="🔌"
            title="No AdSense accounts connected"
            description="“Connect AdSense account” onboards every AFS account that Google login can see — connect again with a different login to add more."
            action={<Button onClick={() => void connectAdsense()}>Connect AdSense account</Button>}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Account</th>
                  <th className={styles.thLeft}>pubId</th>
                  <th>In AdSense</th>
                  <th>Imported</th>
                  <th className={styles.thLeft}>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {afsAccounts.map((a) => {
                  const rev = revData[a.id];
                  return (
                    <Fragment key={a.id}>
                      <tr>
                        <td>
                          <div className={styles.name}>{a.label ?? a.account ?? 'AFS account'}</div>
                          {a.account && <div className={styles.subtle}>{a.account}</div>}
                        </td>
                        <td className="mono">{a.afsPubId ?? '—'}</td>
                        <td className={styles.num}>{a.catalogCount ? a.catalogCount.toLocaleString() : '—'}</td>
                        <td className={styles.num}>{a.importedCount.toLocaleString()}</td>
                        <td>
                          <Badge tone={a.status === 'CONNECTION_BROKEN' ? 'danger' : 'success'}>{a.status.toLowerCase()}</Badge>
                        </td>
                        <td>
                          <div className={styles.actions}>
                            <button type="button" className={styles.actionBtn} aria-expanded={revOpen === a.id} onClick={() => previewRevenue(a.id)}>
                              {revOpen === a.id ? 'Hide revenue' : 'Revenue (7d)'}
                            </button>
                            <button type="button" className={styles.actionBtn} disabled={catSyncing === a.id} onClick={() => void syncCatalog(a.id)}>
                              {catSyncing === a.id ? 'Syncing…' : 'Sync catalog'}
                            </button>
                            <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} onClick={() => void disconnectAfs(a.id)}>
                              Disconnect
                            </button>
                          </div>
                        </td>
                      </tr>
                      {revOpen === a.id && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface-2, rgba(255,255,255,0.02))' }}>
                            {rev === 'loading' || rev === undefined ? (
                              <Skeleton className={styles.rowSkel} />
                            ) : rev === 'error' ? (
                              <p className={styles.empty}>Could not load the live report — confirm AFS reporting access is granted for this account.</p>
                            ) : (
                              <div style={{ padding: '0.4rem 0' }}>
                                <p className={styles.fieldHint}>
                                  <strong>{rev.since} → {rev.until}</strong> · gross{' '}
                                  <strong>{rev.currency} {(rev.totalRevenueMinor / 100).toFixed(2)}</strong> ·{' '}
                                  {rev.totalClicks.toLocaleString()} AFS clicks · top {rev.rows.length} channels ·{' '}
                                  <strong>{rev.matchedInPool}</strong> map to your pool
                                  {rev.rows.length > 0 && rev.matchedInPool === 0 && (
                                    <> — <span style={{ color: 'var(--rust, #d9512c)' }}>none match: the report&apos;s channel ids differ from imported ids (re-sync / mapping fix needed)</span></>
                                  )}.
                                </p>
                                {rev.rows.length === 0 ? (
                                  <p className={styles.empty}>No channel earnings reported in this window.</p>
                                ) : (
                                  <div className={styles.tableWrap}>
                                    <table className={styles.table}>
                                      <thead>
                                        <tr>
                                          <th className={styles.thLeft}>Channel id</th>
                                          <th className={styles.thLeft}>Pool</th>
                                          <th>Revenue</th>
                                          <th>AFS clicks</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rev.rows.slice(0, 25).map((r) => (
                                          <tr key={r.channelId}>
                                            <td className="mono">{r.channelId}</td>
                                            <td className={styles.subtle}>{r.inPool ? (r.label ?? 'imported') : '—'}</td>
                                            <td className={styles.num}>{rev.currency} {(r.revenueMinor / 100).toFixed(2)}</td>
                                            <td className={styles.num}>{r.afsClicks.toLocaleString()}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.fieldHint}>
          <strong>In AdSense</strong> = channels mirrored to the local catalog by &ldquo;Sync catalog&rdquo; (≈ the account&apos;s total).{' '}
          <strong>Imported</strong> = channels added into a website&apos;s usable pool. Browse, import &amp; trace channels in{' '}
          <strong>Channels</strong>.
        </p>
      </Card>

      {/* Redirect domains — the go.* hosts the edge Worker serves (default = ad link target) */}
      <RedirectDomainsPanel />

      {/* Settings */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Platform settings</span>
          {savedAt && <span className={styles.savedNote}>Saved ✓</span>}
        </div>
        {!settings ? (
          <div role="status">
            <span className="srOnly">Loading platform settings…</span>
            <Skeleton className={styles.rowSkel} />
          </div>
        ) : (
          <form className={styles.settingsForm} onSubmit={(e) => void saveSettings(e)}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="compliance">
                Compliance rewrite prompt
              </label>
              <span className={styles.fieldHint}>
                Appended at article generation to rewrite copy for ad-policy compliance. Empty = skip the rewrite.
              </span>
              <textarea
                id="compliance"
                className={styles.textarea}
                value={settings.compliancePrompt}
                onChange={(e) => setSettings({ ...settings, compliancePrompt: e.target.value })}
                placeholder="e.g. Rewrite to avoid prohibited claims; keep it factual and non-sensational…"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="articleDomain">
                Article domain
              </label>
              <input
                id="articleDomain"
                className={styles.textInput}
                value={settings.articleDomain}
                onChange={(e) => setSettings({ ...settings, articleDomain: e.target.value })}
                placeholder="https://articles.example.com"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="redirectDomain">
                Redirect domain
              </label>
              <input
                id="redirectDomain"
                className={styles.textInput}
                value={settings.redirectDomain}
                onChange={(e) => setSettings({ ...settings, redirectDomain: e.target.value })}
                placeholder="https://go.example.com"
              />
            </div>
            <div>
              <Button type="submit" loading={savingSettings}>
                Save settings
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
