'use client';

import { costPer, formatRate, formatRoi, formatUsd, rpcPerAdClick } from '@knn/shared';
import { IconClock } from '@/components/icons';
import { Button, Segmented, Skeleton, StatTile } from '@/components/ui';
import styles from './campaign.module.css';
import { bigCount as big, count, money, safe } from './format';
import { timeAgo } from './status';
import { RANGES, type CampaignStats, type RangeKey } from './use-stats';


/** The numbers that decide whether to scale or cut a campaign, for the chosen range, with how fresh they are. */
export function KpiStrip({ stats, range, onRange }: { stats: CampaignStats; range: RangeKey; onRange: (r: RangeKey) => void }) {
  const raw = stats.data?.totals;
  const t = raw && {
    spendUsd: safe(raw.spendUsd),
    revenueUsd: safe(raw.revenueUsd),
    profitUsd: safe(raw.profitUsd),
    roi: safe(raw.roi),
    impressions: safe(raw.impressions),
    clicks: safe(raw.clicks),
    conversions: safe(raw.conversions),
    adClicks: safe(raw.adClicks),
  };
  const refreshed = stats.sync?.at ? `Updated ${timeAgo(stats.sync.at)}` : 'Waiting for the first sync';
  const every = stats.sync ? ` · refreshes about every ${Math.round(stats.sync.everySec / 60)} min` : '';
  // Hourly numbers that have not moved for three cycles mean a sync problem, not a quiet campaign: say so.
  const syncAt = stats.sync?.at ? Date.parse(stats.sync.at) : NaN;
  const late = Number.isFinite(syncAt) && Date.now() - syncAt > 3 * safe(stats.sync?.everySec || 3600) * 1000;
  return (
    <section className={styles.kpis} aria-label="Campaign performance">
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>Performance</h2>
          <p className={styles.sectionSub}>
            {refreshed}
            {every}
            {' · '}
            <button type="button" className={styles.linkBtn} onClick={stats.reload} disabled={stats.loading}>
              {stats.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </p>
          {late && (
            <span className={styles.warnChip} style={{ marginTop: 8 }}>
              <IconClock size={13} /> Numbers are behind schedule. They catch up on the next sync.
            </span>
          )}
        </div>
        <Segmented options={RANGES} value={range} onChange={onRange} ariaLabel="Date range" />
      </div>

      {stats.failed ? (
        <div className={styles.panel}>
          <div className={styles.empty}>
            <strong>We couldn’t load the numbers.</strong>
            <span>The campaign itself is fine; this is only the performance figures.</span>
            <Button variant="secondary" onClick={stats.reload} loading={stats.loading}>
              Try again
            </Button>
          </div>
        </div>
      ) : !t ? (
        <div className={styles.kpiGrid}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className={styles.kpiSkel} />
          ))}
        </div>
      ) : (
        <div className={styles.kpiGrid} style={{ opacity: stats.loading ? 0.6 : 1, transition: 'opacity .15s' }}>
          <StatTile label="Spend" value={money(t.spendUsd)} valueTitle={formatUsd(t.spendUsd)} sub={`${big(t.impressions)} impressions`} />
          <StatTile
            label="Revenue"
            value={money(t.revenueUsd)}
            valueTitle={formatUsd(t.revenueUsd)}
            sub={t.adClicks > 0 ? `${formatUsd(rpcPerAdClick(t.revenueUsd, t.adClicks) ?? 0)} per ad click` : 'From Google ad clicks'}
            info="What the ads on this campaign's landing pages earned you. Google reports it per campaign, so per ad it is an estimate."
          />
          <StatTile
            label="Profit"
            value={money(t.profitUsd)}
            valueTitle={formatUsd(t.profitUsd)}
            tone={t.profitUsd > 0 ? 'pos' : t.profitUsd < 0 ? 'neg' : 'neutral'}
            sub="Revenue minus spend"
          />
          <StatTile
            label="ROI"
            value={formatRoi(t.roi)}
            tone={t.roi > 0 ? 'pos' : t.roi < 0 ? 'neg' : 'neutral'}
            sub="Break-even is 0%"
            info="Profit divided by spend."
          />
          <StatTile label="Clicks" value={big(t.clicks)} valueTitle={count(t.clicks)} sub={t.impressions > 0 ? `${formatRate(t.clicks / t.impressions)} click rate` : 'No impressions yet'} />
          <StatTile
            label="Conversions"
            value={big(t.conversions)}
            valueTitle={count(t.conversions)}
            sub={costPer(t.spendUsd, t.conversions) != null ? `${formatUsd(costPer(t.spendUsd, t.conversions) ?? 0)} each` : 'No conversions yet'}
            info="What the ad network counts as a result for this campaign."
          />
        </div>
      )}
    </section>
  );
}
