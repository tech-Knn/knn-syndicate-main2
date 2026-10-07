'use client';

import Link from 'next/link';
import { type ReactNode, use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CampaignWizard } from '@/components/campaign-wizard';
import { IconAlert, IconAnalytics, IconCopy, IconExternal } from '@/components/icons';
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
import { type MenuEntry, SectionBoundary, StatusPill, type TabDef, Tabs } from './parts';
import { RoutingTab } from './routing';
import { HAS_DELIVERY, networkName, statusMeta } from './status';
import { LAUNCHABLE, StatusCard } from './status-card';
import { type RangeKey, useCampaignStats } from './use-stats';
import { ColumnPicker } from '../../analytics/column-picker';
import { ALL_COLUMNS, ESSENTIAL_COLUMNS, type ColKey } from '../../analytics/columns';
import { DailyTable } from './daily';

type TabId = 'overview' | 'ads' | 'monetization' | 'routing' | 'setup' | 'byday';
const TAB_IDS: TabId[] = ['overview', 'ads', 'monetization', 'routing', 'setup', 'byday'];
const TAB_LABEL: Record<TabId, string> = { overview: 'Overview', ads: 'Ads', monetization: 'Monetization', routing: 'Routing', setup: 'Setup', byday: 'By day' };
const POLL_MS = 8000;
/** Its OWN key — the campaign page's columns are independent of the Analytics page's. */
const CAMPAIGN_COLUMNS_KEY = 'knn.campaign.columns.v1';

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

