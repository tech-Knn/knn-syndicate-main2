'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type ChannelSummary,
  type CompanyRollup,
  type PlatformSettings,
  addBusinessDays,
  currentBusinessDay,
  formatUsd,
} from '@knn/shared';
import { Badge, Button, Card, Segmented, Skeleton } from '@/components/ui';
import { adsense, admin, stats } from '@/lib/api';
import { type AfsAccountRow } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

const RANGE_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };
function rangeFor(days: number): { from: string; to: string } {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

export default function PlatformPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [rangeKey, setRangeKey] = useState('30');
  const [companies, setCompanies] = useState<CompanyRollup[] | null>(null);
  const [summary, setSummary] = useState<ChannelSummary | null>(null);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [cuts, setCuts] = useState<Record<string, string>>({});
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

  const loadCompanies = useCallback(async (key: string) => {
    setCompanies(null);
    try {
      const rows = await stats.byCompany(rangeFor(RANGE_DAYS[key] ?? 30));
      setCompanies(rows);
      setCuts(Object.fromEntries(rows.map((c) => [c.orgId, String(Math.round(c.defaultRevenueCutPct * 100))])));
    } catch {
      setCompanies([]);
    }
  }, []);

  useEffect(() => {
    void loadCompanies(rangeKey);
  }, [rangeKey, loadCompanies]);
  useEffect(() => {
    loadSummary();
    loadAfsAccounts();
    void admin.settings().then(setSettings).catch(() => setSettings({ compliancePrompt: '', articleDomain: '', redirectDomain: '' }));
  }, [loadSummary, loadAfsAccounts]);

  const persistCut = async (orgId: string): Promise<void> => {
    const pct = Number(cuts[orgId]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    try {
      await admin.setRevenueCut(orgId, pct / 100);
    } catch {
      /* keep the typed value; surfaced on next reload */
    }
  };

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
          <p className={styles.sub}>Companies &amp; revenue, AdSense accounts, and the channel pool.</p>
        </div>
      </div>

      {/* Companies */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Revenue by company</span>
          <Segmented
            options={[
              { label: '7D', value: '7' },
              { label: '30D', value: '30' },
              { label: '90D', value: '90' },
            ]}
            value={rangeKey}
            onChange={setRangeKey}
          />
        </div>
        {!companies ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : companies.length === 0 ? (
          <p className={styles.empty}>No companies yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Company</th>
                  <th>Buyers</th>
                  <th>Campaigns</th>
                  <th>Spend</th>
                  <th>Revenue</th>
                  <th>Margin</th>
                  <th>Cut %</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.orgId}>
                    <td className={styles.name}>{c.name}</td>
                    <td className={styles.num}>{c.buyerCount}</td>
                    <td className={styles.num}>{c.campaignCount}</td>
                    <td className={styles.num}>{formatUsd(c.spendUsd)}</td>
                    <td className={styles.num}>{formatUsd(c.revenueUsd)}</td>
                    <td className={styles.num}>{formatUsd(c.marginUsd)}</td>
                    <td className={styles.num}>
                      <input
                        className={styles.cutInput}
                        inputMode="numeric"
                        value={cuts[c.orgId] ?? ''}
                        onChange={(e) => setCuts((prev) => ({ ...prev, [c.orgId]: e.target.value.replace(/[^0-9]/g, '') }))}
                        onBlur={() => void persistCut(c.orgId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        aria-label={`Revenue cut for ${c.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
