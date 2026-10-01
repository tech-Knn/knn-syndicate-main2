import { type AdProvider, type Role, type UserStatus, type WhopChecklist, type WhopEnvironment } from '@knn/shared';

export type { AdProvider, Role, UserStatus };

/** A problem Whop reports on a campaign, ad group or ad (Meta's asynchronous rejections land here, in words). */
export interface WhopIssue {
  id: string;
  message: string;
  resource_id: string | null;
  resource_type: string;
}

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  /** The buyer's effective funnel mode — the wizard hides fallback/display for CLOAKER buyers. */
  funnelMode?: FunnelMode;
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
  /** Which app: DATA (sync/reads/CAPI), LAUNCH (short-lived, ad writes), or VERIFY (Advanced-Access app — syncs + publishes). */
  appKind: 'DATA' | 'LAUNCH' | 'VERIFY';
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
  /** The buyer who owns it (an admin can open it too, but only its buyer's connections and assets apply to it). */
  buyerId: string;
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
  /** Which ad network runs it (D33). Every campaign from before Whop Ads is FACEBOOK. */
  adProvider: AdProvider;
  adAccountId: string | null;
  pageId: string | null;
  /** Resolved label for the selected ad account — server-side lookup so admins can view
   * a buyer's selection even when the admin has no FB connection of their own. */
  adAccount?: { id: string; fbAccountId: string; name: string } | null;
  /** Resolved label for the selected page (see `adAccount` above). */
  page?: { id: string; fbPageId: string; name: string } | null;
  /** Whop campaigns only: the connected business, the Facebook page its ads run under, and what Whop reports. */
  whopConnectionId: string | null;
  whopPageId: string | null;
  whopBizId: string | null;
  whopCampaignId: string | null;
  whopDeliveryStatus: string | null;
  whopIssues: WhopIssue[];
  /** Resolved labels for the Whop business and page (server-side, like `adAccount` / `page`). */
  whopBusiness?: { bizId: string; label: string | null } | null;
  whopPage?: { whopId: string; name: string | null } | null;
  articleId: string | null;
  channelId: string | null;
  /** The go-link host and (Cloaker only) the white domain recorded at launch. `whiteDomainHost` null = a Normal-mode campaign. */
  redirectDomainHost: string | null;
  whiteDomainHost: string | null;
  fbCampaignId: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  adSets: CampaignAdSet[];
}

export type FunnelMode = 'NORMAL' | 'CLOAKER';

export interface AdminOrg {
  id: string;
  name: string;
  autoApprove: boolean;
  autoLaunch: boolean;
  cloakingEnabled: boolean;
  defaultFunnelMode: FunnelMode;
  whopEnabled: boolean;
}

export interface PublicUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  /** Per-buyer funnel-mode override; null = inherit the org default. */
  funnelMode: FunnelMode | null;
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
  cloakingEnabled: boolean;
  defaultFunnelMode: FunnelMode;
  whopEnabled: boolean;
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

/** Result of a bulk queue action — partial success: ids that worked + per-id failures. */
export interface BulkResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** A buyer's Facebook tester-onboarding state (apps in Dev mode). */
export interface FbAccessState {
  fbHandle: string | null;
  status: 'NONE' | 'REQUESTED' | 'INVITED';
  connected: boolean;
}
export interface FbAccessRequestRow {
  userId: string;
  name: string;
  email: string;
  orgName: string;
  fbHandle: string | null;
  status: 'REQUESTED' | 'INVITED';
  updatedAt: string;
}
/** Super-admin queue of buyers awaiting tester access + the dashboard deep-links to add them. */
export interface FbAccessRequestList {
  requests: FbAccessRequestRow[];
  dataAppRolesUrl: string | null;
  launchAppRolesUrl: string | null;
  approveUrl: string;
}

/** D28 — a Referrer Ad Creative word that makes Google hide the keyword block (super-admin view). */
export interface RcTermRow {
  id: string;
  /** Normalized word/phrase (lowercase, plurals folded). */
  term: string;
  source: 'SEED' | 'LEARNED' | 'MANUAL';
  /** BLOCKED = buyers can't use it in a new rc; ALLOWED = override (never blocked, never re-learned). */
  status: 'BLOCKED' | 'ALLOWED';
  note: string | null;
  suppressedCampaigns: number | null;
  campaignsUsing: number | null;
  keywordClicksPer100: number | null;
  baselinePer100: number | null;
  learnedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** D28 — result of a learning run (daily cron or "Learn now"). */
export interface RcLearningRunResult {
  baselinePer100: number | null;
  eligibleCampaigns: number;
  suppressedCampaigns: number;
  added: { term: string; suppressedCampaigns: number; campaignsUsing: number; keywordClicksPer100: number }[];
}

// ── Whop Ads (D33) ──────────────────────────────────────────────────────────────────────────────

/** Whether the user may use Whop Ads (global flag AND their company's switch). */
export interface WhopStatus {
  enabled: boolean;
  allowSandbox: boolean;
}

export interface WhopPage {
  /** Whop's social account id, `sacc_…`. */
  id: string;
  platform: string;
  name: string | null;
  username: string | null;
  verified: boolean;
  error: string | null;
}

export interface WhopConnection {
  id: string;
  bizId: string;
  environment: WhopEnvironment;
  label: string | null;
  /** The only part of the API key we ever show. */
  apiKeyLast4: string;
  status: 'ACTIVE' | 'BROKEN';
  lastError: string | null;
  reportingCurrency: string | null;
  apiVersionDate: string;
  checklist: WhopChecklist | null;
  lastCheckedAt: string | null;
  connectedAt: string;
  pages: WhopPage[];
}

export interface WhopConnectionWithOwner extends WhopConnection {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  orgId: string;
  orgName: string;
}

export interface WhopPixelCheck {
  installed: boolean;
  lastSeenDays: number | null;
  lastFiredDays: Record<string, number>;
  nativeTracking: boolean;
  reachable: boolean | null;
  url: string | null;
}