/** "Not found" (gone, or not yours) and "could not load" (a network or server problem) are different: only the second is worth a retry. */
function LoadProblem({ kind, onRetry }: { kind: 'missing' | 'failed'; onRetry: () => void }) {
  return (
    <section className={styles.panel} role="alert">
      <div className={styles.empty}>
        <IconAlert size={26} />
        <strong>{kind === 'missing' ? 'Campaign not found' : 'We couldn’t load this campaign'}</strong>
        <span>
          {kind === 'missing'
            ? 'It may have been deleted, or you may not have access to it.'
            : 'That looks like a network or server problem, not a problem with the campaign. Nothing has changed.'}
        </span>
        <div className={styles.inlineRow}>
          {kind === 'failed' && <Button onClick={onRetry}>Try again</Button>}
          <Link href="/dashboard/campaigns" className={styles.linkBtn}>
            Back to campaigns
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Keyed by id: moving from one campaign to another starts clean instead of showing the last one until the new one loads.
  return <CampaignView key={id} id={id} />;
}

function CampaignView({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [problem, setProblem] = useState<'missing' | 'failed' | null>(null);
  const [launching, setLaunching] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  // Tabs already opened stay mounted (hidden), so what someone has typed in one is not lost by looking at another.
  const [opened, setOpened] = useState<Set<TabId>>(() => new Set<TabId>(['overview']));
  const [range, setRange] = useState<RangeKey>('7d');
  const [columns, setColumns] = useState<ColKey[]>(ESSENTIAL_COLUMNS);
  // Read in an effect, not the initializer, so server and first client render agree (no hydration mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CAMPAIGN_COLUMNS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter((k): k is ColKey => ALL_COLUMNS.includes(k as ColKey));
      if (valid.length) setColumns(valid);
    } catch {
      /* private mode or bad JSON → the defaults stand */
    }
  }, []);
  const chooseColumns = (next: ColKey[]): void => {
    setColumns(next);
    try {
      localStorage.setItem(CAMPAIGN_COLUMNS_KEY, JSON.stringify(next));
    } catch {
      /* not worth surfacing — the choice still applies for this visit */
    }
  };
  const loaded = useRef(false);

  const load = useCallback(() => {
    void campaigns
      .get(id)
      .then((c) => {
        loaded.current = true;
        setCampaign(c);
        setProblem(null);
      })
      .catch((err: unknown) => {
        // A refresh that fails (a network blip while polling) must not replace a page that is already showing.
        if (loaded.current) return;
        setProblem(err instanceof ApiError && [400, 403, 404].includes(err.status) ? 'missing' : 'failed');
      });
  }, [id]);
  useEffect(() => load(), [load]);

  // A launch takes a moment and finishes on the server: follow it until the status changes (not while the tab is hidden).
  const status = campaign ? campaign.status : null;
  useEffect(() => {
    if (status !== 'LAUNCHING') return;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [status, load]);

  // The campaign's name in the browser tab and the history, so ten open campaigns are not ten identical tabs.
  const name = campaign?.name;
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = `${name} · KNN Syndicate`;
    return () => {
      document.title = before;
    };
  }, [name]);

  // The open tab lives in the address (#ads): a link, a reload, and the back button all land where they should.
  useEffect(() => {
    const fromHash = (): void => {
      const h = window.location.hash.replace('#', '') as TabId;
      if (TAB_IDS.includes(h)) {
        setTab(h);
        setOpened((o) => (o.has(h) ? o : new Set(o).add(h)));
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  const pickTab = (t: TabId): void => {
    setTab(t);
    setOpened((o) => (o.has(t) ? o : new Set(o).add(t)));
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

  const c = campaign;
  const stats = useCampaignStats(id, c != null && HAS_DELIVERY.has(c.status), range);

  if (problem && !c) {
    return (
      <LoadProblem
        kind={problem}
        onRetry={() => {
          setProblem(null);
          load();
        }}
      />
    );
  }
  if (!c) return <PageSkeleton />;

  const noteBanner = note && (
    <Banner tone={note.tone} onDismiss={() => setNote(null)}>
      {note.text}
    </Banner>
  );

  // A draft is still being built: the wizard is the page (with the note, so "reopened" is still acknowledged).
  if (c.status === 'DRAFT') {
    return (
      <div className={styles.page}>
        {noteBanner}
        <CampaignWizard campaign={c} />
      </div>
    );
  }

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
      setCampaign((prev) => (prev ? { ...prev, status: res.status as Campaign['status'] } : prev));
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
      if (!prev) return prev;
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

  const adTotal = c.adSets.reduce((n, s) => n + (s.ads ?? []).length, 0);
  const tabs: TabDef<TabId>[] = TAB_IDS.map((tid) => ({ id: tid, label: TAB_LABEL[tid], ...(tid === 'ads' ? { count: adTotal } : {}) }));

  const menu: MenuEntry[] = [
    { key: 'analytics', label: 'Open in Analytics', href: `/dashboard/analytics?campaign=${c.id}`, icon: <IconAnalytics size={16} /> },
    { key: 'clone', label: cloning ? 'Cloning…' : 'Clone campaign', icon: <IconCopy size={16} />, onSelect: () => void clone(), disabled: cloning },
    {
      key: 'copy-id',
      label: 'Copy campaign ID',
      icon: <IconCopy size={16} />,
      onSelect: () => void navigator.clipboard?.writeText(c.id).then(() => toast.success('Campaign ID copied.')).catch(() => toast.error('Could not copy. The ID is in the address bar.')),
      separatorBefore: true,
    },
    ...(c.adProvider === 'WHOP' && c.whopBizId
      ? [{ key: 'whop', label: 'Open Whop Ads', href: `https://whop.com/dashboard/${c.whopBizId}/ads/`, external: true, icon: <IconExternal size={16} /> }]
      : []),
  ];

  const panel = (tid: TabId): ReactNode => {
    switch (tid) {
      case 'overview':
        return <OverviewTab campaign={c} stats={stats} onBudgetSaved={onBudgetSaved} />;
      case 'ads':
        return <AdsTab campaign={c} stats={stats} />;
      case 'monetization':
        return (
          <>
            {/* D27: what paid clicks send Google (per-ad rc + keywords), editable live without approval. */}
            <GoogleSignalsEditor campaignId={c.id} onCampaignRacChange={(racValue) => setCampaign((prev) => (prev ? { ...prev, racValue } : prev))} />
            <OffersEditor campaignId={c.id} status={c.status} />
          </>
        );
      case 'routing':
        return <RoutingTab campaign={c} />;
      case 'setup':
        return <CampaignWizard campaign={c} embedded />;
      case 'byday':
        return (
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>By day</h2>
              <p className={styles.panelSub}>
                Each IST business day in the selected range. Same columns and definitions as Analytics.
              </p>
            </div>
            {stats.daily ? <DailyTable rows={stats.daily} columns={columns} /> : <p className={styles.panelSub}>Loading…</p>}
          </section>
        );
    }
  };

  return (
    <div className={styles.page}>
      <CampaignHeader
        campaign={c}
        menu={menu}
        actions={
          HAS_DELIVERY.has(c.status) ? (
            <>
              <ColumnPicker value={columns} onChange={chooseColumns} tag={c.adProvider === 'WHOP' ? 'Whop' : 'FB'} />
              <Button variant="secondary" onClick={() => router.push(`/dashboard/analytics?campaign=${c.id}`)}>
                <IconAnalytics size={16} /> Analytics
              </Button>
            </>
          ) : undefined
        }
      />

      {noteBanner}

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

      {TAB_IDS.filter((tid) => opened.has(tid)).map((tid) => (
        <div key={tid} id={`campaign-panel-${tid}`} role="tabpanel" aria-labelledby={`campaign-tab-${tid}`} className={styles.tabPanel} hidden={tid !== tab}>
          <SectionBoundary label={TAB_LABEL[tid]}>{panel(tid)}</SectionBoundary>
        </div>
      ))}
    </div>
  );
}