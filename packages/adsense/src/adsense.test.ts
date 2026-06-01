import { describe, expect, it, vi } from 'vitest';
import {
  AdsenseNotConfiguredError,
  bareChannelId,
  buildReportQuery,
  buildTotalsQuery,
  fetchChannelReport,
  fetchChannelTotals,
  parseChannelReport,
  parseChannelTotals,
  qualifyChannelId,
} from './index.js';

describe('parseChannelReport', () => {
  it('maps v2 report rows to ChannelDayRevenue (earnings→minor, currency from header)', () => {
    const rows = parseChannelReport({
      headers: [
        { name: 'DATE', type: 'DIMENSION' },
        { name: 'CUSTOM_CHANNEL_ID', type: 'DIMENSION' },
        { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: 'USD' },
        { name: 'CLICKS', type: 'METRIC_TALLY' },
      ],
      rows: [
        { cells: [{ value: '2026-05-27' }, { value: 'ch-A' }, { value: '12.34' }, { value: '57' }] },
        { cells: [{ value: '2026-05-27' }, { value: 'ch-B' }, { value: '0.00' }, { value: '3' }] },
      ],
    });
    expect(rows).toEqual([
      { channelId: 'ch-A', day: '2026-05-27', revenueMinor: 1234, currency: 'USD', afsClicks: 57, requests: 0, matchedRequests: 0, impressions: 0 },
      { channelId: 'ch-B', day: '2026-05-27', revenueMinor: 0, currency: 'USD', afsClicks: 3, requests: 0, matchedRequests: 0, impressions: 0 },
    ]);
  });

  it('parses the AFS fill-rate metrics when present (requests / matched / impressions)', () => {
    const rows = parseChannelReport({
      headers: [
        { name: 'DATE' },
        { name: 'CUSTOM_CHANNEL_ID' },
        { name: 'ESTIMATED_EARNINGS', currencyCode: 'USD' },
        { name: 'CLICKS' },
        { name: 'AD_REQUESTS' },
        { name: 'MATCHED_AD_REQUESTS' },
        { name: 'IMPRESSIONS' },
      ],
      rows: [{ cells: [{ value: '2026-06-01' }, { value: 'ch-A' }, { value: '5.00' }, { value: '4' }, { value: '900' }, { value: '720' }, { value: '700' }] }],
    });
    expect(rows[0]).toMatchObject({ channelId: 'ch-A', requests: 900, matchedRequests: 720, impressions: 700 });
    // fill rate (coverage) = 720/900 = 0.8 — computed downstream, not stored.
  });

  it('defaults the fill metrics to 0 when their headers are absent (self-dormant)', () => {
    const rows = parseChannelReport({
      headers: [{ name: 'DATE' }, { name: 'CUSTOM_CHANNEL_ID' }, { name: 'ESTIMATED_EARNINGS' }, { name: 'CLICKS' }],
      rows: [{ cells: [{ value: '2026-06-01' }, { value: 'ch-Z' }, { value: '1.00' }, { value: '1' }] }],
    });
    expect(rows[0]).toMatchObject({ requests: 0, matchedRequests: 0, impressions: 0 });
  });

  it('resolves columns by header name regardless of order, defaults currency to USD', () => {
    const rows = parseChannelReport({
      headers: [
        { name: 'CLICKS' },
        { name: 'CUSTOM_CHANNEL_ID' },
        { name: 'ESTIMATED_EARNINGS' },
        { name: 'DATE' },
      ],
      rows: [{ cells: [{ value: '9' }, { value: 'ch-X' }, { value: '5.00' }, { value: '2026-01-02' }] }],
    });
    expect(rows).toEqual([
      { channelId: 'ch-X', day: '2026-01-02', revenueMinor: 500, currency: 'USD', afsClicks: 9, requests: 0, matchedRequests: 0, impressions: 0 },
    ]);
  });

  it('skips rows missing a date or channel and tolerates empty reports', () => {
    expect(parseChannelReport({})).toEqual([]);
    const rows = parseChannelReport({
      headers: [{ name: 'DATE' }, { name: 'CUSTOM_CHANNEL_ID' }, { name: 'ESTIMATED_EARNINGS' }, { name: 'CLICKS' }],
      rows: [{ cells: [{ value: '2026-05-27' }, {}, { value: '1.00' }, { value: '1' }] }],
    });
    expect(rows).toEqual([]);
  });
});

describe('channel-id form mapping (OQ#4)', () => {
  it('qualifyChannelId prefixes the bare code with the account pubId for the report', () => {
    expect(qualifyChannelId('partner-pub-6567805284657549', '05219')).toBe('partner-pub-6567805284657549:05219');
    // No pubId → leave the bare code as-is (legacy / dormant).
    expect(qualifyChannelId(null, '05219')).toBe('05219');
    expect(qualifyChannelId(undefined, '00869')).toBe('00869');
  });

  it('bareChannelId strips the `{pubId}:` prefix back to our pool code', () => {
    expect(bareChannelId('partner-pub-6567805284657549:05219')).toBe('05219');
    expect(bareChannelId('partner-pub-6567805284657549:6895555411')).toBe('6895555411');
    // Already bare → unchanged (round-trips with qualifyChannelId).
    expect(bareChannelId('05219')).toBe('05219');
    expect(bareChannelId(qualifyChannelId('partner-pub-X', '00686'))).toBe('00686');
  });
});

