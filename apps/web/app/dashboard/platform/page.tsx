'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type ChannelRow,
  type CompanyRollup,
  type PlatformSettings,
  addBusinessDays,
  currentBusinessDay,
  formatUsd,
} from '@knn/shared';
import { Badge, Button, Card, Segmented, Skeleton } from '@/components/ui';
import { admin, stats } from '@/lib/api';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

const RANGE_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };
function rangeFor(days: number): { from: string; to: string } {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

const CH_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning'> = {
  AVAILABLE: 'success',
  ASSIGNED: 'brand',
  RESERVED: 'warning',
};

export default function PlatformPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [rangeKey, setRangeKey] = useState('30');
  const [companies, setCompanies] = useState<CompanyRollup[] | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [cuts, setCuts] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

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
    void admin.channels().then(setChannels).catch(() => setChannels([]));
    void admin.settings().then(setSettings).catch(() => setSettings({ compliancePrompt: '', articleDomain: '', redirectDomain: '' }));
  }, []);

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
          <p className={styles.sub}>Revenue by company, the channel pool, and global settings.</p>
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

      {/* Channel pool */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Channel pool</span>
          {channels && (
            <span className={styles.subtle}>
              {channels.filter((c) => c.status === 'AVAILABLE').length} available · {channels.length} total
            </span>
          )}
        </div>
        {!channels ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : channels.length === 0 ? (
          <p className={styles.empty}>The channel pool is empty. Seed it with real AdSense channel ids.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Channel</th>
                  <th className={styles.thLeft}>Status</th>
                  <th className={styles.thLeft}>Holding campaign</th>
                  <th className={styles.thLeft}>Locked for</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className={styles.name}>{c.label ?? c.channelId}</div>
                      {c.label && <div className={styles.subtle}>{c.channelId}</div>}
                    </td>
                    <td>
                      <Badge tone={CH_TONE[c.status] ?? 'neutral'}>{c.status.toLowerCase()}</Badge>
                    </td>
                    <td className={styles.subtle}>{c.campaignName ?? '—'}</td>
                    <td className={styles.subtle}>{c.lockedForDay ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
