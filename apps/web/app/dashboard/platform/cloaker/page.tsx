'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type CloakStats, addBusinessDays, currentBusinessDay } from '@knn/shared';
import { Badge, Banner, Card, type DateRange, DateRangePicker, EmptyState, Skeleton, StatTile } from '@/components/ui';
import { ApiError, admin } from '@/lib/api';
import styles from '../../admin.module.css';
import page from '../cloaker.module.css';

/**
 * Cloaker routing — the dedicated home for the ad-ID verification split (lifted out of the
 * crowded Channels page). Shows, over a chosen IST-business-day range:
 *   • headline KPIs (money vs white, paid clicks reaching the ad-id gate, the macro-missing loss signal)
 *   • a per-media-buyer rollup (click a buyer to filter the campaign table below)
 *   • a per-campaign table (campaign + buyer + company + the full count breakdown)
 * Verification is ENFORCED in production: a paid click without a matching {{ad.id}} macro is routed to
 * the WHITE page — so "macro missing" here is real lost monetization, not a hypothetical. Super-admin
 * only (the platform layout guards the route).
 */

// Soft cap on painted campaign rows — only campaigns with cloak traffic in range appear, so this is
// rarely hit, but it keeps the table responsive if a wide range fans out to many campaigns.
const ROW_CAP = 200;

function defaultRange(): DateRange {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -6), to };
}

/** Whole-number percentage of `n` out of `d` (or "—" when there's nothing to divide). */
function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

/** One media buyer's rolled-up cloak counts across their campaigns in range. */
interface BuyerRollup {
  buyerId: string;
  buyerName: string;
  companyName: string;
  campaigns: number;
  money: number;
  white: number;
  verifiedMatch: number;
  verifiedMismatch: number;
  macroMissing: number;
}

