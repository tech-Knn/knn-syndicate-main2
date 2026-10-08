'use client';

import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import {
  type AdPerf,
  type CampaignBreakdown,
  type CampaignDayPerf,
  type DimStat,
  type FunnelCounts,
  type OfferStat,
  costPer,
  cvr,
  epv,
  formatRate,
  formatRoi,
  formatUnitUsd,
  formatUsd,
  lpCtr,
  perVisit,
  rpcPerAdClick,
  vcvr,
} from '@knn/shared';
import { Skeleton } from '@/components/ui';
import { Tooltip } from '@/components/tooltip';
import { FbStatusBadge } from '@/components/fb-status-badge';
import { type DateRange } from '@/components/ui';
import { campaigns as campaignApi, stats } from '@/lib/api';
import admin from '../admin.module.css';
import styles from '../analytics.module.css';
import { BudgetCell } from './budget-cell';
import { type ColKey, fmtCount, infoFor, networkTag, relabel } from './columns';

type Tab = 'ads' | 'websites' | 'countries' | 'hours' | 'byday';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ads', label: 'Ads' },
  { id: 'websites', label: 'Websites' },
  { id: 'countries', label: 'Countries' },
  { id: 'hours', label: 'Hours' },
  { id: 'byday', label: 'By day' },
];

/** A breakdown row's Facebook + revenue numbers — every other column is derived from these. */
interface Row {
  spendUsd: number;
  revenueUsd: number;
  impressions: number;
  /** Facebook's link clicks. */
  clicks: number;
  /** Facebook's pixel conversions. */
  conversions: number;
}

/** An ad / ad-set / campaign-total row: also carries our own funnel counts (exact per ad, D30). */
type FunnelRow = Row & FunnelCounts;

interface DetailCol<R> {
  key: string;
  label: string;
  /** Built on revenue, which Google reports per campaign only — so per ad / country / hour it's split
   *  by Facebook conversions, an estimate. */
  est?: boolean;
  info: string;
  cell: (r: R) => ReactNode;
  tone?: (r: R) => string | undefined;
}

const RESULT_COLS: DetailCol<Row>[] = [
  // Facebook wording on purpose: `relabel` names the campaign's own ad network where this is shown (Whop ad spend, for a Whop one).
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
];

const FB_CTR_COL: DetailCol<Row> = { key: 'ctrFb', label: 'CTR (FB)', info: 'FB clicks ÷ impressions — how often people clicked the ad when Facebook showed it.', cell: (r) => formatRate(perVisit(r.clicks, r.impressions)) };
const FB_CONV_COLS: DetailCol<Row>[] = [
  { key: 'conv', label: 'Conv (FB)', info: "Facebook's count of ad clicks (its pixel 'Search' event).", cell: (r) => fmtCount(r.conversions) },
  { key: 'cpa', label: 'CPA (FB)', info: 'Spend ÷ Conv (FB).', cell: (r) => formatUnitUsd(costPer(r.spendUsd, r.conversions)) },
];

/**
 * Ads tab — the main table's metrics per ad (same names and definitions). Our funnel counts are exact
 * per ad; revenue is split across ads by Facebook conversions, so the columns built on it are marked.
 */
const AD_COLS: DetailCol<FunnelRow>[] = [
  ...RESULT_COLS,
  {
    key: 'epv',
    label: 'EPV',
    est: true,
    info: 'Estimated revenue ÷ visits (ClickFlare EPV). Green when it beats CPV.',
    cell: (r) => formatUnitUsd(epv(r.revenueUsd, r.visits)),
    tone: (r) => {
      const e = epv(r.revenueUsd, r.visits);
      const c = costPer(r.spendUsd, r.visits);
      return e === null || c === null ? undefined : e > c ? styles.pos : e < c ? styles.neg : undefined;
    },
  },
  { key: 'cpv', label: 'CPV', info: 'Spend ÷ visits (ClickFlare CPV).', cell: (r) => formatUnitUsd(costPer(r.spendUsd, r.visits)) },
  { key: 'rpc', label: 'RPC', est: true, info: 'Estimated revenue ÷ ad clicks (ClickFlare Dynamic payout).', cell: (r) => formatUnitUsd(rpcPerAdClick(r.revenueUsd, r.adClicks)) },
  { key: 'vcvr', label: 'vCVR', info: 'Ad clicks ÷ visits — landing page → conversion (ClickFlare vCVR).', cell: (r) => formatRate(vcvr(r.adClicks, r.visits)) },
  { key: 'visits', label: 'Visits', info: 'People who landed on the page from this ad (once per visit).', cell: (r) => fmtCount(r.visits) },
  { key: 'ctr', label: 'CTR', info: 'Keyword clicks ÷ visits (ClickFlare CTR).', cell: (r) => formatRate(lpCtr(r.keywordClicks, r.visits)) },
  { key: 'cvr', label: 'CVR', info: 'Ad clicks ÷ keyword clicks (ClickFlare CVR).', cell: (r) => formatRate(cvr(r.adClicks, r.keywordClicks)) },
  FB_CTR_COL,
  ...FB_CONV_COLS,
];

