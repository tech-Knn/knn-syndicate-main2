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
  /** The owning buyer + company — used by the Analytics workbench filters. */
  buyerId: string;
  buyerName: string;
  orgId: string;
  companyName: string;
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
  /** Rolled-up metrics across the ad set's ads (so the tree shows numbers at every level). */
  spendUsd: number;
  revenueUsd: number;
  profitUsd: number;
  roi: number;
  impressions: number;
  clicks: number;
  conversions: number;
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

/** Per-offer revenue for a campaign (Phase F). Cost is campaign-level FB spend; revenue
 *  is per offer (its AFS channel). `revenueUsd` is buyer-visible (the platform cut applied);
 *  hidden (0 + `suppressed`) when AFS clicks are below the §5.8.2 threshold. */
/** A breakdown dimension for the campaign drill-down. */
export type StatDim = 'country' | 'hour';

/** One bucket of a dimension breakdown (country code or hour). Revenue is allocated. */
export interface DimStat {
  dimValue: string;
  spendUsd: number;
  revenueUsd: number; // allocated from campaign revenue by conversion share (approximation)
  profitUsd: number;
  roi: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface OfferStat {
  offerId: string;
  host: string;
  afsLabel: string | null;
  kind: 'PAID' | 'ORGANIC';
  weightPct: number;
  revenueUsd: number;
  afsClicks: number;
  suppressed: boolean;
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

/** Accurate channel-pool counts for the platform view (real totals, per website). */
export interface ChannelSummary {
  total: number;
  available: number;
  assigned: number;
  /** Channels with no domain (legacy global / placeholder seed) — should be 0 in prod. */
  untagged: number;
  byDomain: { domainId: string; host: string; total: number; available: number }[];
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

/**
 * One contiguous span a channel was held by a campaign — consecutive per-IST-day
 * `ChannelAssignment` rows collapsed into a single range. Revenue is GROSS platform USD.
 */
export interface ChannelAssignmentSpan {
  campaignId: string;
  campaignName: string | null;
  companyName: string | null;
  articleId: string | null;
  articleTitle: string | null;
  articleSlug: string | null;
  host: string | null; // the offer's domain host this channel served
  liveUrl: string | null; // https://{host}/a/{slug}
  firstDay: string; // "YYYY-MM-DD"
  lastDay: string;
  active: boolean; // still currently assigned (a row has releasedAt == null)
  revenueUsd: number; // gross platform revenue over the span
  afsClicks: number;
}

/** Full usage lineage for ONE channel id (super-admin Channels page). */
export interface ChannelUsage {
  id: string; // channels.id (uuid)
  channelId: string; // the AFS `ch` value
  label: string | null;
  status: string;
  host: string | null; // the pool/domain this channel belongs to
  spans: ChannelAssignmentSpan[]; // newest-first
}

/** A campaign that uses an article + the channels/domains it ran on (Articles page). */
export interface ArticleUsageCampaign {
  campaignId: string;
  campaignName: string;
  companyName: string | null;
  status: string;
  channels: {
    channelDbId: string;
    channelId: string; // AFS ch value
    host: string | null;
    liveUrl: string | null;
    firstDay: string | null;
    lastDay: string | null;
    active: boolean;
    revenueUsd: number;
    afsClicks: number;
  }[];
}

/** Per-article lineage: where it's live (domains/channels) and for how long. */
export interface ArticleUsage {
  id: string;
  title: string;
  slug: string;
  status: string;
  createdAt: string; // ISO
  liveHosts: string[]; // distinct hosts it's/was live on
  totalRevenueUsd: number;
  campaigns: ArticleUsageCampaign[];
}