export default function CloakerPage() {
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [data, setData] = useState<CloakStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // '' = all buyers. Clicking a buyer in the rollup narrows the per-campaign table to that buyer.
  const [buyerFilter, setBuyerFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    admin
      .cloakStats(range)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load cloaker stats'))
      .finally(() => setLoading(false));
  }, [range]);
  useEffect(() => load(), [load]);

  // Per-buyer rollup (computed client-side from the per-campaign rows), busiest first.
  const byBuyer = useMemo<BuyerRollup[]>(() => {
    if (!data) return [];
    const m = new Map<string, BuyerRollup>();
    for (const r of data.rows) {
      const key = r.buyerId || r.buyerName;
      const e =
        m.get(key) ??
        ({ buyerId: r.buyerId, buyerName: r.buyerName, companyName: r.companyName, campaigns: 0, money: 0, white: 0, verifiedMatch: 0, verifiedMismatch: 0, macroMissing: 0 } satisfies BuyerRollup);
      e.campaigns += 1;
      e.money += r.money;
      e.white += r.white;
      e.verifiedMatch += r.verifiedMatch;
      e.verifiedMismatch += r.verifiedMismatch;
      e.macroMissing += r.macroMissing;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.money + b.white - (a.money + a.white));
  }, [data]);

  // Drop a stale buyer filter when the new range has no rows for that buyer.
  useEffect(() => {
    if (buyerFilter && !byBuyer.some((b) => b.buyerId === buyerFilter)) setBuyerFilter('');
  }, [byBuyer, buyerFilter]);

  const campRows = useMemo(() => {
    if (!data) return [];
    return buyerFilter ? data.rows.filter((r) => r.buyerId === buyerFilter) : data.rows;
  }, [data, buyerFilter]);

  const t = data?.totals;
  const totalClicks = t ? t.money + t.white : 0;
  const paidClicks = t ? t.verifiedMatch + t.verifiedMismatch + t.macroMissing : 0;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Cloaker routing</h1>
          <p className={styles.sub}>
            Where redirect clicks land — the <strong>money</strong> (article) page vs the <strong>white</strong> (safe) page —
            and how ad-id verification splits paid traffic. Verification is <strong>enforced</strong>: a paid click without a
            matching <code>{'{{ad.id}}'}</code> macro is sent to white, so <strong>macro missing</strong> is real lost revenue.
          </p>
        </div>
      </div>

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {/* Controls: date range (drives the API query) + a buyer filter for the campaign table. */}
      <div className={page.controls}>
        <DateRangePicker value={range} onChange={setRange} />
        <span className={page.spacer} />
        <select
          className={styles.select}
          aria-label="Filter campaigns by media buyer"
          value={buyerFilter}
          onChange={(e) => setBuyerFilter(e.target.value)}
          disabled={byBuyer.length === 0}
        >
          <option value="">All media buyers</option>
          {byBuyer.map((b) => (
            <option key={b.buyerId || b.buyerName} value={b.buyerId}>
              {b.buyerName}
              {b.companyName && b.companyName !== '—' ? ` · ${b.companyName}` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Headline KPIs (whole range, all buyers). */}
      <div className={page.kpis}>
        {loading || !t ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className={page.kpiSkel} />)
        ) : (
          <>
            <StatTile label="Total clicks" value={totalClicks.toLocaleString()} sub={`${byBuyer.length} buyer${byBuyer.length === 1 ? '' : 's'} · ${data?.rows.length ?? 0} campaigns`} />
            <StatTile label="Money page" value={t.money.toLocaleString()} sub={`${pct(t.money, totalClicks)} of clicks`} tone="pos" />
            <StatTile label="White page" value={t.white.toLocaleString()} sub={`${pct(t.white, totalClicks)} of clicks`} />
            <StatTile label="Paid clicks" value={paidClicks.toLocaleString()} sub="reached the ad-id check" />
            <StatTile label="Verified match" value={t.verifiedMatch.toLocaleString()} sub="→ money page" tone="pos" />
            <StatTile
              label="Macro missing"
              value={t.macroMissing.toLocaleString()}
              sub={t.macroMissing > 0 ? 'paid → white (lost)' : 'none — clean'}
              tone={t.macroMissing > 0 ? 'neg' : 'neutral'}
            />
          </>
        )}
      </div>

      {/* Per media buyer */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>By media buyer</span>
          {data && (
            <span className={styles.subtle}>
              {data.range.from} → {data.range.to}
            </span>
          )}
        </div>
        {loading ? (
          <Skeleton className={styles.rowSkel} />
        ) : byBuyer.length === 0 ? (
          <EmptyState title="No cloaker traffic in range" description="Money-vs-white counts appear once live ad clicks flow through the redirect for the selected dates." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Media buyer</th>
                  <th className={styles.thLeft}>Company</th>
                  <th>Campaigns</th>
                  <th>Money</th>
                  <th>White</th>
                  <th>Money rate</th>
                  <th>Verified</th>
                  <th>Mismatch</th>
                  <th>Macro missing</th>
                </tr>
              </thead>
              <tbody>
                {byBuyer.map((b) => {
                  const total = b.money + b.white;
                  const active = buyerFilter === b.buyerId;
                  return (
                    <tr key={b.buyerId || b.buyerName}>
                      <td className={styles.name}>
                        <button
                          type="button"
                          className={styles.sortBtn}
                          aria-pressed={active}
                          title="Filter the campaign table to this buyer"
                          onClick={() => setBuyerFilter(active ? '' : b.buyerId)}
                        >
                          {b.buyerName}
                          {active ? ' ✓' : ''}
                        </button>
                      </td>
                      <td className={styles.subtle}>{b.companyName}</td>
                      <td className={styles.num}>{b.campaigns.toLocaleString()}</td>
                      <td className={styles.num}>{b.money.toLocaleString()}</td>
                      <td className={styles.num}>{b.white.toLocaleString()}</td>
                      <td className={styles.num}>{pct(b.money, total)}</td>
                      <td className={styles.num}>{b.verifiedMatch.toLocaleString()}</td>
                      <td className={styles.num} title="Paid clicks with the wrong ad id — blocked spoof/bot traffic (safe to send to white)">
                        {b.verifiedMismatch.toLocaleString()}
                      </td>
                      <td className={styles.num}>
                        {b.macroMissing > 0 ? <Badge tone="danger">{b.macroMissing.toLocaleString()}</Badge> : b.macroMissing}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Per campaign */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>By campaign</span>
          {buyerFilter && (
            <button type="button" className={styles.actionBtn} onClick={() => setBuyerFilter('')}>
              Clear buyer filter
            </button>
          )}
        </div>
        <p className={styles.fieldHint}>
          <strong>Money/White</strong> = where each click actually went. <strong>Verified</strong> = paid clicks whose{' '}
          <code>{'{{ad.id}}'}</code> matched (→ money). <strong>Mismatch</strong> = wrong id (blocked spoof/bot).{' '}
          <strong>Macro missing</strong> = paid clicks with no macro — routed to white under enforce, i.e. lost monetization.
        </p>
        {loading ? (
          <div className={styles.rowsSkel} role="status">
            <span className="srOnly">Loading campaigns…</span>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : campRows.length === 0 ? (
          <EmptyState
            title={buyerFilter ? 'No campaigns for this buyer in range' : 'No cloaker traffic in range'}
            description="Per-campaign money-vs-white counts appear once live ad clicks flow through the redirect."
          />
        ) : (
          (() => {
            const visible = campRows.slice(0, ROW_CAP);
            return (
              <>
                {campRows.length > ROW_CAP && (
                  <Banner tone="info">
                    Showing {visible.length.toLocaleString()} of {campRows.length.toLocaleString()} campaigns — narrow the date range or pick a buyer to see the rest.
                  </Banner>
                )}
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.thLeft}>Campaign</th>
                        <th className={styles.thLeft}>Media buyer</th>
                        <th className={styles.thLeft}>Company</th>
                        <th>Money</th>
                        <th>White</th>
                        <th>Money rate</th>
                        <th>Verified</th>
                        <th>Mismatch</th>
                        <th>Macro missing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => {
                        const total = r.money + r.white;
                        return (
                          <tr key={r.campaignId}>
                            <td className={styles.name}>{r.name}</td>
                            <td className={styles.subtle}>{r.buyerName}</td>
                            <td className={styles.subtle}>{r.companyName}</td>
                            <td className={styles.num}>{r.money.toLocaleString()}</td>
                            <td className={styles.num}>{r.white.toLocaleString()}</td>
                            <td className={styles.num}>{pct(r.money, total)}</td>
                            <td className={styles.num}>{r.verifiedMatch.toLocaleString()}</td>
                            <td className={styles.num} title="Paid clicks with the wrong ad id — blocked spoof/bot traffic">
                              {r.verifiedMismatch.toLocaleString()}
                            </td>
                            <td className={styles.num}>
                              {r.macroMissing > 0 ? <Badge tone="danger">{r.macroMissing.toLocaleString()}</Badge> : r.macroMissing}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()
        )}
      </Card>
    </div>
  );
}
