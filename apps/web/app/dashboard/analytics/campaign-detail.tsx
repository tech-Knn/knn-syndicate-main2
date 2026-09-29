'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  type AdPerf,
  type CampaignBreakdown,
  type DimStat,
  type OfferStat,
  costPer,
  epv,
  formatRate,
  formatRoi,
  formatUnitUsd,
  formatUsd,
  perVisit,
} from '@knn/shared';
import { Skeleton } from '@/components/ui';
import { Tooltip } from '@/components/tooltip';
import { FbStatusBadge } from '@/components/fb-status-badge';
import { type DateRange } from '@/components/ui';
import { campaigns as campaignApi, stats } from '@/lib/api';
import admin from '../admin.module.css';
import styles from '../analytics.module.css';
import { BudgetCell } from './budget-cell';
import { fmtCount, maskedAware } from './columns';

type Tab = 'ads' | 'websites' | 'countries' | 'hours';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ads', label: 'Ads' },
  { id: 'websites', label: 'Websites' },
  { id: 'countries', label: 'Countries' },
  { id: 'hours', label: 'Hours' },
];

/** A breakdown row's raw numbers — every other column is derived from these. */
interface Row {
  spendUsd: number;
  revenueUsd: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

/**
 * The breakdown columns shared by the Ads / Countries / Hours tabs — the same metrics, names and
 * definitions as the main table. `est` marks the ones built on revenue, which Google reports per
 * campaign only: per ad / country / hour it's split by Facebook conversions, so it's an estimate.
 */
const DETAIL_COLS: { key: string; label: string; est?: boolean; info: string; cell: (r: Row) => ReactNode; tone?: (r: Row) => string | undefined }[] = [
  { key: 'spend', label: 'Spend', info: 'Facebook ad spend.', cell: (r) => formatUsd(r.spendUsd) },
  { key: 'revenue', label: 'Revenue', est: true, info: 'Estimated — Google reports revenue per campaign, so it is split by Facebook conversions.', cell: (r) => formatUsd(r.revenueUsd) },
  {
    key: 'profit',
    label: 'Profit',
    est: true,
    info: 'Estimated revenue − spend.',
    cell: (r) => formatUsd(r.revenueUsd - r.spendUsd),
    tone: (r) => (r.revenueUsd - r.spendUsd > 0 ? styles.pos : r.revenueUsd - r.spendUsd < 0 ? styles.neg : undefined),
  },
  {
    key: 'roi',
    label: 'ROI',
    est: true,
    info: 'Estimated profit ÷ spend.',
    cell: (r) => (r.spendUsd > 0 ? formatRoi((r.revenueUsd - r.spendUsd) / r.spendUsd) : '—'),
    tone: (r) => (r.spendUsd <= 0 ? undefined : r.revenueUsd > r.spendUsd ? styles.pos : r.revenueUsd < r.spendUsd ? styles.neg : undefined),
  },
  {
    key: 'epv',
    label: 'EPV',
    est: true,
    info: 'Estimated revenue ÷ visits (ClickFlare EPV). Green when it beats CPC.',
    cell: (r) => formatUnitUsd(epv(r.revenueUsd, r.clicks)),
    tone: (r) => {
      const e = epv(r.revenueUsd, r.clicks);
      const c = costPer(r.spendUsd, r.clicks);
      return e === null || c === null ? undefined : e > c ? styles.pos : e < c ? styles.neg : undefined;
    },
  },
  { key: 'cpc', label: 'CPC', info: 'Spend ÷ visits (ClickFlare CPV).', cell: (r) => formatUnitUsd(costPer(r.spendUsd, r.clicks)) },
  { key: 'visits', label: 'Visits', info: 'Facebook link clicks that reached the landing page.', cell: (r) => fmtCount(r.clicks) },
  { key: 'conv', label: 'Conv (FB)', info: "Facebook's count of ad clicks (pixel 'Search' event).", cell: (r) => fmtCount(r.conversions) },
  { key: 'cvrFb', label: 'CVR (FB)', info: 'Conv (FB) ÷ visits — the ad-click rate as Facebook sees it.', cell: (r) => formatRate(perVisit(r.conversions, r.clicks)) },
  { key: 'cpa', label: 'CPA (FB)', info: 'Spend ÷ Conv (FB).', cell: (r) => formatUnitUsd(costPer(r.spendUsd, r.conversions)) },
  { key: 'ctr', label: 'CTR', info: 'Visits ÷ impressions.', cell: (r) => formatRate(perVisit(r.clicks, r.impressions)) },
];

function sumRows(rows: readonly Row[]): Row {
  return rows.reduce<Row>(
    (t, r) => ({
      spendUsd: t.spendUsd + r.spendUsd,
      revenueUsd: t.revenueUsd + r.revenueUsd,
      impressions: t.impressions + r.impressions,
      clicks: t.clicks + r.clicks,
      conversions: t.conversions + r.conversions,
    }),
    { spendUsd: 0, revenueUsd: 0, impressions: 0, clicks: 0, conversions: 0 },
  );
}

function HeadCell({ label, info, est, left }: { label: string; info: string; est?: boolean; left?: boolean }) {
  return (
    <th scope="col" className={`${left ? admin.thLeft : styles.thNum}`}>
      <Tooltip content={info} className={styles.headTip}>
        <span className={`${styles.defined} ${styles.plainHead} ${est ? styles.estLabel : ''}`}>{label}</span>
      </Tooltip>
    </th>
  );
}

function MetricCells({ r }: { r: Row }) {
  return (
    <>
      {DETAIL_COLS.map((c) => (
        <td key={c.key} className={`${admin.num} ${c.tone?.(r) ?? ''}`}>
          {c.cell(r)}
        </td>
      ))}
    </>
  );
}

/** Why an ad's revenue split isn't the usual conversion share (shown under the ad name). */
function basisNote(basis: AdPerf['basis']): string | null {
  if (basis === 'clicks') return 'revenue split by visits (no Facebook conversions)';
  if (basis === 'impressions') return 'revenue split by impressions (no visits)';
  if (basis === 'unallocated') return 'revenue not assigned to ads yet';
  return null;
}

/** The expandable campaign panel: ads (ad sets → ads), websites, countries and hours. */
export function CampaignDetail({
  campaignId,
  bd,
  range,
  onError,
}: {
  campaignId: string;
  bd: CampaignBreakdown | undefined;
  range: DateRange;
  onError: (msg: string) => void;
}): ReactNode {
  const [tab, setTab] = useState<Tab>('ads');
  const [offers, setOffers] = useState<OfferStat[] | null>(null);
  const [dim, setDim] = useState<{ countries: DimStat[] | null; hours: DimStat[] | null }>({ countries: null, hours: null });
  const baseId = useId();

  useEffect(() => {
    if (tab === 'websites' && offers === null) {
      void stats.campaignOffers(campaignId, range).then(setOffers).catch(() => setOffers([]));
    }
    if ((tab === 'countries' || tab === 'hours') && dim[tab] === null) {
      void stats
        .campaignDim(campaignId, tab === 'countries' ? 'country' : 'hour', range)
        .then((rows) => setDim((d) => ({ ...d, [tab]: rows })))
        .catch(() => setDim((d) => ({ ...d, [tab]: [] })));
    }
  }, [tab, offers, dim, campaignId, range]);

  const onTabKey = (e: React.KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : -1;
    if (next >= 0) {
      e.preventDefault();
      setTab(TABS[next]!.id);
      document.getElementById(`${baseId}-tab-${TABS[next]!.id}`)?.focus();
    }
  };

  const dimRows = tab === 'countries' ? dim.countries : tab === 'hours' ? dim.hours : null;
  const dimWord = tab === 'countries' ? 'country' : 'hour';

  return (
    <div className={styles.detail}>
      <div className={styles.detailTabs} role="tablist" aria-label="Campaign breakdown" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`${baseId}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`${styles.detailTab} ${tab === t.id ? styles.detailTabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`}>
        {tab === 'ads' ? (
          !bd ? (
            <Skeleton className={admin.rowSkel} />
          ) : bd.adSets.length === 0 ? (
            <p className={admin.subtle}>No ad sets.</p>
          ) : (
            <>
              <p className={styles.detailNote}>
                <span className={styles.estChip}>Estimated</span> Revenue, profit, ROI and EPV per ad are estimates: Google reports revenue per
                campaign, so it&apos;s split across ads by their Facebook conversions. Spend, visits and conversions are exact.
              </p>
              <div className={styles.detailScroll}>
                <table className={`${admin.table} ${styles.detailTable}`}>
                  <thead>
                    <tr>
                      <th scope="col" className={admin.thLeft}>
                        Ad set / Ad
                      </th>
                      {DETAIL_COLS.map((c) => (
                        <HeadCell key={c.key} label={c.label} info={c.info} est={c.est} />
                      ))}
                      <HeadCell label="Budget" info="The ad set's daily budget. Click to edit — goes live on Facebook." />
                    </tr>
                  </thead>
                  <tbody>
                    {bd.adSets.map((set) => (
                      <SetRows key={set.id} campaignId={campaignId} set={set} onError={onError} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={styles.detailTotal}>
                      <th scope="row" className={admin.thLeft}>
                        Campaign total
                      </th>
                      <MetricCells r={bd.totals} />
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )
        ) : tab === 'websites' ? (
          offers === null ? (
            <Skeleton className={admin.rowSkel} />
          ) : offers.length === 0 ? (
            <p className={admin.subtle}>This campaign sends all traffic to one website (no offer split).</p>
          ) : (
            <>
              <p className={styles.detailNote}>
                Spend and visits aren&apos;t tracked per website (the redirect splits traffic by share), so compare websites on revenue and
                RPC. RPC leaves out days where Google hides ad clicks (fewer than 10).
              </p>
              <div className={styles.detailScroll}>
                <table className={`${admin.table} ${styles.detailTable}`}>
                  <thead>
                    <tr>
                      <th scope="col" className={admin.thLeft}>
                        Website
                      </th>
                      <th scope="col" className={admin.thLeft}>
                        Type
                      </th>
                      <HeadCell label="Traffic share" info="The share of paid traffic this website gets." />
                      <HeadCell label="Revenue" info="AdSense earnings on this website's channel (after any platform cut)." />
                      <HeadCell label="Ad clicks" info="Paid ad clicks reported by Google for this website (hidden on days with fewer than 10)." />
                      <HeadCell label="RPC" info="Revenue ÷ Google ad clicks (ClickFlare RPC), over the days Google shows the clicks." />
                    </tr>
                  </thead>
                  <tbody>
                    {offers.map((o) => (
                      <tr key={o.offerId}>
                        <td className={admin.name}>
                          {o.host}
                          {o.afsLabel && <span className={styles.cellSub}>{o.afsLabel}</span>}
                        </td>
                        <td className={admin.subtle}>{o.kind === 'PAID' ? 'Paid' : 'Organic'}</td>
                        <td className={admin.num}>{o.kind === 'PAID' ? `${o.weightPct}%` : '—'}</td>
                        <td className={admin.num}>{formatUsd(o.revenueUsd)}</td>
                        <td className={admin.num}>{o.afsClicks === 0 && o.maskedDays > 0 ? maskedAware(null, o.maskedDays, () => '') : fmtCount(o.afsClicks)}</td>
                        <td className={admin.num}>{maskedAware(o.rpcUsd, o.maskedDays, formatUnitUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : dimRows === null ? (
          <Skeleton className={admin.rowSkel} />
        ) : dimRows.length === 0 ? (
          <p className={admin.subtle}>No {dimWord} data yet — it appears once the campaign is delivering on Facebook.</p>
        ) : (
          <>
            <p className={styles.detailNote}>
              <span className={styles.estChip}>Estimated</span> AdSense earnings aren&apos;t tagged by {dimWord}, so revenue, profit, ROI and EPV
              are split by Facebook conversions. Spend, visits and conversions are exact.
            </p>
            <div className={styles.detailScroll}>
              <table className={`${admin.table} ${styles.detailTable}`}>
                <thead>
                  <tr>
                    <th scope="col" className={admin.thLeft}>
                      {tab === 'countries' ? 'Country' : 'Hour (ad account time)'}
                    </th>
                    {DETAIL_COLS.map((c) => (
                      <HeadCell key={c.key} label={c.label} info={c.info} est={c.est} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dimRows.map((d) => (
                    <tr key={d.dimValue}>
                      <td className={admin.name}>{d.dimValue}</td>
                      <MetricCells r={d} />
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={styles.detailTotal}>
                    <th scope="row" className={admin.thLeft}>
                      Total
                    </th>
                    <MetricCells r={sumRows(dimRows)} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SetRows({ campaignId, set, onError }: { campaignId: string; set: CampaignBreakdown['adSets'][number]; onError: (msg: string) => void }) {
  return (
    <>
      <tr className={styles.setRow}>
        <th scope="row" className={admin.thLeft}>
          <span className={styles.treeName}>
            {set.name} <FbStatusBadge status={set.effectiveStatus} />
          </span>
        </th>
        <MetricCells r={set} />
        <td className={admin.num}>
          <BudgetCell
            cents={set.dailyBudgetCents}
            editable={set.editableBudget}
            label={set.name}
            save={(c) => campaignApi.setAdSetBudget(campaignId, set.id, c)}
            onError={onError}
          />
        </td>
      </tr>
      {set.ads.map((ad) => {
        const note = basisNote(ad.basis);
        return (
          <tr key={ad.id}>
            <th scope="row" className={`${admin.thLeft} ${styles.adIndent}`}>
              <span className={styles.treeName}>
                {ad.name} <FbStatusBadge status={ad.effectiveStatus} />
              </span>
              {note && <span className={styles.cellSub}>{note}</span>}
            </th>
            <MetricCells r={ad} />
            <td className={admin.subtle} />
          </tr>
        );
      })}
    </>
  );
}
