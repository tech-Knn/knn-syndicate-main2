'use client';

import { useMemo } from 'react';
import type { CampaignDayPerf } from '@knn/shared';
import { COLUMNS, type ColKey } from '../../analytics/columns';
import styles from './campaign.module.css';

/** "Mon 6 Oct" reads faster than "2026-10-06"; the ISO day stays the row key. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * This campaign, one row per IST business day, in whichever columns the buyer picked. Driven by the
 * SAME column registry as Analytics, so a metric defined once renders in both places and they can
 * never disagree.
 */
export function DailyTable({ rows, columns }: { rows: CampaignDayPerf[]; columns: ColKey[] }) {
  const cols = useMemo(
    // `budget` is a campaign setting, not a daily measurement — the Analytics totals row drops it for the same reason.
    () => columns.flatMap((k) => (k === 'budget' ? [] : (COLUMNS.find((c) => c.key === k) ?? []))),
    [columns],
  );

  if (rows.length === 0) return <p className={styles.panelSub}>No activity in this range.</p>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={styles.num} title={c.info}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <th scope="row">{dayLabel(r.day)}</th>
              {/* ctx null: the in-cell data bars compare rows in a list — meaningless across days. */}
              {cols.map((c) => (
                <td key={c.key} className={[styles.num, c.tone?.(r)].filter(Boolean).join(' ')}>
                  {c.cell(r, null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}