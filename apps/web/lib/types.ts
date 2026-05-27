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
  ageMin: number;
  ageMax: number;
  genders: string[];
  placementMode: string;
  placements: string[];
  pixelId: string | null;
  pxeEvent: string;
  targeting: Record<string, unknown>;
  startTime: string | null;
  endTime: string | null;
  ads: CampaignAd[];
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: string;
  optimizationGoal: string;
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
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  adSets: CampaignAdSet[];
}

export interface UploadResult {
  id: string;
  filename: string;
  kind: 'IMAGE' | 'VIDEO';
  mimeType: string;
  sizeBytes: number;
}
