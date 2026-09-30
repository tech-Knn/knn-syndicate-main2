'use client';

import { formatRoi, formatUsd } from '@knn/shared';
import { FbStatusBadge } from '@/components/fb-status-badge';
import { IconCheck } from '@/components/icons';
import { Skeleton } from '@/components/ui';
import type { Campaign, CampaignAdSet } from '@/lib/types';
import { LiveBudget } from './budget';
import styles from './campaign.module.css';
import { bigCount as big, budgetText, count, money, safe, scheduleText } from './format';
import { HAS_DELIVERY, networkName } from './status';
import { LIVE_TOGGLEABLE } from './status-card';
import type { CampaignStats } from './use-stats';

const human = (s: string): string => s.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());


const PRE_LAUNCH = new Set(['PENDING_APPROVAL', 'APPROVED', 'QUEUED_NO_CHANNEL', 'PROCESSING', 'BATCHED', 'LAUNCHING']);

/** Before there is anything to measure: what launching does, in order, and how far this campaign already is. */
function LaunchPlan({ campaign: c }: { campaign: Campaign }) {
  const net = networkName(c);
  const approved = c.status !== 'PENDING_APPROVAL';
  const channel = c.status === 'PROCESSING' || c.status === 'BATCHED' || c.status === 'LAUNCHING';
  const steps: { text: string; done: boolean }[] = [
    { text: 'An admin approves the campaign', done: approved },
    { text: 'An AdSense channel is assigned to it', done: channel },
    { text: 'The landing article is written for your topic', done: false },
    { text: 'The redirect is wired, and the go-link host and white page are chosen', done: false },
    ...(c.adProvider === 'WHOP' ? [{ text: 'Whop checks that its pixel loads on the landing page', done: false }] : []),
    { text: `The campaign, its ${c.adProvider === 'WHOP' ? 'ad group' : 'ad sets'} and ads are created on ${net} and switched on`, done: false },
    { text: `${net === 'Whop' ? 'Meta reviews' : 'Facebook reviews'} the ads, and delivery starts once they are approved`, done: false },
  ];
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h3 className={styles.panelTitle}>What happens when you launch</h3>
          <p className={styles.panelSub}>Nothing spends until the last step. Numbers appear here after the first hourly sync following the first click.</p>
        </div>
      </div>
      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={s.text} className={s.done ? styles.stepDone : ''}>
            <span className={styles.stepDot} aria-hidden>
              {s.done ? <IconCheck size={13} /> : i + 1}
            </span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PerformanceByAd({ stats }: { stats: CampaignStats }) {
  const sets = stats.data?.adSets ?? [];
  const rows = sets.flatMap((s) => s.ads.map((a) => ({ ...a, adSet: s.name, multi: sets.length > 1 })));
  const t = stats.data?.totals;
  const noActivity = Boolean(t) && t!.spendUsd === 0 && t!.impressions === 0 && t!.clicks === 0 && t!.conversions === 0;
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h3 className={styles.panelTitle}>Performance by ad</h3>
          <p className={styles.panelSub}>Spend and clicks come from the ad network. Revenue is Google’s, shared across the ads by conversions, so per ad it is an estimate.</p>
        </div>
      </div>
      {stats.failed && !stats.data ? (
        // The Performance strip above already says so and offers the retry: don't shout it twice.
        <div className={styles.empty}>
          <span>The numbers are not available right now.</span>
        </div>
      ) : !stats.data ? (
        <>
          <Skeleton className={styles.skel} />
          <div style={{ height: 8 }} />
          <Skeleton className={styles.skel} />
        </>
      ) : rows.length === 0 || noActivity ? (
        <div className={styles.empty}>
          <strong>No delivery in this range yet</strong>
          <span>Numbers appear after the first hourly sync following the first click.</span>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ad</th>
                <th className={styles.num}>Spend</th>
                <th className={styles.num}>Revenue</th>
                <th className={styles.num}>Profit</th>
                <th className={styles.num}>ROI</th>
                <th className={styles.num}>Clicks</th>
                <th className={styles.num}>Conv.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className={styles.cellName} title={a.name}>
                      {a.name}
                    </div>
                    <div className={styles.cellSub} title={a.multi ? a.adSet : undefined}>
                      {a.multi ? `${a.adSet} · ` : ''}
                      <FbStatusBadge status={a.effectiveStatus} />
                    </div>
                  </td>
                  <td className={styles.num} title={formatUsd(safe(a.spendUsd))}>{money(a.spendUsd)}</td>
                  <td className={styles.num} title={formatUsd(safe(a.revenueUsd))}>{money(a.revenueUsd)}</td>
                  <td className={`${styles.num} ${safe(a.profitUsd) > 0 ? styles.pos : safe(a.profitUsd) < 0 ? styles.neg : ''}`}>{money(a.profitUsd)}</td>
                  <td className={`${styles.num} ${safe(a.roi) > 0 ? styles.pos : safe(a.roi) < 0 ? styles.neg : ''}`}>{formatRoi(safe(a.roi))}</td>
                  <td className={styles.num} title={count(a.clicks)}>{big(a.clicks)}</td>
                  <td className={styles.num} title={count(a.conversions)}>{big(a.conversions)}</td>
                </tr>
              ))}
            </tbody>
            {t && rows.length > 1 && (
              <tfoot>
                <tr className={styles.tfoot}>
                  <td>Total</td>
                  <td className={styles.num} title={formatUsd(safe(t.spendUsd))}>{money(t.spendUsd)}</td>
                  <td className={styles.num} title={formatUsd(safe(t.revenueUsd))}>{money(t.revenueUsd)}</td>
                  <td className={`${styles.num} ${t.profitUsd > 0 ? styles.pos : t.profitUsd < 0 ? styles.neg : ''}`}>{money(t.profitUsd)}</td>
                  <td className={`${styles.num} ${t.roi > 0 ? styles.pos : t.roi < 0 ? styles.neg : ''}`}>{formatRoi(t.roi)}</td>
                  <td className={styles.num} title={count(t.clicks)}>{big(t.clicks)}</td>
                  <td className={styles.num} title={count(t.conversions)}>{big(t.conversions)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  );
}

function AdSetFacts({ campaign: c, set }: { campaign: Campaign; set: CampaignAdSet }) {
  // Old rows can miss a list entirely: read every list defensively so one odd ad set never blanks the page.
  const countries = set.countries ?? [];
  const excluded = set.excludeCountries ?? [];
  const genders = set.genders ?? [];
  const placements = set.placements ?? [];
  const gender = genders.length === 0 ? 'All genders' : genders.map(human).join(', ');
  return (
    <dl className={styles.facts}>
      <dt>Countries</dt>
      <dd>
        <div className={styles.chipList}>
          {countries.length ? countries.map((x) => <span key={x} className={styles.tag}>{x}</span>) : 'Everywhere'}
        </div>
      </dd>
      {excluded.length > 0 && (
        <>
          <dt>Excluding</dt>
          <dd>
            <div className={styles.chipList}>
              {excluded.map((x) => <span key={x} className={styles.tag}>{x}</span>)}
            </div>
          </dd>
        </>
      )}
      <dt>Audience</dt>
      <dd>
        {set.ageMin}–{set.ageMax} · {gender}
      </dd>
      <dt>Placements</dt>
      <dd>{set.placementMode === 'manual' && placements.length ? placements.map(human).join(', ') : 'Automatic (all placements)'}</dd>
      <dt>Optimized for</dt>
      <dd>{set.pxeEvent === 'adclick' ? 'Google ad click' : human(set.pxeEvent ?? '')}</dd>
      <dt>Schedule</dt>
      <dd>{scheduleText(set)}</dd>
      {c.budgetMode === 'AD_SET' && set.dailyBudgetCents != null && (
        <>
          <dt>Daily budget</dt>
          <dd>{formatUsd(safe(set.dailyBudgetCents) / 100)}</dd>
        </>
      )}
    </dl>
  );
}

export function OverviewTab({ campaign: c, stats, onBudgetSaved }: { campaign: Campaign; stats: CampaignStats; onBudgetSaved: (next: { adSetId?: string; cents: number }) => void }) {
  const live = LIVE_TOGGLEABLE.has(c.status);
  return (
    <div className={styles.twoCol}>
      <div className={styles.stack}>
        {HAS_DELIVERY.has(c.status) ? (
          <PerformanceByAd stats={stats} />
        ) : PRE_LAUNCH.has(c.status) ? (
          <LaunchPlan campaign={c} />
        ) : (
          <section className={styles.panel}>
            <div className={styles.empty}>
              <strong>Nothing has run yet</strong>
              <span>This campaign was not launched, so there are no numbers.</span>
            </div>
          </section>
        )}
      </div>
      <div className={styles.stack}>
        {live ? (
          <LiveBudget campaign={c} onSaved={onBudgetSaved} />
        ) : (
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <h3 className={styles.panelTitle}>Daily budget</h3>
                <p className={styles.panelSub}>You can change the budget once the campaign is live.</p>
              </div>
            </div>
            <dl className={styles.facts}>
              <dt>{c.budgetMode === 'CAMPAIGN' ? 'Campaign' : 'Total'}</dt>
              <dd>{budgetText(c)}</dd>
            </dl>
          </section>
        )}
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>Audience and delivery</h3>
              <p className={styles.panelSub}>
                {human(c.objective)} objective · {c.budgetMode === 'CAMPAIGN' ? 'budget set on the campaign' : 'budget set per ad set'}
              </p>
            </div>
          </div>
          <div className={styles.stack}>
            {c.adSets.length === 0 && <span className={styles.panelSub}>No ad sets on this campaign.</span>}
            {c.adSets.map((s, i) => (
              <div key={s.id}>
                {c.adSets.length > 1 && <h4 className={styles.panelTitle} style={{ marginBottom: 10 }}>{s.name || `Ad set ${i + 1}`}</h4>}
                <AdSetFacts campaign={c} set={s} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
