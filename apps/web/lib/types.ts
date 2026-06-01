import { type Role, type UserStatus } from '@knn/shared';

export type { Role, UserStatus };

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export type FbStatus = 'ACTIVE' | 'CONNECTION_BROKEN';

export interface ConnectionStatus {
  connected: boolean;
  status?: FbStatus;
  fbUserId?: string;
  scopes?: string[];
  tokenExpiresAt?: string;
  lastError?: string | null;
  connectedAt?: string;
}

/** A connected Facebook profile (one OAuth connection). A user may have several. */
export interface FbProfile {
  id: string;
  fbUserId: string;
  name: string;
  /** Which app this connection is for: DATA (sync/reads/CAPI) or LAUNCH (short-lived, ad writes). */
  appKind: 'DATA' | 'LAUNCH';
  status: FbStatus;
  scopes: string[];
  tokenExpiresAt: string;
  lastError: string | null;
  connectedAt: string;
  adAccountCount: number;
  pageCount: number;
}

/** Whether a launch-app connection's token can see all the same person's DATA assets. */
export interface LaunchAccessResult {
  status: 'ok' | 'gaps' | 'expired' | 'broken' | 'no_assets';
  total: number;
  accessible: number;
  missing: { type: 'account' | 'page' | 'pixel'; id: string; name: string }[];
}

/** A profile plus its owner — for the super-admin platform oversight view. */
export interface FbProfileWithOwner extends FbProfile {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  orgId: string;
  orgName: string;
}

export interface FbAccount {
  id: string;
  fbAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
}

export interface FbPage {
  id: string;
  fbPageId: string;
  name: string;
  instagramId: string | null;
}

export interface FbPixel {
  id: string;
  fbPixelId: string;
  name: string;
}

export interface SyncResult {
  adAccounts: number;
  pages: number;
  pixels: number;
}

export type CampaignStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSING'
  | 'LAUNCHING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'REJECTED'
  | 'BATCHED'
  | 'QUEUED_NO_CHANNEL'
  | 'META_REJECTED'
  | 'ARCHIVED';

export interface CampaignAd {
  id: string;
  name: string;
  headline: string;
  primaryText: string;
  description: string | null;
  cta: string;
  /** Visible URL caption shown in the ad (FB link_data.caption); null = derived from destination. */
  displayLink: string | null;
  creativeType: 'IMAGE' | 'VIDEO';
  uploadId: string | null;
  redirectId: string;
  fallbackUrl: string | null;
  beneficiary: string | null;
}

export interface CampaignAdSet {
  id: string;
  name: string;
  dailyBudgetCents: number | null;
  billingEvent: string;
  optimizationGoal: string;
  bidStrategy: string | null;
  countries: string[];
  excludeCountries: string[];
  ageMin: number;
  ageMax: number;
  genders: string[];
  languages: string[];
  devicePlatforms: string[];
  mobileOs: string[];
  advantageAudience: boolean;
  placementMode: string;
  placements: string[];
  pixelId: string | null;
  pxeEvent: string;
  conversionType: string;
  costCapCents: number | null;
  roasFactor: number | null;
  attributionWindow: string | null;
  targeting: Record<string, unknown>;
  startTime: string | null;
  endTime: string | null;
  timezone: string | null;
  ads: CampaignAd[];
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: string;
  optimizationGoal: string;
  specialAdCategories: string[];
  nameTemplate: string | null;
  adsetNameTemplate: string | null;
  budgetMode: 'AD_SET' | 'CAMPAIGN';
  dailyBudgetCents: number | null;
  keywords: string[];
  racValue: string | null;
  query: string | null;
  fallbackUrl: string | null;
  adAccountId: string | null;
  pageId: string | null;
  articleId: string | null;
  channelId: string | null;
  fbCampaignId: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  adSets: CampaignAdSet[];
}

export interface AdminOrg {
  id: string;
  name: string;
  autoApprove: boolean;
  autoLaunch: boolean;
}

export interface PublicUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  approvedAt: string | null;
}

export type UserAction = 'approve' | 'reject' | 'suspend' | 'reactivate';

export interface DomainRow {
  id: string;
  host: string;
  afsAccountId: string;
  afsLabel: string | null;
  afsPubId: string | null;
  channelRanges: string | null;
  styleId: string | null;
  adsafe: string | null;
  status: string;
  verifyToken: string;
  verifiedAt: string | null;
  lastCheck: string | null;
  channelCount: number;
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  createdAt: string;
}

export interface AfsAccountRow {
  id: string;
  label: string | null;
  afsPubId: string | null;
  account: string | null;
  email: string | null;
  status: string;
  connectedAt: string;
  catalogCount: number;
  importedCount: number;
}

/** A campaign offer (Phase E): one website the campaign's traffic routes to. */
export interface OfferRow {
  id: string;
  domainId: string;
  host: string;
  afsLabel: string | null;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
  channelId: string | null;
  domainStatus: string;
  articleId: string | null;
  articleTitle: string | null;
}

export interface OfferInput {
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
  articleId?: string | null;
}

export interface OfferDomainOption {
  id: string;
  host: string;
  afsLabel: string | null;
}

export interface ArticleVariantOption {
  id: string;
  title: string;
  slug: string;
}

/** A company (organization) row for the super-admin Companies page. */
export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  isPlatform: boolean;
  autoApprove: boolean;
  autoLaunch: boolean;
  buyerCount: number;
  adminCount: number;
  pendingCount: number;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  orgId: string | null;
  orgName: string | null;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  createdAt: string;
}

export interface CreateOrgInput {
  name: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

/** An AFS custom channel as shown in the domain channel browser (pick by name). */
export interface AfsChannelRow {
  channelId: string;
  displayName: string | null;
  imported: boolean;
  status: string | null;
}

export interface AdsenseStatus {
  connected: boolean;
  email?: string | null;
  account?: string | null;
  adClient?: string | null;
  channelRanges?: string | null;
  status?: string;
  scopes?: string[];
  connectedAt?: string;
  tokenExpiresAt?: string;
}

export interface AdsenseRevenuePreviewRow {
  channelId: string;
  label: string | null;
  inPool: boolean;
  revenueMinor: number;
  afsClicks: number;
  /** AFS fill-rate (observe-only): fill rate = matchedRequests / requests; null below the floor. */
  requests: number;
  matchedRequests: number;
  impressions: number;
  fillRate: number | null;
  /** Revenue per AFS click (account currency, major units); null below the click floor. */
  rpc: number | null;
}

export interface AdsenseRevenuePreview {
  account: string | null;
  since: string;
  until: string;
  currency: string;
  totalRevenueMinor: number;
  totalClicks: number;
  channelsWithRevenue: number;
  matchedInPool: number;
  rows: AdsenseRevenuePreviewRow[];
}

export interface UploadResult {
  id: string;
  filename: string;
  kind: 'IMAGE' | 'VIDEO';
  mimeType: string;
  sizeBytes: number;
}
