import { AdsenseNotConfiguredError, AdsenseRequestError } from './errors.js';

/**
 * AdSense (AFS / Custom Search Ads) revenue client — Phase 9, the AFS source of
 * truth for attribution (D8). Reads per-channel, per-day estimated earnings + AFS
 * clicks from the AdSense Management API v2 `reports:generate` endpoint. Pure
 * `parseChannelReport` does the row mapping (tested); `fetchChannelReport` adds the
 * HTTP call. Revenue is returned in the report's native currency (minor units) — the
 * caller converts to USD via the daily FxRate (D15).
 *
 * NOTE: AFS reporting access is invite/approval-gated by Google (OPEN_QUESTIONS #4)
 * and the exact CUSTOM_CHANNEL_ID ↔ our `ch` value mapping + any AFS product filter
 * must be confirmed against a live account. The real fetch path stays dormant until a
 * Google OAuth token is wired; attribution is exercised with injected data until then.
 */

/** Per-channel, per-day revenue row (the unit attribution consumes). */
export interface ChannelDayRevenue {
  /** AdSense custom-channel id as reported (mapped to our Channel.channelId upstream). */
  channelId: string;
  /** Report day, YYYY-MM-DD. */
  day: string;
  /** Estimated earnings in `currency`, minor units (2-decimal assumption). */
  revenueMinor: number;
  currency: string;
  /** AFS ad clicks for the day (drives the <10 suppression rule, §5.8.2). */
  afsClicks: number;
  /** AFS ad requests — the unit asked Google for ads. Fill-rate DENOMINATOR. */
  requests?: number;
  /** AFS matched ad requests — requests Google returned ads for. Fill-rate NUMERATOR
   *  (fill rate = matchedRequests / requests = AdSense "coverage"). */
  matchedRequests?: number;
  /** AFS ad impressions (ads rendered) — secondary signal, not the fill trigger. */
  impressions?: number;
}

/** Shape of the AdSense Management API v2 report response (the bits we read). */
export interface AdsenseReportResponse {
  headers?: { name: string; type?: string; currencyCode?: string }[];
  rows?: { cells: { value?: string }[] }[];
}

const DIM_DATE = 'DATE';
const DIM_CHANNEL = 'URL_CHANNEL_NAME';
const MET_EARNINGS = 'ESTIMATED_EARNINGS';
const MET_CLICKS = 'CLICKS';
// Fill-rate metrics (RSOC observe-only). fill rate = MATCHED_AD_REQUESTS / AD_REQUESTS
// ("coverage"). All are parsed absence-tolerantly (missing header → 0), so if a live AFS
// account doesn't return one the feature simply self-dorments rather than breaking.
const MET_REQUESTS = 'AD_REQUESTS';
const MET_MATCHED = 'MATCHED_AD_REQUESTS';
const MET_IMPRESSIONS = 'IMPRESSIONS';
const FILL_METRICS = [MET_REQUESTS, MET_MATCHED, MET_IMPRESSIONS] as const;

/**
 * Channel-id form mapping (confirmed against a live AFS account, OPEN_QUESTIONS #4):
 * the v2 report keys custom channels as `{afsPubId}:{code}`
 * (e.g. `partner-pub-6567805284657549:05219`), but our pool stores the bare `code`
 * (the `ch` value). `qualifyChannelId` builds the report filter/dimension value from a
 * bare code + the account's pubId; `bareChannelId` strips it back for pool matching.
 */
export function qualifyChannelId(afsPubId: string | null | undefined, channelId: string): string {
  return afsPubId ? `${afsPubId}:${channelId}` : channelId;
}
export function bareChannelId(reportedId: string): string {
  const i = reportedId.lastIndexOf(':');
  return i >= 0 ? reportedId.slice(i + 1) : reportedId;
}

/**
 * Map a v2 report response → ChannelDayRevenue rows. Resolves columns by header
 * name (order-independent). Earnings (a decimal in the header's currency) → minor
 * units; currency from the earnings header's `currencyCode` (default USD). Rows
 * missing a date or channel are skipped.
 */
