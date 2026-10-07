'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type CampaignBreakdown, type CampaignDayPerf, addBusinessDays, currentBusinessDay } from '@knn/shared';
import { stats } from '@/lib/api';

export type RangeKey = 'today' | '7d' | '30d';

export const RANGES: { label: string; value: RangeKey }[] = [
  { label: 'Today', value: 'today' },
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
];

const REFRESH_MS = 5 * 60_000;
const VISIBLE_STALE_MS = 60_000;
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
  /** One row per IST business day in the range, newest first. Null while loading or if it failed. */
  daily: CampaignDayPerf[] | null;
  loading: boolean;
  failed: boolean;
  /** When the hourly numbers last refreshed, and how often they do. */
  sync: SyncInfo | null;
  reload: () => void;
}

/** The campaign's numbers for a range, read once per change and re-read on demand; `enabled` false = nothing to show yet. */
export function useCampaignStats(id: string, enabled: boolean, range: RangeKey): CampaignStats {
  const [data, setData] = useState<CampaignBreakdown | null>(null);
  const [daily, setDaily] = useState<CampaignDayPerf[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [tick, setTick] = useState(0);
  const loadedAt = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setFailed(false);
    void Promise.all([
      stats.campaignBreakdown(id, rangeFor(range)),
      // Its own catch: a new endpoint failing must never take the existing numbers off the page.
      stats.campaignDaily(id, rangeFor(range)).catch(() => null),
      stats.syncStatus().catch(() => null),
    ])
      .then(([d, days, s]) => {
        if (!alive) return;
        setData(d);
        setDaily(days);
        setSync(s?.metrics ?? null);
        loadedAt.current = Date.now();
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, enabled, range, tick]);

  // The numbers move hourly, so a page left open should not go stale: re-read every few minutes while it is visible, and
  // when a hidden tab comes back after a while (also the one way a page kept open across the IST midnight notices it).
  useEffect(() => {
    if (!enabled) return;
    const refresh = (): void => {
      if (!document.hidden) setTick((t) => t + 1);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = (): void => {
      if (!document.hidden && Date.now() - loadedAt.current > VISIBLE_STALE_MS) setTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, daily, loading, failed, sync, reload };
}
