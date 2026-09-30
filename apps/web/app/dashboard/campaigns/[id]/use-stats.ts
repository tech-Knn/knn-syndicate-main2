'use client';

import { useCallback, useEffect, useState } from 'react';
import { type CampaignBreakdown, addBusinessDays, currentBusinessDay } from '@knn/shared';
import { stats } from '@/lib/api';

export type RangeKey = 'today' | '7d' | '30d';

export const RANGES: { label: string; value: RangeKey }[] = [
  { label: 'Today', value: 'today' },
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
];

const DAYS: Record<RangeKey, number> = { today: 1, '7d': 7, '30d': 30 };

/** An inclusive run of IST business days ending today (the same day the rest of the dashboard uses). */
export function rangeFor(key: RangeKey): { from: string; to: string } {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(DAYS[key] - 1)), to };
}

export interface SyncInfo {
  at: string | null;
  everySec: number;
}

export interface CampaignStats {
  data: CampaignBreakdown | null;
  loading: boolean;
  failed: boolean;
  /** When the hourly numbers last refreshed, and how often they do. */
  sync: SyncInfo | null;
  reload: () => void;
}

/** The campaign's numbers for a range, read once per change and re-read on demand; `enabled` false = nothing to show yet. */
export function useCampaignStats(id: string, enabled: boolean, range: RangeKey): CampaignStats {
  const [data, setData] = useState<CampaignBreakdown | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setFailed(false);
    void Promise.all([stats.campaignBreakdown(id, rangeFor(range)), stats.syncStatus().catch(() => null)])
      .then(([d, s]) => {
        if (!alive) return;
        setData(d);
        setSync(s?.metrics ?? null);
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, enabled, range, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, failed, sync, reload };
}
