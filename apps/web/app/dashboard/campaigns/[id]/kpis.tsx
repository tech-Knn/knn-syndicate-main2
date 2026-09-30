'use client';

import { costPer, formatRate, formatRoi, formatUsd, rpcPerAdClick } from '@knn/shared';
import { IconClock } from '@/components/icons';
import { Segmented, Skeleton, StatTile } from '@/components/ui';
import styles from './campaign.module.css';
import { timeAgo } from './status';
import { RANGES, type CampaignStats, type RangeKey } from './use-stats';

const count = (n: number): string => new Intl.NumberFormat('en-US').format(n);

/** The numbers that decide whether to scale or cut a campaign, for the chosen range, with how fresh they are. */
export function KpiStrip({ stats, range, onRange }: { stats: CampaignStats; range: RangeKey; onRange: (r: RangeKey) => void }) {
  const t = stats.data?.totals;
  const refreshed = stats.sync?.at ? `Updated ${timeAgo(stats.sync.at)}` : 'Waiting for the first sync';
  const every = stats.sync ? ` · refreshes about every ${Math.round(stats.sync.everySec / 60)} min` : '';
  // Hourly numbers that have not moved for three cycles mean a sync problem, not a quiet campaign: say so.
  const late = Boolean(stats.sync?.at) && Date.now() - Date.parse(stats.sync!.at!) > 3 * stats.sync!.everySec * 1000;
  return (
    <section className={styles.kpis} aria-label="Campaign performance">
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>Performance</h2>
          <p className={styles.sectionSub}>
            {refreshed}
            {every}
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
            <span>Try again in a moment.</span>
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
          <StatTile label="Spend" value={formatUsd(t.spendUsd)} sub={`${count(t.impressions)} impressions`} />
          <StatTile
            label="Revenue"
            value={formatUsd(t.revenueUsd)}
            sub={t.adClicks > 0 ? `${formatUsd(rpcPerAdClick(t.revenueUsd, t.adClicks) ?? 0)} per ad click` : 'From Google ad clicks'}
            info="What the ads on this campaign's landing pages earned you. Google reports it per campaign, so per ad it is an estimate."
          />
          <StatTile
            label="Profit"
            value={formatUsd(t.profitUsd)}
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
          <StatTile label="Clicks" value={count(t.clicks)} sub={t.impressions > 0 ? `${formatRate(t.clicks / t.impressions)} click rate` : 'No impressions yet'} />
          <StatTile
            label="Conversions"
            value={count(t.conversions)}
            sub={costPer(t.spendUsd, t.conversions) != null ? `${formatUsd(costPer(t.spendUsd, t.conversions) ?? 0)} each` : 'No conversions yet'}
            info="What the ad network counts as a result for this campaign."
          />
        </div>
      )}
    </section>
  );
}