describe('buildReportQuery', () => {
  it('encodes the custom date range, dimensions, metrics, and channel filters', () => {
    const q = buildReportQuery({
      accessToken: 't',
      account: 'accounts/pub-1',
      since: '2026-05-01',
      until: '2026-05-08',
      channelIds: ['ch-A', 'ch-B'],
    });
    expect(q).toContain('dateRange=CUSTOM');
    expect(q).toContain('startDate.year=2026');
    expect(q).toContain('startDate.month=5');
    expect(q).toContain('startDate.day=1');
    expect(q).toContain('endDate.day=8');
    expect(q).toContain('dimensions=DATE');
    expect(q).toContain('dimensions=CUSTOM_CHANNEL_ID');
    expect(q).toContain('metrics=ESTIMATED_EARNINGS');
    expect(q).toContain('metrics=AD_REQUESTS');
    expect(q).toContain('metrics=MATCHED_AD_REQUESTS');
    expect(q).toContain('metrics=IMPRESSIONS');
    expect(q).toContain('filters=CUSTOM_CHANNEL_ID%3D%3Dch-A');
  });
});

describe('fetchChannelReport', () => {
  it('throws AdsenseNotConfiguredError without an access token (the dormant path)', async () => {
    await expect(
      fetchChannelReport({ accessToken: '', account: 'accounts/pub-1', since: '2026-05-01', until: '2026-05-01' }),
    ).rejects.toBeInstanceOf(AdsenseNotConfiguredError);
  });

  it('fetches with a bearer token and parses the report', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          headers: [{ name: 'DATE' }, { name: 'CUSTOM_CHANNEL_ID' }, { name: 'ESTIMATED_EARNINGS', currencyCode: 'USD' }, { name: 'CLICKS' }],
          rows: [{ cells: [{ value: '2026-05-27' }, { value: 'ch-A' }, { value: '3.50' }, { value: '12' }] }],
        }),
        { status: 200 },
      ),
    );
    const rows = await fetchChannelReport(
      { accessToken: 'tok', account: 'accounts/pub-1', since: '2026-05-27', until: '2026-05-27' },
      { fetch: fetchMock as unknown as typeof fetch, baseUrl: 'https://adsense.googleapis.com/v2' },
    );
    expect(rows).toEqual([{ channelId: 'ch-A', day: '2026-05-27', revenueMinor: 350, currency: 'USD', afsClicks: 12, requests: 0, matchedRequests: 0, impressions: 0 }]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(url).toContain('/accounts/pub-1/reports:generate?');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('buildTotalsQuery', () => {
  it('requests channel totals ordered by earnings desc, capped, with no DATE dimension', () => {
    const q = buildTotalsQuery({ accessToken: 't', account: 'accounts/pub-1', since: '2026-05-01', until: '2026-05-07', limit: 25 });
    expect(q).toContain('dimensions=CUSTOM_CHANNEL_ID');
    expect(q).not.toContain('dimensions=DATE');
    expect(q).toContain('metrics=ESTIMATED_EARNINGS');
    expect(q).toContain('metrics=CLICKS');
    expect(q).toContain('orderBy=-ESTIMATED_EARNINGS');
    expect(q).toContain('limit=25');
  });
});

describe('parseChannelTotals', () => {
  it('maps a totals report → per-channel totals (earnings→minor, currency from header)', () => {
    const { rows, currency } = parseChannelTotals({
      headers: [{ name: 'CUSTOM_CHANNEL_ID' }, { name: 'ESTIMATED_EARNINGS', currencyCode: 'INR' }, { name: 'CLICKS' }],
      rows: [
        { cells: [{ value: '05219' }, { value: '12.34' }, { value: '57' }] },
        { cells: [{ value: '00500' }, { value: '0.00' }, { value: '2' }] },
      ],
    });
    expect(currency).toBe('INR');
    expect(rows).toEqual([
      { channelId: '05219', revenueMinor: 1234, currency: 'INR', afsClicks: 57, requests: 0, matchedRequests: 0, impressions: 0 },
      { channelId: '00500', revenueMinor: 0, currency: 'INR', afsClicks: 2, requests: 0, matchedRequests: 0, impressions: 0 },
    ]);
  });
});

describe('fetchChannelTotals', () => {
  it('throws AdsenseNotConfiguredError without a token', async () => {
    await expect(
      fetchChannelTotals({ accessToken: '', account: 'accounts/pub-1', since: '2026-05-01', until: '2026-05-07' }),
    ).rejects.toBeInstanceOf(AdsenseNotConfiguredError);
  });

  it('fetches with a bearer token and parses channel totals', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          headers: [{ name: 'CUSTOM_CHANNEL_ID' }, { name: 'ESTIMATED_EARNINGS', currencyCode: 'USD' }, { name: 'CLICKS' }],
          rows: [{ cells: [{ value: 'ch-A' }, { value: '3.50' }, { value: '12' }] }],
        }),
        { status: 200 },
      ),
    );
    const { rows } = await fetchChannelTotals(
      { accessToken: 'tok', account: 'accounts/pub-1', since: '2026-05-27', until: '2026-05-27', limit: 10 },
      { fetch: fetchMock as unknown as typeof fetch, baseUrl: 'https://adsense.googleapis.com/v2' },
    );
    expect(rows).toEqual([{ channelId: 'ch-A', revenueMinor: 350, currency: 'USD', afsClicks: 12, requests: 0, matchedRequests: 0, impressions: 0 }]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/accounts/pub-1/reports:generate?');
    expect(url).toContain('orderBy=-ESTIMATED_EARNINGS');
  });
});
