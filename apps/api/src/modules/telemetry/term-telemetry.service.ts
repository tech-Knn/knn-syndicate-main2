import { withSystem } from '@knn/db';
import {
  RSOC_TERM_DISPLAY_FLOOR,
  type TermPerf,
  addBusinessDays,
  currentBusinessDay,
  normalizeTerm,
} from '@knn/shared';

/**
 * Per-term RSOC telemetry (observe-only). The /search page beacons two kinds of signal per term:
 *   `render` — the term was queried (searches++); if Google served ads, fills++ as well
 *   `click`  — an AFS ad for that term was clicked (clicks++)
 * Aggregated per term per IST business day in `term_stat_daily` (platform-wide, no org scope —
 * terms recur across articles). This is the only place term-grain performance is observable: the
 * AdSense v2 report has no per-query dimension. Super-admin reads it via `getTermPerformance`.
 *
 * Also carries synthetic per-host unit-fill signals under the `unit:<host>` namespace, beaconed
 * by the article-page RSOC widget's `adLoadedCallback`. These share storage with real terms but
 * are filtered out of `getTermPerformance` so they never clutter per-term rankings; a dedicated
 * `getRsocUnitPerformance` reader exposes them for the "did the widget fill?" diagnostic.
 */

export type TermSignal = 'render' | 'click';
/** Namespace prefix for per-host unit-fill signals; not a real search term. */
const UNIT_TERM_PREFIX = 'unit:';

/** Max stored term length (a related-search query is short; cap to bound the public beacon). */
const MAX_TERM_LEN = 120;

/** Record one term-telemetry signal. No-ops on an empty/garbage term. Never throws (beacon path). */
export async function recordTermSignal(input: { term: string; event: TermSignal; filled?: boolean }): Promise<void> {
  const term = normalizeTerm(input.term).toLowerCase().slice(0, MAX_TERM_LEN);
  if (!term) return;

  const incSearches = input.event === 'render' ? 1 : 0;
  const incFills = input.event === 'render' && input.filled ? 1 : 0;
  const incClicks = input.event === 'click' ? 1 : 0;
  if (incSearches + incFills + incClicks === 0) return;

  const day = currentBusinessDay();
  try {
    await withSystem((tx) =>
      tx.termStatDaily.upsert({
        where: { term_day: { term, day } },
        create: { term, day, searches: incSearches, fills: incFills, clicks: incClicks },
        update: {
          searches: { increment: incSearches },
          fills: { increment: incFills },
          clicks: { increment: incClicks },
        },
      }),
    );
  } catch {
    // A concurrent create can race the upsert into a unique violation; retry as a pure increment.
    try {
      await withSystem((tx) =>
        tx.termStatDaily.update({
          where: { term_day: { term, day } },
          data: {
            searches: { increment: incSearches },
            fills: { increment: incFills },
            clicks: { increment: incClicks },
          },
        }),
      );
    } catch {
      /* observe-only telemetry: dropping a single increment is acceptable, never surface */
    }
  }
}

/**
 * Super-admin term-performance rollup over [from, to] IST days (default: last 7 days), ranked by
 * searches. Computes fill rate (fills/searches) + CTR (clicks/fills); both null below the display
 * floor so tiny samples don't read as a misleading 0%.
 */
export async function getTermPerformance(opts: { from?: string; to?: string; limit?: number } = {}): Promise<{
  range: { from: string; to: string };
  terms: TermPerf[];
}> {
  const to = opts.to ?? currentBusinessDay();
  const from = opts.from ?? addBusinessDays(to, -6);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const rows = await withSystem((tx) =>
    tx.termStatDaily.groupBy({
      by: ['term'],
      // Exclude synthetic per-host unit-fill signals (`unit:<host>`) — they share storage
      // with real terms but must never appear in the per-term rankings.
      where: { day: { gte: from, lte: to }, NOT: { term: { startsWith: UNIT_TERM_PREFIX } } },
      _sum: { searches: true, fills: true, clicks: true },
      orderBy: { _sum: { searches: 'desc' } },
      take: limit,
    }),
  );

  const terms: TermPerf[] = rows.map((r) => {
    const searches = r._sum.searches ?? 0;
    const fills = r._sum.fills ?? 0;
    const clicks = r._sum.clicks ?? 0;
    return {
      term: r.term,
      searches,
      fills,
      clicks,
      fillRate: searches >= RSOC_TERM_DISPLAY_FLOOR ? fills / searches : null,
      ctr: fills >= RSOC_TERM_DISPLAY_FLOOR ? clicks / fills : null,
    };
  });

  return { range: { from, to }, terms };
}

/** Per-host RSOC unit-fill performance: one row per host summing render impressions + fills. */
export interface RsocUnitPerf {
  host: string;
  impressions: number;
  fills: number;
  /** fills / impressions, or null below the display floor. */
  fillRate: number | null;
}

/**
 * Per-host RSOC unit-fill rollup — reads the `unit:<host>` synthetic terms written by the article-
 * page RSOC widget's `adLoadedCallback`. Answers "did Google actually return chips on this host?"
 * A near-zero fillRate on a host with real impressions points at a domain-approval gap or an
 * `rc`-quality gate; a 0/0 host has no article-page traffic. Ranked by impressions.
 */
export async function getRsocUnitPerformance(opts: { from?: string; to?: string; limit?: number } = {}): Promise<{
  range: { from: string; to: string };
  hosts: RsocUnitPerf[];
}> {
  const to = opts.to ?? currentBusinessDay();
  const from = opts.from ?? addBusinessDays(to, -6);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const rows = await withSystem((tx) =>
    tx.termStatDaily.groupBy({
      by: ['term'],
      where: { day: { gte: from, lte: to }, term: { startsWith: UNIT_TERM_PREFIX } },
      _sum: { searches: true, fills: true },
      orderBy: { _sum: { searches: 'desc' } },
      take: limit,
    }),
  );

  const hosts: RsocUnitPerf[] = rows.map((r) => {
    const impressions = r._sum.searches ?? 0;
    const fills = r._sum.fills ?? 0;
    return {
      host: r.term.slice(UNIT_TERM_PREFIX.length),
      impressions,
      fills,
      fillRate: impressions >= RSOC_TERM_DISPLAY_FLOOR ? fills / impressions : null,
    };
  });

  return { range: { from, to }, hosts };
}
