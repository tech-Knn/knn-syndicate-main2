'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CampaignWizard } from '@/components/campaign-wizard';
import { IconAnalytics, IconCopy, IconExternal } from '@/components/icons';
import { Banner, Button, Skeleton, useConfirm, useToast } from '@/components/ui';
import { ApiError, campaigns } from '@/lib/api';
import type { Campaign } from '@/lib/types';
import { AdsTab } from './ads';
import styles from './campaign.module.css';
import { GoogleSignalsEditor } from './google-signals-editor';
import { CampaignHeader } from './header';
import { KpiStrip } from './kpis';
import { OffersEditor } from './offers-editor';
import { OverviewTab } from './overview';
import { type MenuEntry, StatusPill, Tabs, type TabDef } from './parts';
import { RoutingTab } from './routing';
import { HAS_DELIVERY, networkName, statusMeta } from './status';
import { LAUNCHABLE, StatusCard } from './status-card';
import { type RangeKey, useCampaignStats } from './use-stats';

type TabId = 'overview' | 'ads' | 'monetization' | 'routing' | 'setup';

const TAB_IDS: TabId[] = ['overview', 'ads', 'monetization', 'routing', 'setup'];

function PageSkeleton() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading campaign">
      <Skeleton className={styles.skel} />
      <div style={{ height: 56 }} />
      <Skeleton className={styles.skel} />
      <div className={styles.kpiGrid}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className={styles.kpiSkel} />
        ))}
      </div>
    </div>
  );
}

