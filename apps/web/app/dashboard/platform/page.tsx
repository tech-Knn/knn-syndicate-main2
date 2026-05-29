'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type ChannelSummary, type PlatformSettings } from '@knn/shared';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { adsense, admin } from '@/lib/api';
import { type AfsAccountRow } from '@/lib/types';
import { useAuth } from '../../providers';
import { RedirectDomainsPanel } from './redirect-domains-panel';
import styles from '../admin.module.css';

export default function PlatformPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [summary, setSummary] = useState<ChannelSummary | null>(null);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [afsAccounts, setAfsAccounts] = useState<AfsAccountRow[] | null>(null);
  const [catSyncing, setCatSyncing] = useState<string | null>(null);
  const [adsNote, setAdsNote] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const loadAfsAccounts = useCallback(() => {
    void adsense.accounts().then(setAfsAccounts).catch(() => setAfsAccounts([]));
  }, []);
  const loadSummary = useCallback(() => {
    void admin.channelSummary().then(setSummary).catch(() => setSummary(null));
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
    await adsense.disconnectAccount(id).catch(() => undefined);
    loadAfsAccounts();
  };

  useEffect(() => {
    loadSummary();
    loadAfsAccounts();
    void admin.settings().then(setSettings).catch(() => setSettings({ compliancePrompt: '', articleDomain: '', redirectDomain: '' }));
  }, [loadSummary, loadAfsAccounts]);

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
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Platform control</h1>
          <p className={styles.sub}>AdSense accounts, the channel pool, and platform settings. Company revenue &amp; cuts live in the Companies tab.</p>
        </div>
      </div>

      {/* AdSense accounts (multi-account) */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>AdSense accounts</span>
          <Button onClick={() => void connectAdsense()}>Connect AdSense account</Button>
        </div>
        {adsNote && <p className={styles.adsNote}>{adsNote}</p>}
        {!afsAccounts ? (
          <Skeleton className={styles.rowSkel} />
        ) : afsAccounts.length === 0 ? (
          <p className={styles.empty}>
            No AdSense accounts connected. &ldquo;Connect AdSense account&rdquo; onboards every AFS account that Google login can see — connect again with a different login to add more.
          </p>
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
                {afsAccounts.map((a) => (
                  <tr key={a.id}>
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
                        <button type="button" className={styles.actionBtn} disabled={catSyncing === a.id} onClick={() => void syncCatalog(a.id)}>
                          {catSyncing === a.id ? 'Syncing…' : 'Sync catalog'}
                        </button>
                        <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} onClick={() => void disconnectAfs(a.id)}>
                          Disconnect
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.fieldHint}>
          <strong>In AdSense</strong> = channels mirrored to the local catalog by &ldquo;Sync catalog&rdquo; (≈ the account&apos;s total).{' '}
          <strong>Imported</strong> = channels added into a website&apos;s usable pool. Assign channels to a website in{' '}
          <strong>Domains → Channels</strong>.
        </p>
      </Card>

      {/* Channel pool — accurate counts, per website */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Channel pool</span>
          {summary && (
            <span className={styles.subtle}>
              {summary.available.toLocaleString()} available · {summary.assigned.toLocaleString()} in use ·{' '}
              {summary.total.toLocaleString()} total
            </span>
          )}
        </div>
        {!summary ? (
          <Skeleton className={styles.rowSkel} />
        ) : summary.total === 0 ? (
          <p className={styles.empty}>No channels imported yet. Sync an AdSense account above, then import channels per website in Domains → Channels.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.thLeft}>Website</th>
                    <th>Channels</th>
                    <th>Available</th>
                    <th>In use</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byDomain.length === 0 ? (
                    <tr>
                      <td className={styles.subtle} colSpan={4}>
                        No channels are tied to a website yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byDomain.map((d) => (
                      <tr key={d.domainId}>
                        <td className={styles.name}>{d.host}</td>
                        <td className={styles.num}>{d.total.toLocaleString()}</td>
                        <td className={styles.num}>{d.available.toLocaleString()}</td>
                        <td className={styles.num}>{(d.total - d.available).toLocaleString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {summary.untagged > 0 && (
              <p className={styles.fieldHint}>
                {summary.untagged.toLocaleString()} channel(s) are untagged (legacy/placeholder, not tied to a website) — these are ignored by the offer funnel.
              </p>
            )}
          </>
        )}
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
          <Skeleton className={styles.rowSkel} />
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