/** The per-day rows are the campaign's own totals, so the "Estimated" wording the per-ad split needs doesn't apply. */
const DAY_INFO: Record<string, string> = {
  revenue: 'AdSense earnings on this day.',
  profit: 'Revenue − spend.',
  roi: 'Profit ÷ spend.',
  epv: 'Revenue ÷ visits (ClickFlare EPV). Green when it beats CPV.',
  rpc: 'Revenue ÷ ad clicks (ClickFlare Dynamic payout).',
};

/**
 * By day — the SAME metrics as the Ads tab, but these are the campaign's own per-day totals, so
 * revenue isn't split across anything: no estimate chips, and no "estimated" in the tooltips.
 */
const DAY_COLS: DetailCol<FunnelRow>[] = AD_COLS.map((c) => ({ ...c, est: false, info: DAY_INFO[c.key] ?? c.info }));

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * Countries / Hours tabs — Facebook's breakdowns, so Facebook's clicks: our funnel events don't carry a
 * country, and Facebook's hours are in the ad account's time zone.
 */
const DIM_COLS: DetailCol<Row>[] = [
  ...RESULT_COLS,
  { key: 'fbClicks', label: 'FB clicks', info: "Facebook's link clicks.", cell: (r) => fmtCount(r.clicks) },
  { key: 'cpcFb', label: 'CPC (FB)', info: 'Spend ÷ FB clicks.', cell: (r) => formatUnitUsd(costPer(r.spendUsd, r.clicks)) },
  FB_CTR_COL,
  ...FB_CONV_COLS,
  { key: 'cvrFb', label: 'CVR (FB)', info: 'Conv (FB) ÷ FB clicks — the ad-click rate as Facebook sees it.', cell: (r) => formatRate(perVisit(r.conversions, r.clicks)) },
];

/**
 * A breakdown's columns, in the ORDER the buyer ticked them in the Columns picker. Falls back to the
 * full set when none of their choices exist here (a few picker columns — keyword clicks, ad clicks,
 * impressions, land rate — have no per-ad/day equivalent), so the table is never just a name column.
 */
function pickCols<R>(all: readonly DetailCol<R>[], columns: readonly ColKey[]): DetailCol<R>[] {
  const chosen = columns.flatMap((k) => all.find((c) => c.key === k) ?? []);
  return chosen.length ? chosen : [...all];
}

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

