import { describe, expect, it, vi } from 'vitest';
import {
  AdsenseNotConfiguredError,
  buildReportQuery,
  fetchChannelReport,
  parseChannelReport,
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
      { channelId: 'ch-A', day: '2026-05-27', revenueMinor: 1234, currency: 'USD', afsClicks: 57 },
      { channelId: 'ch-B', day: '2026-05-27', revenueMinor: 0, currency: 'USD', afsClicks: 3 },
    ]);
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
      { channelId: 'ch-X', day: '2026-01-02', revenueMinor: 500, currency: 'USD', afsClicks: 9 },
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
    expect(rows).toEqual([{ channelId: 'ch-A', day: '2026-05-27', revenueMinor: 350, currency: 'USD', afsClicks: 12 }]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(url).toContain('/accounts/pub-1/reports:generate?');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});
