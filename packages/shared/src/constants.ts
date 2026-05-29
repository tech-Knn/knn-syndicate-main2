/** Platform-wide constants and enums shared across services. */

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  MEDIA_BUYER: 'MEDIA_BUYER',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

export const USER_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REJECTED: 'REJECTED',
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

/** Ad/launch lifecycle (spec §5.4.2), tracked per ad post-launch. */
export const AD_STATUS = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  BATCHED: 'BATCHED',
  QUEUED_NO_CHANNEL: 'QUEUED_NO_CHANNEL',
  LAUNCHING: 'LAUNCHING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  META_REJECTED: 'META_REJECTED',
  REJECTED: 'REJECTED',
} as const;
export type AdStatus = (typeof AD_STATUS)[keyof typeof AD_STATUS];

export const CHANNEL_STATUS = {
  AVAILABLE: 'AVAILABLE',
  ASSIGNED: 'ASSIGNED',
  RESERVED: 'RESERVED',
} as const;
export type ChannelStatus = (typeof CHANNEL_STATUS)[keyof typeof CHANNEL_STATUS];

export const QUEUE_STATUS = {
  WAITING: 'WAITING',
  ASSIGNED: 'ASSIGNED',
  CANCELLED: 'CANCELLED',
} as const;
export type QueueStatus = (typeof QUEUE_STATUS)[keyof typeof QUEUE_STATUS];

export const FB_CONNECTION_STATUS = {
  ACTIVE: 'ACTIVE',
  CONNECTION_BROKEN: 'CONNECTION_BROKEN',
} as const;
export type FbConnectionStatus =
  (typeof FB_CONNECTION_STATUS)[keyof typeof FB_CONNECTION_STATUS];

/** Business / domain constants from the spec. */
export const CHANNEL_POOL_SIZE = 2000;
export const ARTICLE_SIMILARITY_THRESHOLD = 0.7; // §5.5.2 cosine reuse threshold
export const EMBEDDING_DIMENSIONS = 1536; // OpenAI text-embedding-3-small
export const AFS_CLICK_SUPPRESSION_THRESHOLD = 10; // §5.8.2 "< 10" suppression

/** Data finalization windows (§5.8 "Data Finalization"). */
export const FINALIZATION = {
  FB_REPULL_DAYS: 3,
  ADSENSE_REPULL_DAYS: 8,
  REPULL_INTERVAL_HOURS: 6,
} as const;

/** FB error codes that signal a broken/expired connection (verified vs Meta docs). */
export const FB_TOKEN_ERROR_SUBCODES = [458, 459, 460, 463, 466, 467] as const;
export const FB_RATE_LIMIT_ERROR_CODES = [4, 17, 32, 613, 80004, 80000, 80003] as const;
/**
 * FB error codes that mean the AD ACCOUNT (not the token) is under a security/policy
 * hold — create/modify is blocked until the account owner re-authenticates in Ads
 * Manager, but reads + existing ads keep running. 368 = "action deemed abusive or
 * otherwise disallowed" (the "authenticate your account" checkpoint); 1487390 is the
 * account-restricted subcode seen alongside it. Distinct from a token break (190) so
 * the launcher can give an actionable message + stop blind retries instead of looping. */
export const FB_ACCOUNT_RESTRICTED_ERROR_CODES = [368] as const;
export const FB_ACCOUNT_RESTRICTED_SUBCODES = [1487390] as const;

/** Names of the BullMQ queues (single source of truth for worker + Bull-Board). */
export const QUEUES = {
  STATS_PULL: 'stats-pull',
  ATTRIBUTION: 'attribution',
  CHANNEL_MAINTENANCE: 'channel-maintenance',
  FB_LAUNCH: 'fb-launch',
  CAPI_DISPATCH: 'capi-dispatch',
  TOKEN_REFRESH: 'token-refresh',
  ARTICLE_GENERATION: 'article-generation',
  META_REJECTION_CHECK: 'meta-rejection-check',
  NOTIFICATIONS: 'notifications',
  HEALTH: 'health',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