export function parseChannelReport(report: AdsenseReportResponse): ChannelDayRevenue[] {
  const headers = report.headers ?? [];
  const idx = (name: string): number => headers.findIndex((h) => h.name === name);
  const di = idx(DIM_DATE);
  const ci = idx(DIM_CHANNEL);
  const ei = idx(MET_EARNINGS);
  const ki = idx(MET_CLICKS);
  const ri = idx(MET_REQUESTS);
  const mi = idx(MET_MATCHED);
  const ii = idx(MET_IMPRESSIONS);
  const currency = (ei >= 0 ? headers[ei]?.currencyCode : undefined) ?? 'USD';

  const out: ChannelDayRevenue[] = [];
  for (const row of report.rows ?? []) {
    const cell = (i: number): string | undefined => (i >= 0 ? row.cells[i]?.value : undefined);
    const day = cell(di);
    const channelId = cell(ci);
    if (!day || !channelId) continue;
    out.push({
      channelId,
      day,
      revenueMinor: Math.round((Number(cell(ei)) || 0) * 100),
      currency,
      afsClicks: Math.round(Number(cell(ki)) || 0),
      requests: Math.round(Number(cell(ri)) || 0),
      matchedRequests: Math.round(Number(cell(mi)) || 0),
      impressions: Math.round(Number(cell(ii)) || 0),
    });
  }
  return out;
}

/** Per-channel revenue TOTAL over a range (no date breakdown) — the preview unit. */
export interface ChannelRevenueTotal {
  channelId: string;
  revenueMinor: number;
  currency: string;
  afsClicks: number;
  /** AFS fill-rate metrics over the range (observe-only). Absent → 0. */
  requests?: number;
  matchedRequests?: number;
  impressions?: number;
}

export interface FetchChannelReportParams {
  /** Google OAuth access token with AdSense Management scope. */
  accessToken: string;
  /** AdSense account resource id, e.g. `accounts/pub-1234567890`. */
  account: string;
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
  /** Optional: restrict to these custom-channel ids. */
  channelIds?: string[];
}

export interface FetchDeps {
  fetch: typeof fetch;
  baseUrl: string;
}
const defaultDeps: FetchDeps = { fetch, baseUrl: 'https://adsense.googleapis.com/v2' };

/**
 * Row cap for a per-day report fetched WITHOUT a server channel filter (the >1-channel
 * path — see `buildReportQuery`). Set to the AdSense Management API v2 JSON maximum (100k rows),
 * i.e. the most a single `reports:generate` call can return — so we never truncate below what the
 * API itself allows. `fetchChannelReport` still warns if a report actually hits it (the only case
 * left would be a genuinely huge shared account, which then needs date-range splitting).
 */
export const REPORT_ROW_LIMIT = 100_000;

/**
 * Build the `reports:generate` query string for a per-channel per-day report.
 *
 * **Filter footgun (verified live, OQ#4):** the AdSense v2 API combines repeated `filters`
 * params with **AND**, so `CUSTOM_CHANNEL_ID==A` + `CUSTOM_CHANNEL_ID==B` matches ZERO rows
 * (no single row's channel equals both) — the bug that left revenue empty platform-wide.
 * So we push a server filter down ONLY for a single channel; for many, we fetch the whole
 * account's per-day rows (ordered by earnings, row-capped) and match client-side in
 * `fetchChannelReport`. A row's `CUSTOM_CHANNEL_ID` is the qualified `{pubId}:{code}`, which
 * is exactly what `qualifyChannelId` produces, so the client-side `Set` match is 1:1.
 */
export function buildReportQuery(p: FetchChannelReportParams): string {
  const [sy, sm, sd] = p.since.split('-');
  const [uy, um, ud] = p.until.split('-');
  const q = new URLSearchParams();
  q.set('dateRange', 'CUSTOM');
  q.set('startDate.year', sy ?? '');
  q.set('startDate.month', String(Number(sm)));
  q.set('startDate.day', String(Number(sd)));
  q.set('endDate.year', uy ?? '');
  q.set('endDate.month', String(Number(um)));
  q.set('endDate.day', String(Number(ud)));
  q.append('dimensions', DIM_DATE);
  q.append('dimensions', DIM_CHANNEL);
  q.append('metrics', MET_EARNINGS);
  q.append('metrics', MET_CLICKS);
  for (const m of FILL_METRICS) q.append('metrics', m);
  const ids = p.channelIds ?? [];
  if (ids.length === 1) {
    // Exactly one channel → a single server-side equality filter is safe (and cheap).
    q.append('filters', `${DIM_CHANNEL}==${ids[0]}`);
  } else if (ids.length > 1) {
    // Many channels → cannot AND-filter; fetch all + match client-side. Cap the response.
    q.append('orderBy', `-${MET_EARNINGS}`);
    q.set('limit', String(REPORT_ROW_LIMIT));
  }
  return q.toString();
}

/**
 * Fetch per-channel daily AFS revenue over [since, until]. Throws
 * `AdsenseNotConfiguredError` when no access token is supplied (the dormant path),
 * `AdsenseRequestError` on a non-OK response. When MORE THAN ONE `channelIds` is requested
 * the report is fetched unfiltered (the v2 API can't AND-filter multiple channels — see
 * `buildReportQuery`) and the rows are filtered to the requested set here, client-side.
 */