export default function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [campaign, setCampaign] = useState<Campaign | null | 'error'>(null);
  const [launching, setLaunching] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [range, setRange] = useState<RangeKey>('7d');

  const load = useCallback(() => {
    void campaigns
      .get(id)
      .then((c) => setCampaign(c))
      .catch(() => setCampaign('error'));
  }, [id]);
  useEffect(() => load(), [load]);

  // A launch takes a moment and finishes on the server: follow it until the status changes.
  const status = campaign && campaign !== 'error' ? campaign.status : null;
  useEffect(() => {
    if (status !== 'LAUNCHING') return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [status, load]);

  // The open tab lives in the address (#ads), so a link or a reload lands where it was.
  useEffect(() => {
    const fromHash = window.location.hash.replace('#', '') as TabId;
    if (TAB_IDS.includes(fromHash)) setTab(fromHash);
  }, []);
  const pickTab = (t: TabId): void => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  // Once the status card has scrolled away, its main action moves into the sticky tab bar.
  const statusRef = useRef<HTMLDivElement | null>(null);
  const [statusInView, setStatusInView] = useState(true);
  useEffect(() => {
    const el = statusRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setStatusInView(entry?.isIntersecting ?? true), { rootMargin: '-64px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [status]);

  const c = campaign && campaign !== 'error' ? campaign : null;
  const stats = useCampaignStats(id, c != null && HAS_DELIVERY.has(c.status), range);

  if (campaign === 'error') {
    return <Banner tone="error" title="Campaign not found">We couldn’t load this campaign. It may have been deleted or you don’t have access.</Banner>;
  }
  if (!c) return <PageSkeleton />;

  // A draft is still being built: the wizard is the page.
  if (c.status === 'DRAFT') return <CampaignWizard campaign={c} />;

  const net = networkName(c);

  const launch = async (): Promise<void> => {
    setLaunching(true);
    setNote(null);
    try {
      const res = await campaigns.launch(c.id);
      setNote({
        tone: 'success',
        text: res.fbCampaignId
          ? `Sent to Facebook — status: ${res.status}.`
          : res.whopCampaignId
            ? `Sent to Whop — status: ${res.status}. Meta reviews new ads first, so delivery can take a while to start.`
            : `Launch queued — status: ${res.status}.`,
      });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Launch failed.');
    } finally {
      setLaunching(false);
    }
  };

  const reopen = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Reopen for editing?',
      body:
        c.adProvider === 'WHOP'
          ? c.whopCampaignId
            ? 'This returns the campaign to a draft, releases its assigned channel back to the pool, and deletes the half-built campaign on Whop (nothing has spent). You can resubmit when you are done.'
            : 'This returns the campaign to a draft and releases its assigned channel back to the pool. You can resubmit when you are done.'
          : 'This returns the campaign to a draft and releases its assigned channel back to the pool. If part of it was already created on Facebook (for example the launch was rate-limited), that unfinished Facebook campaign is paused first. You can resubmit when you are done.',
      confirmLabel: 'Reopen',
    });
    if (!ok) return;
    setReopening(true);
    setNote(null);
    try {
      const updated = await campaigns.reopen(c.id);
      setCampaign(updated);
      setNote({ tone: 'success', text: 'Campaign reopened — it’s now an editable draft. Make your changes and submit again.' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reopen failed.');
    } finally {
      setReopening(false);
    }
  };

  const toggleActive = async (active: boolean): Promise<void> => {
    // Pausing is destructive (stops live delivery + spend): confirm first. Resuming is non-destructive.
    if (!active) {
      const ok = await confirm({
        title: 'Pause this campaign?',
        body: `Pausing stops live delivery on ${net} and halts ad spend. You can resume anytime.`,
        confirmLabel: 'Pause campaign',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setToggling(true);
    setNote(null);
    try {
      const res = active ? await campaigns.resume(c.id) : await campaigns.pause(c.id);
      setCampaign({ ...c, status: res.status as Campaign['status'] });
      setNote({ tone: 'success', text: active ? `Campaign resumed — ads are live on ${net} again.` : 'Campaign paused — ad delivery (and spend) is stopped. Resume anytime.' });
      stats.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change campaign status.');
    } finally {
      setToggling(false);
    }
  };

  const clone = async (): Promise<void> => {
    setCloning(true);
    try {
      const copy = await campaigns.clone(c.id);
      toast.success('Copy created — it opens as a draft you can edit.');
      router.push(`/dashboard/campaigns/${copy.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not clone the campaign.');
    } finally {
      setCloning(false);
    }
  };

  const onBudgetSaved = (next: { adSetId?: string; cents: number }): void =>
    setCampaign((prev) => {
      if (!prev || prev === 'error') return prev;
      if (next.adSetId) return { ...prev, adSets: prev.adSets.map((s) => (s.id === next.adSetId ? { ...s, dailyBudgetCents: next.cents } : s)) };
      return prev.budgetMode === 'CAMPAIGN'
        ? { ...prev, dailyBudgetCents: next.cents }
        : { ...prev, adSets: prev.adSets.map((s, i) => (i === 0 ? { ...s, dailyBudgetCents: next.cents } : s)) };
    });

  // A campaign Meta turned down has nothing to measure: don't show a row of zeros.
  const t = stats.data?.totals;
  const noActivity = Boolean(t) && t!.spendUsd === 0 && t!.impressions === 0 && t!.clicks === 0 && t!.conversions === 0;
  const showKpis = HAS_DELIVERY.has(c.status) && !(c.status === 'META_REJECTED' && noActivity);

  const compact = (
    <>
      <StatusPill meta={statusMeta(c)} />
      {c.status === 'ACTIVE' && (
        <Button variant="danger" onClick={() => void toggleActive(false)} loading={toggling}>
          Pause
        </Button>
      )}
      {c.status === 'PAUSED' && (
        <Button onClick={() => void toggleActive(true)} loading={toggling}>
          Resume
        </Button>
      )}
      {LAUNCHABLE.has(c.status) && (
        <Button onClick={() => void launch()} loading={launching} disabled={reopening}>
          {`Launch to ${net}`}
        </Button>
      )}
    </>
  );

  const adTotal = c.adSets.reduce((n, s) => n + s.ads.length, 0);
  const tabs: TabDef<TabId>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'ads', label: 'Ads', count: adTotal },
    { id: 'monetization', label: 'Monetization' },
    { id: 'routing', label: 'Routing' },
    { id: 'setup', label: 'Setup' },
  ];

  const menu: MenuEntry[] = [
    { key: 'analytics', label: 'Open in Analytics', href: '/dashboard/analytics', icon: <IconAnalytics size={16} /> },
    { key: 'clone', label: cloning ? 'Cloning…' : 'Clone campaign', icon: <IconCopy size={16} />, onSelect: () => void clone(), disabled: cloning },
    {
      key: 'copy-id',
      label: 'Copy campaign ID',
      icon: <IconCopy size={16} />,
      onSelect: () => void navigator.clipboard?.writeText(c.id).then(() => toast.success('Campaign ID copied.')).catch(() => undefined),
      separatorBefore: true,
    },
    ...(c.adProvider === 'WHOP' && c.whopBizId
      ? [{ key: 'whop', label: 'Open Whop Ads', href: `https://whop.com/dashboard/${c.whopBizId}/ads/`, external: true, icon: <IconExternal size={16} /> }]
      : []),
  ];

  return (
    <div className={styles.page}>
      <CampaignHeader
        campaign={c}
        menu={menu}
        actions={
          HAS_DELIVERY.has(c.status) ? (
            <Button variant="secondary" onClick={() => router.push('/dashboard/analytics')}>
              <IconAnalytics size={16} /> Analytics
            </Button>
          ) : undefined
        }
      />

      {note && (
        <Banner tone={note.tone} onDismiss={() => setNote(null)}>
          {note.text}
        </Banner>
      )}

      <div ref={statusRef}>
        <StatusCard
          campaign={c}
          actions={{
            launching,
            reopening,
            toggling,
            cloning,
            onLaunch: () => void launch(),
            onReopen: () => void reopen(),
            onToggle: (active) => void toggleActive(active),
            onClone: () => void clone(),
          }}
        />
      </div>

      {showKpis && <KpiStrip stats={stats} range={range} onRange={setRange} />}

      {/* No wrapper: a sticky bar can only travel inside its parent, and the page is the parent it needs. */}
      <Tabs tabs={tabs} value={tab} onChange={pickTab} idPrefix="campaign" trailing={statusInView ? undefined : compact} />

      <div key={tab} id={`campaign-panel-${tab}`} role="tabpanel" aria-labelledby={`campaign-tab-${tab}`} className={styles.tabPanel}>
        {tab === 'overview' && <OverviewTab campaign={c} stats={stats} onBudgetSaved={onBudgetSaved} />}
        {tab === 'ads' && <AdsTab campaign={c} stats={stats} />}
        {tab === 'monetization' && (
          <>
            {/* D27: what paid clicks send Google (per-ad rc + keywords), editable live without approval. */}
            <GoogleSignalsEditor campaignId={c.id} onCampaignRacChange={(racValue) => setCampaign((prev) => (prev && prev !== 'error' ? { ...prev, racValue } : prev))} />
            <OffersEditor campaignId={c.id} status={c.status} />
          </>
        )}
        {tab === 'routing' && <RoutingTab campaign={c} />}
        {tab === 'setup' && <CampaignWizard campaign={c} embedded />}
      </div>
    </div>
  );
}