function sumFunnelRows(rows: readonly FunnelCounts[]): FunnelCounts {
  return rows.reduce<FunnelCounts>(
    (t, r) => ({ visits: t.visits + r.visits, keywordClicks: t.keywordClicks + r.keywordClicks, adClicks: t.adClicks + r.adClicks }),
    { visits: 0, keywordClicks: 0, adClicks: 0 },
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

function MetricCells<R>({ r, cols }: { r: R; cols: readonly DetailCol<R>[] }) {
  return (
    <>
      {cols.map((c) => (
        <td key={c.key} className={`${admin.num} ${c.tone?.(r) ?? ''}`}>
          {c.cell(r)}
        </td>
      ))}
    </>
  );
}

type WebsiteNums = Pick<OfferStat, 'revenueUsd' | 'visits' | 'keywordClicks' | 'adClicks'>;

function sumOffers(offers: readonly OfferStat[]): WebsiteNums {
  return offers.reduce<WebsiteNums>(
    (t, o) => ({ revenueUsd: t.revenueUsd + o.revenueUsd, visits: t.visits + o.visits, keywordClicks: t.keywordClicks + o.keywordClicks, adClicks: t.adClicks + o.adClicks }),
    { revenueUsd: 0, visits: 0, keywordClicks: 0, adClicks: 0 },
  );
}

/** One website's (or the total's) cells — every value derived from the same four numbers. */
function WebsiteCells({ r }: { r: WebsiteNums }) {
  return (
    <>
      <td className={admin.num}>{fmtCount(r.visits)}</td>
      <td className={admin.num}>{formatRate(vcvr(r.adClicks, r.visits))}</td>
      <td className={admin.num}>{fmtCount(r.adClicks)}</td>
      <td className={admin.num}>{formatUsd(r.revenueUsd)}</td>
      <td className={admin.num}>{formatUnitUsd(epv(r.revenueUsd, r.visits))}</td>
      <td className={admin.num}>{formatUnitUsd(rpcPerAdClick(r.revenueUsd, r.adClicks))}</td>
    </>
  );
}

/** Why an ad's revenue split isn't the usual conversion share (shown under the ad name). */
function basisNote(basis: AdPerf['basis'], whop: boolean): string | null {
  if (basis === 'clicks') return whop ? 'revenue split by visits (no ad-click conversions recorded)' : 'revenue split by visits (no Facebook conversions)';
  if (basis === 'impressions') return 'revenue split by impressions (no visits)';
  if (basis === 'unallocated') return 'revenue not assigned to ads yet';
  return null;
}

/** The expandable campaign panel: ads (ad sets → ads), websites, countries and hours. */
export function CampaignDetail({
  campaignId,
  bd,
  range,
  columns,
  onError,
}: {
  campaignId: string;
  bd: CampaignBreakdown | undefined;
  range: DateRange;
  /** The Columns picker's selection, in the buyer's own order — the breakdowns follow the main table. */
  columns: ColKey[];
  onError: (msg: string) => void;
}): ReactNode {
  const [tab, setTab] = useState<Tab>('ads');
  const [offers, setOffers] = useState<OfferStat[] | null>(null);
  const [dim, setDim] = useState<{ countries: DimStat[] | null; hours: DimStat[] | null }>({ countries: null, hours: null });
  const [daily, setDaily] = useState<CampaignDayPerf[] | null>(null);
  const baseId = useId();
  const adCols = useMemo(() => pickCols(AD_COLS, columns), [columns]);
  const dimCols = useMemo(() => pickCols(DIM_COLS, columns), [columns]);
  const dayCols = useMemo(() => pickCols(DAY_COLS, columns), [columns]);
  const showBudget = columns.includes('budget');

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
    if (tab === 'byday' && daily === null) {
      void stats.campaignDaily(campaignId, range).then(setDaily).catch(() => setDaily([]));
    }
  }, [tab, offers, dim, daily, campaignId, range]);

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
  // Columns that come from the ad network are named after it: (FB) for a Facebook campaign, (Whop) for a Whop one (D33).
  const whop = bd?.campaign.adProvider === 'WHOP';
  const tag = networkTag([whop ? 'WHOP' : 'FACEBOOK']);

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
                <span className={styles.estChip}>Estimated</span> Revenue, profit, ROI, EPV and RPC per ad are estimates: Google reports revenue per
                {whop ? (
                  <>
                    {' '}campaign, so it&apos;s split across ads by the ad clicks recorded for each (Whop&apos;s own count is used only on a day we recorded
                    none). Spend, visits, keyword clicks, ad clicks and Whop&apos;s numbers are exact.
                  </>
                ) : (
                  <>
                    {' '}campaign, so it&apos;s split across ads by their Facebook conversions. Spend, visits, keyword clicks, ad clicks and Facebook&apos;s
                    numbers are exact.
                  </>
                )}
              </p>
              <div className={styles.detailScroll}>
                <table className={`${admin.table} ${styles.detailTable}`}>
                  <thead>
                    <tr>
                      <th scope="col" className={admin.thLeft}>
                        Ad set / Ad
                      </th>
                      {adCols.map((c) => (
                        <HeadCell key={c.key} label={relabel(c.label, tag)} info={infoFor(c.key === 'revenue' ? 'detail:revenue' : c.key, c.info, tag)} est={c.est} />
                      ))}
                      {showBudget && (
                        <HeadCell label="Budget" info={`The ad set's daily budget. Click to edit — goes live on ${whop ? 'Whop' : 'Facebook'}.`} />
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {bd.adSets.map((set) => (
                      <SetRows key={set.id} campaignId={campaignId} set={set} cols={adCols} showBudget={showBudget} whop={whop} minBudgetCents={whop ? 1 : 200} onError={onError} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={styles.detailTotal}>
                      <th scope="row" className={admin.thLeft}>
                        Campaign total
                      </th>
                      <MetricCells r={bd.totals} cols={adCols} />
                      {showBudget && <td />}
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
                Each website&apos;s visits and ad clicks are counted on that website by our pages, and its revenue comes from its own AdSense
                channel — all exact. Spend isn&apos;t split by website (the redirect splits traffic by share), so compare websites on EPV, vCVR
                and RPC.
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
                      <HeadCell label="Visits" info="People who landed on this website (once per visit)." />
                      <HeadCell label="vCVR" info="Ad clicks ÷ visits — landing page → conversion (ClickFlare vCVR)." />
                      <HeadCell label="Ad clicks" info="Visits on this website that clicked a Google ad (once per visit). ClickFlare: Conversions." />
                      <HeadCell label="Revenue" info="AdSense earnings on this website's channel (after any platform cut)." />
                      <HeadCell label="EPV" info="Revenue ÷ visits (ClickFlare EPV)." />
                      <HeadCell label="RPC" info="Revenue ÷ ad clicks (ClickFlare Dynamic payout)." />
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
                        <WebsiteCells r={o} />
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={styles.detailTotal}>
                      <th scope="row" className={admin.thLeft} colSpan={3}>
                        Total
                      </th>
                      <WebsiteCells r={sumOffers(offers)} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )
        ) : tab === 'byday' ? (
          daily === null ? (
            <Skeleton className={admin.rowSkel} />
          ) : daily.length === 0 ? (
            <p className={admin.subtle}>No activity in this range.</p>
          ) : (
            <>
              <div className={styles.detailScroll}>
                <table className={`${admin.table} ${styles.detailTable}`}>
                  <thead>
                    <tr>
                      <th scope="col" className={admin.thLeft}>Date</th>
                      {dayCols.map((c) => (
                        <HeadCell key={c.key} label={relabel(c.label, tag)} info={infoFor(c.key, c.info, tag)} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((d) => (
                      <tr key={d.day}>
                        <td className={admin.name}>{dayLabel(d.day)}</td>
                        <MetricCells r={d} cols={dayCols} />
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={styles.detailTotal}>
                      <th scope="row" className={admin.thLeft}>Total</th>
                      <MetricCells r={{ ...sumRows(daily), ...sumFunnelRows(daily) }} cols={dayCols} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )
        ) : dimRows === null ? (
          <Skeleton className={admin.rowSkel} />
        ) : dimRows.length === 0 ? (
          <p className={admin.subtle}>
            {whop
              ? `Whop doesn't report a ${dimWord} breakdown, so there is nothing to show here for a Whop campaign.`
              : `No ${dimWord} data yet — it appears once the campaign is delivering on Facebook.`}
          </p>
        ) : (
          <>
            <p className={styles.detailNote}>
              <span className={styles.estChip}>Estimated</span> This view comes from Facebook&apos;s {dimWord} breakdown, so it uses Facebook&apos;s
              clicks — our visits, vCVR and RPC aren&apos;t split by {dimWord}. AdSense earnings aren&apos;t tagged by {dimWord} either, so revenue,
              profit and ROI are split by Facebook conversions. Spend and Facebook&apos;s numbers are exact.
            </p>
            <div className={styles.detailScroll}>
              <table className={`${admin.table} ${styles.detailTable}`}>
                <thead>
                  <tr>
                    <th scope="col" className={admin.thLeft}>
                      {tab === 'countries' ? 'Country' : 'Hour (ad account time)'}
                    </th>
                    {dimCols.map((c) => (
                      <HeadCell key={c.key} label={relabel(c.label, tag)} info={infoFor(c.key === 'revenue' ? 'detail:revenue' : c.key, c.info, tag)} est={c.est} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dimRows.map((d) => (
                    <tr key={d.dimValue}>
                      <td className={admin.name}>{d.dimValue}</td>
                      <MetricCells r={d} cols={dimCols} />
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={styles.detailTotal}>
                    <th scope="row" className={admin.thLeft}>
                      Total
                    </th>
                    <MetricCells r={sumRows(dimRows)} cols={dimCols} />
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

function SetRows({ campaignId, set, cols, showBudget, whop, minBudgetCents, onError }: { campaignId: string; set: CampaignBreakdown['adSets'][number]; cols: DetailCol<FunnelRow>[]; showBudget: boolean; whop: boolean; minBudgetCents: number; onError: (msg: string) => void }) {
  return (
    <>
      <tr className={styles.setRow}>
        <th scope="row" className={admin.thLeft}>
          <span className={styles.treeName}>
            {set.name} <FbStatusBadge status={set.effectiveStatus} />
          </span>
        </th>
        <MetricCells r={set} cols={cols} />
        {showBudget && (
          <td className={admin.num}>
            <BudgetCell
              cents={set.dailyBudgetCents}
              editable={set.editableBudget}
              label={set.name}
              minCents={minBudgetCents}
              save={(c) => campaignApi.setAdSetBudget(campaignId, set.id, c)}
              onError={onError}
            />
          </td>
        )}
      </tr>
      {set.ads.map((ad) => {
        const note = basisNote(ad.basis, whop);
        return (
          <tr key={ad.id}>
            <th scope="row" className={`${admin.thLeft} ${styles.adIndent}`}>
              <span className={styles.treeName}>
                {ad.name} <FbStatusBadge status={ad.effectiveStatus} />
              </span>
              {note && <span className={styles.cellSub}>{note}</span>}
            </th>
            <MetricCells r={ad} cols={cols} />
            {showBudget && <td className={admin.subtle} />}
          </tr>
        );
      })}
    </>
  );
}
