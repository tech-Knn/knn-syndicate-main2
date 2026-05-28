import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractConversions, fetchAdInsights } from './insights.js';

function res(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractConversions', () => {
  it('sums offsite pixel conversions and ignores engagement actions', () => {
    const actions = [
      { action_type: 'link_click', value: '40' },
      { action_type: 'landing_page_view', value: '20' },
      { action_type: 'offsite_conversion.fb_pixel_search', value: '3' },
      { action_type: 'offsite_conversion.fb_pixel_custom', value: '2' },
    ];
    expect(extractConversions(actions)).toBe(5);
  });

  it('is 0 when there are no actions or no pixel conversions', () => {
    expect(extractConversions(undefined)).toBe(0);
    expect(extractConversions([{ action_type: 'link_click', value: '99' }])).toBe(0);
  });
});

describe('fetchAdInsights', () => {
  it('normalizes per-ad daily rows (spend→native minor, conversions from actions)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({
        data: [
          {
            ad_id: 'fbad_1',
            date_start: '2026-05-27',
            impressions: '1000',
            clicks: '40',
            spend: '12.34',
            actions: [
              { action_type: 'link_click', value: '40' },
              { action_type: 'offsite_conversion.fb_pixel_search', value: '4' },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchAdInsights({
      fbCampaignId: 'fbcamp_1',
      accountId: 'act_1',
      accessToken: 'tok',
      since: '2026-05-27',
      until: '2026-05-27',
    });

    expect(rows).toEqual([
      { fbAdId: 'fbad_1', day: '2026-05-27', impressions: 1000, clicks: 40, spendMinor: 1234, conversions: 4 },
    ]);
    // Requested per-ad daily breakdown for the campaign insights edge.
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/fbcamp_1/insights');
    expect(url).toContain('level=ad');
    expect(url).toContain('time_increment=1');
  });

  it('requests a country breakdown and returns dimValue per row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({
        data: [
          { ad_id: 'a1', date_start: '2026-05-27', impressions: '100', clicks: '5', spend: '2.00', country: 'US' },
          { ad_id: 'a1', date_start: '2026-05-27', impressions: '40', clicks: '1', spend: '0.50', country: 'CA' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const rows = await fetchAdInsights({ fbCampaignId: 'c', accountId: 'act_1', accessToken: 'tok', since: '2026-05-27', until: '2026-05-27', breakdown: 'country' });
    expect(rows.map((r) => r.dimValue)).toEqual(['US', 'CA']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('breakdowns=country');
  });

  it('requests an hourly breakdown via the advertiser-timezone field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({ data: [{ ad_id: 'a1', date_start: '2026-05-27', impressions: '10', clicks: '1', spend: '1.00', hourly_stats_aggregated_by_advertiser_time_zone: '06:00:00 - 06:59:59' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const rows = await fetchAdInsights({ fbCampaignId: 'c', accountId: 'act_1', accessToken: 'tok', since: '2026-05-27', until: '2026-05-27', breakdown: 'hour' });
    expect(rows[0]?.dimValue).toBe('06:00:00 - 06:59:59');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('breakdowns=hourly_stats_aggregated_by_advertiser_time_zone');
  });

  it('follows pagination across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        res({
          data: [{ ad_id: 'a1', date_start: '2026-05-27', impressions: '10', clicks: '1', spend: '1.00' }],
          paging: { cursors: { after: 'C1' }, next: 'https://graph.facebook.com/vX/fbcamp_1/insights?after=C1' },
        }),
      )
      .mockResolvedValueOnce(
        res({
          data: [{ ad_id: 'a2', date_start: '2026-05-27', impressions: '20', clicks: '2', spend: '2.00' }],
          paging: { cursors: { after: 'C2' } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchAdInsights({ fbCampaignId: 'fbcamp_1', accountId: 'act_1', accessToken: 'tok', since: '2026-05-27', until: '2026-05-27' });
    expect(rows.map((r) => r.fbAdId)).toEqual(['a1', 'a2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('after=C1');
  });
});
