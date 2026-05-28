/**
 * Dashboard stats DTOs (Phase 10). The read API aggregates the Phase 9 daily
 * tables (`ad_stats_daily` cost + `ad_revenue_daily` derived revenue) over an
 * IST-business-day range and returns display-ready figures. All money is in
 * whole USD (dollars, 2-dp numbers) — the API does the minor-unit → dollar
 * conversion so the client never re-derives money. ROI = revenue ÷ spend (ROAS;
 * 0 when spend is 0). `marginUsd` is the platform's take (revenue cut) and is
 * only meaningful in the admin/super rollups — it's 0 in a buyer's own view.
 */

export interface DateRange {
  from: string; // inclusive IST business day, "YYYY-MM-DD"
  to: string; // inclusive
}

export interface MetricTotals {
  spendUsd: number;
  revenueUsd: number; // buyer-visible revenue (post revenue-cut)
  profitUsd: number; // revenueUsd − spendUsd
  roi: number; // revenueUsd / spendUsd (0 when spend is 0)
  impressions: number;
  clicks: number;
  conversions: number;
  marginUsd: number; // platform margin (admin/super); 0 for a buyer's own totals
}

export interface DailyPoint {
  day: string; // "YYYY-MM-DD"
  spendUsd: number;
  revenueUsd: number;
  profitUsd: number;
}

export interface StatsSummary {
  range: DateRange;
  totals: MetricTotals;
  series: DailyPoint[]; // one point per day in range (gaps filled with zeros)
}

export interface CampaignPerf {
  id: string;
  name: string;
  status: string;
  channelLabel: string | null;
  spendUsd: number;
  revenueUsd: number;
  profitUsd: number;
  roi: number;
  impressions: number;
  clicks: number;
  conversions: number;
  adSetCount: number;
  adCount: number;
}

export interface AdPerf {
  id: string;
  name: string;
  spendUsd: number;
  revenueUsd: number;
  profitUsd: number;
  roi: number;
  impressions: number;
  clicks: number;
  conversions: number;
  basis: string | null; // allocation basis of the latest day (conversions|clicks|impressions|unallocated)
}

export interface AdSetPerf {
  id: string;
  name: string;
  ads: AdPerf[];
}

export interface CampaignBreakdown {
  range: DateRange;
  campaign: { id: string; name: string; status: string };
  totals: MetricTotals;
  adSets: AdSetPerf[];
}

/** Per-buyer rollup (company-admin: own org; super-admin: a chosen org or all). */
export interface BuyerRollup {
  buyerId: string;
  name: string;
  email: string;
  spendUsd: number;
  revenueUsd: number;
  profitUsd: number;
  marginUsd: number;
  campaignCount: number;
}

/** Per-company rollup (super-admin only). */
export interface CompanyRollup {
  orgId: string;
  name: string;
  spendUsd: number;
  revenueUsd: number;
  marginUsd: number;
  buyerCount: number;
  campaignCount: number;
  defaultRevenueCutPct: number; // 0..1 — the platform's cut for this company
}

/** A channel-pool row for the super-admin operational view. */
export interface ChannelRow {
  id: string;
  channelId: string;
  label: string | null;
  status: string; // AVAILABLE | ASSIGNED | RESERVED
  campaignId: string | null;
  campaignName: string | null;
  lockedForDay: string | null;
}

/** An article row for the admin/super articles list. */
export interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  createdAt: string; // ISO
}

/** Platform-wide settings editable by the super-admin. */
export interface PlatformSettings {
  compliancePrompt: string;
  articleDomain: string;
  redirectDomain: string;
}
