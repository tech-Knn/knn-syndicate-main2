'use client';

import { formatUsd } from '@knn/shared';
import { FbStatusBadge } from '@/components/fb-status-badge';
import type { Campaign, CampaignAd } from '@/lib/types';
import styles from './campaign.module.css';
import { bigCount as big, count, money, safe } from './format';
import { Chip, CopyField, Creative } from './parts';
import { goLink } from './status';
import type { CampaignStats } from './use-stats';

const cta = (s: string): string => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function AdCard({ ad, host, perf, status }: { ad: CampaignAd; host: string | null; perf?: { spendUsd: number; clicks: number; conversions: number }; status?: string | null }) {
  return (
    <article className={styles.ad}>
      <div className={styles.adMedia}>
        <Creative uploadId={ad.uploadId} kind={ad.creativeType} alt={`Creative for ${ad.name}`} />
      </div>
      <div className={styles.adBody}>
        <div className={styles.adHead}>
          <h4 className={styles.adName} title={ad.name}>
            {ad.name}
          </h4>
          <FbStatusBadge status={status} />
        </div>
        <h5 className={styles.adHeadline}>{ad.headline || 'No headline'}</h5>
        {ad.primaryText && <p className={styles.adText}>{ad.primaryText}</p>}
        <div className={styles.chipList}>
          <Chip>{cta(ad.cta)}</Chip>
          {ad.creativeType === 'VIDEO' && <Chip>Video</Chip>}
        </div>
        {host && <CopyField value={goLink(host, ad.redirectId)} label={`go-link for ${ad.name}`} />}
        {perf && (
          <div className={styles.adFoot}>
            <div className={styles.mini}>
              <span>Spend</span>
              <strong title={formatUsd(safe(perf.spendUsd))}>{money(perf.spendUsd)}</strong>
            </div>
            <div className={styles.mini}>
              <span>Clicks</span>
              <strong title={count(perf.clicks)}>{big(perf.clicks)}</strong>
            </div>
            <div className={styles.mini}>
              <span>Conv.</span>
              <strong title={count(perf.conversions)}>{big(perf.conversions)}</strong>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

/** Every ad with its creative, words, go-link and (when there is delivery) its own numbers. */
export function AdsTab({ campaign: c, stats }: { campaign: Campaign; stats: CampaignStats }) {
  const perAd = new Map((stats.data?.adSets ?? []).flatMap((s) => s.ads).map((a) => [a.id, a]));
  if (c.adSets.every((s) => (s.ads ?? []).length === 0)) {
    return (
      <section className={styles.panel}>
        <div className={styles.empty}>
          <strong>No ads on this campaign</strong>
          <span>There is nothing to show here.</span>
        </div>
      </section>
    );
  }
  return (
    <div className={styles.stack}>
      {c.adSets.map((set, i) => (
        <section key={set.id} className={styles.stack}>
          {c.adSets.length > 1 && (
            <div className={styles.sectionHead}>
              <div>
                <h3 className={styles.sectionTitle}>{set.name || `Ad set ${i + 1}`}</h3>
                <p className={styles.sectionSub}>
                  {(set.ads ?? []).length} ad{(set.ads ?? []).length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          )}
          <div className={styles.adGrid}>
            {(set.ads ?? []).map((ad) => {
              const p = perAd.get(ad.id);
              return <AdCard key={ad.id} ad={ad} host={c.redirectDomainHost} perf={p} status={p?.effectiveStatus ?? null} />;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