export async function fetchChannelReport(
  params: FetchChannelReportParams,
  deps: FetchDeps = defaultDeps,
): Promise<ChannelDayRevenue[]> {
  if (!params.accessToken) throw new AdsenseNotConfiguredError();
  const url = `${deps.baseUrl}/${params.account}/reports:generate?${buildReportQuery(params)}`;
  const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AdsenseRequestError(`AdSense report failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as AdsenseReportResponse;
  const rawRowCount = json.rows?.length ?? 0;
  const rows = parseChannelReport(json);
  const ids = params.channelIds ?? [];
  if (ids.length > 1) {
    // No silent truncation: a full-limit response means some channels may be missing.
    if (rawRowCount >= REPORT_ROW_LIMIT) {
      console.warn(
        `[adsense] channel report hit the ${REPORT_ROW_LIMIT}-row cap for ${params.account} — ` +
          `some channels may be truncated; pagination needed.`,
      );
    }
    const want = new Set(ids);
    return rows.filter((r) => want.has(r.channelId));
  }
  return rows;
}

export interface FetchChannelTotalsParams {
  accessToken: string;
  account: string;
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
  /** Top-N earning channels to return (the report is ordered by earnings desc). */
  limit?: number;
}

/**
 * Build the `reports:generate` query for top-earning channel TOTALS over [since, until]
 * (CUSTOM_CHANNEL_ID only, no date breakdown), ordered by earnings desc + capped — so an
 * account with 100k channels returns just the top N rows. Powers the super-admin revenue
 * preview / live-pull validation (no per-day rows = bounded response).
 */
export function buildTotalsQuery(p: FetchChannelTotalsParams): string {
  const [sy, sm, sd] = p.since.split('-');
  const [uy, um, ud] = p.until.split('-');
  const q = new URLSearchParams();
  q.set('dateRange', 'CUSTOM');
  q.set('startDate.year', sy ?? '');
  q.set('startDate.month', String(Number(sm)));
  q.set('startDate.day', String(Number(sd)));
  q.set('endDate.year', uy ?? '');
  q.set('endDate.month', String(Number(um)));
  q.set('endDate.day', String(Number(ud)));
  q.append('dimensions', DIM_CHANNEL);
  q.append('metrics', MET_EARNINGS);
  q.append('metrics', MET_CLICKS);
  for (const m of FILL_METRICS) q.append('metrics', m);
  q.append('orderBy', `-${MET_EARNINGS}`);
  q.set('limit', String(p.limit ?? 50));
  return q.toString();
}

/** Parse a totals report (CUSTOM_CHANNEL_ID + earnings + clicks) → per-channel totals. */
export function parseChannelTotals(report: AdsenseReportResponse): { rows: ChannelRevenueTotal[]; currency: string } {
  const headers = report.headers ?? [];
  const idx = (name: string): number => headers.findIndex((h) => h.name === name);
  const ci = idx(DIM_CHANNEL);
  const ei = idx(MET_EARNINGS);
  const ki = idx(MET_CLICKS);
  const ri = idx(MET_REQUESTS);
  const mi = idx(MET_MATCHED);
  const ii = idx(MET_IMPRESSIONS);
  const currency = (ei >= 0 ? headers[ei]?.currencyCode : undefined) ?? 'USD';
  const rows: ChannelRevenueTotal[] = [];
  for (const row of report.rows ?? []) {
    const cell = (i: number): string | undefined => (i >= 0 ? row.cells[i]?.value : undefined);
    const channelId = cell(ci);
    if (!channelId) continue;
    rows.push({
      channelId,
      revenueMinor: Math.round((Number(cell(ei)) || 0) * 100),
      currency,
      afsClicks: Math.round(Number(cell(ki)) || 0),
      requests: Math.round(Number(cell(ri)) || 0),
      matchedRequests: Math.round(Number(cell(mi)) || 0),
      impressions: Math.round(Number(cell(ii)) || 0),
    });
  }
  return { rows, currency };
}

/** Fetch the top-earning channel totals over [since, until] (the preview path). */
export async function fetchChannelTotals(
  params: FetchChannelTotalsParams,
  deps: FetchDeps = defaultDeps,
): Promise<{ rows: ChannelRevenueTotal[]; currency: string }> {
  if (!params.accessToken) throw new AdsenseNotConfiguredError();
  const url = `${deps.baseUrl}/${params.account}/reports:generate?${buildTotalsQuery(params)}`;
  const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AdsenseRequestError(`AdSense report failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return parseChannelTotals((await res.json()) as AdsenseReportResponse);
}
